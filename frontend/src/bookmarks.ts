/**
 * Shared cloud bookmark store.
 *
 * The whole list is shared by every visitor — no accounts, no per-user
 * partitioning. Anyone can add, anyone can delete. This is fine because
 * the app is for personal/family use; the cloud blob lives in a private
 * GCS bucket and the only public surface is `/api/bookmarks` GET/PUT
 * with size + rate limits enforced server-side.
 *
 * localStorage is kept as an offline cache so the dialog opens instantly
 * with the last-known list, even if the server is slow / offline.
 */

const CACHE_KEY = "piano-key-detector.bookmarks.v1";
const API_URL = "/api/bookmarks";

export interface Bookmark {
  id: string;
  name: string;
  xml: string;
  savedAt: number;
}

let cached: Bookmark[] | null = null;
let inflightFetch: Promise<Bookmark[]> | null = null;

function loadCache(): Bookmark[] {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return (cached = []);
    const arr = JSON.parse(raw);
    cached = Array.isArray(arr) ? arr : [];
    return cached;
  } catch {
    return (cached = []);
  }
}

function saveCache(list: Bookmark[]) {
  cached = list;
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(list));
  } catch (e) {
    console.warn("bookmarks: localStorage save failed", e);
  }
}

/** Synchronously return the cached list (instant, may be stale). */
export function listBookmarks(): Bookmark[] {
  return [...loadCache()].sort((a, b) => b.savedAt - a.savedAt);
}

/**
 * Fetch the latest list from the server, replace the local cache with it,
 * and return it. Falls back to the cached list on network error so the UI
 * still works offline.
 */
export async function refreshFromCloud(): Promise<Bookmark[]> {
  if (inflightFetch) return inflightFetch;
  inflightFetch = (async () => {
    try {
      const r = await fetch(API_URL, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const list: Bookmark[] = Array.isArray(j?.bookmarks) ? j.bookmarks : [];
      saveCache(list);
      return [...list].sort((a, b) => b.savedAt - a.savedAt);
    } catch (e) {
      console.warn("bookmarks: cloud fetch failed, using cache", e);
      return listBookmarks();
    } finally {
      inflightFetch = null;
    }
  })();
  return inflightFetch;
}

async function pushToCloud(list: Bookmark[]): Promise<void> {
  const r = await fetch(API_URL, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ bookmarks: list }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`HTTP ${r.status}: ${text || r.statusText}`);
  }
}

export async function saveBookmark(name: string, xml: string): Promise<Bookmark> {
  const list = loadCache();
  const bm: Bookmark = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim() || "未命名琴譜",
    xml,
    savedAt: Date.now(),
  };
  const next = [...list, bm];
  saveCache(next); // optimistic local
  try {
    await pushToCloud(next);
  } catch (e: any) {
    // Roll back local cache so it doesn't drift from cloud.
    saveCache(list);
    throw new Error(`雲端儲存失敗：${e?.message ?? e}`);
  }
  return bm;
}

export async function deleteBookmark(id: string): Promise<void> {
  const list = loadCache();
  const next = list.filter((b) => b.id !== id);
  saveCache(next);
  try {
    await pushToCloud(next);
  } catch (e: any) {
    saveCache(list); // roll back
    throw new Error(`雲端刪除失敗：${e?.message ?? e}`);
  }
}

export function getBookmark(id: string): Bookmark | undefined {
  return loadCache().find((b) => b.id === id);
}

/** Best-effort: pull <work-title> from a MusicXML string. */
export function extractTitle(xml: string): string {
  const m = xml.match(/<work-title>([^<]+)<\/work-title>/);
  return m ? decodeXmlEntities(m[1].trim()) : "";
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

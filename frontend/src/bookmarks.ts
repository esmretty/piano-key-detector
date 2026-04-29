/**
 * Bookmark store: persist loaded MusicXML scores in localStorage.
 * Each bookmark is identified by a random id and shows a user-supplied (or
 * auto-extracted) display name.
 */

const KEY = "piano-key-detector.bookmarks.v1";

export interface Bookmark {
  id: string;
  name: string;
  xml: string;
  savedAt: number;
}

function load(): Bookmark[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function persist(list: Bookmark[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

export function listBookmarks(): Bookmark[] {
  return load().sort((a, b) => b.savedAt - a.savedAt);
}

export function saveBookmark(name: string, xml: string): Bookmark {
  const list = load();
  const bm: Bookmark = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    name: name.trim() || "未命名琴譜",
    xml,
    savedAt: Date.now(),
  };
  list.push(bm);
  persist(list);
  return bm;
}

export function deleteBookmark(id: string): void {
  persist(load().filter((b) => b.id !== id));
}

export function getBookmark(id: string): Bookmark | undefined {
  return load().find((b) => b.id === id);
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

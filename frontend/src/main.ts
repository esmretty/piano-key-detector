import "./style.css";
import { Piano } from "./piano";
import { Player } from "./player";
import { SheetView } from "./sheet";
import { midiToMusicXML } from "./parsers/midi";
import { imageToMusicXML, type OMRProgress } from "./parsers/omr";
import { appendMusicXML } from "./concat";
import {
  listBookmarks,
  saveBookmark,
  deleteBookmark,
  extractTitle,
  type Bookmark,
} from "./bookmarks";
import type { CursorStep } from "./types";

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const fileInput = $<HTMLInputElement>("file-input");
const appendInput = $<HTMLInputElement>("append-input");
const playBtn = $<HTMLButtonElement>("play-btn");
const stopBtn = $<HTMLButtonElement>("stop-btn");
const bpmInput = $<HTMLInputElement>("bpm-input");
const soundToggle = $<HTMLInputElement>("sound-toggle");
const statusEl = $("status");
const sheetContainer = $("sheet-container");
const pianoSvg = document.getElementById("piano") as unknown as SVGSVGElement;
const pianoScroll = $("piano-scroll");
const progressEl = $("progress");
const progressFill = $("progress-fill");

const bookmarksBtn = $<HTMLButtonElement>("bookmarks-btn");
const bookmarksDialog = document.getElementById("bookmarks-dialog") as HTMLDialogElement;
const bookmarkNameInput = $<HTMLInputElement>("bookmark-name");
const bookmarkSaveBtn = $<HTMLButtonElement>("bookmark-save-btn");
const bookmarkList = $("bookmark-list") as HTMLUListElement;
const bookmarkEmpty = $("bm-empty");

const piano = new Piano(pianoSvg, pianoScroll);
const player = new Player();
const sheet = new SheetView(sheetContainer);

piano.setKeyHandlers(
  async (midi) => {
    try { await player.start(); } catch { /* ignore */ }
    player.triggerAttack(midi);
  },
  (midi) => player.triggerRelease(midi),
);

let timeline: CursorStep[] = [];
let playState: "idle" | "playing" | "paused" = "idle";
let currentTimer: number | null = null;
let currentIdx = 0;
let currentXml: string | null = null;
const pendingNoteOffTimers: number[] = [];

// ===== status / progress =====

function setStatus(msg: string, kind: "" | "ok" | "error" = "") {
  statusEl.textContent = msg;
  statusEl.className = "status" + (kind ? " " + kind : "");
}

function showProgress(determinate: boolean, percent = 0) {
  progressEl.hidden = false;
  progressEl.classList.toggle("indeterminate", !determinate);
  if (determinate) progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  else progressFill.style.width = "";
}

function hideProgress() {
  progressEl.hidden = true;
  progressEl.classList.remove("indeterminate");
  progressFill.style.width = "0%";
}

// ===== controls =====

soundToggle.addEventListener("change", () => player.setEnabled(soundToggle.checked));

bpmInput.addEventListener("change", () => {
  const v = clampInt(bpmInput.value, 20, 300, 60);
  bpmInput.value = String(v);
  if (timeline.length) timeline = sheet.buildTimeline(v);
});

fileInput.addEventListener("change", async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  await loadFile(f, "replace");
  fileInput.value = ""; // allow re-selecting the same file later
});

appendInput.addEventListener("change", async () => {
  const f = appendInput.files?.[0];
  if (!f) return;
  await loadFile(f, "append");
  appendInput.value = "";
});

playBtn.addEventListener("click", async () => {
  if (!timeline.length) return;
  setStatus("載入鋼琴音色…");
  try { await player.start(); }
  catch { setStatus("音訊載入失敗（仍可繼續無聲播放）", "error"); }
  startPlayback();
});

stopBtn.addEventListener("click", () => stopPlayback());

// Space: toggle pause/resume; if idle, start (from selected note if any).
window.addEventListener("keydown", (e) => {
  if (e.code !== "Space") return;
  // Don't hijack space when typing in an input (BPM, bookmark name, etc.)
  const t = e.target as HTMLElement;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
  e.preventDefault();
  if (playState === "playing") {
    pausePlayback();
  } else if (playState === "paused") {
    resumePlayback();
  } else {
    if (!timeline.length) return;
    const sel = sheet.getSelectedStepIdx();
    (async () => {
      try { await player.start(); } catch { /* ignore */ }
      startPlayback(sel ?? 0);
    })();
  }
});

// Click-to-select on a note → blue highlight, ready to start from there.
sheet.setOnStepSelected((stepIdx) => {
  if (playState === "playing") {
    // Clicks during playback don't select — keep playing.
    return;
  }
  if (stepIdx != null) {
    const t = timeline[stepIdx]?.time ?? 0;
    setStatus(
      `已選擇 步 ${stepIdx + 1}/${timeline.length} (${t.toFixed(2)}s)。空白鍵從此處開始`,
      "ok",
    );
  }
});

// ===== loading pipeline =====

async function fileToMusicXML(f: File): Promise<string> {
  const name = f.name.toLowerCase();
  if (name.endsWith(".mid") || name.endsWith(".midi")) {
    setStatus(`解析 MIDI：${f.name}`);
    showProgress(false);
    const buf = await f.arrayBuffer();
    return midiToMusicXML(buf);
  }
  if (name.endsWith(".xml") || name.endsWith(".musicxml")) {
    setStatus(`讀取 MusicXML：${f.name}`);
    showProgress(false);
    return await f.text();
  }
  if (name.endsWith(".mxl")) {
    setStatus(`解壓 MXL：${f.name}`);
    showProgress(false);
    return await unzipMxl(f);
  }
  if (
    name.endsWith(".png") ||
    name.endsWith(".jpg") ||
    name.endsWith(".jpeg") ||
    name.endsWith(".pdf")
  ) {
    setStatus(`上傳並辨識琴譜：${f.name}`);
    showProgress(false); // indeterminate until backend reports pages
    let totalPages = 1;
    let pagesDone = 0;
    return await imageToMusicXML(f, (e: OMRProgress) => {
      if (e.type === "status") {
        setStatus(e.message);
      } else if (e.type === "start") {
        totalPages = e.pages;
        pagesDone = 0;
        if (totalPages > 1) {
          showProgress(true, 5);
          setStatus(`PDF 共 ${totalPages} 頁，準備辨識…`);
        }
      } else if (e.type === "page") {
        if (e.phase === "start") {
          setStatus(`辨識第 ${e.current}/${e.total} 頁中…`);
          if (e.total > 1) showProgress(true, ((e.current - 1) / e.total) * 100 + 2);
        } else {
          pagesDone = e.current;
          if (e.total > 1) showProgress(true, (pagesDone / e.total) * 100);
          const took = e.elapsed_s != null ? `（${e.elapsed_s.toFixed(1)} 秒）` : "";
          const fixed = e.fixed_measures && e.fixed_measures > 0
            ? `，自動修正 ${e.fixed_measures} 個小節`
            : "";
          setStatus(`第 ${e.current}/${e.total} 頁完成${took}${fixed}`);
        }
      } else if (e.type === "done") {
        showProgress(true, 100);
      }
    });
  }
  throw new Error("不支援的檔案格式");
}

async function loadFile(f: File, mode: "replace" | "append") {
  stopPlayback();
  const t0 = performance.now();
  try {
    const incoming = await fileToMusicXML(f);
    const finalXml =
      mode === "append" && currentXml
        ? appendMusicXML(currentXml, incoming)
        : incoming;
    currentXml = finalXml;
    await applyXml(finalXml, f.name, mode, performance.now() - t0);
  } catch (err: any) {
    console.error(err);
    setStatus(`載入失敗：${err?.message ?? err}`, "error");
    hideProgress();
    if (mode === "replace") {
      playBtn.disabled = true;
      stopBtn.disabled = true;
      appendInput.disabled = true;
    }
  }
}

async function applyXml(
  xml: string,
  sourceLabel: string,
  mode: "replace" | "append" | "bookmark",
  elapsedMs?: number,
) {
  await sheet.loadXml(xml);
  const detected = sheet.defaultBpm();
  if (detected && detected > 20 && detected < 300) bpmInput.value = String(detected);
  timeline = sheet.buildTimeline(Number(bpmInput.value));
  playBtn.disabled = false;
  stopBtn.disabled = false;
  appendInput.disabled = false;
  bookmarkSaveBtn.disabled = false;
  hideProgress();
  const verb = mode === "append" ? "已追加" : mode === "bookmark" ? "已載入書籤" : "載入完成";
  const timing = elapsedMs != null ? `，耗時 ${formatDuration(elapsedMs)}` : "";
  setStatus(`${verb}（${sourceLabel}）：${timeline.length} 個演奏點${timing}，按 ▶ 開始`, "ok");
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(1)} 秒`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m} 分 ${s} 秒`;
}

// ===== mxl unzip (browser-only) =====

async function unzipMxl(f: File): Promise<string> {
  const buf = new Uint8Array(await f.arrayBuffer());
  const entries = readZip(buf);
  const container = entries.find((e) => e.name === "META-INF/container.xml");
  let xmlPath: string | null = null;
  if (container) {
    const txt = new TextDecoder().decode(await inflate(container.data, container.method));
    const m = txt.match(/full-path="([^"]+\.xml)"/);
    if (m) xmlPath = m[1];
  }
  const target = xmlPath
    ? entries.find((e) => e.name === xmlPath)
    : entries.find((e) => e.name.endsWith(".xml") && !e.name.startsWith("META-INF/"));
  if (!target) throw new Error("無法在 .mxl 中找到 MusicXML 檔");
  return new TextDecoder().decode(await inflate(target.data, target.method));
}

interface ZipEntry { name: string; data: Uint8Array; method: number; }

function readZip(bytes: Uint8Array): ZipEntry[] {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: ZipEntry[] = [];
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error(".mxl 不是有效的 zip");
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  let p = cdOff;
  const end = cdOff + cdSize;
  while (p < end) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(bytes.slice(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    const lhNameLen = dv.getUint16(localOff + 26, true);
    const lhExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lhNameLen + lhExtraLen;
    const data = bytes.slice(dataStart, dataStart + compSize);
    out.push({ name, data, method });
  }
  return out;
}

async function inflate(data: Uint8Array, method: number): Promise<Uint8Array> {
  if (method === 0) return data;
  if (method !== 8) throw new Error(`不支援的 zip 壓縮方法 ${method}`);
  const ds = new (window as any).DecompressionStream("deflate-raw");
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

// ===== playback =====

function startPlayback(fromIdx: number = 0) {
  if (playState === "playing") return;
  playState = "playing";
  currentIdx = Math.max(0, Math.min(fromIdx, timeline.length));
  sheet.cursorReset();
  // Honor any leading rest at the start of the score (pickup measure /
  // anacrusis). timeline[0].time is the first NOTE's onset in seconds; the
  // span [0, timeline[0].time) is leading silence that lets the OSMD cursor
  // visually rest on the pickup beat before audio kicks in. Without this,
  // the first note plays immediately on click while the cursor sits on a
  // rest a half-beat away — perceived as "audio is 半拍 ahead of the cursor".
  const leadMs = Math.max(0, (timeline[0]?.time ?? 0) * 1000);
  if (leadMs > 20) {
    setStatus(`等待起拍 ${(leadMs / 1000).toFixed(2)} 秒…`, "ok");
    currentTimer = window.setTimeout(() => {
      setStatus("播放中…", "ok");
      scheduleStep();
    }, leadMs);
  } else {
    setStatus("播放中…", "ok");
    scheduleStep();
  }
}

function stopPlayback() {
  if (currentTimer != null) {
    clearTimeout(currentTimer);
    currentTimer = null;
  }
  for (const t of pendingNoteOffTimers) clearTimeout(t);
  pendingNoteOffTimers.length = 0;
  playState = "idle";
  currentIdx = 0;
  piano.clear();
  sheet.clearActive();
  player.stopAll();
  if (timeline.length) setStatus("已停止，按 ▶ 重新播放");
}

function pausePlayback() {
  if (playState !== "playing") return;
  if (currentTimer != null) {
    clearTimeout(currentTimer);
    currentTimer = null;
  }
  for (const t of pendingNoteOffTimers) clearTimeout(t);
  pendingNoteOffTimers.length = 0;
  playState = "paused";
  player.stopAll();
  piano.clear();
  setStatus(`已暫停 (步 ${currentIdx + 1}/${timeline.length})。空白鍵繼續`, "ok");
}

function resumePlayback() {
  if (playState !== "paused") return;
  playState = "playing";
  setStatus("播放中…", "ok");
  scheduleStep();
}

function scheduleStep() {
  if (playState !== "playing") return;
  if (currentIdx >= timeline.length) {
    // Wait for any still-ringing notes to finish their visual highlight
    // before declaring done. The longest pending note-off determines the
    // wait; piano.clear() inside stopPlayback would otherwise yank highlights.
    if (pendingNoteOffTimers.length > 0) {
      currentTimer = window.setTimeout(scheduleStep, 100);
      return;
    }
    stopPlayback();
    setStatus("播放完成 ✓", "ok");
    return;
  }
  const step = timeline[currentIdx];
  // SVG cursor still follows step boundaries (it's a visual aid, not per-note).
  sheet.setActiveNotes(step.svgElements);
  // Per-note: turn ON keyboard highlight + audio attack, schedule a matching
  // OFF after the note's own duration so an X (8th) doesn't keep its highlight
  // through Y's quarter and vice-versa.
  for (const n of step.notes) {
    const durMs = Math.max(50, n.durationSec * 1000);
    player.triggerAttackRelease([n.midi], Math.max(0.05, n.durationSec * 0.95));
    piano.noteOn(n.midi);
    const tid = window.setTimeout(() => {
      piano.noteOff(n.midi);
      const idx = pendingNoteOffTimers.indexOf(tid);
      if (idx >= 0) pendingNoteOffTimers.splice(idx, 1);
    }, durMs);
    pendingNoteOffTimers.push(tid);
  }
  currentTimer = window.setTimeout(() => {
    // No OSMD cursorNext — visual indicator is the red/enlarged note from
    // setActiveNotes which is timeline-synchronous. OSMD's cursor walks
    // voice entries (incl. rests) at a different rate and would drift.
    currentIdx++;
    scheduleStep();
  }, Math.max(20, step.delta * 1000));
}

// ===== bookmarks =====

bookmarksBtn.addEventListener("click", () => {
  renderBookmarks();
  bookmarksDialog.showModal();
});

bookmarksDialog.addEventListener("click", (e) => {
  // click outside content closes
  if (e.target === bookmarksDialog) bookmarksDialog.close();
});

bookmarkSaveBtn.addEventListener("click", () => {
  if (!currentXml) return;
  const name = bookmarkNameInput.value.trim() || extractTitle(currentXml) || `琴譜 ${new Date().toLocaleString()}`;
  saveBookmark(name, currentXml);
  bookmarkNameInput.value = "";
  renderBookmarks();
});

function renderBookmarks() {
  const items = listBookmarks();
  bookmarkList.innerHTML = "";
  bookmarkEmpty.classList.toggle("hidden", items.length > 0);
  bookmarkSaveBtn.disabled = !currentXml;
  for (const bm of items) {
    bookmarkList.appendChild(renderBookmarkRow(bm));
  }
}

function renderBookmarkRow(bm: Bookmark): HTMLLIElement {
  const li = document.createElement("li");
  const nameWrap = document.createElement("div");
  nameWrap.className = "bm-name";
  const nameSpan = document.createElement("div");
  nameSpan.textContent = bm.name;
  const meta = document.createElement("div");
  meta.className = "bm-meta";
  meta.textContent = new Date(bm.savedAt).toLocaleString();
  nameWrap.appendChild(nameSpan);
  nameWrap.appendChild(meta);

  const loadBtn = document.createElement("button");
  loadBtn.type = "button";
  loadBtn.className = "bm-load";
  loadBtn.textContent = "載入";
  loadBtn.addEventListener("click", async () => {
    bookmarksDialog.close();
    stopPlayback();
    const t0 = performance.now();
    currentXml = bm.xml;
    showProgress(false);
    setStatus(`載入書籤：${bm.name}`);
    try {
      await applyXml(bm.xml, bm.name, "bookmark", performance.now() - t0);
    } catch (e: any) {
      setStatus(`載入失敗：${e?.message ?? e}`, "error");
      hideProgress();
    }
  });

  const appendBtn = document.createElement("button");
  appendBtn.type = "button";
  appendBtn.className = "bm-append";
  appendBtn.textContent = "追加";
  appendBtn.disabled = !currentXml;
  appendBtn.title = currentXml ? "把這個書籤的內容追加到目前琴譜後面" : "需要先有目前琴譜才能追加";
  appendBtn.addEventListener("click", async () => {
    if (!currentXml) return;
    bookmarksDialog.close();
    stopPlayback();
    const t0 = performance.now();
    showProgress(false);
    setStatus(`追加書籤：${bm.name}`);
    try {
      const combined = appendMusicXML(currentXml, bm.xml);
      currentXml = combined;
      await applyXml(combined, bm.name, "append", performance.now() - t0);
    } catch (e: any) {
      setStatus(`追加失敗：${e?.message ?? e}`, "error");
      hideProgress();
    }
  });

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "bm-delete";
  delBtn.textContent = "刪除";
  delBtn.addEventListener("click", () => {
    if (!confirm(`刪除書籤「${bm.name}」？`)) return;
    deleteBookmark(bm.id);
    renderBookmarks();
  });

  li.appendChild(nameWrap);
  li.appendChild(loadBtn);
  li.appendChild(appendBtn);
  li.appendChild(delBtn);
  return li;
}

// ===== utils =====

function clampInt(v: string, min: number, max: number, fallback: number): number {
  const n = parseInt(v, 10);
  if (!isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

setStatus("請選擇 .mid / .musicxml / .mxl / 圖片琴譜");

/**
 * Send an image (or PDF) to the backend OMR endpoint and receive MusicXML.
 * The backend streams NDJSON progress events; the caller's `onProgress`
 * gets each event so the UI can update a progress bar / status text.
 *
 * Always uses same-origin /api/omr — in dev Vite proxies it to :3001.
 */

export type OMRProgress =
  | { type: "status"; message: string }
  | { type: "start"; pages: number }
  | { type: "page"; current: number; total: number; phase: "start" | "done"; elapsed_s?: number; fixed_measures?: number }
  | { type: "done"; musicxml: string; pages: number }
  | { type: "error"; message: string; hint?: string };

export async function imageToMusicXML(
  file: File,
  onProgress: (e: OMRProgress) => void = () => {},
): Promise<string> {
  const fd = new FormData();
  fd.append("file", file, file.name);

  let res: Response;
  try {
    res = await fetch(`/api/omr`, { method: "POST", body: fd });
  } catch (e: any) {
    throw new Error(
      `無法連到 OMR 後端：${e?.message ?? e}。請確認你是用 \`npm run dev\`（會同時啟動前端與後端）而不是只跑前端。`
    );
  }
  if (res.status === 404) {
    throw new Error(
      "OMR 後端 404 — 表示後端 (port 3001) 沒在跑。請開另一個 terminal 執行 `npm run dev:backend`，或停掉前端後改用 `npm run dev` 同時啟動兩個。"
    );
  }
  if (!res.body) {
    const txt = await res.text().catch(() => "");
    throw new Error(`OMR 後端無回應 body：${res.status} ${txt}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let result: string | null = null;
  let lastError: string | null = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let evt: OMRProgress;
      try {
        evt = JSON.parse(line);
      } catch {
        continue;
      }
      onProgress(evt);
      if (evt.type === "done") result = evt.musicxml;
      if (evt.type === "error") lastError = evt.message;
    }
  }
  if (lastError) throw new Error(lastError);
  if (!result) throw new Error("OMR 後端未送出 done 事件就斷線");
  return result;
}

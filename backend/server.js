const express = require("express");
const multer = require("multer");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const { fixMusicXML, dumpDebug } = require("./musicxml-fixup");
const { audiverisExtract, audiverisAvailable, AUDIVERIS_EXE } = require("./audiveris");
const bookmarksStore = require("./bookmarks-store");

// OMR_ENGINE: 'audiveris' | 'oemer' | 'auto' (try audiveris, fall back to oemer)
const OMR_ENGINE = (process.env.OMR_ENGINE || "auto").toLowerCase();

const PORT = Number(process.env.PORT || 3001);
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const OMR_WORKER_PY = path.join(__dirname, "omr_worker.py");

// Legacy fallback: if the worker can't be started for any reason (e.g.,
// Python missing, oemer not installed), the per-page OMR call falls back
// to spawning oemer.exe directly.
const OEMER_BIN =
  process.env.OEMER_BIN ||
  (process.platform === "win32"
    ? path.join(
        process.env.APPDATA || "",
        "Python",
        "Python314",
        "Scripts",
        "oemer.exe"
      )
    : "oemer");

// ---- persistent Oemer worker ----
let workerProc = null;
let workerReady = null;        // Promise that resolves when worker prints "ready"
const workerQueue = [];        // FIFO of {resolve, reject} for pending requests

function startWorker() {
  if (workerProc) return workerReady;
  console.log(`[omr_worker] spawning ${PYTHON_BIN} ${OMR_WORKER_PY}`);
  workerProc = spawn(PYTHON_BIN, [OMR_WORKER_PY], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdoutBuf = "";
  workerProc.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (line) onWorkerLine(line);
    }
  });
  workerProc.stderr.on("data", (d) => process.stderr.write(`[omr_worker] ${d}`));
  workerProc.on("error", (e) => {
    console.error("[omr_worker] spawn error:", e);
    failAll(e);
    workerProc = null;
    workerReady = null;
  });
  workerProc.on("exit", (code, signal) => {
    console.error(`[omr_worker] exited code=${code} signal=${signal}`);
    // SIGKILL with no exit code is the classic OOM-kill signature on Linux —
    // surface that explicitly so the streamed error event tells the user
    // something useful instead of a bare "worker exited code=null".
    const oomKilled = signal === "SIGKILL" && code === null;
    const msg = oomKilled
      ? "OMR worker 被系統強制終止（記憶體不足）。請改用較小的圖片或 PDF。"
      : `OMR worker 異常結束 (code=${code}${signal ? `, signal=${signal}` : ""})`;
    failAll(new Error(msg));
    workerProc = null;
    workerReady = null;
  });

  workerReady = new Promise((resolve, reject) => {
    workerReadyResolve = resolve;
    workerReadyReject = reject;
  });
  return workerReady;
}

let workerReadyResolve = null;
let workerReadyReject = null;

function onWorkerLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    process.stdout.write(`[omr_worker stdout] ${line}\n`);
    return;
  }
  if (msg.type === "ready") {
    if (workerReadyResolve) workerReadyResolve();
    return;
  }
  // every other message corresponds to the next pending request
  const next = workerQueue.shift();
  if (!next) return;
  if (msg.type === "error") {
    next.reject(new Error(msg.message + (msg.tb ? `\n${msg.tb}` : "")));
  } else if (msg.type === "done") {
    next.resolve(msg);
  } else {
    next.reject(new Error(`unexpected worker message: ${JSON.stringify(msg)}`));
  }
}

function failAll(err) {
  if (workerReadyReject) workerReadyReject(err);
  workerReadyResolve = null;
  workerReadyReject = null;
  for (const p of workerQueue) p.reject(err);
  workerQueue.length = 0;
}

async function workerExtract(imgPath, outDir) {
  await startWorker();
  return new Promise((resolve, reject) => {
    workerQueue.push({ resolve, reject });
    workerProc.stdin.write(
      JSON.stringify({
        img_path: imgPath,
        out_dir: outDir,
        without_deskew: true,
      }) + "\n"
    );
  });
}

async function workerUpscale(imgPath, outDir) {
  await startWorker();
  return new Promise((resolve, reject) => {
    workerQueue.push({ resolve, reject });
    workerProc.stdin.write(
      JSON.stringify({ type: "upscale", img_path: imgPath, out_dir: outDir }) + "\n"
    );
  });
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// Serve the built frontend if it exists (production single-port deploy).
const distDir = path.resolve(__dirname, "..", "frontend", "dist");
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB
});

// Trust the first proxy hop (Fly.io / nginx etc.) so rate-limit reads the
// real client IP from X-Forwarded-For. Safe because we only trust ONE hop.
app.set("trust proxy", 1);

// Rate-limit OMR: it's CPU-heavy (Audiveris ~30–90s per request). Without
// this a single client can pin the server. Defaults are generous; tune via
// env if abuse appears.
const omrLimiter = rateLimit({
  windowMs: Number(process.env.OMR_RATE_WINDOW_MS || 60_000),
  max: Number(process.env.OMR_RATE_MAX || 5),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "OMR 請求太頻繁，請稍等再試" },
});
app.use("/api/omr", omrLimiter);

// Rate-limit bookmark writes to make graffiti / flood inconvenient (a
// motivated attacker can rotate IPs but this kills the casual case).
const bookmarksWriteLimiter = rateLimit({
  windowMs: Number(process.env.BOOKMARKS_WRITE_WINDOW_MS || 60_000),
  max: Number(process.env.BOOKMARKS_WRITE_MAX || 10),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "雲端書籤寫入太頻繁，請稍等" },
});

// === Cloud bookmarks (shared, no auth) ===
app.get("/api/bookmarks", async (_req, res) => {
  if (!bookmarksStore.ENABLED) {
    return res.status(503).json({ error: "cloud bookmarks disabled" });
  }
  try {
    const list = await bookmarksStore.getList();
    res.json({ bookmarks: list });
  } catch (e) {
    console.error("[bookmarks] read failed:", e);
    res.status(500).json({ error: "failed to read bookmarks" });
  }
});

// PUT replaces the whole list (frontend keeps its full local copy and
// uploads everything on every change). Simple, no merge conflicts.
app.put(
  "/api/bookmarks",
  bookmarksWriteLimiter,
  express.json({ limit: "60mb" }),
  async (req, res) => {
    if (!bookmarksStore.ENABLED) {
      return res.status(503).json({ error: "cloud bookmarks disabled" });
    }
    try {
      const incoming = Array.isArray(req.body)
        ? req.body
        : Array.isArray(req.body?.bookmarks)
          ? req.body.bookmarks
          : null;
      if (!incoming) {
        return res.status(400).json({ error: "expected an array of bookmarks" });
      }
      const saved = await bookmarksStore.putList(incoming);
      res.json({ bookmarks: saved, count: saved.length });
    } catch (e) {
      console.warn("[bookmarks] write rejected:", e?.message);
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  },
);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    omr_engine: OMR_ENGINE,
    oemer_bin: OEMER_BIN,
    oemer_exists: fs.existsSync(OEMER_BIN),
    worker_alive: !!workerProc,
    audiveris_exe: AUDIVERIS_EXE,
    audiveris_available: audiverisAvailable(),
    platform: process.platform,
    pid: process.pid,
  });
});

// Pre-warm the worker at startup so the first OMR request doesn't pay the
// import cost.
startWorker().catch((e) => console.error("[omr_worker] failed to start:", e));

/**
 * Streams progress as newline-delimited JSON (NDJSON):
 *   {"type":"status","message":"..."}
 *   {"type":"start","pages":N}
 *   {"type":"page","current":i,"total":N,"phase":"start|done"}
 *   {"type":"done","musicxml":"..."}
 *   {"type":"error","message":"..."}
 */
app.post("/api/omr", upload.single("file"), async (req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  const send = (obj) => {
    res.write(JSON.stringify(obj) + "\n");
    if (typeof res.flush === "function") res.flush();
  };

  if (!req.file) {
    send({ type: "error", message: "missing 'file' field" });
    return res.end();
  }
  const original = req.file.originalname || "score";
  const ext = (path.extname(original) || ".png").toLowerCase();
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omr-"));

  try {
    send({ type: "status", message: "準備檔案…" });

    // ARCHITECTURAL RESET: when we have a PDF, feed it DIRECTLY to Audiveris
    // in a single shot. Audiveris already handles multi-page PDFs natively
    // and uses its own rendering pipeline that preserves thin features
    // (flags, dots, slurs) far better than our pdf-to-img rasterize-then-
    // upscale path. This was the upstream cause of "8th notes detected as
    // quarter" — rasterization blurred the flag away before Audiveris could
    // see it.
    const tryAudiveris = OMR_ENGINE === "audiveris" || OMR_ENGINE === "auto";
    const tryOemer = OMR_ENGINE === "oemer" || OMR_ENGINE === "auto";

    let inputPath;
    if (ext === ".pdf") {
      inputPath = path.join(tmpDir, "input.pdf");
      await fsp.writeFile(inputPath, req.file.buffer);
    } else {
      inputPath = path.join(tmpDir, `input${ext}`);
      await fsp.writeFile(inputPath, req.file.buffer);
    }

    // We still want a page count for the progress UI. For PDFs, peek at it
    // with pdf-to-img (no full rasterize, just metadata).
    let pageCount = 1;
    if (ext === ".pdf") {
      try {
        const probeDir = path.join(tmpDir, "probe");
        await fsp.mkdir(probeDir);
        const probe = await pdfToPngs(req.file.buffer, probeDir);
        pageCount = probe.length || 1;
      } catch (e) {
        console.warn("[OMR] page-count probe failed:", e.message);
      }
    }
    send({ type: "start", pages: pageCount });

    let combined;
    let engineUsed = "";
    let elapsedS;

    if (tryAudiveris && audiverisAvailable()) {
      try {
        send({
          type: "status",
          message: ext === ".pdf"
            ? `Audiveris 辨識整份 PDF（${pageCount} 頁）中…`
            : `Audiveris 辨識中…`,
        });
        // For images, run our existing upscale to give Audiveris enough resolution.
        // For PDFs, skip upscale entirely — Audiveris draws from vectors.
        let toAudi = inputPath;
        if (ext !== ".pdf") {
          try {
            const upRes = await workerUpscale(inputPath, tmpDir);
            toAudi = upRes.img_path || inputPath;
          } catch (upErr) {
            console.warn("[audiveris] upscale failed:", upErr.message);
          }
        }
        const r = await audiverisExtract(toAudi, tmpDir);
        combined = await fsp.readFile(r.xml_path, "utf8");
        elapsedS = r.elapsed_s;
        engineUsed = "audiveris";
      } catch (audiErr) {
        console.warn("[audiveris] failed:", audiErr.message);
        if (!tryOemer) throw audiErr;
      }
    }

    // Oemer fallback: rasterize per-page if PDF, single image otherwise.
    if (!combined && tryOemer) {
      const xmls = [];
      let imgs;
      if (ext === ".pdf") {
        send({ type: "status", message: "PDF 拆頁中…" });
        imgs = await pdfToPngs(req.file.buffer, tmpDir);
      } else {
        imgs = [inputPath];
      }
      for (let i = 0; i < imgs.length; i++) {
        send({
          type: "page",
          current: i + 1,
          total: imgs.length,
          phase: "start",
        });
        const pageDir = path.join(tmpDir, `oem${i}`);
        await fsp.mkdir(pageDir, { recursive: true });
        let xmlPath;
        try {
          const r = await workerExtract(imgs[i], pageDir);
          xmlPath = r.xml_path;
          elapsedS = r.elapsed_s;
        } catch (workerErr) {
          console.warn("[omr_worker] failed, falling back:", workerErr.message);
          xmlPath = await runOemer(imgs[i], pageDir);
        }
        xmls.push(await fsp.readFile(xmlPath, "utf8"));
        send({
          type: "page",
          current: i + 1,
          total: imgs.length,
          phase: "done",
          elapsed_s: elapsedS,
        });
      }
      combined = xmls.length === 1 ? xmls[0] : concatMusicXML(xmls);
      engineUsed = "oemer";
    }

    if (!combined) {
      throw new Error(`No OMR engine produced output (engine=${OMR_ENGINE})`);
    }

    console.log(
      `[omr] ${pageCount}-page input via ${engineUsed} in ${elapsedS?.toFixed(1) ?? "?"}s`
    );
    dumpDebug(`raw-combined`, combined);
    // Run the (now-disabled-by-default) measure-balance fixup as a no-op
    // unless explicitly enabled. Real corrections happen inside Audiveris now.
    const { xml: fixedXml } = fixMusicXML(combined);
    dumpDebug(`fixed-combined`, fixedXml);
    send({
      type: "page",
      current: pageCount,
      total: pageCount,
      phase: "done",
      elapsed_s: elapsedS,
    });
    send({ type: "status", message: "整合 MusicXML…" });
    send({ type: "done", musicxml: fixedXml, pages: pageCount });
  } catch (err) {
    console.error("[OMR] failed:", err);
    send({
      type: "error",
      message: String(err && err.message ? err.message : err),
      hint:
        "確認 Oemer 已安裝並在 PATH 上。Windows: pip install oemer，並把 %APPDATA%\\Python\\Python314\\Scripts 加入 PATH 或設 OEMER_BIN 環境變數。",
    });
  } finally {
    res.end();
    fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
});

/**
 * Render every page of a PDF to PNG files in `outDir`. Returns the file paths in order.
 *
 * scale=4 (~400 DPI). With CUDA + the persistent Python worker, OMR speed
 * is dominated by GPU inference, so paying for more pixels is cheap. The
 * extra resolution helps Oemer see thin features that get squeezed out at
 * lower DPI: the secondary beams on 16th-note pairs (the asymmetric
 * 8th+16th misread fixed at the model level) and small augmentation dots
 * next to noteheads (the missing-dots complaint).
 */
async function pdfToPngs(pdfBuffer, outDir) {
  const { pdf } = await import("pdf-to-img");
  const document = await pdf(pdfBuffer, { scale: 4 });
  const out = [];
  let i = 0;
  for await (const png of document) {
    const p = path.join(outDir, `page_${String(++i).padStart(3, "0")}.png`);
    await fsp.writeFile(p, png);
    out.push(p);
  }
  return out;
}

/** Stitch multiple Oemer MusicXML outputs into one score by concatenating measures. */
function concatMusicXML(xmls) {
  const first = xmls[0];
  // Find the closing </part> in the first doc; we'll inject more <measure> blocks before it.
  const partCloseIdx = first.lastIndexOf("</part>");
  if (partCloseIdx < 0) return first;
  const head = first.slice(0, partCloseIdx);
  const tail = first.slice(partCloseIdx);

  // Count measures in first doc to renumber subsequent ones.
  let measureNum = (head.match(/<measure\b/g) || []).length;

  let extra = "";
  for (let i = 1; i < xmls.length; i++) {
    const matches = xmls[i].match(/<measure\b[\s\S]*?<\/measure>/g) || [];
    for (const m of matches) {
      measureNum++;
      // Strip <attributes> from non-first-page measures so OSMD keeps the original key/clef.
      const renumbered = m.replace(/<measure\s+number="[^"]*"/, `<measure number="${measureNum}"`);
      extra += renumbered;
    }
  }
  return head + extra + tail;
}

function runOemer(inputPath, outDir) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(OEMER_BIN) && OEMER_BIN.endsWith(".exe")) {
      return reject(new Error(`找不到 oemer 執行檔：${OEMER_BIN}`));
    }
    // -d skips the deskew pass, which is unnecessary for PDF-rasterized pages
    // (already perfectly aligned). Cuts ~10–20% off per page.
    const args = ["-d", "-o", outDir, inputPath];
    const child = spawn(OEMER_BIN, args, {
      windowsHide: true,
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      process.stdout.write(`[oemer] ${d}`);
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      process.stderr.write(`[oemer] ${d}`);
    });
    child.on("error", reject);
    child.on("close", async (code) => {
      if (code !== 0) {
        return reject(
          new Error(
            `Oemer 結束碼 ${code}: ${stderr.slice(-400) || stdout.slice(-400)}`
          )
        );
      }
      // Oemer writes <basename>.musicxml into outDir
      try {
        const files = await fsp.readdir(outDir);
        const xml = files.find(
          (f) => f.toLowerCase().endsWith(".musicxml") || f.toLowerCase().endsWith(".xml")
        );
        if (!xml) {
          return reject(new Error("Oemer 未產生 MusicXML 輸出"));
        }
        resolve(path.join(outDir, xml));
      } catch (e) {
        reject(e);
      }
    });
  });
}

// Catch-all: serve index.html for SPA routes (production)
app.get(/^(?!\/api\/).*/, (_req, res, next) => {
  const idx = path.join(distDir, "index.html");
  if (fs.existsSync(idx)) return res.sendFile(idx);
  next();
});

app.listen(PORT, () => {
  console.log(`Piano Key Detector backend listening on http://localhost:${PORT}`);
  console.log(`OEMER_BIN = ${OEMER_BIN} (exists: ${fs.existsSync(OEMER_BIN)})`);
});

// Silence unused-var warning when crypto is not used elsewhere.
void crypto;

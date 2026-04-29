/**
 * Audiveris OMR adapter.
 *
 * Spawns the locally-extracted Audiveris CLI (`audiveris/Audiveris/Audiveris.exe`),
 * waits for it to write a `.mxl` (zipped MusicXML) into the per-request output
 * dir, then unzips and returns the MusicXML string.
 *
 * Audiveris needs decent image resolution — interline (gap between staff
 * lines) must be ≥ ~15 px or it bails with "No system found".  Our shared
 * upscale pass (the one used for Oemer too) already takes 80–100 DPI scans
 * up to ~300 DPI which is normally enough, so we accept the upscaled
 * filepath here without re-upscaling.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const AdmZip = require("adm-zip");

// Production deployment overrides this via $AUDIVERIS_EXE (e.g.,
// /usr/bin/Audiveris on Linux). Local Windows dev keeps the bundled extract.
const AUDIVERIS_EXE =
  process.env.AUDIVERIS_EXE ||
  path.join(__dirname, "audiveris", "Audiveris", "Audiveris.exe");

function audiverisAvailable() {
  return fs.existsSync(AUDIVERIS_EXE);
}

/**
 * Run Audiveris on the given image. Resolves with `{ xml_path, elapsed_s }`
 * just like the Oemer worker, so the calling server.js code can stay the same.
 */
async function audiverisExtract(imgPath, outDir) {
  if (!audiverisAvailable()) {
    throw new Error(`Audiveris not installed at ${AUDIVERIS_EXE}`);
  }
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const child = spawn(
      AUDIVERIS_EXE,
      ["-batch", "-transcribe", "-export", "-output", outDir, imgPath],
      { windowsHide: true },
    );
    let tail = "";
    child.stdout.on("data", (d) => {
      tail = (tail + d.toString()).slice(-2000);
      process.stdout.write(`[audiveris] ${d}`);
    });
    child.stderr.on("data", (d) => {
      tail = (tail + d.toString()).slice(-2000);
      process.stderr.write(`[audiveris] ${d}`);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Audiveris exit ${code}: ${tail.slice(-400)}`));
      } else {
        resolve();
      }
    });
  });
  const elapsed = (Date.now() - t0) / 1000;

  // Audiveris writes <basename>.mxl into outDir. Find it.
  const files = await fsp.readdir(outDir);
  const mxlFile = files.find((f) => f.toLowerCase().endsWith(".mxl"));
  if (!mxlFile) {
    throw new Error(
      `Audiveris ran but did not produce a .mxl file in ${outDir} ` +
        `(files: ${files.join(", ")}). Likely failed at GRID step — ` +
        `image resolution may still be too low.`
    );
  }
  const mxlPath = path.join(outDir, mxlFile);

  // Unzip the .mxl and find the embedded MusicXML.
  const zip = new AdmZip(mxlPath);
  const entries = zip.getEntries();
  // Look for the rootfile via container.xml
  let rootPath = null;
  const container = entries.find((e) => e.entryName === "META-INF/container.xml");
  if (container) {
    const txt = container.getData().toString("utf8");
    const m = txt.match(/full-path="([^"]+\.xml)"/);
    if (m) rootPath = m[1];
  }
  let target = rootPath
    ? entries.find((e) => e.entryName === rootPath)
    : entries.find(
        (e) => e.entryName.toLowerCase().endsWith(".xml") &&
               !e.entryName.startsWith("META-INF/")
      );
  if (!target) {
    throw new Error("No MusicXML found inside Audiveris .mxl");
  }
  const xml = target.getData().toString("utf8");

  // Write to a stable .musicxml path so caller can read it the same way as
  // Oemer's output.
  const xmlPath = path.join(outDir, "audiveris-output.musicxml");
  await fsp.writeFile(xmlPath, xml, "utf8");
  return { xml_path: xmlPath, elapsed_s: elapsed };
}

module.exports = { audiverisExtract, audiverisAvailable, AUDIVERIS_EXE };

/**
 * Server-side store for the SHARED cloud bookmark list.
 *
 * Backed by a single JSON object in a GCS bucket — there is no per-user
 * partitioning, by design.  Anyone hitting GET /api/bookmarks reads the
 * same list; anyone hitting PUT /api/bookmarks overwrites it.
 *
 * Defenses against abuse:
 *   - Strict schema validation (anything not matching the shape is rejected)
 *   - Per-bookmark size cap and total-payload cap
 *   - Per-bookmark count cap so a single PUT can't flood with thousands
 *   - Rate-limit is wired up at the route level in server.js
 *
 * Environment:
 *   BOOKMARKS_BUCKET   GCS bucket name (default "piano-key-detector-data")
 *   BOOKMARKS_OBJECT   object name inside the bucket (default "bookmarks.json")
 *   ENABLE_CLOUD_BOOKMARKS  set to "false" to disable the cloud endpoints (default on)
 */

const { Storage } = require("@google-cloud/storage");

const BUCKET_NAME = process.env.BOOKMARKS_BUCKET || "piano-key-detector-data";
const OBJECT_NAME = process.env.BOOKMARKS_OBJECT || "bookmarks.json";
const ENABLED = (process.env.ENABLE_CLOUD_BOOKMARKS ?? "true").toLowerCase() !== "false";

// Limits — chosen so a single user's library fits comfortably while a
// malicious payload can't blow up our bucket or our wallet.
const MAX_BOOKMARKS = 500;
const MAX_NAME_LEN = 80;
const MAX_XML_LEN = 1_000_000;          // ~1 MB MusicXML per bookmark
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;  // 50 MB whole list

const storage = ENABLED ? new Storage() : null;

function isValidBookmark(b) {
  if (!b || typeof b !== "object") return false;
  if (typeof b.id !== "string" || b.id.length === 0 || b.id.length > 64) return false;
  if (typeof b.name !== "string" || b.name.length === 0 || b.name.length > MAX_NAME_LEN) return false;
  if (typeof b.xml !== "string" || b.xml.length === 0 || b.xml.length > MAX_XML_LEN) return false;
  if (typeof b.savedAt !== "number" || !Number.isFinite(b.savedAt)) return false;
  return true;
}

async function getList() {
  if (!ENABLED) return [];
  try {
    const file = storage.bucket(BUCKET_NAME).file(OBJECT_NAME);
    const [buf] = await file.download();
    const txt = buf.toString("utf8");
    const parsed = JSON.parse(txt);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidBookmark);
  } catch (e) {
    if (e.code === 404 || /No such object/i.test(String(e?.message))) {
      return []; // fresh bucket, no file yet
    }
    throw e;
  }
}

async function putList(list) {
  if (!ENABLED) {
    throw new Error("Cloud bookmarks disabled (ENABLE_CLOUD_BOOKMARKS=false)");
  }
  if (!Array.isArray(list)) throw new Error("payload must be an array");
  if (list.length > MAX_BOOKMARKS) {
    throw new Error(`too many bookmarks (max ${MAX_BOOKMARKS})`);
  }
  const cleaned = [];
  for (const b of list) {
    if (!isValidBookmark(b)) {
      throw new Error("invalid bookmark in payload");
    }
    cleaned.push({
      id: b.id,
      name: b.name,
      xml: b.xml,
      savedAt: Math.floor(b.savedAt),
    });
  }
  const json = JSON.stringify(cleaned);
  if (Buffer.byteLength(json, "utf8") > MAX_TOTAL_BYTES) {
    throw new Error(`payload exceeds ${MAX_TOTAL_BYTES} bytes`);
  }
  const file = storage.bucket(BUCKET_NAME).file(OBJECT_NAME);
  await file.save(json, {
    contentType: "application/json; charset=utf-8",
    resumable: false,
  });
  return cleaned;
}

module.exports = {
  ENABLED,
  BUCKET_NAME,
  OBJECT_NAME,
  MAX_BOOKMARKS,
  MAX_NAME_LEN,
  MAX_XML_LEN,
  MAX_TOTAL_BYTES,
  getList,
  putList,
};

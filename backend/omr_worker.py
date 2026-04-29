"""
Long-lived Oemer worker.

Backend (server.js) spawns this once and keeps it alive.  For each OMR
request the backend writes one JSON line to stdin; this script writes one
JSON line back to stdout.  The first line printed at startup is
{"type":"ready"} — the backend waits for that before sending requests.

Why a worker process and not a fresh `oemer.exe` per page?
  - Python startup + onnxruntime import + first-page model load is ~10–15s.
  - For a 5-page PDF that's ~60s of pure overhead duplicated.  A persistent
    worker pays it once and reuses the loaded models for every subsequent
    page.

Request schema:
    {"img_path": "...", "out_dir": "...", "without_deskew": true}

Response (success):
    {"type":"done","xml_path":"..."}

Response (failure):
    {"type":"error","message":"...","tb":"..."}
"""

import os
import sys
import json
import time
import traceback
from argparse import Namespace

# Quiet noisy ML libs before importing them.
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")

# --- CUDA bootstrap ---
# onnxruntime-gpu does not bundle CUDA runtime DLLs; they are installed via
# the nvidia-* pip wheels. Point Windows' DLL loader at them BEFORE importing
# onnxruntime, otherwise ORT silently falls back to the CPU provider.
def _bootstrap_cuda():
    try:
        import nvidia
    except ImportError:
        return False
    nv_root = os.path.dirname(nvidia.__file__)
    bins = []
    for sub in os.listdir(nv_root):
        bin_dir = os.path.join(nv_root, sub, "bin")
        if os.path.isdir(bin_dir):
            bins.append(bin_dir)
    if not bins:
        return False
    os.environ["PATH"] = os.pathsep.join(bins) + os.pathsep + os.environ.get("PATH", "")
    if hasattr(os, "add_dll_directory"):
        for d in bins:
            try: os.add_dll_directory(d)
            except OSError: pass
    return True

_CUDA_BOOTSTRAPPED = _bootstrap_cuda()

import logging
logging.basicConfig(level=logging.WARNING)
logging.getLogger("oemer").setLevel(logging.WARNING)


def patch_oemer_rhythm():
    """
    Monkey-patch oemer.rhythm_extraction.parse_rhythm to fix asymmetric
    rhythm classification within beamed groups.

    Background: Oemer scans the beam stack ONCE per beam-group and gets a
    single beam-count, but at line ~604 it only assigns the resulting label
    to notes whose label is currently None.  Any note that picked up a
    pre-label earlier in the pipeline (e.g., one of two beamed sixteenths
    classified as EIGHTH from a partial flag detection) keeps that prior
    label, producing the asymmetric "8th + 16th" we see in 2-note 16th
    pairs in real scores.

    The fix: after the original parse_rhythm runs, walk every note-group
    that has beams, find the highest-beam-count label seen on any note in
    the group (excluding hollow notes which can't be beamed), and force
    every other beamable note in that group to use the same label.  In
    practice this turns "8th + 16th" into "16th + 16th" or "8th + 8th"
    consistently — whichever has more pixel evidence.
    """
    try:
        from oemer import rhythm_extraction
        from oemer import layers
        from oemer.notehead_extraction import NoteType
    except Exception as e:
        sys.stderr.write(f"[omr_worker] patch import failed: {e}\n")
        return

    # Order from longest -> shortest. Higher index = more beams = shorter.
    BEAM_ORDER = [
        NoteType.WHOLE,
        NoteType.HALF,
        NoteType.QUARTER,
        NoteType.EIGHTH,
        NoteType.SIXTEENTH,
        NoteType.THIRTY_SECOND,
        NoteType.SIXTY_FOURTH,
    ]
    HOLLOW = {NoteType.WHOLE, NoteType.HALF, NoteType.HALF_OR_WHOLE}

    orig_parse_rhythm = rhythm_extraction.parse_rhythm

    def patched(beam_map, map_info, agree_th=0.15):
        result = orig_parse_rhythm(beam_map, map_info, agree_th)
        try:
            groups = layers.get_layer("note_groups")
            notes = layers.get_layer("notes")
        except Exception as e:
            sys.stderr.write(f"[omr_worker] patch: layer lookup failed: {e}\n")
            return result

        rev_map_info = {}
        for reg, info in map_info.items():
            for gid in info.get("gids", []):
                rev_map_info[gid] = info

        # ==== Pass A: within-group unification ====
        unified_in_group = 0
        for gid in range(len(groups)):
            if gid not in rev_map_info:
                continue
            group = groups[gid]
            note_ids = list(group.note_ids)
            labels = [notes[nid].label for nid in note_ids
                      if notes[nid].label is not None and notes[nid].label not in HOLLOW]
            if len(set(labels)) < 2:
                continue
            best_idx = max(
                (BEAM_ORDER.index(l) for l in labels if l in BEAM_ORDER),
                default=-1,
            )
            if best_idx < 0:
                continue
            target = BEAM_ORDER[best_idx]
            for nid in note_ids:
                lbl = notes[nid].label
                if lbl is None or lbl in HOLLOW or lbl == target:
                    continue
                notes[nid].force_set_label(target)
                unified_in_group += 1

        # ==== Diagnostic: count what we see ====
        diag = {"total": 0, "with_bbox": 0, "with_label": 0, "with_stem": 0,
                "eighths": 0, "sixteenths": 0}
        for n in notes:
            if n is None:
                continue
            diag["total"] += 1
            bbox = getattr(n, "bbox", None)
            if bbox is not None:
                diag["with_bbox"] += 1
            if getattr(n, "label", None) is not None:
                diag["with_label"] += 1
            if getattr(n, "stem_up", None) is not None:
                diag["with_stem"] += 1
            if n.label == NoteType.EIGHTH:
                diag["eighths"] += 1
            elif n.label == NoteType.SIXTEENTH:
                diag["sixteenths"] += 1
        sys.stderr.write(f"[omr_worker] note diag: {diag}\n")
        sys.stderr.flush()

        # ==== Pass B: cross-group neighbour unification ====
        # Oemer's note_group_extraction often *splits* a 2-note 16th beam
        # pair into two singleton groups (one note each).  Pass A can't help
        # because each group has only one label.  This pass walks notes
        # ordered by x-position and unifies adjacent EIGHTH/SIXTEENTH pairs
        # that look beamed-together: same staff, stems same direction,
        # horizontally close.  Same-pitch repeats with this duration
        # ratio are nearly always rapid 16th figures, not 8th-tied-to-16th.
        cross_unified = 0
        try:
            # Build one note record per visible note with its bbox + staff.
            raw = []
            for n in notes:
                if n is None:
                    continue
                if getattr(n, "invalid", False):
                    continue
                bbox = getattr(n, "bbox", None)
                if bbox is None:
                    continue
                try:
                    x1, y1, x2, y2 = int(bbox[0]), int(bbox[1]), int(bbox[2]), int(bbox[3])
                except Exception:
                    continue
                raw.append((x1, y1, x2, y2, n))

            # Cluster by Y into staff-rows. We look at note y-centers; gaps
            # bigger than ~3 noteheads vertically separate two staff rows.
            heights = sorted([r[3] - r[1] for r in raw if r[3] > r[1]])
            avg_h = heights[len(heights) // 2] if heights else 12
            row_gap_thresh = max(40, avg_h * 4)

            # Sort all notes by y-center, then split into rows where successive
            # y-centers differ by more than row_gap_thresh.
            by_y = sorted(raw, key=lambda r: (r[1] + r[3]) / 2)
            rows = []
            cur_row = []
            last_yc = None
            for r in by_y:
                yc = (r[1] + r[3]) / 2
                if last_yc is None or yc - last_yc <= row_gap_thresh:
                    cur_row.append(r)
                else:
                    if cur_row:
                        rows.append(cur_row)
                    cur_row = [r]
                last_yc = yc
            if cur_row:
                rows.append(cur_row)

            # Sort each row by x and stitch into a flat sequence where the
            # row index acts as the "staff" group key.
            recs = []
            for row_idx, row in enumerate(rows):
                row.sort(key=lambda r: r[0])
                for r in row:
                    recs.append((r[0], r[1], r[2], r[3], r[4], row_idx))

            sys.stderr.write(
                f"[omr_worker] clustered into {len(rows)} rows; row sizes: "
                f"{[len(r) for r in rows]}\n"
            )

            widths = [r[2] - r[0] for r in recs if r[2] > r[0]]
            if widths:
                widths.sort()
                med_w = widths[len(widths) // 2]
                near_threshold = max(2.0, med_w * 3.0)
            else:
                near_threshold = 60

            reject = {"label_none": 0, "hollow": 0, "wrong_pair": 0,
                      "dotted": 0, "stem": 0, "h_gap": 0, "v_gap": 0,
                      "considered": 0}
            for i in range(len(recs) - 1):
                a = recs[i][4]
                b = recs[i + 1][4]
                # Must be in the same Y-clustered row.
                if recs[i][5] != recs[i + 1][5]:
                    continue
                la = a.label
                lb = b.label
                if la is None or lb is None:
                    reject["label_none"] += 1
                    continue
                if la in HOLLOW or lb in HOLLOW:
                    reject["hollow"] += 1
                    continue
                pair = {la, lb}
                if pair not in (
                    {NoteType.EIGHTH, NoteType.SIXTEENTH},
                    {NoteType.SIXTEENTH, NoteType.THIRTY_SECOND},
                ):
                    reject["wrong_pair"] += 1
                    continue
                # Got an 8th+16th candidate — log what we see so we can tell
                # WHICH filter (if any) is rejecting it.
                cand = (la.name, lb.name, a.stem_up, b.stem_up,
                        getattr(a, "has_dot", False), getattr(b, "has_dot", False))
                gap = recs[i + 1][0] - recs[i][2]
                ya = (recs[i][1] + recs[i][3]) / 2
                yb = (recs[i + 1][1] + recs[i + 1][3]) / 2
                heights = [r[3] - r[1] for r in (recs[i], recs[i + 1])]
                avg_h = sum(heights) / 2 or 10
                sys.stderr.write(f"[omr_worker] candidate: {cand} gap={gap} v={abs(ya-yb):.1f} avg_h={avg_h:.1f}\n")
                if getattr(a, "has_dot", False) or getattr(b, "has_dot", False):
                    reject["dotted"] += 1
                    continue
                if a.stem_up is None or b.stem_up is None or a.stem_up != b.stem_up:
                    reject["stem"] += 1
                    continue
                if gap > near_threshold:
                    reject["h_gap"] += 1
                    continue
                if abs(ya - yb) > avg_h * 8:
                    reject["v_gap"] += 1
                    continue
                reject["considered"] += 1
                shorter = la if BEAM_ORDER.index(la) > BEAM_ORDER.index(lb) else lb
                if la != shorter:
                    a.force_set_label(shorter)
                    cross_unified += 1
                if lb != shorter:
                    b.force_set_label(shorter)
                    cross_unified += 1
            sys.stderr.write(f"[omr_worker] cross-group rejection breakdown: {reject}\n")
        except Exception as e:
            sys.stderr.write(f"[omr_worker] cross-group pass failed: {e}\n")

        if unified_in_group or cross_unified:
            sys.stderr.write(
                f"[omr_worker] beam fixup: in-group={unified_in_group} cross-group={cross_unified}\n"
            )
            sys.stderr.flush()
        return result

    rhythm_extraction.parse_rhythm = patched
    sys.stderr.write("[omr_worker] patched oemer.rhythm_extraction.parse_rhythm\n")
    sys.stderr.flush()


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def upscale_if_needed(src_path, out_dir, target_px=2400):
    """Oemer was trained on roughly 200–300 DPI scans. Sub-1500-px wide
    images leave dots and secondary beams as 2-3 pixel blobs which the
    model can't see. Upscale to target_px wide using Lanczos so fine
    features get enough pixels to classify reliably."""
    try:
        from PIL import Image
    except Exception:
        return src_path
    try:
        img = Image.open(src_path)
        w, h = img.size
        if w >= target_px:
            return src_path
        scale = target_px / w
        new_w = int(w * scale)
        new_h = int(h * scale)
        upscaled = img.resize((new_w, new_h), Image.LANCZOS)
        ext = os.path.splitext(src_path)[1].lower() or ".png"
        if ext in (".jpg", ".jpeg"):
            ext = ".png"  # avoid double JPEG quality loss
        new_path = os.path.join(out_dir, f"upscaled_{w}_{new_w}{ext}")
        upscaled.save(new_path)
        sys.stderr.write(f"[omr_worker] upscaled {w}x{h} -> {new_w}x{new_h}\n")
        sys.stderr.flush()
        return new_path
    except Exception as e:
        sys.stderr.write(f"[omr_worker] upscale failed: {e}\n")
        return src_path


def handle(req, ete):
    img_path = upscale_if_needed(req["img_path"], req["out_dir"])
    args = Namespace(
        img_path=img_path,
        output_path=req["out_dir"],
        use_tf=bool(req.get("use_tf", False)),
        save_cache=False,
        without_deskew=bool(req.get("without_deskew", True)),
    )
    t0 = time.perf_counter()
    out_path = ete.extract(args)
    elapsed = time.perf_counter() - t0
    # Reset the global layer registry so the next page starts clean.
    ete.clear_data()
    sys.stderr.write(f"[omr_worker] page took {elapsed:.1f}s ({req['img_path']})\n")
    sys.stderr.flush()
    return {"type": "done", "xml_path": str(out_path), "elapsed_s": elapsed}


def main():
    # Importing oemer.ete eagerly so the first request doesn't pay the cost.
    from oemer import ete
    patch_oemer_rhythm()
    # Probe which onnxruntime provider actually loaded (CUDA vs CPU only).
    try:
        import onnxruntime as rt
        from oemer import MODULE_PATH
        import glob
        onx_files = glob.glob(os.path.join(MODULE_PATH, "checkpoints", "**", "model.onnx"), recursive=True)
        if onx_files:
            providers = [("CUDAExecutionProvider", {"device_id": 0}), "CPUExecutionProvider"] if _CUDA_BOOTSTRAPPED else ["CPUExecutionProvider"]
            try:
                sess = rt.InferenceSession(onx_files[0], providers=providers)
                actual = sess.get_providers()
                sys.stderr.write(f"[omr_worker] onnxruntime providers: {actual}\n")
            except Exception as e:
                sys.stderr.write(f"[omr_worker] provider probe failed: {e}\n")
        sys.stderr.flush()
    except Exception as e:
        sys.stderr.write(f"[omr_worker] provider probe error: {e}\n")
    emit({"type": "ready"})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            emit({"type": "error", "message": f"bad json: {e}"})
            continue

        if req.get("type") == "ping":
            emit({"type": "pong"})
            continue

        if req.get("type") == "upscale":
            # Pure-upscale request: do not call Oemer. Used by the Audiveris
            # path so it gets the same high-res input.
            try:
                out = upscale_if_needed(req["img_path"], req["out_dir"])
                emit({"type": "done", "img_path": out})
            except Exception as e:
                emit({"type": "error", "message": str(e), "tb": traceback.format_exc()})
            continue

        try:
            emit(handle(req, ete))
        except Exception as e:
            emit({
                "type": "error",
                "message": str(e),
                "tb": traceback.format_exc(),
            })


if __name__ == "__main__":
    main()

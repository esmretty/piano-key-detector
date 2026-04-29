/**
 * Best-effort post-processor for Oemer MusicXML output.
 *
 * Two passes:
 *   1) Per-MEASURE: voice-1 total != expected → search for adjacent 2:1
 *      duration pairs and halve/double them until the measure balances.
 *   2) Per-BEAT: walk notes and accumulate into beat-sized buckets. If a
 *      bucket crosses the beat boundary asymmetrically (e.g. 8+16 = 3 divs
 *      where 4 was expected, plus more notes pushing past), try halving the
 *      odd-one-out 8th to make the beat total clean.
 *
 * Both passes only act on 2:1 neighbour ratios so they can never invent
 * tuplets or crazy durations out of nowhere.
 *
 * Returns { xml, stats } so the caller can log how much was changed.
 */

const fs = require("fs");
const path = require("path");

const TYPE_BY_DIVS = (divisions) => (d) => {
  const q = divisions; // 1 quarter
  if (d >= q * 4) return "whole";
  if (d >= q * 2) return "half";
  if (d >= q) return "quarter";
  if (d >= q / 2) return "eighth";
  if (d >= q / 4) return "16th";
  if (d >= q / 8) return "32nd";
  return "64th";
};

function fixMusicXML(xml, opts = {}) {
  const stats = {
    measuresChecked: 0,
    measuresFixed: 0,
    halved: 0,
    doubled: 0,
    perBeatFixed: 0,
    expected: null,
    divisions: null,
  };

  // The XML-level fixup has been disabled: it didn't honor <backup> elements
  // so on Oemer's grand-staff output (which uses backup/forward heavily) it
  // saw the linear sum-of-durations as ~2x the expected and aggressively
  // halved legitimate notes. Real beam-group fixing now happens in the
  // Python omr_worker via a monkey-patch on parse_rhythm (uses pixel
  // positions and stem directions, much more robust). Left in place as a
  // skeleton for the eventual backup-aware version.
  if (!opts.enabled) {
    return { xml, stats };
  }

  const divMatch = xml.match(/<divisions>(\d+)<\/divisions>/);
  if (!divMatch) {
    return { xml, stats };
  }
  // Oemer doesn't always emit <time>; fall back to 4/4 (the dominant case for
  // popular piano sheets). If you load a 3/4 or 6/8 piece this fallback is
  // wrong but the monkey-patched parse_rhythm already does the heavy lifting.
  const beatsMatch = xml.match(/<beats>(\d+)<\/beats>/);
  const beatTypeMatch = xml.match(/<beat-type>(\d+)<\/beat-type>/);
  const divisions = parseInt(divMatch[1], 10);
  const beats = beatsMatch ? parseInt(beatsMatch[1], 10) : 4;
  const beatType = beatTypeMatch ? parseInt(beatTypeMatch[1], 10) : 4;
  const expected = (beats * divisions * 4) / beatType;
  stats.expected = expected;
  stats.divisions = divisions;
  const typeFor = TYPE_BY_DIVS(divisions);

  const out = xml.replace(/<measure\b[^>]*>[\s\S]*?<\/measure>/g, (measureXml) => {
    stats.measuresChecked++;

    // Pass 1: per-measure balance
    let { xml: pass1, halved, doubled } = balanceMeasureTotal(measureXml, expected, typeFor);

    // Pass 2: per-beat balance (catches symmetric-measure-but-wrong-beat cases)
    const pass2 = balancePerBeat(pass1, divisions, typeFor);
    stats.perBeatFixed += pass2.beatFixes;

    if (halved + doubled + pass2.beatFixes > 0) {
      stats.measuresFixed++;
      stats.halved += halved + pass2.halved;
      stats.doubled += doubled + pass2.doubled;
      if (opts.verbose) {
        const num = (measureXml.match(/<measure\s+number="(\d+)"/) || [, "?"])[1];
        console.log(
          `[fixup] measure ${num}: halved=${halved + pass2.halved} doubled=${doubled + pass2.doubled} beatFixes=${pass2.beatFixes}`
        );
      }
    }
    return pass2.xml;
  });

  return { xml: out, stats };
}

// --- helpers --------------------------------------------------------------

function parseVoice1Notes(measureXml) {
  const noteRe = /<note\b[^>]*>[\s\S]*?<\/note>/g;
  const out = [];
  let m;
  while ((m = noteRe.exec(measureXml)) !== null) {
    const xml = m[0];
    if (/<chord\s*\/>/.test(xml)) continue;
    const voiceMatch = xml.match(/<voice>(\d+)<\/voice>/);
    const voice = voiceMatch ? voiceMatch[1] : "1";
    if (voice !== "1") continue;
    const dur = parseInt((xml.match(/<duration>(\d+)<\/duration>/) || [, "0"])[1], 10);
    if (!dur) continue;
    out.push({
      idx: m.index,
      end: m.index + xml.length,
      xml,
      dur,
      hasDot: /<dot\s*\/>/.test(xml),
      isRest: /<rest\b/.test(xml),
      stemUp: /<stem>up<\/stem>/.test(xml),
      stemDown: /<stem>down<\/stem>/.test(xml),
    });
  }
  return out;
}

function rewriteNote(noteXml, newDur, typeFor) {
  let updated = noteXml.replace(
    /<duration>\d+<\/duration>/,
    `<duration>${newDur}</duration>`,
  );
  updated = updated.replace(/<type>[^<]+<\/type>/, `<type>${typeFor(newDur)}</type>`);
  return updated;
}

function applyReplacements(xml, replacements) {
  let out = xml;
  for (const r of replacements) {
    const i = out.indexOf(r.from);
    if (i >= 0) out = out.slice(0, i) + r.to + out.slice(i + r.from.length);
  }
  return out;
}

// --- pass 1: per-measure balance ------------------------------------------

function balanceMeasureTotal(measureXml, expected, typeFor) {
  const v1 = parseVoice1Notes(measureXml);
  let cur = v1.reduce((s, n) => s + n.dur, 0);
  if (cur === expected || v1.length < 2) {
    return { xml: measureXml, halved: 0, doubled: 0 };
  }
  let halved = 0;
  let doubled = 0;
  const touched = new Set();

  for (let pass = 0; pass < 8 && cur !== expected; pass++) {
    let bestKind = null;
    let bestIdx = -1;
    let bestNewDur = -1;
    let bestNewTotal = cur;

    for (let i = 0; i < v1.length; i++) {
      const a = v1[i];
      if (touched.has(i) || a.hasDot || a.isRest) continue;
      const left = i > 0 ? v1[i - 1] : null;
      const right = i < v1.length - 1 ? v1[i + 1] : null;

      if (cur > expected) {
        const okLeft = left && a.dur === 2 * left.dur && left.dur >= 1;
        const okRight = right && a.dur === 2 * right.dur && right.dur >= 1;
        if (!(okLeft || okRight)) continue;
        const newDur = a.dur / 2;
        if (!Number.isInteger(newDur) || newDur < 1) continue;
        const newTotal = cur - newDur;
        if (newTotal < expected) continue;
        if (newTotal < bestNewTotal || bestIdx < 0) {
          bestKind = "halve";
          bestIdx = i;
          bestNewDur = newDur;
          bestNewTotal = newTotal;
        }
      } else {
        const okLeft = left && 2 * a.dur === left.dur;
        const okRight = right && 2 * a.dur === right.dur;
        if (!(okLeft || okRight)) continue;
        const newDur = a.dur * 2;
        const newTotal = cur + a.dur;
        if (newTotal > expected) continue;
        if (newTotal > bestNewTotal || bestIdx < 0) {
          bestKind = "double";
          bestIdx = i;
          bestNewDur = newDur;
          bestNewTotal = newTotal;
        }
      }
    }
    if (bestIdx < 0) break;
    v1[bestIdx].dur = bestNewDur;
    cur = bestNewTotal;
    touched.add(bestIdx);
    if (bestKind === "halve") halved++;
    else doubled++;
  }

  if (halved === 0 && doubled === 0) {
    return { xml: measureXml, halved: 0, doubled: 0 };
  }

  const replacements = [];
  for (let k = 0; k < v1.length; k++) {
    if (!touched.has(k)) continue;
    replacements.push({ from: v1[k].xml, to: rewriteNote(v1[k].xml, v1[k].dur, typeFor) });
  }
  return { xml: applyReplacements(measureXml, replacements), halved, doubled };
}

// --- pass 2: per-beat balance ---------------------------------------------

function balancePerBeat(measureXml, divisions, typeFor) {
  const beatTarget = divisions; // one quarter beat = `divisions` divs
  const v1 = parseVoice1Notes(measureXml);
  if (v1.length < 2) return { xml: measureXml, halved: 0, doubled: 0, beatFixes: 0 };

  let halved = 0, doubled = 0, beatFixes = 0;
  const touched = new Set();

  // Walk notes, accumulating into beats. Whenever a note crosses a beat
  // boundary AND total > beatTarget for current beat, try to halve a 2:1
  // suspect *within this beat* to bring the beat to exactly 1 quarter.
  let beatStart = 0;     // index in v1 where current beat started
  let cur = 0;           // running sum within current beat
  for (let i = 0; i < v1.length; i++) {
    const n = v1[i];
    if (touched.has(i) || n.hasDot || n.isRest) {
      cur += n.dur;
      if (cur >= beatTarget) {
        cur -= beatTarget;
        if (cur === 0) beatStart = i + 1;
      }
      continue;
    }
    const newCur = cur + n.dur;
    if (newCur === beatTarget) {
      cur = 0;
      beatStart = i + 1;
      continue;
    }
    if (newCur < beatTarget) {
      cur = newCur;
      continue;
    }
    // Overshoot. Look for a 2:1 pair within [beatStart..i] (inclusive)
    // where halving the longer would make this beat total exactly beatTarget.
    const overshoot = newCur - beatTarget;
    let fixedHere = false;
    for (let j = beatStart; j <= i && !fixedHere; j++) {
      if (touched.has(j) || v1[j].hasDot || v1[j].isRest) continue;
      const a = v1[j];
      const left = j > 0 ? v1[j - 1] : null;
      const right = j < v1.length - 1 ? v1[j + 1] : null;
      // 2:1 ratio with a neighbor and halving fixes overshoot
      if (
        a.dur >= 2 &&
        Number.isInteger(a.dur / 2) &&
        a.dur / 2 === overshoot &&
        ((left && a.dur === 2 * left.dur) || (right && a.dur === 2 * right.dur))
      ) {
        a.dur = a.dur / 2;
        touched.add(j);
        halved++;
        beatFixes++;
        fixedHere = true;
        // Recompute cur for current beat from scratch
        cur = 0;
        for (let k = beatStart; k <= i; k++) cur += v1[k].dur;
        if (cur === beatTarget) {
          cur = 0;
          beatStart = i + 1;
        }
        // (cur might still differ — we'll let next iteration handle it)
      }
    }
    if (!fixedHere) {
      // Can't fix — accept the overshoot, advance beat.
      cur = newCur - beatTarget;
      beatStart = i + 1;
    }
  }

  if (halved === 0 && doubled === 0) {
    return { xml: measureXml, halved: 0, doubled: 0, beatFixes: 0 };
  }
  const replacements = [];
  for (let k = 0; k < v1.length; k++) {
    if (!touched.has(k)) continue;
    replacements.push({ from: v1[k].xml, to: rewriteNote(v1[k].xml, v1[k].dur, typeFor) });
  }
  return {
    xml: applyReplacements(measureXml, replacements),
    halved,
    doubled,
    beatFixes,
  };
}

// --- debug dump -----------------------------------------------------------

const DEBUG_DIR = path.join(__dirname, "debug");

function dumpDebug(label, content) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(path.join(DEBUG_DIR, `${ts}-${label}.musicxml`), content);
  } catch (e) {
    console.error("[fixup] dump failed:", e.message);
  }
}

module.exports = { fixMusicXML, dumpDebug };

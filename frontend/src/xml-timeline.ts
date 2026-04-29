/**
 * Build a playback timeline directly from MusicXML, bypassing OSMD's
 * Note.Length API.  Honors <backup>, <forward>, per-voice cursors, chord
 * stacking, time-modification (tuplets), and dotted notes.
 *
 * Returns a flat list of (timeSec, midi, durationSec) ordered by onset,
 * grouped by simultaneous-onset into "steps" that align with how OSMD's
 * cursor advances, so the existing player code can consume it unchanged.
 */

import type { CursorStep } from "./types";

interface XmlNote {
  /** Absolute onset in seconds. */
  time: number;
  /** Sounding duration in seconds. */
  durationSec: number;
  /** MIDI pitch number. */
  midi: number;
  voiceKey: string;
  staff: number;
  measureIdx: number;
  /** Set when the note is part of a <time-modification> group, recording
   *  the (actual, normal) ratio so we can attempt to un-tupletize the
   *  group later if the measure totals say Audiveris was wrong. */
  tupletActual?: number;
  tupletNormal?: number;
  /** Position within the current measure in DIVISIONS — used by the
   *  measure-balance pass below. */
  onsetDiv: number;
  durDiv: number;
  divisions: number;
  expectedMeasureDiv: number;
  /** Convenience flags */
  isForwardStartContinuation: boolean;
}

const STEP_SEMITONES: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

export function buildXmlTimeline(xml: string, bpm: number): CursorStep[] {
  const dom = new DOMParser().parseFromString(xml, "application/xml");
  const parseError = dom.querySelector("parsererror");
  if (parseError) {
    console.warn("[xml-timeline] XML parse error", parseError.textContent);
    return [];
  }
  const part = dom.querySelector("part");
  if (!part) return [];

  const secondsPerQuarter = 60 / bpm;
  const allNotes: XmlNote[] = [];

  let divisions = 4; // updates if <divisions> appears
  let beats = 4; // numerator of <time>
  let beatType = 4; // denominator
  let measureStartSec = 0;
  /** Per-measure max cursor (incl. rests) — used by the trailing-note
   *  extender below. */
  const measureMaxByMeasureIdx = new Map<number, number>();
  /** Per-(measureIdx, voice) max cursor for that voice WITHIN the measure;
   *  if the voice's last note end matches its cursor, no rest follows it
   *  (so we can safely extend). */
  const voiceCursorByMeasureVoice = new Map<string, number>();

  const measures = part.querySelectorAll("measure");
  measures.forEach((measure, mIdx) => {
    // Per-voice cursor in DIVISIONS within this measure.  MusicXML semantics:
    // <backup>/<forward> change the GLOBAL cursor for whichever voice is
    // currently "active" (i.e., they sit between voice tracks). We track a
    // single cursor and reset it via backup/forward; voice IDs come from
    // each note's <voice>.
    let cursorDiv = 0;
    let prevNoteOnsetDiv = 0;
    let measureMaxDiv = 0;
    /** Max end-cursor of any NON-REST note in this measure. Used to decide
     *  the measure's effective length for advancing measureStartSec.  Pure-
     *  rest voices that extend beyond the actual music (e.g., a half-rest
     *  in the bass clef during a 1.75-beat pickup) shouldn't push the next
     *  measure's start time later than necessary — that creates a phantom
     *  silence gap before the next measure. */
    let measureNoteMaxDiv = 0;
    /** Per-voice flag: did we see a <forward> immediately before this voice's
     *  first note? Tracks "Audiveris voice continuation" pattern. */
    let pendingForwardForVoice: string | null = null;
    const voiceFirstNoteSeen = new Set<string>();

    for (const child of Array.from(measure.children)) {
      const tag = child.tagName;
      if (tag === "attributes") {
        const div = child.querySelector("divisions");
        if (div?.textContent) divisions = parseInt(div.textContent, 10) || divisions;
        const time = child.querySelector("time");
        if (time) {
          const b = time.querySelector("beats");
          const bt = time.querySelector("beat-type");
          if (b?.textContent) beats = parseInt(b.textContent, 10) || beats;
          if (bt?.textContent) beatType = parseInt(bt.textContent, 10) || beatType;
        }
        continue;
      }
      if (tag === "backup") {
        const d = parseInt(child.querySelector("duration")?.textContent ?? "0", 10);
        cursorDiv = Math.max(0, cursorDiv - d);
        // After a backup, the *next* voice's note may be at @0 (a clean
        // voice start) or after a forward (a continuation mid-measure).
        pendingForwardForVoice = null;
        continue;
      }
      if (tag === "forward") {
        const d = parseInt(child.querySelector("duration")?.textContent ?? "0", 10);
        cursorDiv += d;
        // Mark "the next voice we encounter has a forward-prefixed start".
        // We don't know which voice yet — record as a sentinel; the next
        // <note> will resolve it.
        pendingForwardForVoice = "_PENDING_";
        continue;
      }
      if (tag !== "note") continue;

      const isChord = child.querySelector("chord") !== null;
      const isRest = child.querySelector("rest") !== null;
      const dur = parseInt(child.querySelector("duration")?.textContent ?? "0", 10);
      const voice = child.querySelector("voice")?.textContent ?? "1";
      const staff = parseInt(child.querySelector("staff")?.textContent ?? "1", 10);

      const onsetDiv = isChord ? prevNoteOnsetDiv : cursorDiv;
      if (!isChord) prevNoteOnsetDiv = cursorDiv;

      // Resolve the pending forward to this voice (if first note of voice).
      const isForwardStart =
        !isChord &&
        pendingForwardForVoice === "_PENDING_" &&
        !voiceFirstNoteSeen.has(voice);
      if (!isChord) {
        voiceFirstNoteSeen.add(voice);
        pendingForwardForVoice = null;
      }

      if (!isRest) {
        const pitch = child.querySelector("pitch");
        if (pitch) {
          const step = pitch.querySelector("step")?.textContent ?? "C";
          const octave = parseInt(pitch.querySelector("octave")?.textContent ?? "4", 10);
          const alter = parseInt(pitch.querySelector("alter")?.textContent ?? "0", 10);
          const semis = STEP_SEMITONES[step] ?? 0;
          const midi = (octave + 1) * 12 + semis + alter;

          // <time-modification><actual-notes>N</actual-notes><normal-notes>M</normal-notes></>
          const tm = child.querySelector("time-modification");
          let tActual: number | undefined;
          let tNormal: number | undefined;
          if (tm) {
            const a = parseInt(tm.querySelector("actual-notes")?.textContent ?? "0", 10);
            const n = parseInt(tm.querySelector("normal-notes")?.textContent ?? "0", 10);
            if (a > 0 && n > 0) {
              tActual = a;
              tNormal = n;
            }
          }

          const onsetQuarters = onsetDiv / divisions;
          const durQuarters = dur / divisions;
          const expectedMDiv = (beats * divisions * 4) / beatType;
          allNotes.push({
            time: measureStartSec + onsetQuarters * secondsPerQuarter,
            durationSec: durQuarters * secondsPerQuarter,
            midi,
            voiceKey: voice,
            staff,
            measureIdx: mIdx,
            tupletActual: tActual,
            tupletNormal: tNormal,
            onsetDiv,
            durDiv: dur,
            divisions,
            expectedMeasureDiv: expectedMDiv,
            isForwardStartContinuation: isForwardStart,
          });
        }
      }

      if (!isChord) {
        cursorDiv += dur;
        if (cursorDiv > measureMaxDiv) measureMaxDiv = cursorDiv;
        if (!isRest && cursorDiv > measureNoteMaxDiv) {
          measureNoteMaxDiv = cursorDiv;
        }
        // Track per-voice cursor — used by the trailing-extension pass to
        // detect "rest after last note" cases (where we should NOT extend).
        const key = `${mIdx}|${voice}`;
        const prev = voiceCursorByMeasureVoice.get(key) ?? 0;
        if (cursorDiv > prev) voiceCursorByMeasureVoice.set(key, cursorDiv);
      }
    }

    // Advance global measure-start time by the largest cursor reached in
    // this measure (covers measures with backup/forward — all voices end at
    // the same spot in well-formed MusicXML). MUST match OSMD's view of
    // measure length so cursor visual positions align with audio timing.
    const fullMax = Math.max(measureMaxDiv, cursorDiv);
    measureMaxByMeasureIdx.set(mIdx, fullMax);
    const maxQuarters = fullMax / divisions;
    measureStartSec += maxQuarters * secondsPerQuarter;
  });

  // ==== Extend trailing note to fill phantom-rest gaps ====
  // When a voice's last note ends earlier than the measure boundary AND
  // the same voice has no rest after that note (meaning the gap is implicit,
  // not an explicit rest), extend the note's playing duration to fill the
  // gap. Audibly, the note rings into what would otherwise be silence; the
  // note's WRITTEN type/duration in the XML is unchanged so OSMD draws it
  // at the original size and the cursor still lines up.
  let extendedNotes = 0;
  const byMeasureForExt = new Map<number, XmlNote[]>();
  for (const n of allNotes) {
    const arr = byMeasureForExt.get(n.measureIdx) ?? [];
    arr.push(n);
    byMeasureForExt.set(n.measureIdx, arr);
  }
  for (const [mIdx, mNotes] of byMeasureForExt) {
    const measureEndDiv = measureMaxByMeasureIdx.get(mIdx) ?? 0;
    if (measureEndDiv === 0) continue;
    // Group by voice and find each voice's LAST note.
    const byVoice = new Map<string, XmlNote[]>();
    for (const n of mNotes) {
      const arr = byVoice.get(n.voiceKey) ?? [];
      arr.push(n);
      byVoice.set(n.voiceKey, arr);
    }
    for (const [, voiceNotes] of byVoice) {
      voiceNotes.sort((a, b) => a.onsetDiv - b.onsetDiv);
      const last = voiceNotes[voiceNotes.length - 1];
      const lastEnd = last.onsetDiv + last.durDiv;
      const lastVoiceCursor = voiceCursorByMeasureVoice.get(`${mIdx}|${last.voiceKey}`) ?? lastEnd;
      // Only extend when: (a) note ends before measure boundary AND (b) the
      // voice has no rest sitting after this note (cursor wouldn't have
      // advanced past lastEnd without rests).
      if (lastEnd < measureEndDiv && lastVoiceCursor === lastEnd) {
        const div = last.divisions;
        const newDur = measureEndDiv - last.onsetDiv;
        last.durDiv = newDur;
        last.durationSec = (newDur / div) * secondsPerQuarter;
        extendedNotes++;
      }
    }
  }
  if (extendedNotes > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[xml-timeline] extended ${extendedNotes} note(s) to fill phantom-rest gaps`
    );
  }

  // ---- Same-staff multi-voice "stitch" pass ----
  // Audiveris (and other OMR engines) sometimes split a single melodic line
  // on one staff into TWO voices when adjacent stems happen to overlap
  // visually — voice 1 gets a "long" note covering the whole span, voice 2
  // gets a separate note that starts mid-way through it. Playback-wise this
  // makes the long note ring 2× longer than intended. Fix: if any other
  // note on the SAME STAFF starts strictly inside this note's window, cap
  // this note's duration to that next-onset.  This conservatively shortens
  // mislabeled long notes to match what the listener expects (the perceived
  // melodic line ending where the "next" note begins).
  // (No stitch heuristic needed — feeding the PDF directly to Audiveris
  // produces clean voice 1 transcripts. The previous voice-split / forward-
  // start work-around was compensating for rasterization blur, not a real
  // OMR limitation.)

  // ==== Measure-balance pass: un-tupletize wrong tuplets ====
  // Audiveris occasionally tags a run of normal 16th-notes as a sextuplet
  // (time-modification 6:4) when their visual spacing happens to be
  // compressed. The notes then play 1.5× too fast. Detect: voice-1 in a
  // measure adds up to LESS than expectedMeasureDiv, AND there's at least
  // one tuplet group whose un-tupletization would balance the measure
  // exactly. If yes, multiply each tuplet note's duration by
  // (actual/normal) — that turns 6:4 sextuplet 16ths back into normal
  // 16ths.
  let untupletGroups = 0;
  let untupletNotes = 0;
  // Group notes by measure
  const byMeasure = new Map<number, XmlNote[]>();
  for (const n of allNotes) {
    const arr = byMeasure.get(n.measureIdx) ?? [];
    arr.push(n);
    byMeasure.set(n.measureIdx, arr);
  }
  for (const [mIdx, mNotes] of byMeasure) {
    const expected = mNotes[0]?.expectedMeasureDiv;
    if (!expected) continue;
    // voice-1 timeline (in divisions). Use first voice — usually voice 1.
    // We compute "covered length" as max(onsetDiv + durDiv) over voice 1 non-chord notes.
    const voice1Notes = mNotes.filter((n) => n.voiceKey === "1");
    if (voice1Notes.length === 0) continue;
    const v1Total = voice1Notes.reduce((m, n) => Math.max(m, n.onsetDiv + n.durDiv), 0);
    const deficit = expected - v1Total;
    if (deficit <= 0) continue;
    // Find tuplet groups in voice 1
    const tuplets = voice1Notes.filter(
      (n) => n.tupletActual && n.tupletNormal && n.tupletActual > n.tupletNormal,
    );
    if (tuplets.length === 0) continue;
    // Sum of "gain" if all tuplets were un-tupletized
    const gain = tuplets.reduce((s, n) => {
      const newDur = n.durDiv * n.tupletActual! / n.tupletNormal!;
      return s + (newDur - n.durDiv);
    }, 0);
    if (Math.abs(gain - deficit) < 0.5) {
      // Snapshot measure boundaries BEFORE the fix so we can compute the
      // cascade shift to apply to all later measures.
      const div = mNotes[0].divisions;
      const oldMeasureEndDiv = mNotes.reduce(
        (m, n) => Math.max(m, n.onsetDiv + n.durDiv),
        0,
      );
      const measureStartSecBefore =
        mNotes[0].time - (mNotes[0].onsetDiv / div) * secondsPerQuarter;

      // Apply un-tupletization to voice 1 notes, sliding each subsequent
      // note onset forward to stay contiguous.
      const sortedV1 = [...voice1Notes].sort((a, b) => a.onsetDiv - b.onsetDiv);
      let cursor = 0;
      for (const n of sortedV1) {
        n.onsetDiv = cursor;
        if (n.tupletActual && n.tupletNormal && n.tupletActual > n.tupletNormal) {
          const newDur = (n.durDiv * n.tupletActual) / n.tupletNormal;
          n.durDiv = newDur;
          n.tupletActual = undefined;
          n.tupletNormal = undefined;
          untupletNotes++;
        }
        cursor += n.durDiv;
      }
      // Re-derive seconds for this measure's voice-1 notes.
      for (const n of sortedV1) {
        n.time = measureStartSecBefore + (n.onsetDiv / div) * secondsPerQuarter;
        n.durationSec = (n.durDiv / div) * secondsPerQuarter;
      }

      // Cascade: this measure now ends later, so every later measure's
      // notes need to slide forward by the same amount.
      const newMeasureEndDiv = mNotes.reduce(
        (m, n) => Math.max(m, n.onsetDiv + n.durDiv),
        0,
      );
      const shiftSec =
        ((newMeasureEndDiv - oldMeasureEndDiv) / div) * secondsPerQuarter;
      if (shiftSec > 1e-4) {
        for (const n of allNotes) {
          if (n.measureIdx > mIdx) n.time += shiftSec;
        }
      }
      untupletGroups++;
      // eslint-disable-next-line no-console
      console.log(
        `[xml-timeline] measure ${mIdx + 1}: un-tupletized ${tuplets.length} notes (deficit ${deficit} → balanced); cascade-shift downstream by ${shiftSec.toFixed(3)}s`
      );
    }
  }
  if (untupletNotes > 0) {
    // eslint-disable-next-line no-console
    console.log(
      `[xml-timeline] un-tuplet pass: rebalanced ${untupletGroups} measure(s), ${untupletNotes} note(s)`
    );
  }

  // Group notes by onset time (within ~1 ms) into CursorSteps.
  allNotes.sort((a, b) => a.time - b.time);
  const steps: CursorStep[] = [];
  const TOL = 0.001;
  for (const n of allNotes) {
    const last = steps[steps.length - 1];
    if (last && Math.abs(n.time - last.time) < TOL) {
      last.midis.push(n.midi);
      last.notes.push({ midi: n.midi, durationSec: n.durationSec });
    } else {
      steps.push({
        time: n.time,
        delta: 0,
        midis: [n.midi],
        notes: [{ midi: n.midi, durationSec: n.durationSec }],
        svgElements: [],
      });
    }
  }
  // Compute delta between successive steps so the play loop can advance.
  for (let i = 0; i < steps.length - 1; i++) {
    steps[i].delta = Math.max(0.001, steps[i + 1].time - steps[i].time);
  }
  if (steps.length > 0) {
    // Last step's delta = its longest note's duration so playback waits for it.
    const last = steps[steps.length - 1];
    last.delta = Math.max(0.05, ...last.notes.map((n) => n.durationSec));
  }

  // Dedupe midis per step so the piano keyboard doesn't double-highlight
  // a unison.
  for (const s of steps) {
    s.midis = Array.from(new Set(s.midis));
  }

  if (steps.length > 0) {
    const sample = steps.slice(0, 8).map((s) => ({
      t: +s.time.toFixed(3),
      d: +s.delta.toFixed(3),
      n: s.notes.map((n) => `${n.midi}/${n.durationSec.toFixed(3)}`).join(","),
    }));
    // eslint-disable-next-line no-console
    console.log("[xml-timeline] first 8 steps:", sample, `bpm=${bpm} totalSteps=${steps.length}`);
  }

  return steps;
}

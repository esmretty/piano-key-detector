import { Midi } from "@tonejs/midi";

/**
 * Convert a MIDI file (ArrayBuffer) into a minimal MusicXML string.
 *
 * Splits notes into two voices/staves based on pitch (RH ≥ C4, LH < C4) so
 * that left- and right-hand notes overlap correctly in time. Within a
 * measure, voice 1 is written, then a <backup> element rewinds the time
 * cursor and voice 2 is written — that way LH onsets land at their real
 * timestamps even when an RH note is still sounding.
 *
 * Limitations (acceptable for v1):
 *   - Onsets/durations quantized to 16th notes
 *   - Each voice treated as monophonic-with-chords (overlapping notes
 *     within the same hand: only the chord onset that lines up with the
 *     voice cursor is emitted; intermediate overlapping onsets get folded
 *     into the prior chord's tail)
 *   - Notes that cross measure boundaries get clipped (no ties)
 *   - Key signature: C major, all accidentals as <accidental>sharp</accidental>
 */
export function midiToMusicXML(buf: ArrayBuffer): string {
  const m = new Midi(buf);
  const ppq = m.header.ppq;
  const unit = ppq / 4; // 1 sixteenth in ticks
  const divisions = 4;  // MusicXML divisions per quarter

  const SPLIT = 60; // C4: notes < SPLIT go to LH/staff-2

  type Raw = { tick: number; durTicks: number; midi: number };
  const allNotes: Raw[] = [];
  for (const tr of m.tracks) {
    for (const n of tr.notes) {
      const tick = Math.round(n.ticks / unit) * unit;
      const dur = Math.max(unit, Math.round(n.durationTicks / unit) * unit);
      allNotes.push({ tick, durTicks: dur, midi: n.midi });
    }
  }
  if (allNotes.length === 0) return emptyScore();
  allNotes.sort((a, b) => a.tick - b.tick || a.midi - b.midi);

  const tsDef = m.header.timeSignatures[0]?.timeSignature ?? [4, 4];
  const beatsPerMeasure = tsDef[0];
  const beatUnit = tsDef[1];
  const ticksPerMeasure = beatsPerMeasure * ((ppq * 4) / beatUnit);
  const divsPerMeasure = Math.round(ticksPerMeasure / unit) * (divisions / 4);

  // Split into RH / LH voices
  const rh: Raw[] = [];
  const lh: Raw[] = [];
  for (const n of allNotes) (n.midi >= SPLIT ? rh : lh).push(n);

  const useGrandStaff = rh.length > 0 && lh.length > 0;
  const rhOnsets = groupByTick(rh);
  const lhOnsets = groupByTick(lh);

  const lastTick = allNotes.reduce((max, n) => Math.max(max, n.tick + n.durTicks), 0);
  const numMeasures = Math.max(1, Math.ceil(lastTick / ticksPerMeasure));

  const bpm = Math.round(m.header.tempos[0]?.bpm ?? 100);

  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>\n`;
  xml += `<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n`;
  xml += `<score-partwise version="3.1">`;
  xml += `<work><work-title>${escapeXml(m.name || "MIDI Score")}</work-title></work>`;
  xml += `<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>`;
  xml += `<part id="P1">`;

  for (let mi = 0; mi < numMeasures; mi++) {
    const mStart = mi * ticksPerMeasure;
    const mEnd = mStart + ticksPerMeasure;
    xml += `<measure number="${mi + 1}">`;
    if (mi === 0) {
      xml += `<attributes>`;
      xml += `<divisions>${divisions}</divisions>`;
      xml += `<key><fifths>0</fifths></key>`;
      xml += `<time><beats>${beatsPerMeasure}</beats><beat-type>${beatUnit}</beat-type></time>`;
      if (useGrandStaff) {
        xml += `<staves>2</staves>`;
        xml += `<clef number="1"><sign>G</sign><line>2</line></clef>`;
        xml += `<clef number="2"><sign>F</sign><line>4</line></clef>`;
      } else if (lh.length > 0) {
        xml += `<clef><sign>F</sign><line>4</line></clef>`;
      } else {
        xml += `<clef><sign>G</sign><line>2</line></clef>`;
      }
      xml += `</attributes>`;
      xml += `<sound tempo="${bpm}"/>`;
    }

    if (useGrandStaff) {
      xml += emitVoiceForMeasure(rhOnsets, mStart, mEnd, unit, 1, 1);
      xml += `<backup><duration>${divsPerMeasure}</duration></backup>`;
      xml += emitVoiceForMeasure(lhOnsets, mStart, mEnd, unit, 2, 2);
    } else {
      const onsets = rh.length > 0 ? rhOnsets : lhOnsets;
      xml += emitVoiceForMeasure(onsets, mStart, mEnd, unit, 1, null);
    }
    xml += `</measure>`;
  }
  xml += `</part></score-partwise>`;
  return xml;
}

type Raw = { tick: number; durTicks: number; midi: number };

function groupByTick(notes: Raw[]): Map<number, Raw[]> {
  const map = new Map<number, Raw[]>();
  for (const n of notes) {
    const arr = map.get(n.tick) ?? [];
    arr.push(n);
    map.set(n.tick, arr);
  }
  return map;
}

function emitVoiceForMeasure(
  onsetMap: Map<number, Raw[]>,
  mStart: number,
  mEnd: number,
  unit: number,
  voice: number,
  staff: number | null,
): string {
  let xml = "";
  let cursor = mStart;
  const onsets = [...onsetMap.keys()]
    .filter((t) => t >= mStart && t < mEnd)
    .sort((a, b) => a - b);

  for (const onset of onsets) {
    if (onset < cursor) continue; // overlap inside a single hand: drop the late onset
    if (onset > cursor) {
      const restSlots = Math.round((onset - cursor) / unit);
      for (const d of splitIntoPow2(restSlots)) {
        xml += emitRest(d, voice, staff);
      }
      cursor = onset;
    }
    const chord = onsetMap.get(onset)!;
    let chordDurTicks = chord[0].durTicks;
    for (const n of chord) chordDurTicks = Math.min(chordDurTicks, n.durTicks);
    const maxDurTicks = mEnd - cursor;
    chordDurTicks = Math.min(chordDurTicks, maxDurTicks);
    const slots = Math.max(1, Math.round(chordDurTicks / unit));
    const durDivs = quantizePow2(slots);
    chord.forEach((n, i) => {
      xml += emitNote(n.midi, durDivs, i > 0, voice, staff);
    });
    cursor += durDivs * unit;
    if (cursor > mEnd) cursor = mEnd;
  }
  if (cursor < mEnd) {
    const restSlots = Math.round((mEnd - cursor) / unit);
    for (const d of splitIntoPow2(restSlots)) {
      xml += emitRest(d, voice, staff);
    }
  }
  return xml;
}

function splitIntoPow2(slots: number): number[] {
  const out: number[] = [];
  let remaining = slots;
  const sizes = [16, 8, 4, 2, 1];
  while (remaining > 0) {
    const size = sizes.find((s) => s <= remaining) ?? 1;
    out.push(size);
    remaining -= size;
  }
  return out;
}

function quantizePow2(slots: number): number {
  const pows = [1, 2, 4, 8, 16];
  let best = pows[0];
  for (const p of pows) if (Math.abs(p - slots) < Math.abs(best - slots)) best = p;
  return best;
}

function emitRest(divs: number, voice: number, staff: number | null): string {
  const staffTag = staff != null ? `<staff>${staff}</staff>` : "";
  return `<note><rest/><duration>${divs}</duration><voice>${voice}</voice><type>${typeName(divs)}</type>${staffTag}</note>`;
}

function emitNote(
  midi: number,
  divs: number,
  isChord: boolean,
  voice: number,
  staff: number | null,
): string {
  const { step, alter, octave } = midiToPitch(midi);
  const staffTag = staff != null ? `<staff>${staff}</staff>` : "";
  let s = `<note>`;
  if (isChord) s += `<chord/>`;
  s += `<pitch><step>${step}</step>`;
  if (alter !== 0) s += `<alter>${alter}</alter>`;
  s += `<octave>${octave}</octave></pitch>`;
  s += `<duration>${divs}</duration><voice>${voice}</voice><type>${typeName(divs)}</type>`;
  if (alter > 0) s += `<accidental>sharp</accidental>`;
  s += staffTag;
  s += `</note>`;
  return s;
}

const STEPS = ["C", "C", "D", "D", "E", "F", "F", "G", "G", "A", "A", "B"];
const ALTERS = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];

function midiToPitch(midi: number) {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return { step: STEPS[pc], alter: ALTERS[pc], octave: oct };
}

function typeName(divs: number): string {
  if (divs >= 16) return "whole";
  if (divs >= 8) return "half";
  if (divs >= 4) return "quarter";
  if (divs >= 2) return "eighth";
  return "16th";
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function emptyScore(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1"><measure number="1">
<attributes><divisions>4</divisions><key><fifths>0</fifths></key>
<time><beats>4</beats><beat-type>4</beat-type></time>
<clef><sign>G</sign><line>2</line></clef></attributes>
<note><rest/><duration>16</duration><type>whole</type></note>
</measure></part></score-partwise>`;
}

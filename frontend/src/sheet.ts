import {
  OpenSheetMusicDisplay,
  type IOSMDOptions,
} from "opensheetmusicdisplay";
import type { CursorStep } from "./types";
import { buildXmlTimeline } from "./xml-timeline";

interface OSMDCursorAny {
  show(): void;
  hide(): void;
  reset(): void;
  next(): void;
  iterator: {
    EndReached: boolean;
    currentTimeStamp: { RealValue: number };
    CurrentVoiceEntries: any[];
  };
  GNotesUnderCursor?: () => any[];
  Iterator?: any;
}

/**
 * Wraps OpenSheetMusicDisplay: load score, render, compute playback timeline,
 * and apply "current note enlarged" highlight on each step.
 */
export class SheetView {
  private osmd: OpenSheetMusicDisplay;
  private container: HTMLElement;
  private currentSvgEls: SVGGElement[] = [];
  private lastLoadedXml: string | null = null;
  private selectedStepIdx: number | null = null;
  private selectedSvgEls: SVGGElement[] = [];
  private onStepSelected: ((stepIdx: number | null) => void) | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    const opts: IOSMDOptions = {
      autoResize: true,
      backend: "svg",
      drawTitle: true,
      drawSubtitle: true,
      drawComposer: true,
      drawCredits: false,
      drawPartNames: false,
      followCursor: true,
      cursorsOptions: [
        { type: 0, color: "#ff5a7a", alpha: 0.5, follow: true },
      ],
    };
    this.osmd = new OpenSheetMusicDisplay(container, opts);
  }

  /** Switch sheet rendering layout. Re-renders the score in place. */
  setLayout(mode: "default" | "compact" | "big") {
    const o = this.osmd as any;
    if (mode === "compact") {
      o.setOptions?.({
        drawingParameters: "compacttight",
        drawTitle: false,
        drawSubtitle: false,
        drawComposer: false,
        drawPartNames: false,
      });
      o.zoom = 0.85;
    } else if (mode === "big") {
      o.setOptions?.({
        drawingParameters: "default",
        drawTitle: true,
        drawSubtitle: false,
        drawComposer: false,
        drawPartNames: false,
      });
      o.zoom = 1.5;
    } else {
      o.setOptions?.({
        drawingParameters: "default",
        drawTitle: true,
        drawSubtitle: true,
        drawComposer: true,
        drawPartNames: false,
      });
      o.zoom = 1.0;
    }
    if (this.lastLoadedXml) {
      try { this.osmd.render(); } catch (e) { console.warn("re-render failed:", e); }
    }
  }

  async loadXml(xml: string) {
    this.clearActive();
    this.lastScrollTargetY = -1e9; // forget previous score's scroll memo
    // Strip elements that crash OSMD's render path. Audiveris occasionally
    // emits an <octave-shift> with an incomplete partner (Fraction.lte()
    // gets called against undefined) — losing the 8va/15ma symbol is
    // cosmetic, so just drop them. Same for stray <slide>/<glissando>/<wedge>
    // that we've seen trigger similar crashes.
    // Use [^>]* (NOT [\s\S]*?) so we don't accidentally eat surrounding
    // elements when Audiveris emits an open-only <octave-shift...> with
    // no self-closing slash and no matching </octave-shift>.
    const sanitized = xml
      .replace(/<octave-shift\b[^>]*\/?>/g, "")
      .replace(/<\/octave-shift>/g, "")
      .replace(/<slide\b[^>]*\/?>/g, "")
      .replace(/<\/slide>/g, "")
      .replace(/<glissando\b[^>]*\/?>/g, "")
      .replace(/<\/glissando>/g, "");
    this.lastLoadedXml = sanitized;
    try {
      await this.osmd.load(sanitized);
    } catch (e: any) {
      console.error("[osmd.load] failed:", e?.stack || e);
      throw new Error(`OSMD load failed: ${e?.message ?? e}`);
    }
    try {
      this.osmd.render();
    } catch (e: any) {
      console.error("[osmd.render] failed:", e?.stack || e);
      throw new Error(`OSMD render failed: ${e?.message ?? e}`);
    }
    const cursor = this.osmd.cursor as unknown as OSMDCursorAny;
    // Hide OSMD's vertical-bar cursor — it advances per voice-entry (visiting
    // rests) while our timeline advances per-NOTE, so the two drift apart.
    // The red+enlarged note from setActiveNotes is the playback indicator
    // and stays in lockstep with audio.
    cursor.hide();
    cursor.reset();
  }

  /**
   * Walk the cursor through the entire score and produce a flat timeline.
   *
   * Two-pass strategy so per-note durations stay correct even when voices
   * have different rhythms in parallel:
   *
   *   Pass 1: walk the cursor, recording at each step which (voiceId → notes)
   *           appear, plus the absolute timestamp.
   *   Pass 2: for each step's note, find the next step in the SAME voice;
   *           the duration is the gap between those two steps. This avoids
   *           a quarter in the right hand getting cut short to a 16th
   *           because the left hand happens to play 16ths underneath it.
   *
   * BPM is the only tempo source — `<sound tempo>` in MusicXML is ignored.
   */
  buildTimeline(bpm: number): CursorStep[] {
    // Prefer parsing the source MusicXML directly — that gives correct
    // per-note durations for tuplets/dotted/cross-voice rhythms which OSMD's
    // Note.Length API gets subtly wrong in some cases.
    if (this.lastLoadedXml) {
      let xmlSteps: CursorStep[] = [];
      try {
        xmlSteps = buildXmlTimeline(this.lastLoadedXml, bpm);
      } catch (e: any) {
        console.error("[buildXmlTimeline] failed:", e?.stack || e);
      }
      if (xmlSteps.length > 0) {
        try {
          this.attachSvgElementsToSteps(xmlSteps, bpm);
        } catch (e: any) {
          console.error("[attachSvgElementsToSteps] failed:", e?.stack || e);
        }
        return xmlSteps;
      }
    }
    // Fallback: legacy OSMD-cursor walk.
    const cursor = this.osmd.cursor as unknown as OSMDCursorAny;
    const secondsPerQuarter = 60 / bpm;

    interface RawStep {
      tsWhole: number;
      voices: Map<number, number[]>; // voiceId -> midis
      svgEls: SVGGElement[];
    }
    const raw: RawStep[] = [];

    cursor.reset();
    while (!cursor.iterator.EndReached) {
      const tsWhole = cursor.iterator.currentTimeStamp.RealValue;
      const voices = new Map<number, number[]>();
      for (const ve of cursor.iterator.CurrentVoiceEntries) {
        const vId =
          ve.ParentVoice?.VoiceId ??
          ve.parentVoice?.VoiceId ??
          ve.parentVoice?.voiceId ??
          1;
        const notesAtVoice: number[] = [];
        for (const n of ve.Notes ?? []) {
          const isRest = typeof n.isRest === "function" ? n.isRest() : !!n.IsRest;
          if (isRest) continue;
          let midi: number | null = null;
          if (typeof n.halfTone === "number") midi = n.halfTone + 12;
          else if (n.Pitch && typeof n.Pitch.halfTone === "number") midi = n.Pitch.halfTone + 12;
          if (midi != null) notesAtVoice.push(midi);
        }
        if (notesAtVoice.length) {
          const arr = voices.get(vId) ?? [];
          arr.push(...notesAtVoice);
          voices.set(vId, arr);
        }
      }
      const svgEls: SVGGElement[] = [];
      const gnotes = cursor.GNotesUnderCursor ? cursor.GNotesUnderCursor() : [];
      for (const gn of gnotes) {
        try {
          const el = gn.getSVGGElement?.();
          if (el) svgEls.push(el as SVGGElement);
        } catch (_) { /* ignore */ }
      }
      raw.push({ tsWhole, voices, svgEls });
      cursor.next();
    }

    // For each (stepIdx, voiceId), find the next step that has the same voice.
    const nextSameVoice: Map<number, number>[] = raw.map(() => new Map());
    for (let i = 0; i < raw.length; i++) {
      for (const vId of raw[i].voices.keys()) {
        for (let j = i + 1; j < raw.length; j++) {
          if (raw[j].voices.has(vId)) {
            nextSameVoice[i].set(vId, j);
            break;
          }
        }
      }
    }

    const steps: CursorStep[] = [];
    for (let i = 0; i < raw.length; i++) {
      const r = raw[i];
      const time = r.tsWhole * 4 * secondsPerQuarter;
      const allMidis: number[] = [];
      const notesOut: { midi: number; durationSec: number }[] = [];
      for (const [vId, midis] of r.voices) {
        const nextIdx = nextSameVoice[i].get(vId);
        // Duration in whole-notes; if no next event in this voice, default
        // to ~1 quarter (will only apply at the very last note).
        const durWhole =
          nextIdx != null ? raw[nextIdx].tsWhole - r.tsWhole : 0.25;
        const durSec = durWhole * 4 * secondsPerQuarter;
        for (const midi of midis) {
          allMidis.push(midi);
          notesOut.push({ midi, durationSec: durSec });
        }
      }
      // delta to next step (any voice) — used by main.ts to schedule cursor advance
      const delta =
        i + 1 < raw.length
          ? (raw[i + 1].tsWhole - r.tsWhole) * 4 * secondsPerQuarter
          : 0.5;
      steps.push({
        time,
        delta,
        midis: dedupe(allMidis),
        notes: notesOut,
        svgElements: r.svgEls,
      });
    }

    // Debug-log first few steps so we can sanity-check durations in dev tools.
    for (let k = 0; k < Math.min(8, steps.length); k++) {
      const s = steps[k];
      const summary = s.notes
        .map((n) => `${n.midi}=${n.durationSec.toFixed(3)}s`)
        .join(", ");
      // eslint-disable-next-line no-console
      console.log(
        `[timeline] step ${k} t=${s.time.toFixed(3)} dlt=${s.delta.toFixed(3)} ${summary}`
      );
    }
    cursor.reset();
    return steps;
  }

  /**
   * Walk OSMD's cursor and attach GraphicalNote SVG elements to whichever
   * timeline step shares the same timestamp.  Also wires click-to-select
   * on each note's SVG so the user can pick a starting point.
   */
  private attachSvgElementsToSteps(steps: CursorStep[], bpm: number): void {
    const cursor = this.osmd.cursor as unknown as OSMDCursorAny;
    const tsKey = (tsWhole: number) => Math.round(tsWhole * 10000);
    const wholeFromSec = (sec: number) => (sec * bpm) / 240;
    const idx = new Map<number, number>();
    for (let i = 0; i < steps.length; i++) {
      idx.set(tsKey(wholeFromSec(steps[i].time)), i);
    }
    cursor.reset();
    while (!cursor.iterator.EndReached) {
      const tsWhole = cursor.iterator.currentTimeStamp.RealValue;
      const stepIdx = idx.get(tsKey(tsWhole));
      if (stepIdx != null) {
        const svgEls: SVGGElement[] = [];
        const gnotes = cursor.GNotesUnderCursor ? cursor.GNotesUnderCursor() : [];
        for (const gn of gnotes) {
          try {
            const el = gn.getSVGGElement?.();
            if (el) svgEls.push(el as SVGGElement);
          } catch (_) { /* ignore */ }
        }
        if (svgEls.length) {
          steps[stepIdx].svgElements.push(...svgEls);
          // Wire click handler on each SVG note to select this step.
          for (const el of svgEls) {
            (el as SVGGElement & { _stepIdx?: number })._stepIdx = stepIdx;
            el.style.cursor = "pointer";
            el.addEventListener("click", this.onNoteClick);
          }
        }
      }
      cursor.next();
    }
    cursor.reset();
  }

  /** Bound so addEventListener uses a stable reference (and we can remove). */
  private onNoteClick = (ev: Event) => {
    const el = ev.currentTarget as SVGGElement & { _stepIdx?: number };
    const stepIdx = el._stepIdx;
    if (stepIdx == null) return;
    ev.stopPropagation();
    this.setSelectedStep(stepIdx);
  };

  setSelectedStep(stepIdx: number | null) {
    // Clear previous blue highlight
    for (const el of this.selectedSvgEls) {
      el.classList.remove("osmd-note-selected");
    }
    this.selectedSvgEls = [];
    this.selectedStepIdx = stepIdx;
    if (stepIdx != null) {
      // Find SVG elements for this step (we kept references via attach).
      const all = this.container.querySelectorAll("g");
      all.forEach((g) => {
        const sIdx = (g as SVGGElement & { _stepIdx?: number })._stepIdx;
        if (sIdx === stepIdx) {
          g.classList.add("osmd-note-selected");
          this.selectedSvgEls.push(g as SVGGElement);
        }
      });
    }
    if (this.onStepSelected) this.onStepSelected(stepIdx);
  }

  getSelectedStepIdx(): number | null {
    return this.selectedStepIdx;
  }

  setOnStepSelected(cb: (stepIdx: number | null) => void) {
    this.onStepSelected = cb;
  }

  /** Manually advance cursor (used by main play loop). */
  cursorReset() { (this.osmd.cursor as unknown as OSMDCursorAny).reset(); }
  cursorNext() { (this.osmd.cursor as unknown as OSMDCursorAny).next(); }
  cursorShow() { (this.osmd.cursor as unknown as OSMDCursorAny).show(); }
  cursorHide() { (this.osmd.cursor as unknown as OSMDCursorAny).hide(); }

  /** Apply "active" class to a set of SVG note elements; remove from previous. */
  setActiveNotes(els: SVGGElement[]) {
    for (const old of this.currentSvgEls) {
      old.classList.remove("osmd-note-active");
    }
    this.currentSvgEls = [];
    for (const el of els) {
      el.classList.add("osmd-note-active");
      this.currentSvgEls.push(el);
    }
    if (els.length) this.scrollNoteIntoView(els[0]);
  }

  private lastScrollTargetY = -1e9;

  private scrollNoteIntoView(el: SVGGElement) {
    try {
      const rect = el.getBoundingClientRect();
      const cont = this.container.parentElement; // sheet-panel
      if (!cont) return;
      const cRect = cont.getBoundingClientRect();

      // Only scroll when the active note is FULLY outside the visible
      // window — within a single staff system the note's vertical position
      // stays the same, so this skips per-note jitter and only fires when
      // the cursor crosses to a new line. Big win on small phone screens
      // where sheet panel is ~200 px tall.
      const fullyVisible =
        rect.top >= cRect.top - 1 && rect.bottom <= cRect.bottom + 1;
      if (fullyVisible) return;

      // Place the note ~25% from the top so there's room to read upcoming
      // measures below, and so a system + the start of the next system are
      // both visible.
      const desiredFromTop = cRect.height * 0.25;
      const targetTop = cont.scrollTop + (rect.top - cRect.top) - desiredFromTop;

      // Debounce: ignore tiny adjustments that don't actually move us into
      // a new system (avoids smooth-scroll animation overlap on rapid notes).
      const clamped = Math.max(0, targetTop);
      if (Math.abs(clamped - this.lastScrollTargetY) < 24) return;
      this.lastScrollTargetY = clamped;
      cont.scrollTo({ top: clamped, behavior: "smooth" });
    } catch (_) { /* noop */ }
  }

  clearActive() {
    this.setActiveNotes([]);
  }

  /** Best-effort tempo extraction from the loaded score. */
  defaultBpm(): number | null {
    const sheet: any = (this.osmd as any).Sheet;
    if (!sheet) return null;
    const tempo = sheet.DefaultStartTempoInBpm ?? sheet.userStartTempoInBPM;
    if (typeof tempo === "number" && tempo > 0) return Math.round(tempo);
    return null;
  }
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

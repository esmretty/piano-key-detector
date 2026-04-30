/**
 * SVG-rendered 88-key piano keyboard (A0=21 to C8=108).
 * Mobile: horizontally scrollable, auto-scrolls to keep the active note in view.
 */

const FIRST_MIDI = 21;   // A0
const LAST_MIDI = 108;   // C8
const WHITE_W = 30;      // px in viewBox units; CSS scales height
const WHITE_H = 160;
const BLACK_W = 18;
const BLACK_H = 100;

const PITCH_CLASS_IS_BLACK = [false, true, false, true, false, false, true, false, true, false, true, false]; // C C# D D# E F F# G G# A A# B
const PITCH_CLASS_NAME = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function isBlackKey(midi: number): boolean {
  return PITCH_CLASS_IS_BLACK[((midi % 12) + 12) % 12];
}

function whiteKeyIndex(midi: number): number {
  // Count white keys from FIRST_MIDI up to midi (inclusive of midi if white).
  let idx = 0;
  for (let m = FIRST_MIDI; m < midi; m++) {
    if (!isBlackKey(m)) idx++;
  }
  return idx;
}

export class Piano {
  private svg: SVGSVGElement;
  private scrollContainer: HTMLElement;
  private keys: Map<number, SVGRectElement> = new Map();
  private active: Set<number> = new Set();
  private pressed: Set<number> = new Set();
  private onKeyDown: ((midi: number) => void) | null = null;
  private onKeyUp: ((midi: number) => void) | null = null;

  constructor(svg: SVGSVGElement, scrollContainer: HTMLElement) {
    this.svg = svg;
    this.scrollContainer = scrollContainer;
    this.render();
    this.attachInputHandlers();
  }

  setKeyHandlers(down: (midi: number) => void, up: (midi: number) => void) {
    this.onKeyDown = down;
    this.onKeyUp = up;
  }

  private render() {
    const totalWhites = whiteKeyIndex(LAST_MIDI + 1); // count whites including LAST_MIDI
    const width = totalWhites * WHITE_W;
    const height = WHITE_H;
    // viewBox + preserveAspectRatio="none" + CSS width:100% → keys stretch
    // horizontally to fill the panel. We keep the height proportionally
    // sensible by clamping piano-panel height in CSS instead.
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    this.svg.removeAttribute("width");
    this.svg.removeAttribute("height");
    this.svg.setAttribute("preserveAspectRatio", "none");

    const ns = "http://www.w3.org/2000/svg";
    const whiteGroup = document.createElementNS(ns, "g");
    const blackGroup = document.createElementNS(ns, "g");
    const labelGroup = document.createElementNS(ns, "g");

    // White keys first
    for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
      if (isBlackKey(midi)) continue;
      const i = whiteKeyIndex(midi);
      const x = i * WHITE_W;
      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("x", String(x));
      rect.setAttribute("y", "0");
      rect.setAttribute("width", String(WHITE_W));
      rect.setAttribute("height", String(WHITE_H));
      rect.setAttribute("class", "key-white");
      rect.setAttribute("data-midi", String(midi));
      rect.setAttribute("rx", "2");
      whiteGroup.appendChild(rect);
      this.keys.set(midi, rect);

      // Label C notes with octave (C4 etc.)
      const pc = ((midi % 12) + 12) % 12;
      if (pc === 0) {
        const octave = Math.floor(midi / 12) - 1;
        const txt = document.createElementNS(ns, "text");
        txt.setAttribute("x", String(x + WHITE_W / 2));
        txt.setAttribute("y", String(WHITE_H - 10));
        txt.setAttribute("text-anchor", "middle");
        txt.setAttribute("class", "key-label octave-c");
        txt.textContent = `C${octave}`;
        labelGroup.appendChild(txt);
      }
    }

    // Black keys overlay
    for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
      if (!isBlackKey(midi)) continue;
      // Position: between the previous white key (midi-1) and the next white (midi+1).
      // x = whiteKeyIndex(midi-1) * WHITE_W + WHITE_W - BLACK_W/2
      const leftWhiteIdx = whiteKeyIndex(midi - 1);
      const x = leftWhiteIdx * WHITE_W + WHITE_W - BLACK_W / 2;
      const rect = document.createElementNS(ns, "rect");
      rect.setAttribute("x", String(x));
      rect.setAttribute("y", "0");
      rect.setAttribute("width", String(BLACK_W));
      rect.setAttribute("height", String(BLACK_H));
      rect.setAttribute("class", "key-black");
      rect.setAttribute("data-midi", String(midi));
      rect.setAttribute("rx", "1.5");
      blackGroup.appendChild(rect);
      this.keys.set(midi, rect);
    }

    this.svg.replaceChildren(whiteGroup, blackGroup, labelGroup);
  }

  /** Bulk replace (legacy). Prefer noteOn/noteOff for per-note scheduling. */
  highlight(midis: number[]) {
    for (const m of this.active) {
      const k = this.keys.get(m);
      if (k) k.classList.remove("active");
    }
    this.active.clear();
    for (const m of midis) {
      const k = this.keys.get(m);
      if (k) {
        k.classList.add("active");
        this.active.add(m);
      }
    }
    this.scrollIntoView(midis);
  }

  /** Reference-counted per-note highlight: a key stays lit while ≥1 voice
   *  is sounding it.  Lets a long quarter overlap with a short 16th without
   *  the keyboard turning off mid-quarter. */
  private noteOnCounts: Map<number, number> = new Map();
  /** Sticky selection (blue) shown while paused/idle. Cleared when a new
   *  selection arrives. Visually overlaid by .active during playback. */
  private selectedMidis: Set<number> = new Set();

  setSelectedKeys(midis: number[]) {
    for (const m of this.selectedMidis) {
      const k = this.keys.get(m);
      if (k) k.classList.remove("selected");
    }
    this.selectedMidis.clear();
    for (const m of midis) {
      const k = this.keys.get(m);
      if (k) {
        k.classList.add("selected");
        this.selectedMidis.add(m);
      }
    }
    if (midis.length) this.scrollIntoView(midis);
  }

  clearSelection() {
    this.setSelectedKeys([]);
  }

  noteOn(midi: number) {
    const c = (this.noteOnCounts.get(midi) ?? 0) + 1;
    this.noteOnCounts.set(midi, c);
    if (c === 1) {
      const k = this.keys.get(midi);
      if (k) k.classList.add("active");
      this.active.add(midi);
      this.scrollIntoView([midi]);
    }
  }

  noteOff(midi: number) {
    const c = (this.noteOnCounts.get(midi) ?? 0) - 1;
    if (c <= 0) {
      this.noteOnCounts.delete(midi);
      // Only clear visual if no manual touch is also pressing it
      if (!this.pressed.has(midi)) {
        const k = this.keys.get(midi);
        if (k) k.classList.remove("active");
        this.active.delete(midi);
      }
    } else {
      this.noteOnCounts.set(midi, c);
    }
  }

  clear() {
    this.noteOnCounts.clear();
    this.highlight([]);
  }

  private scrollIntoView(midis: number[]) {
    if (!midis.length) return;
    const center = midis.reduce((a, b) => a + b, 0) / midis.length;
    const totalWhites = whiteKeyIndex(LAST_MIDI + 1);
    const targetWhiteIdx = whiteKeyIndex(Math.round(center));
    const ratio = targetWhiteIdx / totalWhites;
    const sc = this.scrollContainer;
    const targetX = ratio * sc.scrollWidth - sc.clientWidth / 2;
    sc.scrollTo({ left: Math.max(0, targetX), behavior: "smooth" });
  }

  pitchName(midi: number): string {
    const pc = ((midi % 12) + 12) % 12;
    const oct = Math.floor(midi / 12) - 1;
    return `${PITCH_CLASS_NAME[pc]}${oct}`;
  }

  private attachInputHandlers() {
    // Pointer events handle mouse + touch + pen uniformly.
    const handleDown = (e: PointerEvent) => {
      const midi = midiFromTarget(e.target);
      if (midi == null) return;
      e.preventDefault();
      // Capture so we get pointerup even if the finger slides off.
      try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch {}
      this.pressKey(midi);
    };
    const handleUp = (e: PointerEvent) => {
      const midi = midiFromTarget(e.target);
      if (midi == null) {
        // Release any pressed via this pointer to be safe.
        this.releaseAllPressed();
        return;
      }
      this.releaseKey(midi);
    };
    const handleCancel = () => this.releaseAllPressed();

    this.svg.addEventListener("pointerdown", handleDown);
    this.svg.addEventListener("pointerup", handleUp);
    this.svg.addEventListener("pointercancel", handleCancel);
    this.svg.addEventListener("pointerleave", handleCancel);
    // Block context menu on long-press.
    this.svg.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  private pressKey(midi: number) {
    if (this.pressed.has(midi)) return;
    this.pressed.add(midi);
    const k = this.keys.get(midi);
    if (k) k.classList.add("active");
    this.onKeyDown?.(midi);
  }

  private releaseKey(midi: number) {
    if (!this.pressed.has(midi)) return;
    this.pressed.delete(midi);
    // Only remove the visual class if this key isn't currently being highlighted by playback.
    if (!this.active.has(midi)) {
      const k = this.keys.get(midi);
      if (k) k.classList.remove("active");
    }
    this.onKeyUp?.(midi);
  }

  private releaseAllPressed() {
    for (const m of [...this.pressed]) this.releaseKey(m);
  }
}

function midiFromTarget(t: EventTarget | null): number | null {
  if (!(t instanceof Element)) return null;
  const el = t.closest("[data-midi]");
  if (!el) return null;
  const m = Number(el.getAttribute("data-midi"));
  return Number.isFinite(m) ? m : null;
}

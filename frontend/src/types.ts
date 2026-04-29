export interface NoteEvent {
  /** Onset time in seconds. */
  time: number;
  /** Sounding duration in seconds. */
  duration: number;
  /** MIDI pitch number (60 = C4). */
  midi: number;
  /** Velocity 0-1. */
  velocity: number;
}

export interface NoteAtStep {
  midi: number;
  /** Sounding duration in seconds based on the note's own MusicXML <duration> + tempo. */
  durationSec: number;
}

export interface CursorStep {
  /** Onset time in seconds. */
  time: number;
  /** Time until the next cursor step in seconds (used for highlight + cursor advance). */
  delta: number;
  /** MIDI numbers sounding at this onset (deduped, for piano keyboard highlight). */
  midis: number[];
  /** Each note's own intended sounding duration — used so a quarter doesn't get cut short
   *  when a parallel voice has a 16th starting in the middle of it. */
  notes: NoteAtStep[];
  /** OSMD GraphicalNote SVG <g> elements to enlarge. */
  svgElements: SVGGElement[];
}

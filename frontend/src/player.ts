import * as Tone from "tone";

/**
 * Simple Tone.js piano sampler wrapper. Lazy-loads samples on first call to start().
 */
export class Player {
  private sampler: Tone.Sampler | null = null;
  private loadingPromise: Promise<void> | null = null;
  private enabled = true;

  setEnabled(on: boolean) { this.enabled = on; }

  async ensureLoaded() {
    if (this.sampler) return;
    if (this.loadingPromise) return this.loadingPromise;
    this.loadingPromise = new Promise<void>((resolve, reject) => {
      // Salamander Grand Piano hosted on Tone.js CDN
      const sampler = new Tone.Sampler({
        urls: {
          A0: "A0.mp3",
          C1: "C1.mp3", "D#1": "Ds1.mp3", "F#1": "Fs1.mp3", A1: "A1.mp3",
          C2: "C2.mp3", "D#2": "Ds2.mp3", "F#2": "Fs2.mp3", A2: "A2.mp3",
          C3: "C3.mp3", "D#3": "Ds3.mp3", "F#3": "Fs3.mp3", A3: "A3.mp3",
          C4: "C4.mp3", "D#4": "Ds4.mp3", "F#4": "Fs4.mp3", A4: "A4.mp3",
          C5: "C5.mp3", "D#5": "Ds5.mp3", "F#5": "Fs5.mp3", A5: "A5.mp3",
          C6: "C6.mp3", "D#6": "Ds6.mp3", "F#6": "Fs6.mp3", A6: "A6.mp3",
          C7: "C7.mp3", "D#7": "Ds7.mp3", "F#7": "Fs7.mp3", A7: "A7.mp3",
          C8: "C8.mp3",
        },
        release: 1,
        baseUrl: "https://tonejs.github.io/audio/salamander/",
        onload: () => {
          this.sampler = sampler;
          resolve();
        },
        onerror: (err) => reject(err),
      }).toDestination();
    });
    return this.loadingPromise;
  }

  async start() {
    await Tone.start();
    await this.ensureLoaded();
  }

  triggerAttackRelease(midis: number[], durationSec: number) {
    if (!this.enabled || !this.sampler) return;
    const freqs = midis.map((m) => Tone.Frequency(m, "midi").toFrequency());
    const dur = Math.max(0.05, durationSec);
    try {
      this.sampler.triggerAttackRelease(freqs, dur);
    } catch (e) {
      // Sampler may not be ready; ignore.
    }
  }

  /** Sustained attack — call release(midi) when the user lifts. */
  triggerAttack(midi: number) {
    if (!this.enabled || !this.sampler) return;
    try {
      this.sampler.triggerAttack(Tone.Frequency(midi, "midi").toFrequency());
    } catch (_) { /* ignore */ }
  }

  triggerRelease(midi: number) {
    if (!this.sampler) return;
    try {
      this.sampler.triggerRelease(Tone.Frequency(midi, "midi").toFrequency());
    } catch (_) { /* ignore */ }
  }

  stopAll() {
    if (this.sampler) this.sampler.releaseAll();
  }
}

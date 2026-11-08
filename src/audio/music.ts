/**
 * Generative ambient music (D55): a few calm "tracks", each a chord
 * progression in its own key and color, played with soft pads, a low bass
 * note and sparse bell notes picked at random from the track's scale, so it
 * never repeats exactly. A track fades in, plays for a couple of minutes,
 * fades out, and is followed by a gap of silence before the next one.
 *
 * `MusicDirector.update` is called every frame; it schedules notes a little
 * ahead on the audio clock. While the context is suspended (the tab is
 * hidden) its clock stops, and so does the music.
 */

import type { Random } from './synth';

export interface Track {
  name: string;
  /** Frequency of the root in Hz. */
  root: number;
  /** Chords as semitones above the root, played in order and repeated. */
  chords: readonly (readonly number[])[];
  /** Semitones above the root the bell notes are picked from. */
  scale: readonly number[];
  /** Seconds per chord. */
  chordSeconds: number;
  /** Low-pass cutoff of the pads (Hz): lower is darker. */
  brightness: number;
}

export const TRACKS: readonly Track[] = [
  {
    name: 'First Light',
    root: 146.83, // D3, major pentatonic
    chords: [
      [0, 4, 7],
      [9, 12, 16],
      [5, 9, 12],
      [7, 11, 14],
    ],
    scale: [0, 2, 4, 7, 9, 12, 14, 16],
    chordSeconds: 8,
    brightness: 1200,
  },
  {
    name: 'Night Shift',
    root: 110, // A2, natural minor
    chords: [
      [0, 3, 7],
      [8, 12, 15],
      [3, 7, 10],
      [10, 14, 17],
    ],
    scale: [0, 3, 5, 7, 10, 12, 15, 17],
    chordSeconds: 9,
    brightness: 800,
  },
  {
    name: 'Copper Haze',
    root: 174.61, // F3, lydian
    chords: [
      [0, 4, 7, 11],
      [2, 6, 9, 14],
      [0, 4, 7, 11],
      [-3, 4, 9, 12],
    ],
    scale: [0, 2, 4, 6, 7, 9, 11, 12, 14],
    chordSeconds: 7,
    brightness: 1000,
  },
];

/** Seconds of silence after the audio starts before the first track. */
export const FIRST_DELAY: readonly [number, number] = [3, 8];
/** Seconds of silence between two tracks. */
export const GAP_SECONDS: readonly [number, number] = [30, 90];
/** Chords per track (about 1.5–2.5 minutes). */
export const CHORDS_PER_TRACK: readonly [number, number] = [12, 18];
export const FADE_IN = 8;
export const FADE_OUT = 10;
/** How far ahead notes are scheduled (s). */
const LOOKAHEAD = 1;
/** Pads ring on this long after their chord (s). */
const RELEASE = 3;
const SILENT = 0.0001;

export type MusicPhase = 'gap' | 'playing';

const semis = (root: number, s: number) => root * Math.pow(2, s / 12);

export class MusicDirector {
  phase: MusicPhase = 'gap';
  /** The track playing (or that played last). */
  track: Track | null = null;
  /** Tracks started so far. */
  tracksStarted = 0;
  private nextAt: number;
  private chordIndex = 0;
  private chordsLeft = 0;
  private trackGain: GainNode | null = null;
  private trackEnd = 0;
  /** The music's own echo: a feedback delay, darker on every repeat. */
  private readonly input: GainNode;

  constructor(
    private readonly ctx: BaseAudioContext,
    out: AudioNode,
    private readonly random: Random,
  ) {
    this.input = ctx.createGain();
    this.input.connect(out);
    const delay = ctx.createDelay(1);
    delay.delayTime.value = 0.45;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.35;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 1500;
    this.input.connect(delay);
    delay.connect(tone).connect(feedback).connect(delay);
    feedback.connect(out);
    this.nextAt = ctx.currentTime + this.between(FIRST_DELAY);
  }

  /** When the next track starts (during a gap), or when the current one ends. */
  get nextChange(): number {
    return this.phase === 'gap' ? this.nextAt : this.trackEnd;
  }

  private between([lo, hi]: readonly [number, number]): number {
    return lo + this.random() * (hi - lo);
  }

  /** Schedules what is due before `now + LOOKAHEAD`; call it every frame. */
  update(now: number = this.ctx.currentTime): void {
    if (this.phase === 'gap') {
      if (now + LOOKAHEAD < this.nextAt) return;
      this.startTrack(Math.max(this.nextAt, now));
    }
    while (this.chordsLeft > 0 && this.nextAt < now + LOOKAHEAD) {
      // Chords whose time has passed (frames that didn't come, music muted) are skipped, not crammed in.
      if (this.nextAt >= now - 0.25) this.playChord(this.nextAt);
      else this.chordIndex++;
      this.nextAt += this.track!.chordSeconds;
      this.chordsLeft--;
    }
    if (this.chordsLeft === 0 && now >= this.trackEnd) {
      this.phase = 'gap';
      this.nextAt = this.trackEnd + RELEASE + this.between(GAP_SECONDS);
    }
  }

  private startTrack(t: number): void {
    // Any track but the last one.
    const choices = TRACKS.filter((tr) => tr !== this.track);
    this.track = choices[Math.floor(this.random() * choices.length)] ?? TRACKS[0]!;
    this.tracksStarted++;
    this.phase = 'playing';
    this.chordIndex = 0;
    this.chordsLeft = Math.round(this.between(CHORDS_PER_TRACK));
    this.trackEnd = t + this.chordsLeft * this.track.chordSeconds;
    // The previous track's notes ended long ago.
    this.trackGain?.disconnect();
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(SILENT, t);
    g.gain.exponentialRampToValueAtTime(1, t + FADE_IN);
    g.gain.setValueAtTime(1, this.trackEnd - FADE_OUT);
    g.gain.exponentialRampToValueAtTime(SILENT, this.trackEnd);
    g.connect(this.input);
    this.trackGain = g;
    this.nextAt = t;
  }

  private playChord(t: number): void {
    const track = this.track!;
    const out = this.trackGain!;
    const chord = track.chords[this.chordIndex % track.chords.length]!;
    this.chordIndex++;
    const len = track.chordSeconds;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = track.brightness;
    filter.connect(out);
    for (const s of chord) this.pad(filter, semis(track.root, s), t, len, 0.05);
    // The chord's lowest note an octave down, as a soft bass.
    this.pad(out, semis(track.root, Math.min(...chord) - 12), t, len, 0.07, 'sine');
    // Zero to two bell notes somewhere in the chord.
    const bells = Math.floor(this.random() * 3);
    for (let i = 0; i < bells; i++) {
      const s = track.scale[Math.floor(this.random() * track.scale.length)]!;
      this.bell(out, semis(track.root, s + 12), t + this.random() * (len - 1));
    }
  }

  private pad(
    out: AudioNode,
    freq: number,
    t: number,
    len: number,
    level: number,
    type: OscillatorType = 'triangle',
  ): void {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + Math.min(2.5, len / 2));
    g.gain.setValueAtTime(level, t + len);
    g.gain.linearRampToValueAtTime(0, t + len + RELEASE);
    g.connect(out);
    // Two slightly detuned oscillators: a slow natural chorus.
    for (const detune of [-6, 6]) {
      const o = this.ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      o.connect(g);
      o.start(t);
      o.stop(t + len + RELEASE + 0.1);
    }
  }

  private bell(out: AudioNode, freq: number, t: number): void {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(SILENT, t);
    g.gain.linearRampToValueAtTime(0.06, t + 0.01);
    g.gain.exponentialRampToValueAtTime(SILENT, t + 2.5);
    g.connect(out);
    for (const [mult, level] of [
      [1, 1],
      [2.01, 0.3],
    ] as const) {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = freq * mult;
      const og = this.ctx.createGain();
      og.gain.value = level;
      o.connect(og).connect(g);
      o.start(t);
      o.stop(t + 2.6);
    }
  }
}

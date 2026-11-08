/**
 * Every sound in the game, synthesized with WebAudio nodes (D55): no
 * samples, so nothing to download or license. One-shots build a few nodes,
 * schedule their envelopes and stop themselves; loops run until stopped.
 *
 * Only the `BaseAudioContext` factory methods are used, so the unit tests
 * can run these against a fake context.
 */

import type { LoopKind, SoundEventKind } from './events';

type Ctx = BaseAudioContext;
/** Random numbers in [0, 1) (for small variations between repeats). */
export type Random = () => number;

/** Smallest value exponential ramps may reach (they can't reach 0). */
const SILENT = 0.0001;

const noiseBuffers = new WeakMap<Ctx, AudioBuffer>();

/** One second of white noise for `ctx`, made once (a fixed LCG: no need for real randomness). */
export function noiseBuffer(ctx: Ctx): AudioBuffer {
  let buffer = noiseBuffers.get(ctx);
  if (!buffer) {
    buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    let s = 0x2545f491;
    for (let i = 0; i < data.length; i++) {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      data[i] = s / 0x8000_0000 - 1;
    }
    noiseBuffers.set(ctx, buffer);
  }
  return buffer;
}

/** An attack/decay envelope on `param`: up to `peak` in `attack` s, then down over `decay` s. */
function envelope(param: AudioParam, t: number, peak: number, attack: number, decay: number): void {
  param.setValueAtTime(SILENT, t);
  param.linearRampToValueAtTime(Math.max(SILENT, peak), t + attack);
  param.exponentialRampToValueAtTime(SILENT, t + attack + decay);
}

/** A tone gliding from `f0` to `f1` Hz with an attack/decay envelope; returns its end time. */
function tone(
  ctx: Ctx,
  out: AudioNode,
  type: OscillatorType,
  f0: number,
  f1: number,
  t: number,
  decay: number,
  peak: number,
  attack = 0.005,
): number {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(f1, t + attack + decay);
  envelope(g.gain, t, peak, attack, decay);
  osc.connect(g).connect(out);
  const end = t + attack + decay + 0.02;
  osc.start(t);
  osc.stop(end);
  return end;
}

/** A filtered noise burst; returns its end time. */
function noise(
  ctx: Ctx,
  out: AudioNode,
  t: number,
  decay: number,
  peak: number,
  filter: BiquadFilterType,
  freq: number,
  q = 1,
  attack = 0.003,
): number {
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  const f = ctx.createBiquadFilter();
  f.type = filter;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = ctx.createGain();
  envelope(g.gain, t, peak, attack, decay);
  src.connect(f).connect(g).connect(out);
  const end = t + attack + decay + 0.02;
  // A random point in the buffer, so repeated bursts don't sound identical.
  src.start(t, (t * 7.31) % 0.5);
  src.stop(end);
  return end;
}

/**
 * Plays one-shot `kind` at time `t` into `out` at volume `gain`; returns its
 * length in seconds (for the voice limiter).
 */
export function playOneShot(
  ctx: Ctx,
  out: AudioNode,
  kind: SoundEventKind,
  t: number,
  gain: number,
  random: Random,
): number {
  const vary = (amount: number) => 1 + (random() * 2 - 1) * amount;
  let end = t;
  const at = (e: number) => {
    end = Math.max(end, e);
  };
  switch (kind) {
    case 'place':
      // A solid thunk: a falling low sine with a muffled knock on top.
      at(tone(ctx, out, 'sine', 170 * vary(0.05), 60, t, 0.16, 0.9 * gain));
      at(noise(ctx, out, t, 0.05, 0.35 * gain, 'lowpass', 1400));
      break;
    case 'remove':
      // Picked up: a short rising pop and a brush of noise.
      at(tone(ctx, out, 'triangle', 260 * vary(0.05), 520, t, 0.1, 0.5 * gain));
      at(noise(ctx, out, t, 0.08, 0.25 * gain, 'bandpass', 2400, 0.8));
      break;
    case 'mine-hit':
      // A pick on rock: a bright tick with a short knock.
      at(noise(ctx, out, t, 0.07, 0.6 * gain, 'bandpass', 1100 * vary(0.15), 2.5));
      at(tone(ctx, out, 'triangle', 240 * vary(0.1), 180, t, 0.06, 0.35 * gain));
      break;
    case 'mined':
      // A piece comes off: a little upward blip.
      at(tone(ctx, out, 'triangle', 620 * vary(0.04), 930, t, 0.09, 0.35 * gain));
      break;
    case 'craft-done':
      // Two soft chime notes, a fifth apart.
      at(tone(ctx, out, 'sine', 880, 880, t, 0.25, 0.3 * gain));
      at(tone(ctx, out, 'sine', 1320, 1320, t + 0.07, 0.3, 0.25 * gain));
      break;
    case 'inserter':
      // A servo whir rising through a low-pass filter.
      {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 900;
        const g = ctx.createGain();
        const base = 150 * vary(0.08);
        osc.frequency.setValueAtTime(base, t);
        osc.frequency.linearRampToValueAtTime(base * 1.8, t + 0.18);
        envelope(g.gain, t, 0.18 * gain, 0.03, 0.2);
        osc.connect(f).connect(g).connect(out);
        osc.start(t);
        osc.stop(t + 0.26);
        at(t + 0.26);
      }
      break;
    case 'research-complete':
      // A rising arpeggio (C E G C) with an octave shimmer, and a long tail.
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
        const s = t + i * 0.14;
        at(tone(ctx, out, 'triangle', f, f, s, i === 3 ? 1.2 : 0.5, 0.32 * gain, 0.01));
        at(tone(ctx, out, 'sine', f * 2, f * 2, s, i === 3 ? 1.0 : 0.4, 0.08 * gain, 0.01));
      });
      break;
    case 'low-power':
      // A two-tone warning, twice, softened by a low-pass filter.
      {
        const f = ctx.createBiquadFilter();
        f.type = 'lowpass';
        f.frequency.value = 1800;
        f.connect(out);
        for (let i = 0; i < 2; i++) {
          at(tone(ctx, f, 'square', 440, 440, t + i * 0.36, 0.14, 0.16 * gain, 0.01));
          at(tone(ctx, f, 'square', 330, 330, t + i * 0.36 + 0.17, 0.14, 0.16 * gain, 0.01));
        }
      }
      break;
    case 'ui-click':
      at(tone(ctx, out, 'sine', 1500, 1100, t, 0.03, 0.25 * gain, 0.002));
      break;
  }
  return end - t;
}

/** A running machine loop: set `gain`/`pan` to place it, `stop` to fade it out and end it. */
export interface LoopVoice {
  readonly kind: LoopKind;
  readonly gain: GainNode;
  readonly pan: StereoPannerNode;
  /** Fades out from `t` and stops every node. */
  stop(t: number): void;
}

/** How long loops take to fade in, move and fade out (s). */
export const LOOP_FADE = 0.25;

/**
 * Starts the loop for `kind` into `out`, silent (its `gain` at 0) until the
 * engine sets its volume.
 */
export function createLoop(ctx: Ctx, out: AudioNode, kind: LoopKind, t: number): LoopVoice {
  const pan = ctx.createStereoPanner();
  pan.connect(out);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, t);
  gain.connect(pan);
  const sources: AudioScheduledSourceNode[] = [];
  const osc = (type: OscillatorType, freq: number, level: number, into: AudioNode) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.value = level;
    o.connect(g).connect(into);
    sources.push(o);
    return o;
  };
  const noiseSource = (into: AudioNode) => {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    src.connect(into);
    sources.push(src);
    return src;
  };
  const filter = (type: BiquadFilterType, freq: number, q = 0.7) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  };
  /** Wobbles `param` around its value by `depth` at `rate` Hz. */
  const lfo = (param: AudioParam, rate: number, depth: number, type: OscillatorType = 'sine') => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = rate;
    const g = ctx.createGain();
    g.gain.value = depth;
    o.connect(g).connect(param);
    sources.push(o);
  };
  // `body` is what each kind feeds; its own gain carries the kind's level and pulsing.
  const body = ctx.createGain();
  body.connect(gain);
  switch (kind) {
    case 'furnace': {
      // Fire: low rumbling noise with a slow flicker.
      const f = filter('lowpass', 420);
      noiseSource(f);
      f.connect(body);
      body.gain.value = 0.5;
      lfo(body.gain, 3.3, 0.15);
      break;
    }
    case 'boiler': {
      const f = filter('lowpass', 300);
      noiseSource(f);
      f.connect(body);
      osc('sine', 55, 0.25, body);
      body.gain.value = 0.5;
      lfo(body.gain, 1.7, 0.12);
      break;
    }
    case 'engine': {
      // Pistons: filtered noise chuffing twice a second, over a low drone.
      const f = filter('bandpass', 380, 1.2);
      noiseSource(f);
      const chuff = ctx.createGain();
      chuff.gain.value = 0.35;
      lfo(chuff.gain, 2, 0.35, 'triangle');
      f.connect(chuff).connect(body);
      osc('triangle', 73.4, 0.18, body);
      body.gain.value = 0.7;
      break;
    }
    case 'drill': {
      // A low grinding chug: a square wave through a wobbling low-pass.
      const f = filter('lowpass', 260, 3);
      osc('square', 62, 0.4, f);
      osc('sawtooth', 93, 0.2, f);
      lfo(f.frequency, 5.5, 120, 'triangle');
      f.connect(body);
      body.gain.value = 0.45;
      break;
    }
    case 'assembler': {
      // A mechanical hum that pulses with the arms.
      const f = filter('lowpass', 520, 1.5);
      osc('sawtooth', 110, 0.3, f);
      osc('square', 165, 0.1, f);
      f.connect(body);
      body.gain.value = 0.35;
      lfo(body.gain, 2.6, 0.15);
      break;
    }
    case 'lab': {
      // Soft electronic tones with a slow shimmer.
      osc('sine', 392, 0.18, body);
      osc('sine', 587.3, 0.12, body);
      osc('triangle', 784, 0.04, body);
      body.gain.value = 0.35;
      lfo(body.gain, 0.6, 0.12);
      break;
    }
    case 'belts': {
      // A steady low hum with a faint rattle.
      const f = filter('lowpass', 190);
      osc('sawtooth', 55, 0.5, f);
      osc('sawtooth', 110.5, 0.25, f);
      f.connect(body);
      const rattle = filter('bandpass', 2600, 4);
      noiseSource(rattle);
      const rg = ctx.createGain();
      rg.gain.value = 0.05;
      rattle.connect(rg).connect(body);
      body.gain.value = 0.4;
      break;
    }
  }
  for (const s of sources) s.start(t);
  let stopped = false;
  return {
    kind,
    gain,
    pan,
    stop(at: number) {
      if (stopped) return;
      stopped = true;
      gain.gain.cancelScheduledValues(at);
      gain.gain.setTargetAtTime(0, at, LOOP_FADE / 3);
      const end = at + LOOP_FADE * 2;
      for (const s of sources) s.stop(end);
      sources[0]?.addEventListener('ended', () => {
        pan.disconnect();
      });
    },
  };
}

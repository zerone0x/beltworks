/**
 * The loudest mix the engine can make (D55), for checking that it doesn't
 * clip: the engine's buses at 100% on every volume, the 8 machine loop voices
 * and the belt hum at full level on the listener, the music at full track
 * gain, and bursts of every one-shot kind together, as many as the voice
 * limiter lets start. The test hook renders it in an `OfflineAudioContext`
 * and reports the peak (tests/e2e/audio.spec.ts); the unit tests run it on
 * the fake context (tests/audio/mix.test.ts).
 */

import { BELT_LEVEL, LOOP_LEVEL, createBuses } from './engine';
import type { LoopKind, SoundEventKind } from './events';
import { MAX_LOOP_VOICES, OneShotLimiter } from './mix';
import { FADE_IN, FIRST_DELAY, MusicDirector } from './music';
import { createLoop, playOneShot, type Random } from './synth';
import { volumeToGain } from './volume';

/** One-shot kinds in the order a burst tries them: the loudest first. */
const BURST_ORDER: readonly SoundEventKind[] = [
  'place',
  'mine-hit',
  'remove',
  'research-complete',
  'craft-done',
  'mined',
  'inserter',
  'low-power',
  'ui-click',
];

/** The loudest loops, one voice each, round robin up to the voice cap. */
const LOOP_ORDER: readonly LoopKind[] = [
  'engine',
  'drill',
  'boiler',
  'furnace',
  'assembler',
  'lab',
];

/** Seconds of audio the scenario needs: until the first track's fade-in is over, and a little more. */
export const LOUDEST_MIX_SECONDS = FIRST_DELAY[1] + FADE_IN + 3;

/**
 * Schedules the loudest mix into `ctx` (from time 0); returns how many
 * one-shots it started. `random` drives the synths and the music.
 */
export function scheduleLoudestMix(ctx: BaseAudioContext, random: Random): number {
  const { master, sfx, music } = createBuses(ctx);
  master.gain.value = volumeToGain(100);
  sfx.gain.value = volumeToGain(100);
  music.gain.value = volumeToGain(100);
  for (let i = 0; i < MAX_LOOP_VOICES; i++) {
    const voice = createLoop(ctx, sfx, LOOP_ORDER[i % LOOP_ORDER.length]!, 0);
    voice.gain.gain.setValueAtTime(LOOP_LEVEL, 0);
  }
  createLoop(ctx, sfx, 'belts', 0).gain.gain.setValueAtTime(BELT_LEVEL, 0);
  const director = new MusicDirector(ctx, music, random);
  const musicStart = director.nextChange;
  for (let t = 0; t < LOUDEST_MIX_SECONDS; t += 0.5) director.update(t);
  // Bursts while the music is at full gain (after its fade-in) and early on.
  const limiter = new OneShotLimiter();
  const fullMusic = musicStart + FADE_IN;
  let started = 0;
  for (const start of [0.5, fullMusic, fullMusic + 0.6]) {
    for (let step = 0; step < 20; step++) {
      const t = start + step * 0.01;
      for (const kind of BURST_ORDER) {
        if (!limiter.tryStart(kind, t, 0.3)) continue;
        playOneShot(ctx, sfx, kind, t, 1, random);
        started++;
      }
    }
  }
  return started;
}

/** The largest absolute sample over every channel of `buffer`. */
export function peakOf(buffer: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    for (const v of buffer.getChannelData(c)) peak = Math.max(peak, Math.abs(v));
  }
  return peak;
}

/** A fixed sequence of pseudo-random numbers in [0, 1), so every render is the same. */
export function seededRandom(seed: number): Random {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 2 ** 32;
  };
}

/** Renders the loudest mix offline (browsers only) and returns its peak sample. */
export async function renderLoudestMixPeak(random: Random = seededRandom(7)): Promise<number> {
  const sampleRate = 44_100;
  const ctx = new OfflineAudioContext(2, Math.ceil(LOUDEST_MIX_SECONDS * sampleRate), sampleRate);
  scheduleLoudestMix(ctx, random);
  return peakOf(await ctx.startRendering());
}

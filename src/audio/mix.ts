/**
 * Mixing rules for positional sounds (D55): how loud a source is at a
 * distance from the listener (the camera's center), where it sits in the
 * stereo field, which machine loops get one of the capped voices, and how
 * often one-shots may play. Pure functions, unit tested.
 */

import type { LoopSource, SoundEventKind } from './events';

/** Within this many tiles of the listener a source plays at full volume. */
export const REF_DISTANCE = 4;
/** Sources this many tiles away or further are silent. */
export const MAX_DISTANCE = 40;
/** How fast volume falls past `REF_DISTANCE` (the inverse-distance rolloff factor). */
export const ROLLOFF = 1;
/** Gains below this aren't worth a voice. */
export const MIN_AUDIBLE_GAIN = 0.02;
/** Machine loops playing at once (the nearest working machines get them). */
export const MAX_LOOP_VOICES = 8;
/** One-shot sounds playing at once, all kinds together. */
export const MAX_ONE_SHOTS = 12;

export interface Listener {
  /** Position in tiles. */
  x: number;
  y: number;
  /** The camera zoom: zoomed out, the whole scene is a little quieter. */
  zoom: number;
}

/**
 * Volume (0..1) of a source `distance` tiles from the listener: 1 up to
 * `REF_DISTANCE`, then inverse-distance rolloff (as WebAudio's `inverse`
 * model), faded to exactly 0 over the last quarter before `MAX_DISTANCE`.
 * Never increases with distance.
 */
export function attenuation(distance: number): number {
  if (!(distance > REF_DISTANCE)) return 1;
  if (distance >= MAX_DISTANCE) return 0;
  const inverse = REF_DISTANCE / (REF_DISTANCE + ROLLOFF * (distance - REF_DISTANCE));
  const fadeStart = MAX_DISTANCE * 0.75;
  const fade = distance <= fadeStart ? 1 : (MAX_DISTANCE - distance) / (MAX_DISTANCE - fadeStart);
  return inverse * fade;
}

/** Overall gain for a camera zoom: 1 from zoom 1 up, down to 0.5 at the minimum zoom. */
export function zoomGain(zoom: number): number {
  return Math.min(1, Math.max(0.5, Math.sqrt(zoom)));
}

/** Stereo position (−1 left … 1 right) of a source `dx` tiles right of the listener; kept off the extremes. */
export function panFor(dx: number): number {
  return Math.max(-0.7, Math.min(0.7, dx / 24));
}

/** Gain and pan of a source at `(x, y)` tiles heard from `listener`. */
export function positional(
  listener: Listener,
  x: number,
  y: number,
): { gain: number; pan: number } {
  const dx = x - listener.x;
  const dy = y - listener.y;
  return {
    gain: attenuation(Math.hypot(dx, dy)) * zoomGain(listener.zoom),
    pan: panFor(dx),
  };
}

export interface LoopVoicePlan extends LoopSource {
  gain: number;
  pan: number;
}

/**
 * The loop sources that get a voice: the loudest (nearest) `max` of those
 * that are audible at all, loudest first. Ties go to the lower id, so the
 * choice doesn't flicker between equally distant machines.
 */
export function selectLoopVoices(
  sources: readonly LoopSource[],
  listener: Listener,
  max: number = MAX_LOOP_VOICES,
): LoopVoicePlan[] {
  const audible: LoopVoicePlan[] = [];
  for (const s of sources) {
    const p = positional(listener, s.x, s.y);
    if (p.gain >= MIN_AUDIBLE_GAIN) audible.push({ ...s, ...p });
  }
  audible.sort((a, b) => b.gain - a.gain || a.id - b.id);
  return audible.slice(0, Math.max(0, max));
}

/**
 * The belts' combined hum: one voice, louder with more moving belts nearby
 * (the sum of their attenuations, saturating), panned to their weighted
 * center. `null` when none is audible.
 */
export function beltHum(
  belts: readonly { x: number; y: number }[],
  listener: Listener,
): { gain: number; pan: number } | null {
  let sum = 0;
  let panSum = 0;
  for (const b of belts) {
    const p = positional(listener, b.x, b.y);
    sum += p.gain;
    panSum += p.gain * p.pan;
  }
  if (sum < MIN_AUDIBLE_GAIN) return null;
  // Saturates: a dozen belts at full volume is as loud as it gets.
  return { gain: 1 - Math.exp(-sum / 6), pan: panSum / sum };
}

/** Per-kind limits for one-shots: shortest gap between two (s), and most at once. */
export const ONE_SHOT_LIMITS: Record<SoundEventKind, { minGap: number; maxActive: number }> = {
  place: { minGap: 0.04, maxActive: 3 },
  remove: { minGap: 0.04, maxActive: 3 },
  'mine-hit': { minGap: 0.08, maxActive: 2 },
  mined: { minGap: 0.08, maxActive: 2 },
  'craft-done': { minGap: 0.15, maxActive: 2 },
  inserter: { minGap: 0.06, maxActive: 4 },
  'research-complete': { minGap: 2, maxActive: 1 },
  'low-power': { minGap: 4, maxActive: 1 },
  'ui-click': { minGap: 0.03, maxActive: 2 },
};

/**
 * Caps one-shot voices: at most `maxTotal` at once, and per kind at most
 * `maxActive` at once and one per `minGap` seconds. Sounds that don't fit
 * are dropped (with many inserters swinging, a few audible ones are enough).
 */
export class OneShotLimiter {
  private readonly active: { kind: SoundEventKind; end: number }[] = [];
  private readonly last = new Map<SoundEventKind, number>();

  constructor(private readonly maxTotal: number = MAX_ONE_SHOTS) {}

  /** Whether a `kind` sound lasting `duration` s may start at `now`; if so, it is counted. */
  tryStart(kind: SoundEventKind, now: number, duration: number): boolean {
    for (let i = this.active.length - 1; i >= 0; i--) {
      if (this.active[i]!.end <= now) this.active.splice(i, 1);
    }
    const limit = ONE_SHOT_LIMITS[kind];
    if (this.active.length >= this.maxTotal) return false;
    if (now - (this.last.get(kind) ?? -Infinity) < limit.minGap) return false;
    if (this.active.filter((a) => a.kind === kind).length >= limit.maxActive) return false;
    this.active.push({ kind, end: now + duration });
    this.last.set(kind, now);
    return true;
  }

  /** One-shots still playing at `now`. */
  activeAt(now: number): number {
    return this.active.filter((a) => a.end > now).length;
  }
}

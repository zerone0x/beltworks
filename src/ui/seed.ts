/**
 * World seeds on the title screen: what the player types into the seed
 * field, and a fresh random seed to suggest. Main-thread only (the
 * simulation never sees anything but the resulting uint32, D4).
 */

import { fnv1a32 } from '../sim/hash';

/** Largest seed: the simulation coerces seeds to uint32. */
export const MAX_SEED = 0xffff_ffff;

/**
 * The seed for text `text` from the seed field: a whole number in
 * [0, 2³² − 1] is that seed; any other text (a word, a phrase) hashes to
 * one, so `factory` is always the same world. `null` for empty text.
 */
export function parseSeed(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (n <= MAX_SEED) return n;
  }
  return fnv1a32(new TextEncoder().encode(trimmed)) >>> 0;
}

/** A random seed (not deterministic: only ever a suggestion on the title screen). */
export function randomSeed(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0]!;
}

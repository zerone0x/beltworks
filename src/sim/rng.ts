/**
 * Seeded pseudo-random number generator for the simulation.
 *
 * Algorithm: xoshiro128** 1.1 (Blackman & Vigna), operating purely on uint32
 * values so that results are bit-identical across JS engines. The 128-bit state
 * is derived from a 32-bit seed with splitmix32.
 *
 * This is the only source of randomness allowed inside `src/sim`.
 */

const UINT32_RANGE = 0x1_0000_0000;

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/**
 * splitmix32: a small generator used only to expand a 32-bit seed into the
 * 128-bit xoshiro state. Returns a function yielding successive uint32 values.
 */
export function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}

export class Rng {
  private readonly s: Uint32Array;

  private constructor(state: Uint32Array) {
    this.s = state;
  }

  /** Creates a generator from a 32-bit seed (non-integers and out-of-range values are coerced with `>>> 0`). */
  static fromSeed(seed: number): Rng {
    const next = splitmix32(seed);
    return Rng.fromState([next(), next(), next(), next()]);
  }

  /**
   * Creates a generator from an explicit 128-bit state (four uint32 words),
   * e.g. one previously returned by {@link Rng.getState}. The state must not be all zero.
   */
  static fromState(state: ArrayLike<number>): Rng {
    if (state.length !== 4) {
      throw new RangeError(`Rng state must have 4 words, got ${String(state.length)}`);
    }
    const s = Uint32Array.from(state);
    if ((s[0]! | s[1]! | s[2]! | s[3]!) === 0) {
      throw new RangeError('Rng state must not be all zero');
    }
    return new Rng(s);
  }

  /** Returns a copy of the internal state, suitable for saving and for {@link Rng.fromState}. */
  getState(): Uint32Array {
    return this.s.slice();
  }

  /** Returns the next uniformly distributed uint32 in [0, 2^32). */
  nextU32(): number {
    const s = this.s;
    const s0 = s[0]!;
    const s1 = s[1]!;
    const s2 = s[2]!;
    const s3 = s[3]!;

    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;

    const n2 = s2 ^ s0;
    const n3 = s3 ^ s1;
    s[1] = s1 ^ n2;
    s[0] = s0 ^ n3;
    s[2] = n2 ^ t;
    s[3] = rotl(n3, 11);

    return result;
  }

  /**
   * Returns a uniformly distributed integer in [0, maxExclusive) without modulo bias
   * (rejection sampling). `maxExclusive` must be an integer in [1, 2^32].
   */
  nextInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > UINT32_RANGE) {
      throw new RangeError(
        `maxExclusive must be an integer in [1, 2^32], got ${String(maxExclusive)}`,
      );
    }
    // Values below `threshold` would make the low residues more likely; reject them.
    const threshold = (UINT32_RANGE - maxExclusive) % maxExclusive;
    for (;;) {
      const r = this.nextU32();
      if (r >= threshold) {
        return r % maxExclusive;
      }
    }
  }
}

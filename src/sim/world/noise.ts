/**
 * Integer-only 2D value noise for world generation.
 *
 * Everything here works on int32/uint32 values with `Math.imul`, shifts, and
 * small products that stay well inside the int32 range, so results are
 * bit-identical across JS engines and no floating-point value is produced.
 *
 * Coordinates are int32 tile coordinates; negative values are fine because
 * `>>` floors and `&` yields the non-negative remainder in two's complement.
 */

/** Noise values are in `[0, NOISE_MAX]`. */
export const NOISE_BITS = 16;
export const NOISE_MAX = (1 << NOISE_BITS) - 1;

/** Fixed-point precision of the interpolation weights. */
const FRAC_BITS = 12;
const FRAC_ONE = 1 << FRAC_BITS;

/** Final avalanche step of murmur3 (fmix32). */
function fmix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hashes an integer lattice point to a uint32, for a given seed. */
export function hash2(seed: number, x: number, y: number): number {
  let h = fmix32(seed ^ 0x9e3779b9);
  h = fmix32(h ^ Math.imul(x | 0, 0x27d4eb2d));
  h = fmix32(h ^ Math.imul(y | 0, 0x165667b1));
  return h;
}

/** Hashes an integer lattice point to a noise value in `[0, NOISE_MAX]`. */
function lattice(seed: number, x: number, y: number): number {
  return hash2(seed, x, y) >>> (32 - NOISE_BITS);
}

/** Smoothstep `3t^2 - 2t^3` on a `FRAC_BITS` fixed-point weight. Max intermediate < 2^27. */
function smooth(t: number): number {
  return (((t * t) >> FRAC_BITS) * (3 * FRAC_ONE - 2 * t)) >> FRAC_BITS;
}

/** `a + (b - a) * t` with a `FRAC_BITS` fixed-point weight. `|b - a| * t < 2^28`. */
function lerp(a: number, b: number, t: number): number {
  return a + (((b - a) * t) >> FRAC_BITS);
}

/**
 * Smoothly interpolated value noise with lattice points every `2^cellShift`
 * tiles. Returns an integer in `[0, NOISE_MAX]`. `cellShift` must be in `[0, FRAC_BITS]`.
 */
export function valueNoise(seed: number, x: number, y: number, cellShift: number): number {
  const gx = x >> cellShift;
  const gy = y >> cellShift;
  const mask = (1 << cellShift) - 1;
  const up = FRAC_BITS - cellShift;
  const tx = smooth((x & mask) << up);
  const ty = smooth((y & mask) << up);

  const v00 = lattice(seed, gx, gy);
  const v10 = lattice(seed, gx + 1, gy);
  const v01 = lattice(seed, gx, gy + 1);
  const v11 = lattice(seed, gx + 1, gy + 1);

  return lerp(lerp(v00, v10, tx), lerp(v01, v11, tx), ty);
}

/**
 * Fractal sum of value noise octaves.
 *
 * Plain value noise shows its square lattice as long axis-aligned ridges, so
 * each octave samples a rotated domain instead: `(4x - 3y, 3x + 4y)` or its
 * mirror image on alternate octaves. That is an exact integer rotation by
 * ~36.87 degrees scaled by 5, so octave `i` has lattice points about every
 * `2^(cellShift - i) / 5` tiles. Octaves are weighted 8:4:2:1:... (each half
 * the previous) and the sum is normalized back to `[0, NOISE_MAX]`.
 *
 * Requires `cellShift - octaves + 1 >= 0` and `|x|, |y| < 2^28`.
 */
export function fractalNoise(
  seed: number,
  x: number,
  y: number,
  cellShift: number,
  octaves: number,
): number {
  const ax = 4 * x - 3 * y;
  const ay = 3 * x + 4 * y;
  const bx = 4 * x + 3 * y;
  const by = 4 * y - 3 * x;
  let sum = 0;
  let totalWeight = 0;
  let weight = 1 << (octaves - 1);
  for (let i = 0; i < octaves; i++) {
    const octaveSeed = (seed + Math.imul(i + 1, 0x632be5ab)) | 0;
    const odd = (i & 1) === 1;
    sum += valueNoise(octaveSeed, odd ? bx : ax, odd ? by : ay, cellShift - i) * weight;
    totalWeight += weight;
    weight >>= 1;
  }
  return Math.trunc(sum / totalWeight);
}

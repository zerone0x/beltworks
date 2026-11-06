import { describe, expect, it } from 'vitest';
import { NOISE_MAX, fractalNoise, hash2, valueNoise } from '../../src/sim/world/noise';

describe('hash2', () => {
  it('is deterministic and returns uint32 values', () => {
    for (let i = -50; i < 50; i++) {
      const h = hash2(1234, i, -i * 7);
      expect(h).toBe(hash2(1234, i, -i * 7));
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(2 ** 32);
    }
  });

  it('depends on the seed and on both coordinates', () => {
    expect(hash2(1, 3, 4)).not.toBe(hash2(2, 3, 4));
    expect(hash2(1, 3, 4)).not.toBe(hash2(1, 4, 3));
    expect(hash2(1, -3, 4)).not.toBe(hash2(1, 3, 4));
  });

  it('matches pinned reference values (cross-engine regression guard)', () => {
    expect([hash2(0, 0, 0), hash2(42, -1, 1), hash2(0xffffffff, 123456, -654321)]).toEqual([
      0x642f30e0, 0x6a776b21, 0xbb9cf8f3,
    ]);
  });
});

describe('valueNoise', () => {
  it('returns integers in [0, NOISE_MAX], including at negative coordinates', () => {
    for (let y = -70; y < 70; y += 3) {
      for (let x = -70; x < 70; x += 3) {
        const v = valueNoise(99, x, y, 4);
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(NOISE_MAX);
      }
    }
  });

  it('equals the lattice hash at lattice points', () => {
    for (const [x, y] of [
      [0, 0],
      [16, -32],
      [-48, 64],
    ] as const) {
      expect(valueNoise(5, x, y, 4)).toBe(hash2(5, x >> 4, y >> 4) >>> 16);
    }
  });

  it('is continuous across lattice cells and the origin', () => {
    // Neighboring tiles never jump by more than one cell's worth of slope.
    const maxStep = Math.ceil((NOISE_MAX * 1.5) / 16) + 1;
    for (let y = -40; y < 40; y += 5) {
      for (let x = -40; x < 40; x++) {
        expect(Math.abs(valueNoise(7, x + 1, y, 4) - valueNoise(7, x, y, 4))).toBeLessThanOrEqual(
          maxStep,
        );
        expect(Math.abs(valueNoise(7, y, x + 1, 4) - valueNoise(7, y, x, 4))).toBeLessThanOrEqual(
          maxStep,
        );
      }
    }
  });
});

describe('fractalNoise', () => {
  it('returns integers in [0, NOISE_MAX] and is deterministic', () => {
    for (let i = -100; i < 100; i += 7) {
      const v = fractalNoise(3, i * 13, -i * 5, 9, 4);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(NOISE_MAX);
      expect(fractalNoise(3, i * 13, -i * 5, 9, 4)).toBe(v);
    }
  });

  it('varies with the seed', () => {
    let differing = 0;
    for (let x = 0; x < 200; x += 10) {
      if (fractalNoise(1, x, x, 9, 4) !== fractalNoise(2, x, x, 9, 4)) differing++;
    }
    expect(differing).toBeGreaterThan(15);
  });
});

import { describe, expect, it } from 'vitest';
import { Rng, splitmix32 } from '../../src/sim/rng';

// Expected vectors were produced by an independent reference implementation of
// splitmix32 / xoshiro128** 1.1, not by this code.

describe('splitmix32', () => {
  it('matches known outputs', () => {
    const next = splitmix32(0);
    expect([next(), next(), next(), next()]).toEqual([
      0x64625032, 0xd9c0799c, 0xaf362e10, 0x7fa88912,
    ]);
  });
});

describe('Rng (xoshiro128**)', () => {
  it('matches the reference output for state [1, 2, 3, 4]', () => {
    const rng = Rng.fromState([1, 2, 3, 4]);
    const out = Array.from({ length: 8 }, () => rng.nextU32());
    expect(out).toEqual([
      11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849,
    ]);
  });

  it.each([
    [0, [1789933344, 44971166, 2521387044, 3848737593, 1138324114, 749234105]],
    [1, [393288148, 2174103013, 3814759091, 2092745082, 1865176206, 2179171167]],
    [42, [660444221, 3652823732, 77672526, 910233633, 2297337756, 3786072677]],
    [0xdeadbeef, [3842467093, 879304004, 3694663928, 2788030634, 934155191, 702880729]],
  ])('matches known outputs for seed %i', (seed, expected) => {
    const rng = Rng.fromSeed(seed);
    expect(Array.from({ length: expected.length }, () => rng.nextU32())).toEqual(expected);
  });

  it('seeds from the expanded splitmix32 state', () => {
    expect(Array.from(Rng.fromSeed(42).getState())).toEqual([
      0x20e44818, 0x0895a923, 0x1339a01f, 0xb4e3841a,
    ]);
  });

  it('always returns uint32 values', () => {
    const rng = Rng.fromSeed(7);
    for (let i = 0; i < 10_000; i++) {
      const v = rng.nextU32();
      expect(Number.isInteger(v) && v >= 0 && v <= 0xffffffff).toBe(true);
    }
  });

  it('is reproducible and can resume from a saved state', () => {
    const a = Rng.fromSeed(123);
    a.nextU32();
    a.nextU32();
    const b = Rng.fromState(a.getState());
    for (let i = 0; i < 100; i++) {
      expect(b.nextU32()).toBe(a.nextU32());
    }
  });

  it('getState returns a copy', () => {
    const rng = Rng.fromSeed(1);
    const state = rng.getState();
    state.fill(0);
    expect(rng.nextU32()).toBe(393288148);
  });

  it('rejects invalid states', () => {
    expect(() => Rng.fromState([0, 0, 0, 0])).toThrow(RangeError);
    expect(() => Rng.fromState([1, 2, 3])).toThrow(RangeError);
  });

  describe('nextInt', () => {
    it('matches known outputs', () => {
      const rng = Rng.fromSeed(42);
      expect(Array.from({ length: 10 }, () => rng.nextInt(10))).toEqual([
        1, 2, 6, 3, 6, 7, 4, 6, 1, 9,
      ]);
    });

    it('rejects biased values for large ranges', () => {
      // With maxExclusive = 3e9 the threshold is 1294967296, so the seed-42 outputs
      // 660444221, 77672526 and 910233633 are rejected.
      const rng = Rng.fromSeed(42);
      expect(Array.from({ length: 6 }, () => rng.nextInt(3_000_000_000))).toEqual([
        652823732, 2297337756, 786072677, 123505064, 1891482476, 2460634111,
      ]);
    });

    it('stays in range', () => {
      const rng = Rng.fromSeed(99);
      for (const max of [1, 2, 3, 7, 100, 0x7fffffff, 0x1_0000_0000]) {
        for (let i = 0; i < 1000; i++) {
          const v = rng.nextInt(max);
          expect(Number.isInteger(v) && v >= 0 && v < max).toBe(true);
        }
      }
    });

    it('returns 0 for maxExclusive = 1', () => {
      const rng = Rng.fromSeed(5);
      expect(rng.nextInt(1)).toBe(0);
    });

    it('is the raw uint32 output for maxExclusive = 2^32', () => {
      expect(Rng.fromSeed(42).nextInt(0x1_0000_0000)).toBe(Rng.fromSeed(42).nextU32());
    });

    it.each([0, -1, 1.5, Number.NaN, Infinity, 0x1_0000_0001])('throws for %s', (max) => {
      expect(() => Rng.fromSeed(1).nextInt(max)).toThrow(RangeError);
    });
  });
});

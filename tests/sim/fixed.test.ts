import { describe, expect, it } from 'vitest';
import {
  HALF_TILE,
  PROGRESS_ONE,
  SUBTILES_PER_TILE,
  fixedFrac,
  fixedToTile,
  isInt32,
  tileCenter,
  tileToFixed,
} from '../../src/sim/fixed';

describe('fixed-point helpers', () => {
  it('uses 1/256-tile positions and 1/65536 progress', () => {
    expect(SUBTILES_PER_TILE).toBe(256);
    expect(HALF_TILE).toBe(128);
    expect(PROGRESS_ONE).toBe(65536);
  });

  it('converts between tiles and subtiles', () => {
    expect(tileToFixed(3)).toBe(768);
    expect(tileToFixed(-2)).toBe(-512);
    expect(tileCenter(0)).toBe(128);
    expect(tileCenter(-1)).toBe(-128);
  });

  it('floors toward negative infinity', () => {
    expect(fixedToTile(0)).toBe(0);
    expect(fixedToTile(255)).toBe(0);
    expect(fixedToTile(256)).toBe(1);
    expect(fixedToTile(-1)).toBe(-1);
    expect(fixedToTile(-256)).toBe(-1);
    expect(fixedToTile(-257)).toBe(-2);
    expect(fixedFrac(-1)).toBe(255);
    expect(fixedFrac(257)).toBe(1);
  });

  it('round-trips every tile and offset in a range', () => {
    for (let t = -40; t <= 40; t++) {
      for (const off of [0, 1, 127, 128, 255]) {
        const f = tileToFixed(t) + off;
        expect(fixedToTile(f)).toBe(t);
        expect(fixedFrac(f)).toBe(off);
      }
    }
  });

  it('detects int32 values', () => {
    expect(isInt32(0)).toBe(true);
    expect(isInt32(-(2 ** 31))).toBe(true);
    expect(isInt32(2 ** 31 - 1)).toBe(true);
    expect(isInt32(2 ** 31)).toBe(false);
    expect(isInt32(0.5)).toBe(false);
    expect(isInt32(Number.NaN)).toBe(false);
  });
});

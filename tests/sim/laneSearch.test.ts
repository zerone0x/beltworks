/**
 * The lane queries search a cache of item positions (`Lane.seek`, #73)
 * instead of walking the gaps from the end. They must answer exactly what
 * the walks did: these are the walks as they were, checked against the
 * lane on random lanes (short ones walk, long ones search), between random
 * moves, inserts and removals that change the cache.
 */
import { describe, expect, it } from 'vitest';
import { Lane } from '../../src/sim/belts/lane';
import { Rng } from '../../src/sim/rng';

const MIN_SAFE = Number.MIN_SAFE_INTEGER;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;

function positions(lane: Lane): number[] {
  const out: number[] = [];
  let d = 0;
  for (let i = 0; i < lane.count; i++) out.push((d += lane.gap(i)));
  return out;
}

function slotFor(p: number[], pos: number, spacing: number): number | null {
  let d = 0;
  for (let i = 0; i < p.length; i++) {
    const next = p[i]!;
    if (next >= pos) {
      if (next - pos < spacing) return null;
      if (i > 0 && pos - d < spacing) return null;
      return i;
    }
    d = next;
  }
  if (p.length > 0 && pos - d < spacing) return null;
  return p.length;
}

function find(p: number[], from: number, to: number): number {
  for (let i = 0; i < p.length; i++) {
    if (p[i]! > to) return -1;
    if (p[i]! >= from) return i;
  }
  return -1;
}

function fitNear(p: number[], pos: number, slack: number, spacing: number): number {
  if (pos < 0) return -1;
  let q = pos;
  for (const d of p) {
    if (d + spacing <= q) continue;
    if (d >= q + spacing) break;
    q = d + spacing;
    if (q > pos + slack) return -1;
  }
  return q;
}

function fitBetween(p: number[], lo: number, hi: number, near: number, spacing: number): number {
  if (lo < 0) lo = 0;
  if (lo > hi) return -1;
  let best = -1;
  let bestDist = MAX_SAFE;
  let prev = MIN_SAFE;
  for (let i = 0; i <= p.length; i++) {
    const next = i < p.length ? p[i]! : MAX_SAFE;
    const a = Math.max(lo, prev + spacing);
    const b = Math.min(hi, next - spacing);
    if (a <= b) {
      const q = near < a ? a : near > b ? b : near;
      const dist = Math.abs(q - near);
      if (dist < bestDist) {
        best = q;
        bestDist = dist;
      }
      if (a >= near) break;
    }
    if (next >= hi - spacing + 1) break;
    prev = next;
  }
  return best;
}

function checkQueries(lane: Lane, rng: Rng, length: number): void {
  const p = positions(lane);
  for (let q = 0; q < 40; q++) {
    const pos = rng.nextInt(length + 200) - 100;
    const spacing = [64, 96, 128][rng.nextInt(3)]!;
    expect(lane.canInsert(pos)).toBe(pos >= 0 && slotFor(p, pos, lane.spacing) !== null);
    const from = rng.nextInt(length + 64);
    const to = from + rng.nextInt(320);
    expect(lane.find(from, to)).toBe(find(p, from, to));
    const slack = rng.nextInt(160);
    expect(lane.fitNear(pos, slack, spacing)).toBe(fitNear(p, pos, slack, spacing));
    const lo = rng.nextInt(length + 64) - 32;
    const hi = lo + rng.nextInt(320) - 16;
    const near = lo + rng.nextInt(300) - 20;
    expect(lane.fitBetween(lo, hi, near, spacing)).toBe(fitBetween(p, lo, hi, near, spacing));
    for (let i = 0; i < p.length; i += 1 + rng.nextInt(7)) expect(lane.position(i)).toBe(p[i]);
  }
}

describe('Lane searches', () => {
  it('answer exactly what walking the gaps answers, through moves, inserts and removals', () => {
    const rng = Rng.fromSeed(73);
    for (let round = 0; round < 60; round++) {
      const lane = new Lane(64);
      // Short lanes (walked) and long ones (searched), sparse and packed.
      const items = rng.nextInt(round % 2 === 0 ? 10 : 160);
      let gap = rng.nextInt(64);
      for (let i = 0; i < items; i++) {
        lane.pushBack(gap, 1 + rng.nextInt(20));
        gap = 64 + (rng.nextInt(3) === 0 ? rng.nextInt(300) : 0);
      }
      const length = lane.total + 256;
      checkQueries(lane, rng, length);
      for (let step = 0; step < 30; step++) {
        switch (rng.nextInt(4)) {
          case 0:
            lane.move(8 + rng.nextInt(17));
            break;
          case 1:
            lane.insert(rng.nextInt(length), 2);
            break;
          case 2:
            if (lane.count > 0) lane.removeAt(rng.nextInt(lane.count));
            break;
          default:
            lane.setSpacing(rng.nextInt(2) === 0 ? 64 : 128);
        }
        checkQueries(lane, rng, length);
      }
    }
  });
});

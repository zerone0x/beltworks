/**
 * The WebGPU belt demo's CPU side (#129, demo/gpu/README.md): the belt
 * network is one connected loop with a splitter and a merge, the reference
 * step conserves and moves items deterministically, and the view and limits
 * helpers. `gpuDemo.spec.ts` checks the GPU against this reference.
 */

import { describe, expect, it } from 'vitest';
import { fitView, maxItems } from '../../demo/gpu/gpu';
import {
  DIRS,
  GROUP_COUNT,
  Group,
  SEGMENT_LENGTH,
  SPEED,
  SegmentField as F,
  buildNetwork,
  field,
  type Network,
} from '../../demo/gpu/network';
import {
  Counter,
  ITEM_TYPES,
  cloneItems,
  initItems,
  itemHash,
  mix32,
  referenceCounters,
  referenceRun,
  referenceStep,
} from '../../demo/gpu/sim';

const net = buildNetwork();

function successors(n: Network, s: number): number[] {
  return [...new Set([field(n, s, F.next0), field(n, s, F.next1)])];
}

describe('belt network', () => {
  it('has a few hundred segments with straight runs and corners', () => {
    expect(net.count).toBeGreaterThanOrEqual(200);
    expect(net.count).toBeLessThan(1000);
    let corners = 0;
    for (let s = 0; s < net.count; s++) {
      if (field(net, s, F.inDir) !== field(net, s, F.outDir)) corners++;
    }
    expect(corners).toBeGreaterThanOrEqual(8);
    expect(net.count - corners).toBeGreaterThan(corners);
  });

  it('links every segment to a neighbor tile entered in its exit direction', () => {
    for (let s = 0; s < net.count; s++) {
      const x = field(net, s, F.x);
      const y = field(net, s, F.y);
      expect(x).toBeLessThan(net.width);
      expect(y).toBeLessThan(net.height);
      const [dx, dy] = DIRS[field(net, s, F.outDir)]!;
      for (const t of successors(net, s)) {
        expect(t).toBeLessThan(net.count);
        expect([field(net, t, F.x), field(net, t, F.y)]).toEqual([x + dx, y + dy]);
        expect(field(net, t, F.inDir)).toBe(field(net, s, F.outDir));
      }
      expect(field(net, s, F.speed)).toBeGreaterThan(0);
      expect(field(net, s, F.speed)).toBeLessThan(SEGMENT_LENGTH);
      expect(field(net, s, F.group)).toBeLessThan(GROUP_COUNT);
    }
  });

  it('has one splitter and one merge, the only tiles holding two segments', () => {
    const splitters: number[] = [];
    const inDegree = new Array<number>(net.count).fill(0);
    const perTile = new Map<string, number>();
    for (let s = 0; s < net.count; s++) {
      const next = successors(net, s);
      if (next.length > 1) splitters.push(s);
      for (const t of next) inDegree[t]!++;
      const key = `${String(field(net, s, F.x))},${String(field(net, s, F.y))}`;
      perTile.set(key, (perTile.get(key) ?? 0) + 1);
    }
    expect(splitters).toHaveLength(1);
    const merges = inDegree.flatMap((d, s) => (d > 1 ? [s] : []));
    expect(merges).toHaveLength(1);
    expect(inDegree.every((d) => d >= 1)).toBe(true);
    expect([...perTile.values()].filter((c) => c > 1)).toEqual([2, 2]);
    // The splitter feeds the two branches; both branches end in the merge.
    const [a, b] = successors(net, splitters[0]!);
    expect([field(net, a!, F.group), field(net, b!, F.group)]).toEqual([
      Group.branchA,
      Group.branchB,
    ]);
  });

  it('is one loop: every segment reaches every other', () => {
    const reach = (from: number, next: (s: number) => number[]): number => {
      const seen = new Set([from]);
      const stack = [from];
      while (stack.length > 0) {
        for (const t of next(stack.pop()!)) {
          if (!seen.has(t)) {
            seen.add(t);
            stack.push(t);
          }
        }
      }
      return seen.size;
    };
    const preds: number[][] = Array.from({ length: net.count }, () => []);
    for (let s = 0; s < net.count; s++) for (const t of successors(net, s)) preds[t]!.push(s);
    expect(reach(0, (s) => successors(net, s))).toBe(net.count);
    expect(reach(0, (s) => preds[s]!)).toBe(net.count);
  });

  it('uses all three belt speeds', () => {
    const speeds = new Set<number>();
    for (let s = 0; s < net.count; s++) speeds.add(field(net, s, F.speed));
    expect([...speeds].sort((x, y) => x - y)).toEqual([SPEED.slow, SPEED.fast, SPEED.express]);
  });
});

describe('reference step', () => {
  it('hashes with wrapping 32-bit multiplies, as WGSL u32 arithmetic does', () => {
    // lowbias32 in BigInt arithmetic, reduced mod 2^32 after each multiply.
    const wide = (v: number): number => {
      const M = (1n << 32n) - 1n;
      let x = BigInt(v >>> 0);
      x ^= x >> 16n;
      x = (x * 0x7feb352dn) & M;
      x ^= x >> 15n;
      x = (x * 0x846ca68bn) & M;
      x ^= x >> 16n;
      return Number(x);
    };
    for (const v of [0, 1, 2, 255, 0x80000000, 0xffffffff, 123456789]) {
      expect(mix32(v)).toBe(wide(v));
    }
    for (let v = 0; v < 100_000; v += 7) expect(mix32(v * 40503)).toBe(wide(v * 40503));
  });

  it('starts every item on the network with an item type by quarter', () => {
    const items = initItems(10_000, net);
    const counters = referenceCounters(items, net);
    const types = Array.from(counters.subarray(Counter.types, Counter.types + ITEM_TYPES));
    expect(types.reduce((s, c) => s + c, 0)).toBe(10_000);
    expect(Math.min(...types)).toBeGreaterThan(2000);
    for (let i = 0; i < items.belt.length; i++) {
      expect(items.belt[i]).toBeLessThan(net.count);
      expect(items.progress[i]).toBeLessThan(SEGMENT_LENGTH);
    }
  });

  it('advances each item by its belt speed and carries the rest into the next segment', () => {
    const n = 2000;
    const before = initItems(n, net);
    const after = cloneItems(before);
    referenceStep(before, after, net, 0);
    for (let i = 0; i < n; i++) {
      const s = before.belt[i]!;
      const p = before.progress[i]! + field(net, s, F.speed);
      if (p < SEGMENT_LENGTH) {
        expect([after.belt[i], after.progress[i]]).toEqual([s, p]);
      } else {
        expect(successors(net, s)).toContain(after.belt[i]);
        expect(after.progress[i]).toBe(p - SEGMENT_LENGTH);
      }
    }
  });

  it('is deterministic and conserves items, and the checksum follows the state', () => {
    const items = initItems(5000, net);
    const a = referenceRun(items, net, 500);
    const b = referenceRun(items, net, 500);
    expect(a.belt).toEqual(b.belt);
    expect(a.progress).toEqual(b.progress);
    const start = referenceCounters(items, net);
    const end = referenceCounters(a, net);
    const total = (c: Uint32Array) =>
      Array.from(c.subarray(Counter.groups, Counter.groups + GROUP_COUNT)).reduce((s, x) => s + x);
    expect(total(end)).toBe(5000);
    expect(end.subarray(Counter.types, Counter.types + ITEM_TYPES)).toEqual(
      start.subarray(Counter.types, Counter.types + ITEM_TYPES),
    );
    expect(end[Counter.checksum]).not.toBe(start[Counter.checksum]);
    expect(referenceCounters(b, net)).toEqual(end);
    // The checksum is a wrapping sum, so the order of items doesn't matter.
    let sum = 0;
    for (let i = 0; i < 5000; i++) sum = (sum + itemHash(i, a.belt[i]!, a.progress[i]!)) >>> 0;
    expect(end[Counter.checksum]).toBe(sum);
  });

  it('sends about half the items through each splitter output', () => {
    const splitter = Array.from({ length: net.count }, (_, s) => s).find(
      (s) => successors(net, s).length > 1,
    )!;
    const [toA, toB] = successors(net, splitter) as [number, number];
    let src = initItems(20_000, net);
    let dst = cloneItems(src);
    const taken = [0, 0, 0];
    for (let tick = 0; tick < 1200; tick++) {
      referenceStep(src, dst, net, tick);
      for (let i = 0; i < src.belt.length; i++) {
        if (src.belt[i] === splitter && dst.belt[i] !== splitter) {
          taken[dst.belt[i] === toA ? 0 : dst.belt[i] === toB ? 1 : 2]!++;
        }
      }
      [src, dst] = [dst, src];
    }
    expect(taken[2]).toBe(0);
    const share = taken[0]! / (taken[0]! + taken[1]!);
    expect(taken[0]! + taken[1]!).toBeGreaterThan(4000);
    expect(share).toBeGreaterThan(0.46);
    expect(share).toBeLessThan(0.54);
  });
});

describe('device limits and view', () => {
  it('caps the item count by storage bindings, buffers and workgroups', () => {
    const limits = (binding: number, buffer: number, groups: number) =>
      ({
        maxStorageBufferBindingSize: binding,
        maxBufferSize: buffer,
        maxComputeWorkgroupsPerDimension: groups,
      }) as GPUSupportedLimits;
    expect(maxItems(limits(128 << 20, 256 << 20, 65535))).toBe(65535 * 256);
    expect(maxItems(limits(1 << 20, 256 << 20, 65535))).toBe(1 << 18);
    expect(maxItems(limits(128 << 20, 2 << 20, 65535))).toBe(1 << 19);
  });

  it('fits the grid below the overlay, centered', () => {
    const v = fitView(net, 1280, 720, 120);
    const toPixel = (x: number, y: number): [number, number] => [
      ((x * v.scale[0] + v.offset[0] + 1) / 2) * 1280,
      ((1 - (y * v.scale[1] + v.offset[1])) / 2) * 720,
    ];
    const [left, top] = toPixel(0, 0);
    const [right, bottom] = toPixel(net.width, net.height);
    expect(top).toBeGreaterThanOrEqual(120 - 1e-6);
    expect(bottom).toBeLessThanOrEqual(720 + 1e-6);
    expect(left).toBeCloseTo(1280 - right, 6);
    expect(Math.max(right - left - 1280, bottom - top - 600)).toBeCloseTo(0, 6);
  });
});

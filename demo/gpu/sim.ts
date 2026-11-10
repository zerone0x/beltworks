/**
 * The item model shared by the GPU and the pure-TS reference: structure-of-arrays
 * item state, its initial layout, one tick of the reference step, and the
 * aggregate counters. `shaders.ts` implements the same step and counters in
 * WGSL; `tests/gpu/` checks that both agree bit for bit.
 *
 * All state is integer: a belt id and a progress in 16.16 fixed point
 * (`SEGMENT_LENGTH` units per tile), so the result is exact on any device.
 */

import { GROUP_COUNT, SEGMENT_LENGTH, SEGMENT_WORDS, SegmentField, type Network } from './network';

/** The number of item types (colors). */
export const ITEM_TYPES = 4;

/** Words in the counters buffer: per-group counts, per-type counts, a checksum. */
export const COUNTER_WORDS = 8;
export const Counter = {
  /** First of `GROUP_COUNT` per-group item counts. */
  groups: 0,
  /** First of `ITEM_TYPES` per-type item counts. */
  types: GROUP_COUNT,
  /** Wrapping sum of `itemHash` over all items: order independent. */
  checksum: GROUP_COUNT + ITEM_TYPES,
} as const;

/**
 * Item state as structure of arrays. `belt` and `progress` change every tick
 * (the GPU double-buffers them); `itemType` never changes.
 */
export interface Items {
  readonly belt: Uint32Array;
  readonly progress: Uint32Array;
  readonly itemType: Uint32Array;
}

/** A 32-bit integer hash (lowbias32); `mix32` in `shaders.ts` is the same function. */
export function mix32(v: number): number {
  let x = v >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/** Which output of a splitter item `i` takes when it leaves the splitter's input on `tick`. */
export function splitterOutput(i: number, tick: number): number {
  return mix32(i ^ mix32(tick)) & 1;
}

/** The checksum term of one item. */
export function itemHash(i: number, belt: number, progress: number): number {
  return mix32(i ^ mix32(belt ^ mix32(progress)));
}

/**
 * The starting layout of `n` items: item `i` starts on segment `i % count`,
 * the items of a segment spread over its first five eighths (so the belts
 * show moving dashes), and the item type is the quarter of the network the
 * item starts in (so the colors visibly flow and mix at the splitter and merge).
 */
export function initItems(n: number, net: Network): Items {
  const belt = new Uint32Array(n);
  const progress = new Uint32Array(n);
  const itemType = new Uint32Array(n);
  const perSegment = Math.ceil(n / net.count);
  const span = (SEGMENT_LENGTH * 5) / 8;
  for (let i = 0; i < n; i++) {
    const s = i % net.count;
    const slot = Math.floor(i / net.count);
    belt[i] = s;
    progress[i] = Math.floor((slot * span) / perSegment);
    itemType[i] = Math.floor((s * ITEM_TYPES) / net.count);
  }
  return { belt, progress, itemType };
}

/** A copy of `items` (sharing `itemType`, which never changes): the second buffer of a pair. */
export function cloneItems(items: Items): Items {
  return {
    belt: items.belt.slice(),
    progress: items.progress.slice(),
    itemType: items.itemType,
  };
}

/**
 * The reference step: advances every item of `src` by one tick (`tick` is the
 * tick being stepped, starting at 0) and writes the result into `dst`.
 * Items don't interact, so each one depends only on its own state.
 */
export function referenceStep(src: Items, dst: Items, net: Network, tick: number): void {
  const seg = net.segments;
  const tickHash = mix32(tick);
  const n = src.belt.length;
  for (let i = 0; i < n; i++) {
    let b = src.belt[i]!;
    const o = b * SEGMENT_WORDS;
    let p = src.progress[i]! + seg[o + SegmentField.speed]!;
    if (p >= SEGMENT_LENGTH) {
      p -= SEGMENT_LENGTH;
      b =
        (mix32(i ^ tickHash) & 1) === 1
          ? seg[o + SegmentField.next1]!
          : seg[o + SegmentField.next0]!;
    }
    dst.belt[i] = b;
    dst.progress[i] = p;
  }
}

/** Runs `steps` reference ticks from `tick` on a fresh copy of `items` and returns the result. */
export function referenceRun(items: Items, net: Network, steps: number, tick = 0): Items {
  let a = cloneItems(items);
  let b = cloneItems(items);
  for (let k = 0; k < steps; k++) {
    referenceStep(a, b, net, tick + k);
    [a, b] = [b, a];
  }
  return a;
}

/** The aggregate counters the GPU's count pass reads back (`Counter`). */
export function referenceCounters(items: Items, net: Network): Uint32Array {
  const out = new Uint32Array(COUNTER_WORDS);
  const n = items.belt.length;
  let checksum = 0;
  for (let i = 0; i < n; i++) {
    const b = items.belt[i]!;
    const group = net.segments[b * SEGMENT_WORDS + SegmentField.group]!;
    out[Counter.groups + group]!++;
    out[Counter.types + items.itemType[i]!]!++;
    checksum = (checksum + itemHash(i, b, items.progress[i]!)) >>> 0;
  }
  out[Counter.checksum] = checksum;
  return out;
}

/**
 * Snapshot cost benchmark (`npm run bench -- 10k --snapshot`, docs/TOOLING.md,
 * "Benchmarks"): after the warm-up, every tick encodes the snapshot sections
 * the worker sends (`src/worker/sim.worker.ts`) for a chunk window over the
 * whole scene, the way the worker does (reused writers, then deltas), passes
 * them through `structuredClone` with their buffers transferred (what
 * `postMessage` does), and rebuilds the whole sections the way `SimClient`
 * does. Each step is timed per tick; the render layers that read the
 * sections are measured in the browser by the render profile instead.
 *
 * Each encoder's heap allocation is measured too: the growth of V8's used
 * heap across the call as the median over the ticks, less the median growth
 * across the same measuring steps around nothing (a garbage collection
 * inside the call makes the growth negative, and that tick is left out).
 * Once the writers have grown, an encoder allocates only the `Int32Array`
 * view of its writer it returns: about 100 bytes a call (96 in Node 22),
 * whatever the number of entities.
 */

import { getHeapStatistics } from 'node:v8';

import {
  BELT_ITEM_STRIDE,
  ENTITY_STRIDE,
  beltLayout,
  encodeBelts,
  encodeEntities,
  encodeInserters,
  encodePlayers,
  encodePower,
  encodeResearch,
} from '../../src/sim/snapshot';
import type { ChunkRange } from '../../src/sim/entities/occupancy';
import { CHUNK_SHIFT } from '../../src/sim/world/chunk';
import type { Sim } from '../../src/sim/tick';
import {
  DELTA_SECTIONS,
  type DeltaSection,
  type SnapshotWireMessage,
} from '../../src/worker/protocol';
import { SnapshotDecoder, SnapshotEncoder } from '../../src/worker/snapshotDelta';
import { tickStats, type TickStats } from './measure';

/** Measured ticks per scene unless `--ticks` says otherwise. */
export const SNAPSHOT_TICKS = 600;

/** Snapshot costs of one scene. */
export interface SnapshotResult {
  name: string;
  ticks: number;
  /** The chunk window encoded: every chunk holding an entity. */
  range: ChunkRange;
  /** Entity records and belt items in the last snapshot. */
  entities: number;
  beltItems: number;
  /** Encoding every section into the worker's writers. */
  encode: TickStats;
  /** Mean ms per tick of each section's encoder. */
  sections: Record<DeltaSection, number>;
  /** Median bytes each section's encoder allocated per tick (see the file comment). */
  allocated: Record<DeltaSection, number>;
  /** Comparing with the previous tick and copying out what goes (`SnapshotEncoder`). */
  delta: TickStats;
  /** `structuredClone` with the buffers transferred. */
  transfer: TickStats;
  /** Rebuilding the whole sections on the main thread (`SnapshotDecoder`). */
  decode: TickStats;
  /** Worker side in total: encode + delta + transfer. */
  worker: TickStats;
  /** Mean bytes per tick of the whole sections, and of what was sent. */
  wholeBytes: number;
  sentBytes: number;
  /** Ticks on which each section went whole, as a patch, or not at all. */
  updates: Record<DeltaSection, { whole: number; patch: number; same: number }>;
}

/** The chunks holding every entity of `sim` (its origin chunk). */
export function sceneRange(sim: Sim): ChunkRange {
  const { store } = sim.state.entities;
  let cx0 = Infinity;
  let cy0 = Infinity;
  let cx1 = -Infinity;
  let cy1 = -Infinity;
  for (const id of store.ids) {
    const cx = store.x(id) >> CHUNK_SHIFT;
    const cy = store.y(id) >> CHUNK_SHIFT;
    cx0 = Math.min(cx0, cx);
    cy0 = Math.min(cy0, cy);
    cx1 = Math.max(cx1, cx);
    cy1 = Math.max(cy1, cy);
  }
  return cx0 === Infinity ? { cx0: 0, cy0: 0, cx1: 0, cy1: 0 } : { cx0, cy0, cx1, cy1 };
}

/** Steps `sim` `ticks` times, measuring the snapshot of `range` after each tick. */
export function measureSnapshots(
  name: string,
  sim: Sim,
  ticks: number,
  range = sceneRange(sim),
): SnapshotResult {
  const encoder = new SnapshotEncoder();
  const decoder = new SnapshotDecoder();
  const w = encoder.writers;
  const encode = new Float64Array(ticks);
  const delta = new Float64Array(ticks);
  const transfer = new Float64Array(ticks);
  const decode = new Float64Array(ticks);
  const worker = new Float64Array(ticks);
  const sections = Object.fromEntries(DELTA_SECTIONS.map((s) => [s, 0])) as Record<
    DeltaSection,
    number
  >;
  const updates = Object.fromEntries(
    DELTA_SECTIONS.map((s) => [s, { whole: 0, patch: 0, same: 0 }]),
  ) as SnapshotResult['updates'];
  let wholeBytes = 0;
  let sentBytes = 0;
  let entities = 0;
  let beltItems = 0;
  const heap = Object.fromEntries(
    DELTA_SECTIONS.map((s) => [s, new Float64Array(ticks)]),
  ) as Record<DeltaSection, Float64Array>;
  // What the measuring itself adds: the same steps around nothing, every tick.
  const heapBase = new Float64Array(ticks);
  let tick = 0;
  const timed = <T>(section: DeltaSection | null, fn: () => T): T => {
    const h = usedHeap();
    const t = performance.now();
    const out = fn();
    const ms = performance.now() - t;
    const grew = usedHeap() - h;
    (section ? heap[section] : heapBase)[tick] = grew < 0 ? NaN : grew;
    if (section) sections[section] += ms;
    return out;
  };
  const nothing = () => null;
  (globalThis as { gc?: () => void }).gc?.();
  for (let i = 0; i < ticks; i++) {
    sim.step();
    tick = i;
    timed(null, nothing);
    const t0 = performance.now();
    const next = {
      players: timed('players', () => encodePlayers(sim.state, w.players)),
      research: timed('research', () => encodeResearch(sim.state, 0, w.research)),
      entities: timed('entities', () => encodeEntities(sim.state, range, w.entities)),
      belts: timed('belts', () => encodeBelts(sim.state, range, w.belts)),
      inserters: timed('inserters', () => encodeInserters(sim.state, range, w.inserters)),
      power: timed('power', () => encodePower(sim.state, range, w.power)),
    };
    const t1 = performance.now();
    const wire = encoder.encode(next);
    const t2 = performance.now();
    for (const b of wire.transfer) sentBytes += b.byteLength;
    const msg = structuredClone(
      { ...wire.sections, patched: wire.patched },
      { transfer: wire.transfer },
    );
    const t3 = performance.now();
    const whole = decoder.decode(msg as unknown as SnapshotWireMessage);
    const t4 = performance.now();
    encode[i] = t1 - t0;
    delta[i] = t2 - t1;
    transfer[i] = t3 - t2;
    decode[i] = t4 - t3;
    worker[i] = t3 - t0;
    DELTA_SECTIONS.forEach((s, bit) => {
      wholeBytes += whole[s].byteLength;
      const u = updates[s];
      if (wire.sections[s] === null) u.same++;
      else if (wire.patched & (1 << bit)) u.patch++;
      else u.whole++;
    });
    if (i === ticks - 1) {
      entities = next.entities.length / ENTITY_STRIDE;
      const belts = new Int32Array(whole.belts);
      const layout = beltLayout(belts);
      beltItems = layout ? (belts.length - layout.items) / BELT_ITEM_STRIDE : 0;
    }
  }
  for (const s of DELTA_SECTIONS) sections[s] /= ticks;
  return {
    name,
    ticks,
    range,
    entities,
    beltItems,
    encode: tickStats(encode),
    sections,
    allocated: Object.fromEntries(
      DELTA_SECTIONS.map((s) => [s, Math.max(0, median(heap[s]) - median(heapBase))]),
    ) as Record<DeltaSection, number>,
    delta: tickStats(delta),
    transfer: tickStats(transfer),
    decode: tickStats(decode),
    worker: tickStats(worker),
    wholeBytes: wholeBytes / ticks,
    sentBytes: sentBytes / ticks,
    updates,
  };
}

/** V8's used heap, bytes. */
function usedHeap(): number {
  return getHeapStatistics().used_heap_size;
}

/** The median of the numbers in `values` that aren't NaN (0 for none). */
export function median(values: Float64Array): number {
  const kept = values.filter((v) => !Number.isNaN(v)).sort();
  return kept.length === 0 ? 0 : kept[kept.length >> 1]!;
}

/** The results as Markdown tables. */
export function snapshotMarkdown(results: readonly SnapshotResult[]): string {
  const f = (v: number) => v.toFixed(3);
  const k = (v: number) => (v / 1024).toFixed(1);
  const lines = [
    '| Scene | entities / belt items | encode mean / p99 (ms) | delta mean / p99 | transfer mean / p99 | worker total mean / p99 | main decode mean / p99 | KiB whole / sent |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const r of results) {
    const s = (t: TickStats) => `${f(t.meanMs)} / ${f(t.p99Ms)}`;
    lines.push(
      `| ${r.name} | ${String(r.entities)} / ${String(r.beltItems)} | ${s(r.encode)} | ${s(r.delta)} | ${s(r.transfer)} | ${s(r.worker)} | ${s(r.decode)} | ${k(r.wholeBytes)} / ${k(r.sentBytes)} |`,
    );
  }
  lines.push(
    '',
    '| Scene | ' +
      DELTA_SECTIONS.map((s) => `${s} (ms; bytes allocated; whole / patch / same)`).join(' | ') +
      ' |',
  );
  lines.push('|---|' + DELTA_SECTIONS.map(() => '---').join('|') + '|');
  for (const r of results) {
    lines.push(
      `| ${r.name} | ` +
        DELTA_SECTIONS.map((s) => {
          const u = r.updates[s];
          return `${f(r.sections[s])}; ${String(r.allocated[s])} B; ${String(u.whole)} / ${String(u.patch)} / ${String(u.same)}`;
        }).join(' | ') +
        ' |',
    );
  }
  return lines.join('\n');
}

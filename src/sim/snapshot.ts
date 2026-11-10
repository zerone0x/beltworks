/**
 * Render snapshot encoding: copies the state the renderer needs into int32
 * buffers for the main thread.
 *
 * The section encoders the worker calls every tick (`encodePlayers`,
 * `encodeResearch`, `encodeEntities`, `encodeBelts`, `encodeInserters`,
 * `encodePower`) take an optional `SnapshotWriter`: with one, they write
 * into its reused memory and return a view of it (the worker diffs that
 * against the previous tick, src/worker/snapshotDelta.ts); without, they
 * return a fresh array of their own.
 */

import { SAT_ONE } from '../data/entities';
import { RECIPE_IDS } from '../data/recipes';
import { TECH_IDS, recipeUnlockedBy, technologyPrototype } from '../data/technologies';
import { BELT_LENGTH } from './belts/line';
import { BeltShape, beltTable } from './belts/belts';
import { SPLITTER_HALF_MODE, splitterHalfTile } from './belts/splitter';
import { CRAFT_QUEUE_LENGTH } from './crafting/queue';
import { reaches } from './entities/build';
import { inserterTableOf } from './entities/inserter';
import { MachineState } from './entities/machine';
import type { ChunkRange } from './entities/occupancy';
import { powerGrid, type MemberStats, type NetworkStats } from './power/grid';
import { poweredEnergy } from './power/solver';
import { labTable } from './research/lab';
import { forceOf, isRecipeUnlocked } from './research/unlocks';
import { ScratchSet, SnapshotWriter } from './snapshotWriter';
import type { SimState } from './state';
import { CHUNK_AREA } from './world/chunk';
import { SUBTILE_BITS } from './fixed';

/** Int32 fields per player in {@link encodePlayers}. */
export const PLAYER_STRIDE = 8;
/** Field offsets within one player record. */
export const PlayerField = {
  x: 0,
  y: 1,
  mining: 2,
  mineX: 3,
  mineY: 4,
  mineProgress: 5,
  /** The player's own walking intent per axis (-1, 0 or +1), not how it moved (e.g. carried). */
  moveX: 6,
  moveY: 7,
} as const;

/**
 * Encodes every player as `PLAYER_STRIDE` int32s:
 * `[x, y, mining, mineX, mineY, mineProgress, moveX, moveY]` (positions in
 * subtiles, mine target in tiles, progress in ticks out of
 * `HAND_MINING_TICKS`, the walking intent per axis: the renderer's walk
 * cycle and facing).
 */
export function encodePlayers(state: SimState, writer?: SnapshotWriter): Int32Array<ArrayBuffer> {
  const p = state.players;
  const w = start(writer);
  w.reserve(p.count * PLAYER_STRIDE);
  for (let i = 0; i < p.count; i++) {
    w.push(p.x[i]!);
    w.push(p.y[i]!);
    w.push(p.mining[i]!);
    w.push(p.mineX[i]!);
    w.push(p.mineY[i]!);
    w.push(p.mineProgress[i]!);
    w.push(p.moveX[i]!);
    w.push(p.moveY[i]!);
  }
  return finish(w, writer);
}

/** The writer to encode into: `writer` (reset), or a temporary one. */
function start(writer: SnapshotWriter | undefined): SnapshotWriter {
  return writer ? writer.reset() : new SnapshotWriter();
}

/** What an encoder returns: a view of `writer`'s memory, or a fresh copy of a temporary writer's. */
function finish(w: SnapshotWriter, writer: SnapshotWriter | undefined): Int32Array<ArrayBuffer> {
  return writer ? w.view() : w.take();
}

/**
 * Encodes player `playerId`'s inventory as uint16 pairs `[item, count]`, one
 * per slot (`PLAYER_INVENTORY_SLOTS` slots).
 */
export function encodeInventory(state: SimState, playerId: number): Uint16Array<ArrayBuffer> {
  const inv = state.players.inventory(playerId);
  const out = new Uint16Array(inv.slots * 2);
  for (let i = 0; i < inv.slots; i++) {
    out[2 * i] = inv.items[i]!;
    out[2 * i + 1] = inv.counts[i]!;
  }
  return out;
}

/** Uint16 fields per queue entry in {@link encodeCraftQueue}, after the 2-field header. */
export const CRAFT_ENTRY_STRIDE = 3;

/**
 * Encodes player `playerId`'s crafting queue as uint16s:
 * `[progress, length, then per entry: recipe, crafts, flags]`, front first
 * (progress in ticks into the front entry's current craft; flags as in
 * `CraftFlag`).
 */
export function encodeCraftQueue(state: SimState, playerId: number): Uint16Array<ArrayBuffer> {
  const q = state.crafting;
  const len = q.size(playerId);
  const out = new Uint16Array(2 + len * CRAFT_ENTRY_STRIDE);
  out[0] = q.progress[playerId]!;
  out[1] = len;
  const base = playerId * CRAFT_QUEUE_LENGTH;
  for (let i = 0; i < len; i++) {
    const o = 2 + i * CRAFT_ENTRY_STRIDE;
    out[o] = q.recipe[base + i]!;
    out[o + 1] = q.crafts[base + i]!;
    out[o + 2] = q.flags[base + i]!;
  }
  return out;
}

/** A crafting queue as decoded on the main thread. */
export interface CraftQueueData {
  /** Ticks into the front entry's current craft. */
  progress: number;
  entries: { recipe: number; crafts: number; flags: number }[];
}

/** Unpacks a buffer made by {@link encodeCraftQueue}. */
export function decodeCraftQueue(buffer: ArrayBuffer): CraftQueueData {
  const view = new Uint16Array(buffer, 0, buffer.byteLength >> 1);
  const len = Math.min(view[1] ?? 0, Math.floor((view.length - 2) / CRAFT_ENTRY_STRIDE));
  const entries: CraftQueueData['entries'] = [];
  for (let i = 0; i < len; i++) {
    const o = 2 + i * CRAFT_ENTRY_STRIDE;
    entries.push({ recipe: view[o]!, crafts: view[o + 1]!, flags: view[o + 2]! });
  }
  return { progress: view[0] ?? 0, entries };
}

/**
 * The machine state the renderer and GUI show for entity `id`: its own
 * state, except that a `Working` electric consumer on a network whose
 * satisfaction is below 1 shows `LowPower` (it works, but slower).
 */
export function displayStatus(state: SimState, id: number): MachineState {
  const { entities } = state;
  const status = entities.status(id);
  if (status !== MachineState.Working) return status;
  if (entities.table(entities.store.type(id))?.powerDemand === undefined) return status;
  const grid = powerGrid(entities);
  if (!grid || grid.networkOf(id) === 0) return status;
  return grid.satisfaction(id) < SAT_ONE ? MachineState.LowPower : status;
}

/**
 * Joules electric consumer `id` drew on the latest tick: its demand times
 * its network's satisfaction (`poweredEnergy`); 0 for anything else.
 */
function consumerDraw(state: SimState, id: number): number {
  const { entities } = state;
  if (entities.table(entities.store.type(id))?.powerDemand === undefined) return 0;
  const grid = powerGrid(entities);
  const member = grid?.member(id);
  if (!grid || !member || member.network === 0) return 0;
  return poweredEnergy(member.demand, grid.satisfaction(id));
}

/** Int32 fields per entity in {@link encodeEntities}. */
export const ENTITY_STRIDE = 7;
/** Field offsets within one entity record. */
export const EntityField = {
  id: 0,
  type: 1,
  x: 2,
  y: 3,
  dir: 4,
  status: 5,
  /** The recipe an assembling machine is set to (0 for none and for other types). */
  recipe: 6,
} as const;

/**
 * Encodes the entities whose origin (top-left tile) lies in the chunks of
 * `range` as `ENTITY_STRIDE` int32s each: `[id, type, x, y, dir, status,
 * recipe]` (ids are uint32s stored bit for bit; `x`, `y` is the top-left
 * tile; status is a `MachineState`, so the renderer can show working
 * machines; recipe the one an assembling machine is set to, so it can show
 * its product). Entities are
 * at most `MAX_ENTITY_SIZE` tiles wide, so a range with a one-chunk margin
 * around the viewport catches every entity that overlaps it.
 */
export function encodeEntities(
  state: SimState,
  range: ChunkRange | null,
  writer?: SnapshotWriter,
): Int32Array<ArrayBuffer> {
  const w = start(writer);
  if (range === null) {
    return finish(w, writer);
  }
  const { entities } = state;
  const { store, occupancy } = entities;
  const count = occupancy.originsInto(range, idScratch);
  const grid = powerGrid(entities);
  w.reserve(count * ENTITY_STRIDE);
  for (let i = 0; i < count; i++) {
    const id = idScratch[i]!;
    const type = store.type(id);
    const table = entities.table(type);
    let status = table?.status?.(id) ?? MachineState.Idle;
    // `displayStatus`, with the grid looked up once.
    if (
      status === MachineState.Working &&
      grid &&
      table?.powerDemand !== undefined &&
      grid.networkOf(id) !== 0 &&
      grid.satisfaction(id) < SAT_ONE
    ) {
      status = MachineState.LowPower;
    }
    w.push(id);
    w.push(type);
    w.push(store.x(id));
    w.push(store.y(id));
    w.push(store.dir(id));
    w.push(status);
    w.push(table?.selectedRecipe?.(id) ?? 0);
  }
  return finish(w, writer);
}

/**
 * Scratch list of entity ids for the encoders (`Occupancy.originsInto`):
 * overwritten on every call and never shortened, so it stops allocating once
 * it has grown to the view (one encoder at a time).
 */
const idScratch: number[] = [];

/** Int32 fields per belt in the header block of {@link encodeBelts}. */
export const BELT_STRIDE = 6;
/** Field offsets within one belt record of {@link encodeBelts}. */
export const BeltField = {
  x: 0,
  y: 1,
  dir: 2,
  /** A `BeltShape`. */
  shape: 3,
  /** Entity type (its prototype's `beltSpeed` is the tier). */
  type: 4,
  /** `UndergroundMode`, or for a splitter half `SPLITTER_HALF_MODE` plus the half. */
  mode: 5,
} as const;
/** Int32 fields per item in {@link encodeBelts}: `[offset, packed]` (see {@link packBeltItem}). */
export const BELT_ITEM_STRIDE = 2;

/** Packs an item's lane, how far it moved on the last tick and its id into one int32. */
export function packBeltItem(lane: number, moved: number, item: number): number {
  return (item & 0x7fff) | ((lane & 1) << 15) | (moved << 16);
}
/** The item id of a packed belt item. */
export const beltItemId = (packed: number): number => packed & 0x7fff;
/** The lane (0 left, 1 right) of a packed belt item. */
export const beltItemLane = (packed: number): number => (packed >> 15) & 1;
/** How far a packed belt item moved on the last tick, in subtiles. */
export const beltItemMoved = (packed: number): number => packed >>> 16;

/**
 * Where the parts of a buffer made by {@link encodeBelts} start, checked
 * against its length: belt `b`'s header is at `BELT_HEADER + b * BELT_STRIDE`,
 * its item count at `counts + b`, and the items of all belts follow each
 * other from `items` on. `null` if the buffer is too short for its count.
 */
export function beltLayout(v: Int32Array): { count: number; counts: number; items: number } | null {
  const count = v[0] ?? 0;
  if (count < 0) return null;
  const counts = BELT_HEADER + count * BELT_STRIDE;
  const items = counts + count;
  return items <= v.length ? { count, counts, items } : null;
}
/** Words before the first belt record in {@link encodeBelts}. */
export const BELT_HEADER = 1;

/** Scratch tile for the encoders. */
const tileScratch = { x: 0, y: 0 };

/** Scratch for `encodeBelts`, grown as needed and reused. */
const beltScratch = {
  /** Per belt record: its line's id and its index on that line. */
  line: new Int32Array(256),
  index: new Int32Array(256),
  /** The lines touched, in the order first met. */
  lines: new ScratchSet(),
  /** Per line touched (its index in `lines`): where its belts start in `slot`. */
  base: new Int32Array(64),
  /** Per belt of a touched line (at its line's base + its index): its record, or -1. */
  slot: new Int32Array(256),
  /** Per item found, in walk order: its record, offset and packed fields. */
  itemSlot: new Int32Array(1024),
  itemOffset: new Int32Array(1024),
  itemPacked: new Int32Array(1024),
  /** Per record: items so far, then where its next item goes. */
  counts: new Int32Array(256),
};

function grown(a: Int32Array<ArrayBuffer>, n: number): Int32Array<ArrayBuffer> {
  if (a.length >= n) return a;
  let size = a.length * 2;
  while (size < n) size *= 2;
  return new Int32Array(size);
}

/** `a`, or a bigger copy of its first `keep` entries if it is shorter than `n`. */
function grownCopy(
  a: Int32Array<ArrayBuffer>,
  n: number,
  keep = a.length,
): Int32Array<ArrayBuffer> {
  if (a.length >= n) return a;
  const next = grown(a, n);
  next.set(a.subarray(0, keep));
  return next;
}

/** Notes in `beltScratch` that record `r` is belt `index` of line `lineId`. */
function recordBelt(r: number, lineId: number, index: number): void {
  const sc = beltScratch;
  if (r === sc.line.length) {
    sc.line = grownCopy(sc.line, r + 1);
    sc.index = grownCopy(sc.index, r + 1);
  }
  sc.line[r] = lineId;
  sc.index[r] = index;
}

/**
 * Encodes the belts (every tier, underground belts included) whose tile lies
 * in the chunks of `range`, with the items on them, as int32s in three blocks:
 * `[beltCount]`, then per belt `BELT_STRIDE` fields `[x, y, dir, shape, type,
 * mode]` (see {@link BeltField}), then per belt its item count, then the
 * items of every belt in belt order, `BELT_ITEM_STRIDE` words each:
 * `[offset, packed]` (`offset` the item's distance from the belt's end edge in
 * subtiles, 0..256; `packed` its lane, how far it moved on the last tick, for
 * drawing it between ticks, and its id, see {@link packBeltItem}). Items on
 * a belt come lane by lane, each from the belt's end backwards. The belts
 * block only changes when belts do, so a snapshot that only moves items
 * changes the counts and items alone (src/worker/snapshotDelta.ts sends just
 * those). Items under the ground between an underground pair are on no belt
 * and not sent. A splitter comes as two records, one per half (its left half
 * first, see src/sim/belts/splitter.ts), each on its own tile with `mode`
 * `SPLITTER_HALF_MODE + half`. Belts come in the order of `encodeEntities`.
 */
export function encodeBelts(
  state: SimState,
  range: ChunkRange | null,
  writer?: SnapshotWriter,
): Int32Array<ArrayBuffer> {
  const w = start(writer);
  const table = beltTable(state.entities);
  if (range === null || !table) {
    w.push(0);
    return finish(w, writer);
  }
  const { store, occupancy } = state.entities;
  const count = occupancy.originsInto(range, idScratch);
  const sc = beltScratch;
  // The header block, and which line and index each record's items are on.
  const countAt = w.skip(1);
  let records = 0;
  for (let i = 0; i < count; i++) {
    const id = idScratch[i]!;
    if (!table.isBelt(id)) continue;
    const x = store.x(id);
    const y = store.y(id);
    const dir = store.dir(id);
    const type = store.type(id);
    if (table.isSplitter(id)) {
      for (let half = 0; half < 2; half++) {
        const tile = splitterHalfTile(x, y, dir, half, tileScratch);
        w.push(tile.x);
        w.push(tile.y);
        w.push(dir);
        w.push(BeltShape.Straight);
        w.push(type);
        w.push(SPLITTER_HALF_MODE + half);
        recordBelt(records++, table.halfLine(id, half).id, 0);
      }
      continue;
    }
    w.push(x);
    w.push(y);
    w.push(dir);
    w.push(table.shape(id));
    w.push(type);
    w.push(table.mode(id));
    recordBelt(records++, table.beltLine(id), table.beltIndex(id));
  }
  w.set(countAt, records);
  // Map each touched line's belts to their records.
  const lines = sc.lines;
  lines.clear();
  let slots = 0;
  for (let r = 0; r < records; r++) {
    const lineId = sc.line[r]!;
    let j = lines.indexOf(lineId);
    if (j < 0) {
      j = lines.add(lineId);
      if (j === sc.base.length) sc.base = grownCopy(sc.base, j + 1);
      sc.base[j] = slots;
      slots += table.line(lineId)!.belts.length;
    }
    // From here on, the record's line as its index in `lines`.
    sc.line[r] = j;
  }
  sc.slot = grown(sc.slot, slots);
  sc.slot.fill(-1, 0, slots);
  for (let r = 0; r < records; r++) {
    sc.slot[sc.base[sc.line[r]!]! + sc.index[r]!] = r;
  }
  // Walk each touched line once, picking out the items on belts in range.
  sc.counts = grown(sc.counts, records + 1);
  const counts = sc.counts;
  counts.fill(0, 0, records + 1);
  let found = 0;
  for (let j = 0; j < lines.size; j++) {
    const base = sc.base[j]!;
    const line = table.line(lines.values[j]!)!;
    const last = line.belts.length - 1;
    for (let lane = 0; lane < line.lanes.length; lane++) {
      const l = line.lanes[lane]!;
      const n = l.count;
      if (n === 0) continue;
      if (found + n > sc.itemSlot.length) {
        const size = Math.max(found + n, sc.itemSlot.length * 2);
        sc.itemSlot = grownCopy(sc.itemSlot, size, found);
        sc.itemOffset = grownCopy(sc.itemOffset, size, found);
        sc.itemPacked = grownCopy(sc.itemPacked, size, found);
      }
      let d = 0;
      for (let i = 0; i < n; i++) {
        d += l.gap(i);
        // `line.beltIndexAt(d)`; `BELT_LENGTH` is `1 << SUBTILE_BITS`, and the
        // shift leaves no float to box.
        const k = Math.max(0, Math.min(last, d >> SUBTILE_BITS));
        const r = sc.slot[base + k]!;
        if (r < 0) continue;
        sc.itemSlot[found] = r;
        sc.itemOffset[found] = d - k * BELT_LENGTH;
        sc.itemPacked[found] = packBeltItem(l.index, l.moved(i), l.item(i));
        counts[r]!++;
        found++;
      }
    }
  }
  // The counts, then the items, each record's in the order they were found.
  w.reserve(records + found * BELT_ITEM_STRIDE);
  let at = w.length + records;
  for (let r = 0; r < records; r++) {
    const n = counts[r]!;
    w.push(n);
    counts[r] = at;
    at += n * BELT_ITEM_STRIDE;
  }
  w.skip(found * BELT_ITEM_STRIDE);
  for (let i = 0; i < found; i++) {
    const r = sc.itemSlot[i]!;
    const o = counts[r]!;
    w.set(o, sc.itemOffset[i]!);
    w.set(o + 1, sc.itemPacked[i]!);
    counts[r] = o + BELT_ITEM_STRIDE;
  }
  return finish(w, writer);
}

/** A belt and its items as decoded on the main thread. */
export interface BeltData {
  x: number;
  y: number;
  dir: number;
  shape: number;
  /** Entity type (its prototype's `beltSpeed` is the tier). */
  type: number;
  /**
   * `UndergroundMode` (`None` for transport belts), or for a splitter
   * `SPLITTER_HALF_MODE` plus the half (0 left, 1 right).
   */
  mode: number;
  items: { lane: number; offset: number; moved: number; item: number }[];
}

/** Unpacks a buffer made by {@link encodeBelts}. */
export function decodeBelts(buffer: ArrayBuffer): BeltData[] {
  const v = new Int32Array(buffer);
  const out: BeltData[] = [];
  const layout = beltLayout(v);
  if (!layout) return out;
  let o = layout.items;
  for (let b = 0; b < layout.count; b++) {
    const h = BELT_HEADER + b * BELT_STRIDE;
    const belt: BeltData = {
      x: v[h + BeltField.x]!,
      y: v[h + BeltField.y]!,
      dir: v[h + BeltField.dir]!,
      shape: v[h + BeltField.shape]!,
      type: v[h + BeltField.type]!,
      mode: v[h + BeltField.mode]!,
      items: [],
    };
    const n = v[layout.counts + b]!;
    for (let i = 0; i < n && o + BELT_ITEM_STRIDE <= v.length; i++, o += BELT_ITEM_STRIDE) {
      const packed = v[o + 1]!;
      belt.items.push({
        lane: beltItemLane(packed),
        offset: v[o]!,
        moved: beltItemMoved(packed),
        item: beltItemId(packed),
      });
    }
    out.push(belt);
  }
  return out;
}

/** Int32 fields per inserter in {@link encodeInserters}, after the count. */
export const INSERTER_STRIDE = 8;
/** Field offsets within one inserter record. */
export const InserterField = {
  x: 0,
  y: 1,
  dir: 2,
  /**
   * Arm position from the pickup end (0) to the drop end (`span`), in the
   * inserter type's arm units: ticks for burner inserters, 1/`SAT_ONE` ticks
   * for electric ones.
   */
  arm: 3,
  /** The item in the hand, or 0. */
  held: 4,
  /**
   * How the arm moved on the last tick, in arm units: positive towards the
   * drop end (+1 for a burner inserter), negative back, 0 not at all.
   */
  swing: 5,
  /** Arm position at the drop end (36 for burner inserters, 26 × `SAT_ONE` for electric). */
  span: 6,
  /** Entity type id (for the arm's length and color). */
  type: 7,
} as const;

/**
 * Encodes the inserters (every inserter type) whose tile lies in the chunks
 * of `range` as int32s: `[count]`, then `INSERTER_STRIDE` fields per inserter
 * (see {@link InserterField}), in the order of `encodeEntities`. The
 * renderer draws the arm `swing × (1 − α)` behind `arm` between ticks.
 */
export function encodeInserters(
  state: SimState,
  range: ChunkRange | null,
  writer?: SnapshotWriter,
): Int32Array<ArrayBuffer> {
  const w = start(writer);
  const countAt = w.skip(1);
  if (range === null) {
    return finish(w, writer);
  }
  const { entities } = state;
  const { store, occupancy } = entities;
  const origins = occupancy.originsInto(range, idScratch);
  let count = 0;
  for (let i = 0; i < origins; i++) {
    const id = idScratch[i]!;
    const type = store.type(id);
    const table = inserterTableOf(entities, type);
    if (!table) continue;
    const hand = table.hand(id, handScratch);
    w.reserve(INSERTER_STRIDE);
    w.push(store.x(id));
    w.push(store.y(id));
    w.push(store.dir(id));
    w.push(hand.arm);
    w.push(hand.held);
    w.push(table.lastSwing(id, entities));
    w.push(table.armEnd);
    w.push(type);
    count++;
  }
  w.set(countAt, count);
  return finish(w, writer);
}

/** Scratch hand for `encodeInserters`. */
const handScratch = { held: 0, arm: 0 };

/** An inserter as decoded on the main thread. */
export interface InserterData {
  x: number;
  y: number;
  dir: number;
  arm: number;
  held: number;
  swing: number;
  span: number;
  type: number;
}

/** Unpacks a buffer made by {@link encodeInserters}. */
export function decodeInserters(buffer: ArrayBuffer): InserterData[] {
  const v = new Int32Array(buffer);
  const count = Math.min(v[0] ?? 0, Math.floor((v.length - 1) / INSERTER_STRIDE));
  const out: InserterData[] = [];
  for (let i = 0; i < count; i++) {
    const o = 1 + i * INSERTER_STRIDE;
    out.push({
      x: v[o + InserterField.x]!,
      y: v[o + InserterField.y]!,
      dir: v[o + InserterField.dir]!,
      arm: v[o + InserterField.arm]!,
      held: v[o + InserterField.held]!,
      swing: v[o + InserterField.swing]!,
      span: v[o + InserterField.span]!,
      type: v[o + InserterField.type]!,
    });
  }
  return out;
}

/** Int32 fields per pole in {@link encodePower}. */
export const POLE_STRIDE = 5;
/** Int32 fields per network in {@link encodePower}. */
export const NETWORK_STRIDE = 5;
/** Int32 fields per electric entity in {@link encodePower}. */
export const MEMBER_STRIDE = 5;

/**
 * Encodes the electric grid around the view as int32s, in four sections:
 * - `[poleCount]`, then per pole whose tile lies in the chunks of `range`
 *   (in the order of `encodeEntities`) `[id, type, x, y, network]`;
 * - `[wireCount]`, then per wire between two of those poles `[a, b]` (pole
 *   ids, `a < b`, in pole order). Wires to poles outside the range are left
 *   out: wires are at most 7 tiles long and the range has a one-chunk margin
 *   around the viewport, so none of them would show;
 * - `[networkCount]`, then per network of those poles (ascending ids) `[id,
 *   poles, demand, supply, satisfaction]` as of the latest tick (joules are
 *   uint32s stored bit for bit);
 * - `[memberCount]`, then per electric entity (consumer or producer) whose
 *   origin lies in the chunks of `range`, in the order of `encodeEntities`,
 *   `[id, network, demand, maxOutput, drawn]` as of the latest tick (see
 *   `MemberStats`; network 0 when not connected). Steam engines animate
 *   with what they delivered.
 */
export function encodePower(
  state: SimState,
  range: ChunkRange | null,
  writer?: SnapshotWriter,
): Int32Array<ArrayBuffer> {
  const w = start(writer);
  const grid = powerGrid(state.entities);
  if (range === null || !grid) {
    w.skip(4);
    return finish(w, writer);
  }
  const { store, occupancy } = state.entities;
  const origins = occupancy.originsInto(range, idScratch);
  const poles = powerScratch.poles;
  const nets = powerScratch.nets;
  poles.clear();
  nets.clear();
  for (let i = 0; i < origins; i++) {
    const id = idScratch[i]!;
    if (grid.isPole(id)) poles.add(id);
  }
  w.push(poles.size);
  for (let i = 0; i < poles.size; i++) {
    const id = poles.values[i]!;
    const net = grid.networkOfPole(id);
    nets.add(net);
    w.push(id);
    w.push(store.type(id));
    w.push(store.x(id));
    w.push(store.y(id));
    w.push(net);
  }
  const wireCountAt = w.skip(1);
  let wires = 0;
  for (let i = 0; i < poles.size; i++) {
    const id = poles.values[i]!;
    const neighbours = grid.neighboursView(id);
    for (let k = 0; k < neighbours.length; k++) {
      const n = neighbours[k]!;
      if (n > id && poles.has(n)) {
        w.push(id);
        w.push(n);
        wires++;
      }
    }
  }
  w.set(wireCountAt, wires);
  nets.sort();
  w.push(nets.size);
  const n = powerScratch.network;
  for (let i = 0; i < nets.size; i++) {
    const net = nets.values[i]!;
    if (grid.network(net, n) === undefined) {
      // A pole's network is always in the grid's list (kept as poles and
      // wires change); should that ever break, send zeros rather than the
      // previous network's stats left in the scratch.
      n.poles = 0;
      n.demand = 0;
      n.supply = 0;
      n.satisfaction = 0;
    }
    w.push(net);
    w.push(n.poles);
    w.push(n.demand | 0);
    w.push(n.supply | 0);
    w.push(n.satisfaction);
  }
  const memberCountAt = w.skip(1);
  let members = 0;
  const m = powerScratch.member;
  for (let i = 0; i < origins; i++) {
    const id = idScratch[i]!;
    if (!grid.member(id, m)) continue;
    w.push(id);
    w.push(m.network);
    w.push(m.demand | 0);
    w.push(m.maxOutput | 0);
    w.push(m.drawn | 0);
    members++;
  }
  w.set(memberCountAt, members);
  return finish(w, writer);
}

/** Scratch for `encodePower`, refilled on every call. */
const powerScratch = {
  poles: new ScratchSet(),
  nets: new ScratchSet(),
  network: {
    id: 0,
    poles: 0,
    demand: 0,
    supply: 0,
    satisfaction: 0,
    load: 0,
  } satisfies NetworkStats,
  member: { pole: 0, network: 0, demand: 0, maxOutput: 0, drawn: 0 } satisfies MemberStats,
};

/** A pole as decoded on the main thread. */
export interface PoleData {
  id: number;
  /** Entity type id (a pole prototype). */
  type: number;
  x: number;
  y: number;
  network: number;
}

/** A network as decoded on the main thread. */
export interface NetworkData {
  id: number;
  poles: number;
  demand: number;
  supply: number;
  /** In units of 1/`SAT_ONE`. */
  satisfaction: number;
}

/** An electric entity as decoded on the main thread (joules per tick, as of the latest tick). */
export interface MemberData {
  id: number;
  /** 0 when not connected. */
  network: number;
  demand: number;
  maxOutput: number;
  drawn: number;
}

/** The grid around the view as decoded on the main thread. */
export interface PowerData {
  poles: PoleData[];
  /** Wired pole pairs `[a, b]` with `a < b`. */
  wires: [number, number][];
  networks: NetworkData[];
  members: MemberData[];
}

/** Unpacks a buffer made by {@link encodePower}. */
export function decodePower(buffer: ArrayBuffer): PowerData {
  const v = new Int32Array(buffer);
  const out: PowerData = { poles: [], wires: [], networks: [], members: [] };
  let o = 0;
  const poleCount = v[o++] ?? 0;
  for (let i = 0; i < poleCount && o + POLE_STRIDE <= v.length; i++, o += POLE_STRIDE) {
    out.poles.push({
      id: v[o]! >>> 0,
      type: v[o + 1]!,
      x: v[o + 2]!,
      y: v[o + 3]!,
      network: v[o + 4]! >>> 0,
    });
  }
  const wireCount = v[o++] ?? 0;
  for (let i = 0; i < wireCount && o + 2 <= v.length; i++, o += 2) {
    out.wires.push([v[o]! >>> 0, v[o + 1]! >>> 0]);
  }
  const netCount = v[o++] ?? 0;
  for (let i = 0; i < netCount && o + NETWORK_STRIDE <= v.length; i++, o += NETWORK_STRIDE) {
    out.networks.push({
      id: v[o]! >>> 0,
      poles: v[o + 1]!,
      demand: v[o + 2]! >>> 0,
      supply: v[o + 3]! >>> 0,
      satisfaction: v[o + 4]!,
    });
  }
  const memberCount = v[o++] ?? 0;
  for (let i = 0; i < memberCount && o + MEMBER_STRIDE <= v.length; i++, o += MEMBER_STRIDE) {
    out.members.push({
      id: v[o]! >>> 0,
      network: v[o + 1]! >>> 0,
      demand: v[o + 2]! >>> 0,
      maxOutput: v[o + 3]! >>> 0,
      drawn: v[o + 4]! >>> 0,
    });
  }
  return out;
}

/** Field offsets of the header of {@link encodeNetworkDetail}; the groups follow it. */
export const NetworkDetailField = {
  /** The pole asked about, and its network. */
  pole: 0,
  network: 1,
  poles: 2,
  /** Joules per tick wanted by the consumers and the most the producers could deliver. */
  demand: 3,
  supply: 4,
  /** In units of 1/`SAT_ONE`. */
  satisfaction: 5,
  /** Joules per tick delivered: `min(supply, demand)`. */
  load: 6,
  groupCount: 7,
} as const;
const NETWORK_DETAIL_HEADER = 8;
/** Int32 fields per group in {@link encodeNetworkDetail}. */
export const NETWORK_GROUP_STRIDE = 6;

/**
 * Encodes what the power panel shows about the network of pole `id` as
 * int32s: the {@link NetworkDetailField} header (as of the latest tick,
 * over the whole network, wherever its entities are), then one group per
 * entity type on the network, ascending type ids: `[type, producer, count,
 * demand, maxOutput, power]`, with `producer` 1 for generators, `power` what
 * the group delivered (producers) or drew (consumers, `poweredEnergy` of
 * each one's demand) on the latest tick. Joules are uint32s stored bit for
 * bit. `null` when `id` isn't a pole.
 *
 * Read-only and computed on request (only while a power panel is open):
 * the 60 s graph is sampled on the main thread from snapshots, not kept in
 * the simulation.
 */
export function encodeNetworkDetail(state: SimState, id: number): Int32Array<ArrayBuffer> | null {
  const { entities } = state;
  const grid = powerGrid(entities);
  if (!grid?.isPole(id)) return null;
  const net = grid.networkOfPole(id);
  const stats = grid.network(net);
  const groups = new Map<number, number[]>();
  const sat = stats?.satisfaction ?? 0;
  for (const m of grid.membersOf(net)) {
    const type = entities.store.type(m);
    const member = grid.member(m)!;
    const producer = entities.table(type)?.powerMaxOutput !== undefined;
    let g = groups.get(type);
    if (!g) groups.set(type, (g = [type, producer ? 1 : 0, 0, 0, 0, 0]));
    g[2]! += 1;
    g[3]! += member.demand;
    g[4]! += member.maxOutput;
    g[5]! += producer ? member.drawn : poweredEnergy(member.demand, sat);
  }
  const sorted = [...groups.values()].sort((a, b) => a[0]! - b[0]!);
  const out = new Int32Array(NETWORK_DETAIL_HEADER + sorted.length * NETWORK_GROUP_STRIDE);
  out[NetworkDetailField.pole] = id;
  out[NetworkDetailField.network] = net;
  out[NetworkDetailField.poles] = stats?.poles ?? 0;
  out[NetworkDetailField.demand] = stats?.demand ?? 0;
  out[NetworkDetailField.supply] = stats?.supply ?? 0;
  out[NetworkDetailField.satisfaction] = sat;
  out[NetworkDetailField.load] = stats?.load ?? 0;
  out[NetworkDetailField.groupCount] = sorted.length;
  sorted.forEach((g, i) => {
    out.set(g, NETWORK_DETAIL_HEADER + i * NETWORK_GROUP_STRIDE);
  });
  return out;
}

/** The entities of one type on a network, as decoded on the main thread. */
export interface NetworkGroupData {
  type: number;
  /** Generators (true) or consumers. */
  producer: boolean;
  count: number;
  /** Joules per tick, as of the latest tick. */
  demand: number;
  maxOutput: number;
  /** Delivered (producers) or drawn (consumers). */
  power: number;
}

/** A network as the power panel shows it, decoded on the main thread. */
export interface NetworkDetailData {
  pole: number;
  network: number;
  poles: number;
  demand: number;
  supply: number;
  satisfaction: number;
  load: number;
  groups: NetworkGroupData[];
}

/** Unpacks a buffer made by {@link encodeNetworkDetail}. */
export function decodeNetworkDetail(buffer: ArrayBuffer): NetworkDetailData {
  const v = new Int32Array(buffer);
  const u = (i: number): number => (v[i] ?? 0) >>> 0;
  const groups: NetworkGroupData[] = [];
  const n = Math.min(
    v[NetworkDetailField.groupCount] ?? 0,
    Math.floor((v.length - NETWORK_DETAIL_HEADER) / NETWORK_GROUP_STRIDE),
  );
  for (let i = 0; i < n; i++) {
    const o = NETWORK_DETAIL_HEADER + i * NETWORK_GROUP_STRIDE;
    groups.push({
      type: v[o]!,
      producer: v[o + 1] === 1,
      count: v[o + 2]!,
      demand: u(o + 3),
      maxOutput: u(o + 4),
      power: u(o + 5),
    });
  }
  return {
    pole: u(NetworkDetailField.pole),
    network: u(NetworkDetailField.network),
    poles: v[NetworkDetailField.poles] ?? 0,
    demand: u(NetworkDetailField.demand),
    supply: u(NetworkDetailField.supply),
    satisfaction: v[NetworkDetailField.satisfaction] ?? 0,
    load: u(NetworkDetailField.load),
    groups,
  };
}

/** Int32 fields per technology in {@link encodeResearch}, after the 2-field header. */
export const RESEARCH_TECH_STRIDE = 4;

/**
 * Encodes the research of player `playerId`'s force as int32s: `[current,
 * techCount]`, then per technology in `TECH_IDS` order `[id, unitsDone,
 * unitsInProgress, ticksInProgress]` (units researched, units labs are
 * researching now, and the whole working ticks done on those, summed over
 * the labs). Sent in every snapshot: a few dozen bytes.
 */
export function encodeResearch(
  state: SimState,
  playerId: number,
  writer?: SnapshotWriter,
): Int32Array<ArrayBuffer> {
  const force = forceOf(state, playerId);
  const labs = labTable(state.entities);
  const w = start(writer);
  w.reserve(2 + TECH_IDS.length * RESEARCH_TECH_STRIDE);
  w.push(state.research.currentOf(force));
  w.push(TECH_IDS.length);
  for (let i = 0; i < TECH_IDS.length; i++) {
    const tech = TECH_IDS[i]!;
    w.push(tech);
    w.push(state.research.unitsDone(force, tech));
    w.push(labs?.unitsInProgress(tech) ?? 0);
    w.push(labs?.ticksInProgress(tech) ?? 0);
  }
  return finish(w, writer);
}

/** The research of the local player's force as decoded on the main thread. */
export interface ResearchData {
  /** The current research (0: none). */
  current: number;
  /** Per technology id: units researched, units in progress and their working ticks so far. */
  techs: Map<number, { unitsDone: number; unitsInProgress: number; ticksInProgress: number }>;
}

/** Unpacks a buffer made by {@link encodeResearch}. */
export function decodeResearch(buffer: ArrayBuffer): ResearchData {
  const v = new Int32Array(buffer, 0, buffer.byteLength >> 2);
  const n = Math.min(v[1] ?? 0, Math.floor((v.length - 2) / RESEARCH_TECH_STRIDE));
  const techs: ResearchData['techs'] = new Map();
  for (let i = 0; i < n; i++) {
    const o = 2 + i * RESEARCH_TECH_STRIDE;
    techs.set(v[o]!, {
      unitsDone: v[o + 1]!,
      unitsInProgress: v[o + 2]!,
      ticksInProgress: v[o + 3]!,
    });
  }
  return { current: v[0] ?? 0, techs };
}

/** An empty research (before the first snapshot): nothing researched, nothing current. */
export const NO_RESEARCH: ResearchData = { current: 0, techs: new Map() };

/**
 * Whether recipe `recipe` is unlocked by `research` (the main thread's copy
 * of the simulation's `isRecipeUnlocked`).
 */
export function researchUnlocks(research: ResearchData, recipe: number): boolean {
  return recipeUnlockedBy((tech) => isResearchedIn(research, tech), recipe);
}

/** Whether `research` has technology `tech` researched. */
export function isResearchedIn(research: ResearchData, tech: number): boolean {
  const t = technologyPrototype(tech);
  return t !== undefined && (research.techs.get(tech)?.unitsDone ?? 0) >= t.units;
}

/** Field offsets of the header of {@link encodeEntityDetail}; `[item, count]` slot pairs follow it. */
export const DetailField = {
  id: 0,
  type: 1,
  /** 1 if the player can reach the entity (to use its GUI), else 0. */
  reachable: 2,
  status: 3,
  recipe: 4,
  progress: 5,
  energy: 6,
  burning: 7,
  /**
   * Joules per tick of electric power on the latest tick: delivered
   * (generators, boilers) or drawn (electric consumers).
   */
  power: 8,
  /** The electric network the entity belongs to (0: none, or not electric) and its satisfaction. */
  network: 9,
  satisfaction: 10,
  /** A lab's unit in progress: its technology (0: none). */
  technology: 11,
  slotCount: 12,
} as const;
const DETAIL_HEADER = 13;

/**
 * The recipes player `playerId` can set entity `id` to, in id order: those
 * it can make (`allowsRecipe`) that the player's force has unlocked
 * (`isRecipeUnlocked`). Empty for entities without a recipe picker.
 */
export function recipeOptions(state: SimState, playerId: number, id: number): number[] {
  const { entities } = state;
  if (entities.table(entities.store.type(id))?.setRecipe === undefined) return [];
  const force = forceOf(state, playerId);
  return RECIPE_IDS.filter(
    (r) => entities.allowsRecipe(id, r) && isRecipeUnlocked(state, force, r),
  );
}

/**
 * Encodes what the entity GUI shows about entity `id` for player `playerId`
 * as int32s: the {@link DetailField} header, one `[item, count]` pair per
 * slot, then `[optionCount]` and the recipes its recipe picker offers
 * (`recipeOptions`; none for entities without one). `recipe` is the recipe
 * set (assembling machines) or being made (furnaces). `null` when there is
 * no such entity.
 */
export function encodeEntityDetail(
  state: SimState,
  playerId: number,
  id: number,
): Int32Array<ArrayBuffer> | null {
  const { entities } = state;
  const type = entities.store.type(id);
  if (type === 0) {
    return null;
  }
  const slots = entities.slots(id);
  const detail = entities.detail(id);
  const options = recipeOptions(state, playerId, id);
  const out = new Int32Array(DETAIL_HEADER + 2 * slots.length + 1 + options.length);
  out[DetailField.id] = id;
  out[DetailField.type] = type;
  out[DetailField.reachable] = reaches(state, playerId, id) ? 1 : 0;
  out[DetailField.status] = displayStatus(state, id);
  out[DetailField.recipe] = detail?.recipe ?? 0;
  out[DetailField.progress] = detail?.progress ?? 0;
  out[DetailField.energy] = detail?.energy ?? 0;
  out[DetailField.burning] = detail?.burning ?? 0;
  const grid = powerGrid(entities);
  out[DetailField.power] = detail?.power ?? consumerDraw(state, id);
  out[DetailField.network] = grid?.networkOf(id) ?? 0;
  out[DetailField.satisfaction] = grid?.satisfaction(id) ?? 0;
  out[DetailField.technology] = detail?.technology ?? 0;
  out[DetailField.slotCount] = slots.length;
  slots.forEach((slot, i) => {
    out[DETAIL_HEADER + 2 * i] = slot.item;
    out[DETAIL_HEADER + 2 * i + 1] = slot.count;
  });
  const o = DETAIL_HEADER + 2 * slots.length;
  out[o] = options.length;
  out.set(options, o + 1);
  return out;
}

/** An entity's GUI data as decoded on the main thread. */
export interface EntityDetailData {
  id: number;
  type: number;
  reachable: boolean;
  status: number;
  recipe: number;
  progress: number;
  energy: number;
  burning: number;
  /** Joules per tick of electric power delivered (producers) or drawn (consumers) on the latest tick. */
  power: number;
  /** Electric network (0: none) and its satisfaction in units of 1/`SAT_ONE`. */
  network: number;
  satisfaction: number;
  /** A lab's unit in progress: its technology (0: none). */
  technology: number;
  slots: SlotData[];
  /** The recipes the entity's recipe picker offers, in id order (empty without a picker). */
  recipeOptions: number[];
}

/** Unpacks a buffer made by {@link encodeEntityDetail}. */
export function decodeEntityDetail(buffer: ArrayBuffer): EntityDetailData {
  const v = new Int32Array(buffer);
  const slots: SlotData[] = [];
  const n = v[DetailField.slotCount] ?? 0;
  for (let i = 0; i < n; i++) {
    slots.push({ item: v[DETAIL_HEADER + 2 * i]!, count: v[DETAIL_HEADER + 2 * i + 1]! });
  }
  const o = DETAIL_HEADER + 2 * n;
  const recipeCount = Math.max(0, Math.min(v[o] ?? 0, v.length - o - 1));
  const recipeOptions = Array.from(v.subarray(o + 1, o + 1 + recipeCount));
  return {
    id: v[DetailField.id]! >>> 0,
    type: v[DetailField.type]!,
    reachable: v[DetailField.reachable] === 1,
    status: v[DetailField.status]!,
    recipe: v[DetailField.recipe]!,
    progress: v[DetailField.progress]!,
    energy: v[DetailField.energy]!,
    burning: v[DetailField.burning]!,
    power: v[DetailField.power]! >>> 0,
    network: v[DetailField.network]! >>> 0,
    satisfaction: v[DetailField.satisfaction]!,
    technology: v[DetailField.technology]!,
    slots,
    recipeOptions,
  };
}

/** One inventory slot as decoded on the main thread; `item` 0 is an empty slot. */
export interface SlotData {
  item: number;
  count: number;
}

/** Unpacks a buffer made by {@link encodeInventory}. */
export function decodeInventory(buffer: ArrayBuffer): SlotData[] {
  const view = new Uint16Array(buffer, 0, (buffer.byteLength >> 2) << 1);
  const out: SlotData[] = [];
  for (let i = 0; i + 1 < view.length; i += 2) {
    out.push({ item: view[i]!, count: view[i + 1]! });
  }
  return out;
}

/** Byte offsets of the fields within one chunk record of {@link encodeChunks}. */
const RECORD_TERRAIN = 8;
const RECORD_RESOURCE = RECORD_TERRAIN + CHUNK_AREA;
const RECORD_TREE = RECORD_RESOURCE + CHUNK_AREA;
const RECORD_AMOUNT = RECORD_TREE + CHUNK_AREA;

/**
 * Bytes per chunk record in {@link encodeChunks}:
 * `cx: int32, cy: int32, terrain: uint8[CHUNK_AREA], resource: uint8[CHUNK_AREA],
 * tree: uint8[CHUNK_AREA], amount: uint32[CHUNK_AREA]`. Every field starts at
 * a multiple of 4 bytes.
 */
export const CHUNK_RECORD_BYTES = RECORD_AMOUNT + 4 * CHUNK_AREA;

/** Terrain, resources and trees of one chunk (a `Chunk`, or one decoded on the main thread). */
export interface ChunkData {
  /** Chunk coordinates (in chunks, not tiles). */
  readonly cx: number;
  readonly cy: number;
  /** Row-major per-tile arrays of length `CHUNK_AREA`, as in src/sim/world/chunk.ts. */
  readonly terrain: Uint8Array;
  readonly resource: Uint8Array;
  readonly amount: Uint32Array;
  /** 1 where a tree stands, else 0. */
  readonly tree: Uint8Array;
}

/** Packs the terrain, resources and trees of `chunks` into one transferable buffer. */
export function encodeChunks(chunks: readonly ChunkData[]): ArrayBuffer {
  const buffer = new ArrayBuffer(chunks.length * CHUNK_RECORD_BYTES);
  chunks.forEach((chunk, i) => {
    const r = recordViews(buffer, i);
    r.coords[0] = chunk.cx;
    r.coords[1] = chunk.cy;
    r.terrain.set(chunk.terrain);
    r.resource.set(chunk.resource);
    r.amount.set(chunk.amount);
    r.tree.set(chunk.tree);
  });
  return buffer;
}

/**
 * Unpacks a buffer made by {@link encodeChunks}, in the same order. The arrays
 * are views into `buffer`, not copies.
 */
export function decodeChunks(buffer: ArrayBuffer): ChunkData[] {
  if (buffer.byteLength % CHUNK_RECORD_BYTES !== 0) {
    throw new RangeError(
      `chunk buffer of ${String(buffer.byteLength)} bytes is not a whole number of records`,
    );
  }
  const out: ChunkData[] = [];
  const count = buffer.byteLength / CHUNK_RECORD_BYTES;
  for (let i = 0; i < count; i++) {
    const r = recordViews(buffer, i);
    out.push({
      cx: r.coords[0]!,
      cy: r.coords[1]!,
      terrain: r.terrain,
      resource: r.resource,
      amount: r.amount,
      tree: r.tree,
    });
  }
  return out;
}

function recordViews(
  buffer: ArrayBuffer,
  index: number,
): {
  coords: Int32Array;
  terrain: Uint8Array;
  resource: Uint8Array;
  amount: Uint32Array;
  tree: Uint8Array;
} {
  const base = index * CHUNK_RECORD_BYTES;
  return {
    // [cx, cy]
    coords: new Int32Array(buffer, base, 2),
    terrain: new Uint8Array(buffer, base + RECORD_TERRAIN, CHUNK_AREA),
    resource: new Uint8Array(buffer, base + RECORD_RESOURCE, CHUNK_AREA),
    amount: new Uint32Array(buffer, base + RECORD_AMOUNT, CHUNK_AREA),
    tree: new Uint8Array(buffer, base + RECORD_TREE, CHUNK_AREA),
  };
}

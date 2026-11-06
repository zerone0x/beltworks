/**
 * Render snapshot encoding: copies the state the renderer needs into fresh
 * typed arrays whose buffers can be transferred to the main thread.
 */

import type { ChunkRange } from './entities/occupancy';
import type { SimState } from './state';
import { CHUNK_AREA } from './world/chunk';

/** Int32 fields per player in {@link encodePlayers}. */
export const PLAYER_STRIDE = 6;
/** Field offsets within one player record. */
export const PlayerField = {
  x: 0,
  y: 1,
  mining: 2,
  mineX: 3,
  mineY: 4,
  mineProgress: 5,
} as const;

/**
 * Encodes every player as `PLAYER_STRIDE` int32s:
 * `[x, y, mining, mineX, mineY, mineProgress]` (positions in subtiles, mine
 * target in tiles, progress in ticks out of `HAND_MINING_TICKS`).
 */
export function encodePlayers(state: SimState): Int32Array<ArrayBuffer> {
  const p = state.players;
  const out = new Int32Array(p.count * PLAYER_STRIDE);
  for (let i = 0, o = 0; i < p.count; i++, o += PLAYER_STRIDE) {
    out[o + PlayerField.x] = p.x[i]!;
    out[o + PlayerField.y] = p.y[i]!;
    out[o + PlayerField.mining] = p.mining[i]!;
    out[o + PlayerField.mineX] = p.mineX[i]!;
    out[o + PlayerField.mineY] = p.mineY[i]!;
    out[o + PlayerField.mineProgress] = p.mineProgress[i]!;
  }
  return out;
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

/** Int32 fields per entity in {@link encodeEntities}. */
export const ENTITY_STRIDE = 5;
/** Field offsets within one entity record. */
export const EntityField = {
  id: 0,
  type: 1,
  x: 2,
  y: 3,
  dir: 4,
} as const;

/**
 * Encodes the entities whose origin (top-left tile) lies in the chunks of
 * `range` as `ENTITY_STRIDE` int32s each: `[id, type, x, y, dir]` (ids are
 * uint32s stored bit for bit; `x`, `y` is the top-left tile). Entities are
 * at most `MAX_ENTITY_SIZE` tiles wide, so a range with a one-chunk margin
 * around the viewport catches every entity that overlaps it.
 */
export function encodeEntities(state: SimState, range: ChunkRange | null): Int32Array<ArrayBuffer> {
  if (range === null) {
    return new Int32Array(0);
  }
  const { store, occupancy } = state.entities;
  const ids = occupancy.originsIn(range);
  const out = new Int32Array(ids.length * ENTITY_STRIDE);
  ids.forEach((id, i) => {
    const o = i * ENTITY_STRIDE;
    out[o + EntityField.id] = id;
    out[o + EntityField.type] = store.type(id);
    out[o + EntityField.x] = store.x(id);
    out[o + EntityField.y] = store.y(id);
    out[o + EntityField.dir] = store.dir(id);
  });
  return out;
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
const RECORD_AMOUNT = RECORD_RESOURCE + CHUNK_AREA;

/**
 * Bytes per chunk record in {@link encodeChunks}:
 * `cx: int32, cy: int32, terrain: uint8[CHUNK_AREA], resource: uint8[CHUNK_AREA],
 * amount: uint32[CHUNK_AREA]`. Every field starts at a multiple of 4 bytes.
 */
export const CHUNK_RECORD_BYTES = RECORD_AMOUNT + 4 * CHUNK_AREA;

/** Terrain and resources of one chunk (a `Chunk`, or one decoded on the main thread). */
export interface ChunkData {
  /** Chunk coordinates (in chunks, not tiles). */
  readonly cx: number;
  readonly cy: number;
  /** Row-major per-tile arrays of length `CHUNK_AREA`, as in src/sim/world/chunk.ts. */
  readonly terrain: Uint8Array;
  readonly resource: Uint8Array;
  readonly amount: Uint32Array;
}

/** Packs the terrain and resources of `chunks` into one transferable buffer. */
export function encodeChunks(chunks: readonly ChunkData[]): ArrayBuffer {
  const buffer = new ArrayBuffer(chunks.length * CHUNK_RECORD_BYTES);
  chunks.forEach((chunk, i) => {
    const r = recordViews(buffer, i);
    r.coords[0] = chunk.cx;
    r.coords[1] = chunk.cy;
    r.terrain.set(chunk.terrain);
    r.resource.set(chunk.resource);
    r.amount.set(chunk.amount);
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
    });
  }
  return out;
}

function recordViews(
  buffer: ArrayBuffer,
  index: number,
): { coords: Int32Array; terrain: Uint8Array; resource: Uint8Array; amount: Uint32Array } {
  const base = index * CHUNK_RECORD_BYTES;
  return {
    // [cx, cy]
    coords: new Int32Array(buffer, base, 2),
    terrain: new Uint8Array(buffer, base + RECORD_TERRAIN, CHUNK_AREA),
    resource: new Uint8Array(buffer, base + RECORD_RESOURCE, CHUNK_AREA),
    amount: new Uint32Array(buffer, base + RECORD_AMOUNT, CHUNK_AREA),
  };
}

/**
 * The map: lazily generated chunks plus the modifications made to them.
 */

import { ResourceId } from '../../data/resources';
import { isWalkable } from '../../data/tiles';
import { FNV1A32_OFFSET_BASIS, fnv1a32 } from '../hash';
import { CHUNK_MASK, CHUNK_SHIFT, CHUNK_SIZE, type Chunk } from './chunk';
import { generateChunk } from './generate';

/**
 * Chunk coordinates must be in `[-CHUNK_COORD_LIMIT, CHUNK_COORD_LIMIT)` so
 * they pack into 16 bits each (about ±1M tiles from the origin).
 */
export const CHUNK_COORD_LIMIT = 1 << 15;

/**
 * Packs chunk coordinates into a single int32 `Map` key. Only unique for
 * coordinates that pass {@link isChunkCoord}; anything else wraps around and
 * aliases another chunk, so callers must check the range first.
 */
export function chunkKey(cx: number, cy: number): number {
  return ((cx & 0xffff) << 16) | (cy & 0xffff);
}

/** True if `c` is an integer chunk coordinate in the supported range. */
export function isChunkCoord(c: number): boolean {
  return Number.isInteger(c) && c >= -CHUNK_COORD_LIMIT && c < CHUNK_COORD_LIMIT;
}

/**
 * True if world tile `(x, y)` lies in the supported map range, i.e. its chunk
 * can be generated. Usable without a `World` (e.g. by the renderer).
 */
export function isTileInMap(x: number, y: number): boolean {
  return (
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    isChunkCoord(Math.floor(x / CHUNK_SIZE)) &&
    isChunkCoord(Math.floor(y / CHUNK_SIZE))
  );
}

function assertChunkCoord(c: number): void {
  if (!isChunkCoord(c)) {
    throw new RangeError(`chunk coordinate out of range: ${String(c)}`);
  }
}

export class World {
  /** World seed (uint32). */
  readonly seed: number;
  private readonly chunks = new Map<number, Chunk>();
  /**
   * Chunks that differ from what {@link generateChunk} would produce, keyed by
   * {@link chunkKey}, with the number of modifications made to each. Only the
   * keys are game state (they select what gets hashed); the counts are
   * bookkeeping for {@link chunkVersion}.
   */
  private readonly dirty = new Map<number, number>();

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  /** Number of chunks generated so far. */
  get chunkCount(): number {
    return this.chunks.size;
  }

  /**
   * Returns chunk `(cx, cy)`, generating it on first access. Throws a
   * `RangeError` for coordinates outside the supported range.
   */
  getChunk(cx: number, cy: number): Chunk {
    // Check before building the key: out-of-range coordinates would wrap
    // around in `chunkKey` and return an unrelated cached chunk.
    assertChunkCoord(cx);
    assertChunkCoord(cy);
    const key = chunkKey(cx, cy);
    let chunk = this.chunks.get(key);
    if (chunk === undefined) {
      chunk = generateChunk(this.seed, cx, cy);
      this.chunks.set(key, chunk);
    }
    return chunk;
  }

  /**
   * Returns the chunk if it has already been generated, without generating it.
   * Returns `undefined` for coordinates outside the supported range.
   */
  peekChunk(cx: number, cy: number): Chunk | undefined {
    if (!isChunkCoord(cx) || !isChunkCoord(cy)) return undefined;
    return this.chunks.get(chunkKey(cx, cy));
  }

  /**
   * Number of modifications made to chunk `(cx, cy)` so far: 0 while it is
   * still exactly what generation produces. Lets the worker tell which chunks
   * changed since it last sent them to the renderer.
   */
  chunkVersion(cx: number, cy: number): number {
    if (!isChunkCoord(cx) || !isChunkCoord(cy)) return 0;
    return this.dirty.get(chunkKey(cx, cy)) ?? 0;
  }

  /**
   * Drops chunk `(cx, cy)` from the cache if it is unmodified, so memory stays
   * bounded while a viewer pans across the map. An unmodified chunk is a pure
   * function of the seed, so it is simply generated again on the next access;
   * modified chunks are kept. Returns whether the chunk was dropped.
   */
  unloadChunk(cx: number, cy: number): boolean {
    if (!isChunkCoord(cx) || !isChunkCoord(cy)) return false;
    const key = chunkKey(cx, cy);
    if (this.dirty.has(key)) return false;
    return this.chunks.delete(key);
  }

  /**
   * True if world tile `(x, y)` lies in the supported map range, i.e. its
   * chunk can be generated. The tile accessors throw for tiles outside it.
   */
  isTileInRange(x: number, y: number): boolean {
    return isTileInMap(x, y);
  }

  /** Whether players can walk on tile `(x, y)`. Tiles outside the map range are not walkable. */
  isWalkable(x: number, y: number): boolean {
    return this.isTileInRange(x, y) && isWalkable(this.tileAt(x, y));
  }

  /** Tile id at world tile `(x, y)` (integers). */
  tileAt(x: number, y: number): number {
    return this.getChunk(x >> CHUNK_SHIFT, y >> CHUNK_SHIFT).terrain[
      ((y & CHUNK_MASK) << CHUNK_SHIFT) | (x & CHUNK_MASK)
    ]!;
  }

  /** Resource id at world tile `(x, y)`, or `ResourceId.None` (0). */
  resourceAt(x: number, y: number): number {
    return this.getChunk(x >> CHUNK_SHIFT, y >> CHUNK_SHIFT).resource[
      ((y & CHUNK_MASK) << CHUNK_SHIFT) | (x & CHUNK_MASK)
    ]!;
  }

  /** Remaining resource amount at world tile `(x, y)` (0 when there is no resource). */
  amountAt(x: number, y: number): number {
    return this.getChunk(x >> CHUNK_SHIFT, y >> CHUNK_SHIFT).amount[
      ((y & CHUNK_MASK) << CHUNK_SHIFT) | (x & CHUNK_MASK)
    ]!;
  }

  /**
   * Removes up to `amount` units of resource from tile `(x, y)` and returns the
   * number actually removed. When the tile runs out its resource is cleared.
   * `amount` must be a non-negative integer.
   */
  mine(x: number, y: number, amount: number): number {
    if (!Number.isInteger(amount) || amount < 0) {
      throw new RangeError(`mine amount must be a non-negative integer, got ${String(amount)}`);
    }
    const cx = x >> CHUNK_SHIFT;
    const cy = y >> CHUNK_SHIFT;
    const chunk = this.getChunk(cx, cy);
    const i = ((y & CHUNK_MASK) << CHUNK_SHIFT) | (x & CHUNK_MASK);
    const available = chunk.amount[i]!;
    const taken = Math.min(available, amount);
    if (taken === 0) return 0;
    const left = available - taken;
    chunk.amount[i] = left;
    if (left === 0) chunk.resource[i] = ResourceId.None;
    const key = chunkKey(cx, cy);
    this.dirty.set(key, (this.dirty.get(key) ?? 0) + 1);
    return taken;
  }

  /**
   * Folds the world state into an FNV-1a hash (see src/sim/hash.ts) and returns
   * the new hash: `h = world.hashInto(h)`.
   *
   * Unmodified chunks are a pure function of the seed, so only the seed and the
   * modified chunks (sorted by coordinates) are hashed. This keeps the hash
   * independent of which chunks happen to have been generated, e.g. because a
   * client looked at a different part of the map.
   */
  hashInto(hash: number = FNV1A32_OFFSET_BASIS): number {
    const modified = Array.from(this.dirty.keys(), (key) => this.chunks.get(key)!).sort(
      (a, b) => a.cx - b.cx || a.cy - b.cy,
    );
    const header = Int32Array.of(this.seed | 0, modified.length);
    let h = fnv1a32(header, hash);
    for (const chunk of modified) {
      header[0] = chunk.cx;
      header[1] = chunk.cy;
      h = fnv1a32(header, h);
      h = fnv1a32(chunk.terrain, h);
      h = fnv1a32(chunk.resource, h);
      h = fnv1a32(chunk.amount, h);
    }
    return h;
  }
}

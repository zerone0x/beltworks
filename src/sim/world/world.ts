/**
 * The map: lazily generated chunks plus the modifications made to them.
 */

import { ResourceId } from '../../data/resources';
import { FNV1A32_OFFSET_BASIS, fnv1a32 } from '../hash';
import { CHUNK_MASK, CHUNK_SHIFT, type Chunk } from './chunk';
import { generateChunk } from './generate';

/**
 * Chunk coordinates must be in `[-CHUNK_COORD_LIMIT, CHUNK_COORD_LIMIT)` so
 * they pack into 16 bits each (about ±1M tiles from the origin).
 */
export const CHUNK_COORD_LIMIT = 1 << 15;

/** Packs chunk coordinates into a single int32 `Map` key. */
export function chunkKey(cx: number, cy: number): number {
  return ((cx & 0xffff) << 16) | (cy & 0xffff);
}

function assertChunkCoord(c: number): void {
  if (!Number.isInteger(c) || c < -CHUNK_COORD_LIMIT || c >= CHUNK_COORD_LIMIT) {
    throw new RangeError(`chunk coordinate out of range: ${String(c)}`);
  }
}

export class World {
  /** World seed (uint32). */
  readonly seed: number;
  private readonly chunks = new Map<number, Chunk>();
  /** Keys of chunks that differ from what {@link generateChunk} would produce. */
  private readonly dirty = new Set<number>();

  constructor(seed: number) {
    this.seed = seed >>> 0;
  }

  /** Number of chunks generated so far. */
  get chunkCount(): number {
    return this.chunks.size;
  }

  /** Returns chunk `(cx, cy)`, generating it on first access. */
  getChunk(cx: number, cy: number): Chunk {
    const key = chunkKey(cx, cy);
    let chunk = this.chunks.get(key);
    if (chunk === undefined) {
      assertChunkCoord(cx);
      assertChunkCoord(cy);
      chunk = generateChunk(this.seed, cx, cy);
      this.chunks.set(key, chunk);
    }
    return chunk;
  }

  /** Returns the chunk if it has already been generated, without generating it. */
  peekChunk(cx: number, cy: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cy));
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
    this.dirty.add(chunkKey(cx, cy));
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
    const modified = Array.from(this.dirty, (key) => this.chunks.get(key)!).sort(
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

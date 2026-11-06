/**
 * The spatial index of entities: which entity covers each tile (for placement
 * collision and "what is under the cursor"), and which entities have their
 * origin in each chunk (for collecting the entities in a viewport).
 *
 * Stored per 32×32 chunk, like the world, so footprints that cross chunk
 * borders and negative coordinates need no special cases. A chunk record
 * exists only while at least one tile in it is covered.
 */

import { FNV1A32_OFFSET_BASIS, fnv1a32 } from '../hash';
import { CHUNK_AREA, CHUNK_MASK, CHUNK_SHIFT, tileIndex } from '../world/chunk';
import { chunkKey, isChunkCoord } from '../world/world';

interface OccupancyChunk {
  readonly cx: number;
  readonly cy: number;
  /** Entity id per tile, 0 where the tile is free. */
  readonly tiles: Uint32Array;
  /** Number of covered tiles. */
  covered: number;
  /** Entities whose origin (top-left tile) lies in this chunk, in insertion order. */
  readonly origins: number[];
}

/** An inclusive rectangle of chunk coordinates. */
export interface ChunkRange {
  cx0: number;
  cy0: number;
  cx1: number;
  cy1: number;
}

export class Occupancy {
  private readonly chunks = new Map<number, OccupancyChunk>();

  /** Number of chunk records (chunks with at least one covered tile). */
  get chunkCount(): number {
    return this.chunks.size;
  }

  /** The entity covering tile `(x, y)`, or 0. Tiles outside the map range are free. */
  at(x: number, y: number): number {
    const chunk = this.peek(x >> CHUNK_SHIFT, y >> CHUNK_SHIFT);
    return chunk ? chunk.tiles[tileIndex(x & CHUNK_MASK, y & CHUNK_MASK)]! : 0;
  }

  /**
   * Marks the `w`×`h` tiles from `(x, y)` as covered by `id`, and records `id`
   * as originating in the chunk of `(x, y)`. The tiles must be in the map
   * range and free (the caller has checked placement).
   */
  fill(id: number, x: number, y: number, w: number, h: number): void {
    for (let ty = y; ty < y + h; ty++) {
      for (let tx = x; tx < x + w; tx++) {
        const chunk = this.chunk(tx >> CHUNK_SHIFT, ty >> CHUNK_SHIFT);
        const i = tileIndex(tx & CHUNK_MASK, ty & CHUNK_MASK);
        if (chunk.tiles[i] !== 0) {
          throw new RangeError(`tile (${String(tx)}, ${String(ty)}) is already occupied`);
        }
        chunk.tiles[i] = id;
        chunk.covered++;
      }
    }
    this.chunk(x >> CHUNK_SHIFT, y >> CHUNK_SHIFT).origins.push(id);
  }

  /** Undoes {@link fill} for entity `id` with the same rectangle. */
  clear(id: number, x: number, y: number, w: number, h: number): void {
    const home = this.peek(x >> CHUNK_SHIFT, y >> CHUNK_SHIFT);
    const at = home ? home.origins.indexOf(id) : -1;
    if (at >= 0) home!.origins.splice(at, 1);
    for (let ty = y; ty < y + h; ty++) {
      for (let tx = x; tx < x + w; tx++) {
        const cx = tx >> CHUNK_SHIFT;
        const cy = ty >> CHUNK_SHIFT;
        const chunk = this.peek(cx, cy);
        const i = tileIndex(tx & CHUNK_MASK, ty & CHUNK_MASK);
        if (chunk?.tiles[i] !== id) {
          continue;
        }
        chunk.tiles[i] = 0;
        if (--chunk.covered === 0) {
          this.chunks.delete(chunkKey(cx, cy));
        }
      }
    }
  }

  /**
   * Appends to `out` every entity whose origin lies in the chunks of `range`,
   * row by row of chunks, and returns `out`.
   */
  originsIn(range: ChunkRange, out: number[] = []): number[] {
    for (let cy = range.cy0; cy <= range.cy1; cy++) {
      for (let cx = range.cx0; cx <= range.cx1; cx++) {
        const chunk = this.peek(cx, cy);
        if (chunk) out.push(...chunk.origins);
      }
    }
    return out;
  }

  /** Folds the covered tiles (chunks sorted by coordinates) into a running FNV-1a hash. */
  hashInto(hash: number = FNV1A32_OFFSET_BASIS): number {
    const sorted = Array.from(this.chunks.values()).sort((a, b) => a.cx - b.cx || a.cy - b.cy);
    const header = Int32Array.of(sorted.length, 0);
    let h = fnv1a32(header.subarray(0, 1), hash);
    for (const chunk of sorted) {
      header[0] = chunk.cx;
      header[1] = chunk.cy;
      h = fnv1a32(header, h);
      h = fnv1a32(chunk.tiles, h);
    }
    return h;
  }

  private peek(cx: number, cy: number): OccupancyChunk | undefined {
    if (!isChunkCoord(cx) || !isChunkCoord(cy)) return undefined;
    return this.chunks.get(chunkKey(cx, cy));
  }

  private chunk(cx: number, cy: number): OccupancyChunk {
    if (!isChunkCoord(cx) || !isChunkCoord(cy)) {
      throw new RangeError(`chunk (${String(cx)}, ${String(cy)}) is outside the map`);
    }
    const key = chunkKey(cx, cy);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = { cx, cy, tiles: new Uint32Array(CHUNK_AREA), covered: 0, origins: [] };
      this.chunks.set(key, chunk);
    }
    return chunk;
  }
}

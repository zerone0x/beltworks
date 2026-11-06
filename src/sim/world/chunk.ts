/**
 * A fixed-size square block of the map. Tiles are stored row-major:
 * the tile at local `(lx, ly)` lives at index `ly * CHUNK_SIZE + lx`.
 */

/** Chunk edge length in tiles. Must stay a power of two (see {@link CHUNK_SHIFT}). */
export const CHUNK_SIZE = 32;
/** `log2(CHUNK_SIZE)`: world tile `x` is in chunk `x >> CHUNK_SHIFT`. */
export const CHUNK_SHIFT = 5;
/** Mask for the local coordinate inside a chunk: `x & CHUNK_MASK`. */
export const CHUNK_MASK = CHUNK_SIZE - 1;
/** Number of tiles in a chunk. */
export const CHUNK_AREA = CHUNK_SIZE * CHUNK_SIZE;

export class Chunk {
  /** Chunk coordinates (in chunks, not tiles). */
  readonly cx: number;
  readonly cy: number;
  /** Tile id per tile (see src/data/tiles.ts). */
  readonly terrain = new Uint8Array(CHUNK_AREA);
  /** Resource id per tile, 0 = none (see src/data/resources.ts). */
  readonly resource = new Uint8Array(CHUNK_AREA);
  /** Remaining resource amount per tile; 0 wherever `resource` is 0. */
  readonly amount = new Uint32Array(CHUNK_AREA);

  constructor(cx: number, cy: number) {
    this.cx = cx;
    this.cy = cy;
  }
}

/** Index of local tile `(lx, ly)` in a chunk's arrays. */
export function tileIndex(lx: number, ly: number): number {
  return (ly << CHUNK_SHIFT) | lx;
}

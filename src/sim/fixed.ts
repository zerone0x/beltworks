/**
 * Fixed-point helpers for the simulation.
 *
 * Positions are plain integers in 1/256-tile units ("subtiles"): tile `t` spans
 * subtiles `[t * 256, t * 256 + 255]`. Progress values use 1/65536 units.
 * Values stored in simulation state must fit in an int32, which limits
 * positions to about ±8.3 million tiles.
 *
 * Nothing here returns a fractional number; converting to floats for display
 * is the renderer's job.
 */

/** Number of fractional bits in a fixed-point position. */
export const SUBTILE_BITS = 8;
/** Subtiles per tile (`1 << SUBTILE_BITS`). */
export const SUBTILES_PER_TILE = 1 << SUBTILE_BITS;
/** Mask selecting the sub-tile part of a position. */
export const SUBTILE_MASK = SUBTILES_PER_TILE - 1;
/** Offset from a tile's origin to its center, in subtiles. */
export const HALF_TILE = SUBTILES_PER_TILE >> 1;

/** One whole unit of progress (crafting, mining, ...), in 1/65536 units. */
export const PROGRESS_ONE = 1 << 16;

export const INT32_MIN = -0x8000_0000;
export const INT32_MAX = 0x7fff_ffff;

/** True if `v` is an integer that fits in an int32. */
export function isInt32(v: number): boolean {
  return Number.isInteger(v) && v >= INT32_MIN && v <= INT32_MAX;
}

/** Position of the origin (top-left corner) of tile `tile`, in subtiles. */
export function tileToFixed(tile: number): number {
  return tile * SUBTILES_PER_TILE;
}

/** Position of the center of tile `tile`, in subtiles. */
export function tileCenter(tile: number): number {
  return tile * SUBTILES_PER_TILE + HALF_TILE;
}

/** Tile containing the int32 position `fixed` (rounds toward negative infinity). */
export function fixedToTile(fixed: number): number {
  return fixed >> SUBTILE_BITS;
}

/** Sub-tile part of the int32 position `fixed`, in [0, 255], also for negative positions. */
export function fixedFrac(fixed: number): number {
  return fixed & SUBTILE_MASK;
}

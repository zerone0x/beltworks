/**
 * The four directions an entity can face. Stored as a uint8 in the entity
 * tables; the values must stay stable.
 */

export const Direction = {
  North: 0,
  East: 1,
  South: 2,
  West: 3,
} as const;

export type Direction = (typeof Direction)[keyof typeof Direction];

/** Tile offset of one step in each direction (y grows southwards). */
export const DIRECTION_DX: readonly number[] = [0, 1, 0, -1];
export const DIRECTION_DY: readonly number[] = [-1, 0, 1, 0];

/** True if `v` is a direction value (an integer in [0, 3]). */
export function isDirection(v: unknown): v is Direction {
  return v === 0 || v === 1 || v === 2 || v === 3;
}

/** The direction after a quarter turn clockwise. */
export function rotateClockwise(dir: Direction): Direction {
  return ((dir + 1) & 3) as Direction;
}

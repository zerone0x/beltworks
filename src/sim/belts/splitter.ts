/**
 * Splitter geometry (docs/ARCHITECTURE.md, "Belts: splitters"): a pure
 * function of position and direction, shared by the belt table
 * (src/sim/belts/belts.ts), the snapshot and the renderer.
 *
 * A splitter is 2 tiles across the way items move and 1 along it. Its top-
 * left tile is the entity's position, as for every entity; half 0 is the
 * one on the left (looking the way items move), half 1 the one on the
 * right. Each half is a belt of its own: fed from the tile behind it,
 * feeding the tile in front of it.
 */

import { DIRECTION_DX, DIRECTION_DY, type Direction } from '../entities/direction';

/**
 * The belt snapshot's `mode` of a splitter half: this plus the half (past
 * the `UndergroundMode` values, so nothing takes a half for an underground).
 */
export const SPLITTER_HALF_MODE = 3;

/** The tile of half `half` (0: left, 1: right) of a splitter at `(x, y)` facing `dir`. */
export function splitterHalfTile(
  x: number,
  y: number,
  dir: Direction,
  half: number,
): { x: number; y: number } {
  // The left half: the top-left tile, except facing south (top-right) or west (bottom-left).
  const lx = dir === 2 ? x + 1 : x;
  const ly = dir === 3 ? y + 1 : y;
  // The right half is one step clockwise of the direction from it.
  const r = (dir + 1) & 3;
  return { x: lx + half * DIRECTION_DX[r]!, y: ly + half * DIRECTION_DY[r]! };
}

/** Which half of a splitter at `(x, y)` facing `dir` covers tile `(tx, ty)`: 0 or 1. */
export function splitterHalfAt(
  x: number,
  y: number,
  dir: Direction,
  tx: number,
  ty: number,
): number {
  const left = splitterHalfTile(x, y, dir, 0);
  return left.x === tx && left.y === ty ? 0 : 1;
}

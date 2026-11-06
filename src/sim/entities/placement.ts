/**
 * Placement rules, shared by the simulation (which decides) and the renderer
 * (which colors the ghost preview with the same verdict, from the data in its
 * snapshots).
 *
 * An entity can be placed when its whole footprint is inside the map, on
 * buildable terrain (not water), free of other entities, clear of every
 * player's collision box, and its center is within build reach of the
 * builder. All checks are integer-only.
 */

import type { EntityPrototype } from '../../data/entities';
import { HALF_TILE, SUBTILES_PER_TILE, fixedToTile, tileToFixed } from '../fixed';
import { PLAYER_HALF_SIZE } from '../player';
import type { Direction } from './direction';
import { footprintSize } from './store';

/** Build reach (placing, removing, rotating) in subtiles: 10 tiles. */
export const BUILD_REACH = 10 * SUBTILES_PER_TILE;
const BUILD_REACH_SQ = BUILD_REACH * BUILD_REACH;

/** Why a placement is refused (or `Ok`). */
export const Placement = {
  Ok: 0,
  /** Part of the footprint lies outside the supported map range. */
  OutOfMap: 1,
  /** The footprint's center is out of the builder's reach. */
  OutOfReach: 2,
  /** Part of the footprint is on terrain that can't be built on (water). */
  Terrain: 3,
  /** Another entity covers part of the footprint. */
  Occupied: 4,
  /** A player's collision box overlaps the footprint. */
  PlayerInTheWay: 5,
} as const;

export type Placement = (typeof Placement)[keyof typeof Placement];

/** What a placement check needs to know about the world. */
export interface PlacementView {
  /** Whether tile `(x, y)` lies in the supported map range. */
  inMap(x: number, y: number): boolean;
  /** Whether entities can stand on tile `(x, y)` (it is in the map range). */
  buildable(x: number, y: number): boolean;
  /** The entity covering tile `(x, y)`, or 0. */
  occupant(x: number, y: number): number;
  /** Number of players; player `i` stands at `(playerX(i), playerY(i))`, in subtiles. */
  readonly playerCount: number;
  playerX(i: number): number;
  playerY(i: number): number;
}

/**
 * Whether a builder at `(px, py)` (subtiles) can reach a footprint whose
 * top-left tile is `(x, y)` and size `w`×`h` tiles: the squared distance to
 * its center is compared exactly, after a per-axis check that keeps the
 * squares small.
 */
export function inBuildReach(
  px: number,
  py: number,
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  const dx = tileToFixed(x) + w * HALF_TILE - px;
  const dy = tileToFixed(y) + h * HALF_TILE - py;
  if (dx > BUILD_REACH || dx < -BUILD_REACH || dy > BUILD_REACH || dy < -BUILD_REACH) {
    return false;
  }
  return dx * dx + dy * dy <= BUILD_REACH_SQ;
}

/** Whether a player at `(px, py)` (subtiles) overlaps the tile rectangle `[x0, x1] × [y0, y1]`. */
export function playerOverlaps(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  // The player's box covers subtiles [p - H, p + H) on each axis.
  const H = PLAYER_HALF_SIZE;
  return (
    fixedToTile(px - H) <= x1 &&
    fixedToTile(px + H - 1) >= x0 &&
    fixedToTile(py - H) <= y1 &&
    fixedToTile(py + H - 1) >= y0
  );
}

/**
 * Checks placing `proto` facing `dir` with its top-left tile at `(x, y)`, for
 * a builder at `(px, py)` (subtiles). Tiles covered by entity `ignore` count
 * as free (used when rotating an entity in place).
 */
export function checkPlacement(
  view: PlacementView,
  proto: EntityPrototype,
  x: number,
  y: number,
  dir: Direction,
  px: number,
  py: number,
  ignore: number = 0,
): Placement {
  const { w, h } = footprintSize(proto, dir);
  const x1 = x + w - 1;
  const y1 = y + h - 1;
  if (!view.inMap(x, y) || !view.inMap(x1, y1)) {
    return Placement.OutOfMap;
  }
  if (!inBuildReach(px, py, x, y, w, h)) {
    return Placement.OutOfReach;
  }
  for (let ty = y; ty <= y1; ty++) {
    for (let tx = x; tx <= x1; tx++) {
      if (!view.buildable(tx, ty)) return Placement.Terrain;
    }
  }
  for (let ty = y; ty <= y1; ty++) {
    for (let tx = x; tx <= x1; tx++) {
      const occupant = view.occupant(tx, ty);
      if (occupant !== 0 && occupant !== ignore) return Placement.Occupied;
    }
  }
  for (let i = 0; i < view.playerCount; i++) {
    if (playerOverlaps(view.playerX(i), view.playerY(i), x, y, x1, y1)) {
      return Placement.PlayerInTheWay;
    }
  }
  return Placement.Ok;
}

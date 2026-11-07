/**
 * Viewport culling for the entity layers (docs/ARCHITECTURE.md, "Rendering").
 *
 * Snapshots carry everything in the chunk window: the view plus a whole
 * chunk on every side, about ten times the tiles on screen at 1×. Each layer
 * only draws (and keeps in the scene graph) what overlaps the cull rectangle:
 * the tiles on screen grown by `CULL_MARGIN` tiles, which covers every
 * sprite's overhang past its footprint (tall machines, shadows, a held item,
 * a sagging wire), then snapped outwards to a `CULL_GRID`-tile grid. The
 * snapping means the rectangle changes only when the view crosses a grid
 * line (every 8 tiles of panning, or on a zoom step), so layers rebuild their
 * visible sets now and then rather than every frame.
 */

import type { Viewport } from '../worker/protocol';

/** Tiles of overhang around the screen that still count as visible. */
export const CULL_MARGIN = 4;
/** The cull rectangle's edges sit on multiples of this many tiles. */
export const CULL_GRID = 8;

/** A rectangle of whole tiles: `x0 <= x < x1`, `y0 <= y < y1`. */
export interface TileRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Everything: for layers drawn before the first frame tells them the view. */
export const EVERYWHERE: TileRect = {
  x0: -Infinity,
  y0: -Infinity,
  x1: Infinity,
  y1: Infinity,
};

/** The cull rectangle for the tiles on screen, `view`. */
export function cullRect(
  view: Viewport,
  margin: number = CULL_MARGIN,
  grid: number = CULL_GRID,
): TileRect {
  return {
    x0: Math.floor((view.x - margin) / grid) * grid,
    y0: Math.floor((view.y - margin) / grid) * grid,
    x1: Math.ceil((view.x + view.w + margin) / grid) * grid,
    y1: Math.ceil((view.y + view.h + margin) / grid) * grid,
  };
}

export function sameRect(a: TileRect, b: TileRect): boolean {
  return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1;
}

/** Whether the `w` × `h` tiles from `(x, y)` overlap `rect`. */
export function overlaps(rect: TileRect, x: number, y: number, w = 1, h = 1): boolean {
  return x + w > rect.x0 && x < rect.x1 && y + h > rect.y0 && y < rect.y1;
}

/**
 * Where things sit on a belt tile: the path items follow from the edge they
 * come in at to the edge they leave from, straight or around a curve.
 * Render-only floating-point math; the simulation only knows distances along
 * the line (src/sim/belts/).
 */

import { BeltShape } from '../sim/belts/belts';
import { BeltLane } from '../sim/belts/line';

/** Sideways offset of each lane from the belt's middle, in tiles (left is negative). */
export const LANE_OFFSET = 0.25;

/** Sideways offset of lane `lane` from the middle of the belt, in tiles. */
export function laneLateral(lane: number): number {
  return lane === BeltLane.Left ? -LANE_OFFSET : LANE_OFFSET;
}

/**
 * The point at progress `t` (0 at the input edge, 1 at the output edge)
 * along a belt facing `dir` with shape `shape`, `lateral` tiles to the right
 * of its middle line, relative to the tile's top-left corner (in tiles).
 */
export function beltPoint(
  dir: number,
  shape: number,
  lateral: number,
  t: number,
): { x: number; y: number } {
  const out = { x: 0, y: 0 };
  beltPointInto(out, dir, shape, lateral, t);
  return out;
}

/** `beltPoint`, written into `out` (no allocation: items on belts call it every frame). */
export function beltPointInto(
  out: { x: number; y: number },
  dir: number,
  shape: number,
  lateral: number,
  t: number,
): void {
  let u: number;
  let v: number;
  // Facing north first: in at the bottom (or a side), out at the top.
  if (shape === BeltShape.CurveFromLeft) {
    // In from the west edge, around the north-west corner.
    const r = 0.5 + lateral;
    const a = ((1 - t) * Math.PI) / 2;
    u = r * Math.cos(a);
    v = r * Math.sin(a);
  } else if (shape === BeltShape.CurveFromRight) {
    // In from the east edge, around the north-east corner.
    const r = 0.5 - lateral;
    const a = ((1 - t) * Math.PI) / 2;
    u = 1 - r * Math.cos(a);
    v = r * Math.sin(a);
  } else {
    u = 0.5 + lateral;
    v = 1 - t;
  }
  // A quarter turn clockwise per direction step, about the tile's center.
  for (let i = 0; i < (dir & 3); i++) {
    const nu = 1 - v;
    v = u;
    u = nu;
  }
  out.x = u;
  out.y = v;
}

/** Progress along the belt (0 at the input edge) of an item `offset` subtiles from the belt's end edge. */
export function progressOf(offset: number, beltLength: number): number {
  return Math.min(1, Math.max(0, 1 - offset / beltLength));
}

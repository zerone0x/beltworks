/**
 * Geometry of electric poles, shared by the simulation (which connects poles
 * and assigns entities to networks) and the renderer (which previews the
 * wires a pole ghost would get and draws supply areas), so both agree.
 *
 * Integer-only: centers are compared in half tiles, so a 1×1 pole and a 2×2
 * one measure from their true centers without fractions.
 */

import { ENTITIES, ENTITY_TYPE_IDS, type EntityPrototype } from '../../data/entities';

/** An inclusive rectangle of tiles. */
export interface TileRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Whether `proto` is an electric pole (it has a wire reach and a supply area). */
export function isPolePrototypeOf(proto: EntityPrototype | undefined): boolean {
  return proto?.wireReach !== undefined && proto.supplyArea !== undefined;
}

const POLES = ENTITY_TYPE_IDS.map((id) => ENTITIES[id]).filter(isPolePrototypeOf);

/** Longest wire reach of any pole, in tiles: how far to look for poles to connect. */
export const MAX_WIRE_REACH = Math.max(0, ...POLES.map((p) => p.wireReach ?? 0));

/**
 * Tiles a pole's supply area reaches beyond its footprint on each side
 * (2 for a 1×1 pole with a 5×5 area). Poles are square and their supply
 * areas have the parity of their size, so this is a whole number.
 */
export function supplyRadius(proto: EntityPrototype): number {
  return ((proto.supplyArea ?? proto.width) - proto.width) >> 1;
}

/** Largest supply radius of any pole: how far around an entity to look for poles covering it. */
export const MAX_SUPPLY_RADIUS = Math.max(0, ...POLES.map(supplyRadius));

/**
 * Whether pole `a` (prototype, top-left tile) and pole `b` connect: the
 * distance between their centers is at most the smaller of their wire
 * reaches. For two small poles: `dx² + dy² ≤ 49` in tiles.
 */
export function polesConnect(
  a: EntityPrototype,
  ax: number,
  ay: number,
  b: EntityPrototype,
  bx: number,
  by: number,
): boolean {
  const reach = Math.min(a.wireReach ?? 0, b.wireReach ?? 0);
  // Twice the centers: 2x + w.
  const dx = 2 * ax + a.width - 2 * bx - b.width;
  const dy = 2 * ay + a.height - 2 * by - b.height;
  return dx * dx + dy * dy <= 4 * reach * reach;
}

/** The tiles of the supply area of pole `proto` with its top-left tile at `(x, y)`. */
export function supplyRect(proto: EntityPrototype, x: number, y: number): TileRect {
  const r = supplyRadius(proto);
  return { x0: x - r, y0: y - r, x1: x + proto.width - 1 + r, y1: y + proto.height - 1 + r };
}

/** Whether two inclusive tile rectangles share a tile. */
export function rectsOverlap(a: TileRect, b: TileRect): boolean {
  return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
}

/**
 * The tree layer of the map: which tiles hold a tree.
 *
 * Trees grow in forests: low-frequency noise sets the tree density of an
 * area, and a per-tile hash decides whether that tile has a tree. They only
 * stand on grass without a resource, and never in the starting area: there
 * are none within `TREE_FREE_RADIUS` tiles of the origin, and the density
 * fades in up to `TREE_FADE_RADIUS`, so the spawn stays open to build on.
 *
 * Like the rest of generation this is a pure, integer-only function of the
 * seed and the tile, so chunks can be generated in any order.
 */

import { ResourceId } from '../../data/resources';
import { TileId } from '../../data/tiles';
import { CHUNK_SHIFT, CHUNK_SIZE, type Chunk } from './chunk';
import { fractalNoise, hash2 } from './noise';

/** Forest noise: lattice about every 2^8 / 5 ~ 51 tiles, 2 octaves (down to ~26 tiles). */
const FOREST_CELL_SHIFT = 8;
const FOREST_OCTAVES = 2;
/** Forest noise (in [0, NOISE_MAX]) below which there are no trees at all. */
export const FOREST_MIN = 35_000;
/** Forest noise at and above which the density reaches `MAX_TREE_DENSITY`. */
export const FOREST_FULL = 42_000;
/** Tree density in the middle of a forest, in tiles per thousand. */
export const MAX_TREE_DENSITY = 550;
const DENSITY_SCALE = 1000;

/** No trees on tiles `(x, y)` with `x² + y² < TREE_FREE_RADIUS²`. */
export const TREE_FREE_RADIUS = 48;
/** The density fades in linearly (in squared distance) from `TREE_FREE_RADIUS` to here. */
export const TREE_FADE_RADIUS = 80;
const FREE_SQ = TREE_FREE_RADIUS * TREE_FREE_RADIUS;
const FADE_SQ = TREE_FADE_RADIUS * TREE_FADE_RADIUS;

/** Salt that separates the per-tile roll from the forest noise. */
const ROLL_SALT = 0x7ee5;

/**
 * Tree density at world tile `(x, y)` in tiles per thousand, before the
 * terrain and resource checks: forest noise, faded out around the spawn.
 */
export function treeDensity(treeSeed: number, x: number, y: number): number {
  const d2 = x * x + y * y;
  if (d2 < FREE_SQ) return 0;
  const f = fractalNoise(treeSeed, x, y, FOREST_CELL_SHIFT, FOREST_OCTAVES);
  if (f <= FOREST_MIN) return 0;
  let density =
    f >= FOREST_FULL
      ? MAX_TREE_DENSITY
      : Math.trunc(((f - FOREST_MIN) * MAX_TREE_DENSITY) / (FOREST_FULL - FOREST_MIN));
  if (d2 < FADE_SQ) {
    density = Math.trunc((density * (d2 - FREE_SQ)) / (FADE_SQ - FREE_SQ));
  }
  return density;
}

/** Whether world tile `(x, y)` gets a tree, given its terrain and resource. */
export function hasTree(
  treeSeed: number,
  x: number,
  y: number,
  terrain: number,
  resource: number,
): boolean {
  if (terrain !== TileId.Grass || resource !== ResourceId.None) return false;
  const density = treeDensity(treeSeed, x, y);
  if (density === 0) return false;
  return hash2(treeSeed ^ ROLL_SALT, x, y) % DENSITY_SCALE < density;
}

/**
 * Fills `chunk.tree` from its terrain and resources (which must already be
 * generated): 1 where a tree stands, 0 elsewhere.
 */
export function plantTrees(chunk: Chunk, treeSeed: number): void {
  const x0 = chunk.cx << CHUNK_SHIFT;
  const y0 = chunk.cy << CHUNK_SHIFT;
  // Chunks entirely inside the tree-free circle (its farthest corner too) stay empty.
  const fx = Math.max(Math.abs(x0), Math.abs(x0 + CHUNK_SIZE - 1));
  const fy = Math.max(Math.abs(y0), Math.abs(y0 + CHUNK_SIZE - 1));
  if (fx * fx + fy * fy < FREE_SQ) return;
  const { terrain, resource, tree } = chunk;
  let i = 0;
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++, i++) {
      if (hasTree(treeSeed, x0 + lx, y0 + ly, terrain[i]!, resource[i]!)) tree[i] = 1;
    }
  }
}

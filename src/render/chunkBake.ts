/**
 * Bakes a chunk's terrain, resources and trees into RGBA pixels for one texture.
 *
 * Placeholder art: every tile is a flat color from src/data/tiles.ts,
 * resource tiles get a tint of the ore color plus darker dots (more dots for
 * richer tiles), and trees are a round canopy on a short trunk. Everything is axis-aligned blocks of whole texels, so the
 * texture is sampled with nearest filtering and stays crisp at every zoom
 * level while using `TEXELS_PER_TILE`² texels per tile instead of
 * `TILE_PX`² (1/16 of the memory at 8 texels per tile).
 */

import { RESOURCES, type OreId } from '../data/resources';
import { TILES } from '../data/tiles';
import { TREE_CANOPY_COLOR, TREE_CANOPY_LIGHT, TREE_TRUNK_COLOR } from '../data/trees';
import type { ChunkData } from '../sim/snapshot';
import { CHUNK_SHIFT, CHUNK_SIZE } from '../sim/world/chunk';

/** Texture resolution: texels along one tile edge. */
export const TEXELS_PER_TILE = 8;
/** Edge length of a baked chunk texture, in texels. */
export const CHUNK_TEXTURE_SIZE = CHUNK_SIZE * TEXELS_PER_TILE;

/** Color for tile or resource ids without a prototype, so bad data is obvious. */
export const MISSING_COLOR = 0xff00ff;

/** How strongly a resource tile is tinted towards the ore color, out of 256. */
const ORE_TINT = 112;
/** Dot color: the ore color scaled by this, out of 256. */
const DOT_SHADE = 160;
/** Dot edge length in texels. */
const DOT_TEXELS = 2;
/** Top-left texel of each possible dot inside a tile, in the order dots are added. */
const DOT_SLOTS: readonly (readonly [number, number])[] = [
  [1, 1],
  [5, 5],
  [5, 1],
  [1, 5],
];
/** A tile with at least `DOT_AMOUNTS[i]` units gets `i + 2` dots (always at least one). */
const DOT_AMOUNTS = [400, 1000, 2000] as const;

/**
 * A tree's canopy as texel runs `[row, first column, width]` inside its tile:
 * a rounded blob over the top six rows, with the trunk below it.
 */
const CANOPY_RUNS: readonly (readonly [number, number, number])[] = [
  [0, 2, 4],
  [1, 1, 6],
  [2, 1, 6],
  [3, 1, 6],
  [4, 1, 6],
  [5, 2, 4],
];
/** The lit patch on the canopy's upper left, as `[x, y, w, h]` texels. */
const CANOPY_LIGHT: readonly [number, number, number, number] = [2, 1, 2, 2];
/** The trunk under the canopy, as `[x, y, w, h]` texels. */
const TRUNK: readonly [number, number, number, number] = [3, 6, 2, 2];
/** Ground under a tree is darkened by this, out of 256 (its shadow). */
const TREE_SHADOW = 200;

function mix(a: number, b: number, t256: number): number {
  const ch = (shift: number): number => {
    const ca = (a >> shift) & 0xff;
    const cb = (b >> shift) & 0xff;
    return (ca + (((cb - ca) * t256) >> 8)) << shift;
  };
  return ch(16) | ch(8) | ch(0);
}

function shade(c: number, t256: number): number {
  return (
    (((((c >> 16) & 0xff) * t256) >> 8) << 16) |
    (((((c >> 8) & 0xff) * t256) >> 8) << 8) |
    (((c & 0xff) * t256) >> 8)
  );
}

/** Number of dots drawn on a resource tile holding `amount` units. */
export function dotCount(amount: number): number {
  let n = 1;
  for (const threshold of DOT_AMOUNTS) {
    if (amount >= threshold) n++;
  }
  return n;
}

/** Small integer hash of a world tile, so dot jitter is stable for a given tile. */
function tileHash(x: number, y: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  return (h ^ (h >>> 13)) >>> 0;
}

/** Writes `color` (0xRRGGBB) into a `w`×`h` texel block of an RGBA buffer. */
function fill(px: Uint8Array, x: number, y: number, w: number, h: number, color: number): void {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  for (let ty = y; ty < y + h; ty++) {
    let o = (ty * CHUNK_TEXTURE_SIZE + x) * 4;
    for (let tx = 0; tx < w; tx++, o += 4) {
      px[o] = r;
      px[o + 1] = g;
      px[o + 2] = b;
      px[o + 3] = 0xff;
    }
  }
}

/**
 * Draws a tree on the tile whose top-left texel is `(tx, ty)`, over a shaded
 * `ground`. Bit 0 of `hash` shifts the canopy one texel sideways, so a forest
 * doesn't look like a grid.
 */
function drawTree(px: Uint8Array, tx: number, ty: number, ground: number, hash: number): void {
  fill(px, tx, ty, TEXELS_PER_TILE, TEXELS_PER_TILE, shade(ground, TREE_SHADOW));
  const shift = (hash & 1) === 0 ? 0 : 1;
  const [bx, by, bw, bh] = TRUNK;
  fill(px, tx + bx, ty + by, bw, bh, TREE_TRUNK_COLOR);
  for (const [row, col, w] of CANOPY_RUNS) {
    fill(px, tx + col - shift, ty + row, w, 1, TREE_CANOPY_COLOR);
  }
  const [lx, ly, lw, lh] = CANOPY_LIGHT;
  fill(px, tx + lx - shift, ty + ly, lw, lh, TREE_CANOPY_LIGHT);
}

/**
 * Returns `CHUNK_TEXTURE_SIZE`² RGBA texels (row-major, top row first) for
 * `chunk`. Pass `out` to reuse a buffer of the right size.
 */
export function bakeChunkPixels(
  chunk: ChunkData,
  out: Uint8Array = new Uint8Array(CHUNK_TEXTURE_SIZE * CHUNK_TEXTURE_SIZE * 4),
): Uint8Array {
  if (out.length !== CHUNK_TEXTURE_SIZE * CHUNK_TEXTURE_SIZE * 4) {
    throw new RangeError('output buffer has the wrong size');
  }
  const x0 = chunk.cx << CHUNK_SHIFT;
  const y0 = chunk.cy << CHUNK_SHIFT;
  for (let ly = 0, i = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++, i++) {
      const tx = lx * TEXELS_PER_TILE;
      const ty = ly * TEXELS_PER_TILE;
      const ground = TILES[chunk.terrain[i]!]?.color ?? MISSING_COLOR;
      if (chunk.tree[i] === 1) {
        drawTree(out, tx, ty, ground, tileHash(x0 + lx, y0 + ly));
        continue;
      }
      const resource = chunk.resource[i]!;
      if (resource === 0) {
        fill(out, tx, ty, TEXELS_PER_TILE, TEXELS_PER_TILE, ground);
        continue;
      }
      const ore = RESOURCES[resource as OreId]?.color ?? MISSING_COLOR;
      fill(out, tx, ty, TEXELS_PER_TILE, TEXELS_PER_TILE, mix(ground, ore, ORE_TINT));
      const dot = shade(ore, DOT_SHADE);
      const h = tileHash(x0 + lx, y0 + ly);
      const n = dotCount(chunk.amount[i]!);
      for (let d = 0; d < n; d++) {
        const [sx, sy] = DOT_SLOTS[d]!;
        // Jitter each dot by up to one texel so patches don't look like a grid.
        const jx = (h >>> (2 * d)) & 1;
        const jy = (h >>> (2 * d + 1)) & 1;
        fill(out, tx + sx + jx, ty + sy + jy, DOT_TEXELS, DOT_TEXELS, dot);
      }
    }
  }
  return out;
}

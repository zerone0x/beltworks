/**
 * What the rendered terrain of a chunk is made of (docs/ART.md, "Terrain"),
 * as plain data, so it can be tested without a GPU: the per-tile terrain
 * weights the ground shader blends (a "splat" texture with a one-tile border
 * from the neighbouring chunks), and the sprites drawn over the ground:
 * ore decals, decor, and trees with their shadows. terrainArt.ts turns a plan
 * into pixels.
 *
 * Everything is a pure function of the chunk and its neighbours: variants
 * and offsets come from a hash of the world tile, so a chunk looks the same
 * every time it is baked, and the parts that reach into a neighbouring chunk
 * (canopies, shadows, the edges of ore stains) are drawn the same way from
 * both sides, without seams.
 */

import { RESOURCES, type OreId } from '../data/resources';
import { TileId } from '../data/tiles';
import type { ChunkData } from '../sim/snapshot';
import { CHUNK_SHIFT, CHUNK_SIZE } from '../sim/world/chunk';
import { tileHash } from './chunkBake';

/** Texels of the splat texture along one edge: the chunk plus a one-tile border. */
export const SPLAT_SIZE = CHUNK_SIZE + 2;

/** Ore decal richness: level 1 from this many units, level 2 from the second. */
export const RICHNESS_LEVELS = [400, 1200] as const;
/** Variants per ore decal level, tree and decor kind (as rendered by art/blender/models/). */
export const ORE_VARIANTS = 3;
export const TREE_VARIANTS = 6;
export const DECOR_VARIANTS: Readonly<Record<number, number>> = {
  [TileId.Grass]: 6,
  [TileId.Sand]: 4,
  [TileId.Rock]: 4,
};
/** Decor model per terrain type (none on water). */
const DECOR_NAMES: Readonly<Record<number, string>> = {
  [TileId.Grass]: 'decor-grass',
  [TileId.Sand]: 'decor-sand',
  [TileId.Rock]: 'decor-rock',
};
/** Chance of a decor sprite on a plain tile, in 1/1000, per terrain type. */
export const DECOR_DENSITY: Readonly<Record<number, number>> = {
  [TileId.Grass]: 70,
  [TileId.Sand]: 50,
  [TileId.Rock]: 110,
};
/** Trees stand up to this much (tile fraction) off their tile's center, from the hash. */
export const TREE_JITTER = 0.14;
/**
 * How far around a chunk (tiles) sprites can reach in: canopies up to two
 * tiles up and their shadows about two to the right, so trees and decals
 * of the tiles this far into the neighbouring chunks are drawn too.
 */
export const PLAN_REACH = 2;

/** A sprite to draw: model `name`, footprint center at `(x, y)` in tiles from the chunk's corner. */
export interface PlannedSprite {
  name: string;
  x: number;
  y: number;
}

export interface ChunkPlan {
  /**
   * `SPLAT_SIZE`² RGBA texels: grass, sand and water weights (rock is the
   * rest), and in alpha how much water is around (the water of the 3×3 tiles
   * around, averaged: the shader's wet sand and shallow water).
   */
  splat: Uint8Array;
  /** Ore decals and decor, drawn on the ground. */
  decals: PlannedSprite[];
  /** Trees from north to south (their shadows are drawn first, from the same list). */
  trees: PlannedSprite[];
}

/** Ore decal richness level (0..2) of a tile holding `amount` units. */
export function richnessLevel(amount: number): number {
  let level = 0;
  for (const threshold of RICHNESS_LEVELS) {
    if (amount >= threshold) level++;
  }
  return level;
}

/** The ore decal model of a tile at world `(x, y)` with resource `resource` holding `amount`. */
export function oreDecal(resource: number, amount: number, x: number, y: number): string | null {
  const ore = RESOURCES[resource as OreId];
  if (!ore) return null;
  return `${ore.name}-${String(richnessLevel(amount))}-${String(tileHash(x, y) % ORE_VARIANTS)}`;
}

/** The tree model and where it stands (tiles from the tile's corner) for a tree at world `(x, y)`. */
export function treeAt(x: number, y: number): { name: string; dx: number; dy: number } {
  const h = tileHash(x ^ 0x5bd1, y ^ 0x2c1b);
  const jitter = (bits: number): number => ((bits & 0xff) / 255 - 0.5) * 2 * TREE_JITTER;
  return {
    name: `tree-${String(h % TREE_VARIANTS)}`,
    dx: 0.5 + jitter(h >>> 8),
    dy: 0.5 + jitter(h >>> 16),
  };
}

/** Looks up chunks by chunk coordinates (`undefined`: not loaded). */
export type ChunkLookup = (cx: number, cy: number) => ChunkData | undefined;

/**
 * Tile data of the world around a chunk, from it and its neighbours. Tiles of
 * chunks that aren't loaded read as their nearest loaded tile in `chunk`
 * (so a missing neighbour continues the edge instead of showing a seam).
 */
function reader(chunk: ChunkData, lookup: ChunkLookup) {
  const near = new Map<number, ChunkData | undefined>();
  const get = (dx: number, dy: number): ChunkData | undefined => {
    if (dx === 0 && dy === 0) return chunk;
    const key = (dx + 1) * 3 + dy + 1;
    if (!near.has(key)) near.set(key, lookup(chunk.cx + dx, chunk.cy + dy));
    return near.get(key);
  };
  return (lx: number, ly: number): { data: ChunkData; i: number; missing: boolean } => {
    const dx = lx < 0 ? -1 : lx >= CHUNK_SIZE ? 1 : 0;
    const dy = ly < 0 ? -1 : ly >= CHUNK_SIZE ? 1 : 0;
    const data = get(dx, dy);
    if (!data) {
      const cx = Math.min(CHUNK_SIZE - 1, Math.max(0, lx));
      const cy = Math.min(CHUNK_SIZE - 1, Math.max(0, ly));
      return { data: chunk, i: cy * CHUNK_SIZE + cx, missing: true };
    }
    const tx = lx - dx * CHUNK_SIZE;
    const ty = ly - dy * CHUNK_SIZE;
    return { data, i: ty * CHUNK_SIZE + tx, missing: false };
  };
}

/** Plans the rendered terrain of `chunk`, reading its neighbours through `lookup`. */
export function planChunk(chunk: ChunkData, lookup: ChunkLookup): ChunkPlan {
  const read = reader(chunk, lookup);
  const x0 = chunk.cx << CHUNK_SHIFT;
  const y0 = chunk.cy << CHUNK_SHIFT;

  const splat = new Uint8Array(SPLAT_SIZE * SPLAT_SIZE * 4);
  for (let sy = 0; sy < SPLAT_SIZE; sy++) {
    for (let sx = 0; sx < SPLAT_SIZE; sx++) {
      const { data, i } = read(sx - 1, sy - 1);
      const o = (sy * SPLAT_SIZE + sx) * 4;
      const t = data.terrain[i];
      splat[o] = t === TileId.Grass ? 255 : 0;
      splat[o + 1] = t === TileId.Sand ? 255 : 0;
      splat[o + 2] = t === TileId.Water ? 255 : 0;
    }
  }
  for (let sy = 0; sy < SPLAT_SIZE; sy++) {
    for (let sx = 0; sx < SPLAT_SIZE; sx++) {
      let water = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = Math.min(SPLAT_SIZE - 1, Math.max(0, sx + dx));
          const y = Math.min(SPLAT_SIZE - 1, Math.max(0, sy + dy));
          water += splat[(y * SPLAT_SIZE + x) * 4 + 2]!;
        }
      }
      splat[(sy * SPLAT_SIZE + sx) * 4 + 3] = Math.round(water / 9);
    }
  }

  const terrainAt = (lx: number, ly: number): number => {
    const { data, i } = read(lx, ly);
    return data.terrain[i]!;
  };
  const decals: PlannedSprite[] = [];
  const trees: PlannedSprite[] = [];
  for (let ly = -PLAN_REACH; ly < CHUNK_SIZE + PLAN_REACH; ly++) {
    for (let lx = -PLAN_REACH; lx < CHUNK_SIZE + PLAN_REACH; lx++) {
      const { data, i, missing } = read(lx, ly);
      if (missing) continue;
      const wx = x0 + lx;
      const wy = y0 + ly;
      if (data.tree[i] === 1) {
        const t = treeAt(wx, wy);
        trees.push({ name: t.name, x: lx + t.dx, y: ly + t.dy });
        continue;
      }
      const resource = data.resource[i]!;
      if (resource !== 0) {
        const name = oreDecal(resource, data.amount[i]!, wx, wy);
        if (name) decals.push({ name, x: lx + 0.5, y: ly + 0.5 });
        continue;
      }
      const terrain = data.terrain[i]!;
      const decor = DECOR_NAMES[terrain];
      if (!decor) continue;
      const h = tileHash(wx ^ 0x1d3c, wy ^ 0x7a91);
      if (h % 1000 >= DECOR_DENSITY[terrain]!) continue;
      // Only well inside an area of one terrain, clear of the blended edges.
      if (
        terrainAt(lx - 1, ly) !== terrain ||
        terrainAt(lx + 1, ly) !== terrain ||
        terrainAt(lx, ly - 1) !== terrain ||
        terrainAt(lx, ly + 1) !== terrain
      ) {
        continue;
      }
      const variant = (h >>> 12) % DECOR_VARIANTS[terrain]!;
      decals.push({ name: `${decor}-${String(variant)}`, x: lx + 0.5, y: ly + 0.5 });
    }
  }
  trees.sort((a, b) => a.y - b.y || a.x - b.x);
  return { splat, decals, trees };
}

/**
 * What a tile looks like in the rendered terrain, as one number: terrain,
 * resource, decal richness and tree. A chunk whose tiles all keep their
 * signature (a drill took a few units of ore) doesn't need a new bake.
 */
export function tileSignature(chunk: ChunkData, i: number): number {
  const resource = chunk.resource[i]!;
  const level = resource === 0 ? 0 : richnessLevel(chunk.amount[i]!);
  return chunk.terrain[i]! | (resource << 8) | (level << 16) | (chunk.tree[i]! << 20);
}

/**
 * How a chunk's new data changes its rendered terrain: `self` if any tile
 * looks different, `edge` if one within `PLAN_REACH` of the chunk's edge does
 * (then the neighbours, which draw those tiles too, need a new bake as well).
 */
export function visualChange(
  before: ChunkData,
  after: ChunkData,
): { self: boolean; edge: boolean } {
  let self = false;
  for (let y = 0, i = 0; y < CHUNK_SIZE; y++) {
    for (let x = 0; x < CHUNK_SIZE; x++, i++) {
      if (tileSignature(before, i) === tileSignature(after, i)) continue;
      self = true;
      const nearEdge =
        x < PLAN_REACH ||
        y < PLAN_REACH ||
        x >= CHUNK_SIZE - PLAN_REACH ||
        y >= CHUNK_SIZE - PLAN_REACH;
      if (nearEdge) return { self, edge: true };
    }
  }
  return { self, edge: false };
}

/**
 * Texels per tile the terrain is baked at for `zoom` (screen pixels per
 * world pixel; a tile is 32 world pixels): 32 at 1× (texel for pixel), and
 * halved as the view zooms out, so a baked texture is never minified by more
 * than 1.33× (no mipmaps needed) and, below 1×, magnified by at most 1.5×.
 * That keeps the memory per screen about constant: four times the chunks at
 * half the zoom, each with a quarter of the texels. Zoomed in past 1× the
 * texture is magnified (the sprites on top stay sharp).
 */
export function texelsForZoom(zoom: number, max: number = 32): number {
  if (zoom >= 0.75) return Math.min(32, max);
  if (zoom >= 0.375) return Math.min(16, max);
  return Math.min(8, max);
}

/**
 * The most texels per tile on a software renderer (SwiftShader, llvmpipe):
 * there a bake's cost is its texel count on the CPU, a few hundred
 * milliseconds for a 1024² chunk, so it bakes a quarter of that.
 */
export const SOFTWARE_MAX_TEXELS = 16;

/** Whether a WebGL renderer string (`UNMASKED_RENDERER_WEBGL`) names a software renderer. */
export function isSoftwareRenderer(name: string): boolean {
  return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
}

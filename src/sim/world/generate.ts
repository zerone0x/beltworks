/**
 * Deterministic chunk generation: terrain bands from fractal value noise and
 * blob-shaped resource patches.
 *
 * Generation is a pure function of `(seed, cx, cy)`: a chunk never depends on
 * which other chunks were generated before it, so chunks can be produced
 * lazily in any order. All arithmetic is integer-only.
 */

import { ResourceId, type OreId } from '../../data/resources';
import { TileId } from '../../data/tiles';
import { Rng } from '../rng';
import { CHUNK_SHIFT, CHUNK_SIZE, Chunk } from './chunk';
import { fractalNoise, hash2, valueNoise } from './noise';

// ---------------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------------

/** Elevation noise: lattice about every 2^9 / 5 ~ 102 tiles, 4 octaves (down to ~13 tiles). */
const ELEVATION_CELL_SHIFT = 9;
const ELEVATION_OCTAVES = 4;

/** Elevation bands (noise values in [0, NOISE_MAX]): water < sand < grass < rock. */
export const WATER_MAX = 24_000;
export const SAND_MAX = 26_500;
export const ROCK_MIN = 44_000;
const GRASS_MID = (SAND_MAX + ROCK_MIN) >> 1;

/**
 * Starting area: within `START_FLAT_RADIUS` tiles of (0, 0) the elevation is
 * squeezed toward the middle of the grass band so the spawn area is
 * buildable; the squeeze fades out by `START_FADE_RADIUS`.
 */
const START_FLAT_RADIUS = 44;
const START_FADE_RADIUS = 64;
const WEIGHT_BITS = 12;
const WEIGHT_ONE = 1 << WEIGHT_BITS;

/** Classifies an elevation value into a tile id. */
export function tileForElevation(elevation: number): TileId {
  if (elevation < WATER_MAX) return TileId.Water;
  if (elevation < SAND_MAX) return TileId.Sand;
  if (elevation < ROCK_MIN) return TileId.Grass;
  return TileId.Rock;
}

/** Weight in [0, WEIGHT_ONE] of the starting-area flattening at squared distance `d2`. */
function startAreaWeight(d2: number): number {
  const inner = START_FLAT_RADIUS * START_FLAT_RADIUS;
  const outer = START_FADE_RADIUS * START_FADE_RADIUS;
  if (d2 <= inner) return WEIGHT_ONE;
  if (d2 >= outer) return 0;
  return Math.trunc(((outer - d2) * WEIGHT_ONE) / (outer - inner));
}

/** Terrain elevation at world tile `(x, y)` in [0, 65535], including the starting-area squeeze. */
export function elevationAt(terrainSeed: number, x: number, y: number): number {
  const e = fractalNoise(terrainSeed, x, y, ELEVATION_CELL_SHIFT, ELEVATION_OCTAVES);
  if (x <= -START_FADE_RADIUS || x >= START_FADE_RADIUS) return e;
  if (y <= -START_FADE_RADIUS || y >= START_FADE_RADIUS) return e;
  const w = startAreaWeight(x * x + y * y);
  if (w === 0) return e;
  // Scale the distance from GRASS_MID by 1 - 7/8 * w: at full weight the range
  // [0, NOISE_MAX] shrinks to GRASS_MID ± ~4.3k, which is inside the grass band.
  const scale = WEIGHT_ONE - ((w * 7) >> 3);
  return GRASS_MID + (((e - GRASS_MID) * scale) >> WEIGHT_BITS);
}

// ---------------------------------------------------------------------------
// Resource patches
// ---------------------------------------------------------------------------

/**
 * Resource patches are placed per region of 2^7 = 128 × 128 tiles. The region
 * grid is offset by half a region so that region (0, 0) is centered on the
 * origin: region `rx` covers tiles `[rx * 128 - 64, rx * 128 + 64)`. Region
 * edges fall on chunk edges, so every chunk lies in exactly one region.
 *
 * A patch never extends past its region, so a tile only ever has to look at
 * the patches of its own region.
 */
export const REGION_SHIFT = 7;
export const REGION_SIZE = 1 << REGION_SHIFT;
const REGION_OFFSET = REGION_SIZE >> 1;

/** Blob edges are perturbed by up to ±PATCH_JITTER tiles. */
const PATCH_JITTER = 3;
/** Edge noise lattice every 2^3 = 8 tiles. */
const PATCH_EDGE_CELL_SHIFT = 3;
/** Sub-tile precision of the patch radius (1/16 tile). */
const SUB_BITS = 4;

const NORMAL_RADIUS_MIN = 7;
const NORMAL_RADIUS_RANGE = 8; // radius in [7, 14]
const NORMAL_PATCH_CHANCE = 70; // percent of regions that have a patch
const NORMAL_RICHNESS = 800;
const RICHNESS_CAP = 20_000;
const MIN_AMOUNT = 100;

const START_RADIUS_MIN = 6;
const START_RADIUS_RANGE = 3; // radius in [6, 8]
const START_OFFSET_MIN = 12;
const START_OFFSET_RANGE = 10; // center offset per axis in [12, 21]
const START_RICHNESS = 1500;

/** Ore frequencies (percent) for patches outside the starting area. */
const ORE_WEIGHTS: readonly (readonly [OreId, number])[] = [
  [ResourceId.IronOre, 35],
  [ResourceId.CopperOre, 30],
  [ResourceId.Coal, 20],
  [ResourceId.Stone, 15],
];

export interface Patch {
  readonly ore: OreId;
  /** Center, in world tiles. */
  readonly x: number;
  readonly y: number;
  /** Base radius in tiles (the edge is jittered by up to ±PATCH_JITTER). */
  readonly radius: number;
  /** Amount added on top of MIN_AMOUNT at the center; falls off toward the edge. */
  readonly richness: number;
  /** Seed for the edge noise. */
  readonly seed: number;
}

/** Derives an independent uint32 sub-seed from the world seed. */
function subSeed(seed: number, salt: number): number {
  return hash2(seed, salt, 0x5eed);
}

const SALT_TERRAIN = 1;
const SALT_START = 2;
const SALT_REGION = 3;

/** Region coordinate of world tile coordinate `t`. */
export function regionOf(t: number): number {
  return (t + REGION_OFFSET) >> REGION_SHIFT;
}

/**
 * The four starting patches (one of each ore) placed in the four quadrants
 * around the origin. Centers are at most ~30 tiles from (0, 0) and patches
 * never cross the axes, so they never overlap.
 */
export function startingPatches(seed: number): Patch[] {
  const rng = Rng.fromSeed(subSeed(seed, SALT_START));
  const ores: OreId[] = [
    ResourceId.IronOre,
    ResourceId.CopperOre,
    ResourceId.Coal,
    ResourceId.Stone,
  ];
  // Fisher–Yates shuffle so each seed assigns ores to quadrants differently.
  for (let i = ores.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    const tmp = ores[i]!;
    ores[i] = ores[j]!;
    ores[j] = tmp;
  }
  const quadrants = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ] as const;
  return ores.map((ore, i) => {
    const [sx, sy] = quadrants[i]!;
    return {
      ore,
      x: sx * (START_OFFSET_MIN + rng.nextInt(START_OFFSET_RANGE)),
      y: sy * (START_OFFSET_MIN + rng.nextInt(START_OFFSET_RANGE)),
      radius: START_RADIUS_MIN + rng.nextInt(START_RADIUS_RANGE),
      richness: START_RICHNESS,
      seed: rng.nextU32(),
    };
  });
}

/** The patches of region `(rx, ry)` (zero or one outside the starting region). */
export function regionPatches(seed: number, rx: number, ry: number): Patch[] {
  if (rx === 0 && ry === 0) return startingPatches(seed);

  const regionSeed = subSeed(seed, SALT_REGION);
  const h0 = hash2(regionSeed, rx, ry);
  if (h0 % 100 >= NORMAL_PATCH_CHANCE) return [];

  const rng = Rng.fromSeed(h0);
  let roll = rng.nextInt(100);
  let ore: OreId = ResourceId.IronOre;
  for (const [id, weight] of ORE_WEIGHTS) {
    if (roll < weight) {
      ore = id;
      break;
    }
    roll -= weight;
  }
  const radius = NORMAL_RADIUS_MIN + rng.nextInt(NORMAL_RADIUS_RANGE);
  const margin = radius + PATCH_JITTER;
  const span = REGION_SIZE - 2 * margin;
  const originX = rx * REGION_SIZE - REGION_OFFSET;
  const originY = ry * REGION_SIZE - REGION_OFFSET;
  // Richer patches farther from the start, like Factorio.
  const distance = Math.max(Math.abs(rx), Math.abs(ry));
  const richness = Math.min(RICHNESS_CAP, (NORMAL_RICHNESS * (3 + distance)) >> 2);
  return [
    {
      ore,
      x: originX + margin + rng.nextInt(span),
      y: originY + margin + rng.nextInt(span),
      radius,
      richness,
      seed: rng.nextU32(),
    },
  ];
}

/**
 * Stamps `patch` into `chunk`, skipping water and tiles that already have a
 * resource (earlier patches win).
 */
function stampPatch(chunk: Chunk, patch: Patch): void {
  const x0 = chunk.cx << CHUNK_SHIFT;
  const y0 = chunk.cy << CHUNK_SHIFT;
  const reach = patch.radius + PATCH_JITTER;
  const minX = Math.max(x0, patch.x - reach);
  const maxX = Math.min(x0 + CHUNK_SIZE - 1, patch.x + reach);
  const minY = Math.max(y0, patch.y - reach);
  const maxY = Math.min(y0 + CHUNK_SIZE - 1, patch.y + reach);
  if (minX > maxX || minY > maxY) return;

  const baseRadius = patch.radius << SUB_BITS;
  const jitterSpan = (2 * PATCH_JITTER) << SUB_BITS;
  const jitterOffset = PATCH_JITTER << SUB_BITS;
  const { terrain, resource, amount } = chunk;

  for (let y = minY; y <= maxY; y++) {
    const dy = y - patch.y;
    const row = (y - y0) << CHUNK_SHIFT;
    for (let x = minX; x <= maxX; x++) {
      const i = row | (x - x0);
      if (resource[i] !== ResourceId.None || terrain[i] === TileId.Water) continue;
      const dx = x - patch.x;
      // Effective radius in 1/16 tiles, jittered by low-frequency noise for a blobby edge.
      const n = valueNoise(patch.seed, x, y, PATCH_EDGE_CELL_SHIFT);
      const r = baseRadius + ((n * jitterSpan) >> 16) - jitterOffset;
      const r2 = r * r;
      const d2 = (dx * dx + dy * dy) << (2 * SUB_BITS);
      if (d2 >= r2) continue;
      resource[i] = patch.ore;
      // Linear falloff in squared distance: full richness at the center, MIN_AMOUNT at the edge.
      amount[i] = MIN_AMOUNT + Math.trunc((patch.richness * (r2 - d2)) / r2);
    }
  }
}

// ---------------------------------------------------------------------------
// Chunk generation
// ---------------------------------------------------------------------------

/** Generates chunk `(cx, cy)` of the world with the given seed. Pure and deterministic. */
export function generateChunk(seed: number, cx: number, cy: number): Chunk {
  seed >>>= 0;
  const chunk = new Chunk(cx, cy);
  const x0 = cx << CHUNK_SHIFT;
  const y0 = cy << CHUNK_SHIFT;

  const terrainSeed = subSeed(seed, SALT_TERRAIN);
  const { terrain } = chunk;
  let i = 0;
  for (let ly = 0; ly < CHUNK_SIZE; ly++) {
    for (let lx = 0; lx < CHUNK_SIZE; lx++) {
      terrain[i++] = tileForElevation(elevationAt(terrainSeed, x0 + lx, y0 + ly));
    }
  }

  for (const patch of regionPatches(seed, regionOf(x0), regionOf(y0))) {
    stampPatch(chunk, patch);
  }
  return chunk;
}

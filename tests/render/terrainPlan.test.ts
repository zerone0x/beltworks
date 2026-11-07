import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ORE_IDS, RESOURCES, ResourceId } from '../../src/data/resources';
import { TileId } from '../../src/data/tiles';
import { parseAtlasIndex } from '../../src/render/sprites';
import { GROUND_NAMES } from '../../src/render/terrainArt';
import {
  DECOR_VARIANTS,
  ORE_VARIANTS,
  PLAN_REACH,
  SPLAT_SIZE,
  TREE_JITTER,
  SOFTWARE_MAX_TEXELS,
  TREE_VARIANTS,
  isSoftwareRenderer,
  oreDecal,
  planChunk,
  richnessLevel,
  texelsForZoom,
  treeAt,
  visualChange,
  type ChunkLookup,
} from '../../src/render/terrainPlan';
import type { ChunkData } from '../../src/sim/snapshot';
import { CHUNK_AREA, CHUNK_SIZE, tileIndex } from '../../src/sim/world/chunk';
import { generateChunk } from '../../src/sim/world/generate';

function blankChunk(cx = 0, cy = 0, terrain: number = TileId.Grass): ChunkData {
  return {
    cx,
    cy,
    terrain: new Uint8Array(CHUNK_AREA).fill(terrain),
    resource: new Uint8Array(CHUNK_AREA),
    amount: new Uint32Array(CHUNK_AREA),
    tree: new Uint8Array(CHUNK_AREA),
  };
}

const none: ChunkLookup = () => undefined;

/** The splat weights (grass, sand, water) of the tile at local `(lx, ly)` (-1..CHUNK_SIZE). */
function splatAt(splat: Uint8Array, lx: number, ly: number): number[] {
  const o = ((ly + 1) * SPLAT_SIZE + lx + 1) * 4;
  return [splat[o]!, splat[o + 1]!, splat[o + 2]!, splat[o + 3]!];
}

describe('terrain plan', () => {
  it('weights each tile by its terrain, with a border from the neighbours', () => {
    const chunk = blankChunk();
    chunk.terrain[tileIndex(3, 4)] = TileId.Water;
    chunk.terrain[tileIndex(5, 4)] = TileId.Rock;
    const east = blankChunk(1, 0, TileId.Sand);
    const plan = planChunk(chunk, (cx, cy) => (cx === 1 && cy === 0 ? east : undefined));
    expect(plan.splat).toHaveLength(SPLAT_SIZE * SPLAT_SIZE * 4);
    expect(splatAt(plan.splat, 0, 0)).toEqual([255, 0, 0, 0]);
    // Alpha: the water around (one tile of water in the 3×3 around).
    expect(splatAt(plan.splat, 3, 4)).toEqual([0, 0, 255, 28]);
    expect(splatAt(plan.splat, 4, 5)).toEqual([255, 0, 0, 28]);
    // Rock is what the others leave.
    expect(splatAt(plan.splat, 5, 4)).toEqual([0, 0, 0, 0]);
    // The border column east of the chunk is the sand of the neighbour...
    expect(splatAt(plan.splat, CHUNK_SIZE, 10)).toEqual([0, 255, 0, 0]);
    // ...and a missing neighbour continues the chunk's own edge.
    expect(splatAt(plan.splat, -1, 10)).toEqual([255, 0, 0, 0]);
  });

  it('puts an ore decal on every resource tile, richer for more units', () => {
    expect(richnessLevel(100)).toBe(0);
    expect(richnessLevel(400)).toBe(1);
    expect(richnessLevel(1200)).toBe(2);
    expect(richnessLevel(20_000)).toBe(2);
    expect(oreDecal(ResourceId.None, 500, 0, 0)).toBeNull();
    const chunk = blankChunk();
    chunk.resource[tileIndex(2, 2)] = ResourceId.Coal;
    chunk.amount[tileIndex(2, 2)] = 1500;
    const plan = planChunk(chunk, none);
    const decal = plan.decals.find((d) => d.x === 2.5 && d.y === 2.5);
    expect(decal?.name).toMatch(/^coal-2-[0-2]$/);
    // Every ore at every level and variant has a name the atlas uses.
    const names = new Set<string>();
    for (const ore of ORE_IDS) {
      for (let x = 0; x < 64; x++) names.add(oreDecal(ore, 100 + x * 40, x, 7)!);
    }
    expect(names.size).toBe(ORE_IDS.length * 3 * ORE_VARIANTS);
    expect([...names].every((n) => ORE_IDS.some((o) => n.startsWith(RESOURCES[o].name)))).toBe(
      true,
    );
  });

  it('plans trees from north to south, including those of the neighbours that reach in', () => {
    const chunk = blankChunk();
    chunk.tree[tileIndex(4, 9)] = 1;
    chunk.tree[tileIndex(7, 2)] = 1;
    const south = blankChunk(0, 1);
    south.tree[tileIndex(10, 0)] = 1;
    south.tree[tileIndex(10, PLAN_REACH + 3)] = 1; // too far to reach in
    const plan = planChunk(chunk, (cx, cy) => (cx === 0 && cy === 1 ? south : undefined));
    expect(plan.trees).toHaveLength(3);
    expect(plan.trees.map((t) => Math.floor(t.y))).toEqual([2, 9, CHUNK_SIZE]);
    for (const t of plan.trees) expect(t.name).toMatch(/^tree-[0-5]$/);
    // No decor or decal on a tree.
    expect(plan.decals.some((d) => d.x === 4.5 && d.y === 9.5)).toBe(false);
  });

  it('gives each tree a stable variant and a small offset', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const t = treeAt(i * 7 - 300, i * 3 + 11);
      expect(treeAt(i * 7 - 300, i * 3 + 11)).toEqual(t);
      expect(Math.abs(t.dx - 0.5)).toBeLessThanOrEqual(TREE_JITTER + 1e-9);
      expect(Math.abs(t.dy - 0.5)).toBeLessThanOrEqual(TREE_JITTER + 1e-9);
      seen.add(t.name);
    }
    expect(seen.size).toBe(TREE_VARIANTS);
  });

  it('sprinkles a little decor inside plain areas, never on water or at an edge', () => {
    const plan = planChunk(blankChunk(), none);
    const decor = plan.decals.filter((d) => d.name.startsWith('decor-grass-'));
    expect(decor.length).toBeGreaterThan(20);
    expect(decor.length).toBeLessThan(200);
    const variants = Number(DECOR_VARIANTS[TileId.Grass]);
    expect(decor.every((d) => Number(d.name.split('-').pop()) < variants)).toBe(true);
    expect(planChunk(blankChunk(0, 0, TileId.Water), none).decals).toEqual([]);
    // A checkerboard of two terrains has no tile inside an area of one: no decor at all.
    const mixed = blankChunk();
    for (let i = 0; i < CHUNK_AREA; i++) {
      if (((i % CHUNK_SIZE) + Math.floor(i / CHUNK_SIZE)) % 2 === 0) mixed.terrain[i] = TileId.Sand;
    }
    expect(planChunk(mixed, none).decals).toEqual([]);
  });

  it('is deterministic for generated chunks', () => {
    const chunk = generateChunk(1, 3, 2);
    const a = planChunk(chunk, none);
    const b = planChunk(chunk, none);
    expect(a).toEqual(b);
  });

  it('only needs a new bake when a tile looks different', () => {
    const before = blankChunk();
    before.resource[tileIndex(10, 10)] = ResourceId.IronOre;
    before.amount[tileIndex(10, 10)] = 1000;
    const mined = { ...before, amount: before.amount.slice() };
    mined.amount[tileIndex(10, 10)] = 990;
    expect(visualChange(before, mined)).toEqual({ self: false, edge: false });
    mined.amount[tileIndex(10, 10)] = 300;
    expect(visualChange(before, mined)).toEqual({ self: true, edge: false });
    const felled = { ...before, tree: before.tree.slice() };
    felled.tree[tileIndex(0, 5)] = 1;
    expect(visualChange(before, felled)).toEqual({ self: true, edge: true });
  });

  it('bakes at a resolution that follows the zoom', () => {
    expect(texelsForZoom(4)).toBe(32);
    expect(texelsForZoom(1)).toBe(32);
    expect(texelsForZoom(0.75)).toBe(32);
    expect(texelsForZoom(0.5)).toBe(16);
    expect(texelsForZoom(0.25)).toBe(8);
    // Capped on software renderers.
    expect(texelsForZoom(1, SOFTWARE_MAX_TEXELS)).toBe(16);
    expect(texelsForZoom(0.25, SOFTWARE_MAX_TEXELS)).toBe(8);
    expect(
      isSoftwareRenderer('ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device), SwiftShader driver)'),
    ).toBe(true);
    expect(isSoftwareRenderer('llvmpipe (LLVM 15.0.7, 256 bits)')).toBe(true);
    expect(
      isSoftwareRenderer('ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0)'),
    ).toBe(false);
  });
});

describe('committed terrain atlas', () => {
  const index = parseAtlasIndex(
    JSON.parse(readFileSync(new URL('../../public/sprites/terrain.json', import.meta.url), 'utf8')),
  );

  it('has the four ground textures with one period', () => {
    const periods = GROUND_NAMES.map((name) => index.ground?.[name]?.period);
    expect(periods.every((p) => p === periods[0] && p! > 0)).toBe(true);
  });

  it('has every decal, decor and tree model the plan can ask for', () => {
    const wanted: string[] = [];
    for (const ore of ORE_IDS) {
      for (let level = 0; level < 3; level++) {
        for (let v = 0; v < ORE_VARIANTS; v++)
          wanted.push(`${RESOURCES[ore].name}-${String(level)}-${String(v)}`);
      }
    }
    for (let v = 0; v < TREE_VARIANTS; v++) wanted.push(`tree-${String(v)}`);
    const decor: [string, number][] = [
      ['decor-grass', TileId.Grass],
      ['decor-sand', TileId.Sand],
      ['decor-rock', TileId.Rock],
    ];
    for (const [name, tile] of decor) {
      for (let v = 0; v < DECOR_VARIANTS[tile]!; v++) wanted.push(`${name}-${String(v)}`);
    }
    expect(wanted.filter((n) => !index.models[n])).toEqual([]);
  });
});

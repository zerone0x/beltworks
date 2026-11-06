import { describe, expect, it } from 'vitest';
import { ORE_IDS, ResourceId } from '../../src/data/resources';
import { TILES, TileId } from '../../src/data/tiles';
import { hashBuffers } from '../../src/sim/hash';
import { CHUNK_AREA, CHUNK_SIZE, type Chunk } from '../../src/sim/world/chunk';
import {
  REGION_SIZE,
  generateChunk,
  regionOf,
  regionPatches,
  startingPatches,
} from '../../src/sim/world/generate';
import { World } from '../../src/sim/world/world';

const chunkHash = (c: Chunk): number => hashBuffers([c.terrain, c.resource, c.amount]);

const SEEDS = Array.from({ length: 20 }, (_, i) => (Math.imul(i + 1, 0x9e3779b1) >>> 0) ^ i);

describe('generateChunk', () => {
  it('produces identical bytes for the same seed', () => {
    for (const [cx, cy] of [
      [0, 0],
      [3, -2],
      [-5, 7],
    ] as const) {
      const a = generateChunk(12345, cx, cy);
      const b = generateChunk(12345, cx, cy);
      expect(a.terrain).toEqual(b.terrain);
      expect(a.resource).toEqual(b.resource);
      expect(a.amount).toEqual(b.amount);
    }
  });

  it('produces different chunks for different seeds', () => {
    // Compare 3x3 blocks: a single chunk can legitimately be plain grass for several seeds.
    const blockHash = (seed: number, cx0: number, cy0: number): number => {
      const parts: Uint8Array[] = [];
      for (let cy = cy0; cy < cy0 + 3; cy++) {
        for (let cx = cx0; cx < cx0 + 3; cx++) {
          const c = generateChunk(seed, cx, cy);
          parts.push(c.terrain, c.resource);
        }
      }
      return hashBuffers(parts);
    };
    for (const [cx, cy] of [
      [-1, -1],
      [4, 4],
      [-9, 2],
    ] as const) {
      const hashes = new Set([1, 2, 3, 4].map((seed) => blockHash(seed, cx, cy)));
      expect(hashes.size).toBe(4);
    }
  });

  it('matches pinned hashes (update deliberately when changing generation)', () => {
    // Guards against accidental changes and engine differences; a change here
    // alters every existing map and must be intentional.
    expect(chunkHash(generateChunk(1, 0, 0))).toBe(0x3fd857c5);
    expect(chunkHash(generateChunk(0xdeadbeef, -3, 5))).toBe(0x6362c42d);
  });

  it('works at negative chunk coordinates', () => {
    const c = generateChunk(77, -3, -9);
    expect(c.cx).toBe(-3);
    expect(c.cy).toBe(-9);
    expect(chunkHash(c)).not.toBe(chunkHash(generateChunk(77, 3, 9)));
    // Negative chunks line up seamlessly with the World's tile addressing.
    const world = new World(77);
    for (let ly = 0; ly < CHUNK_SIZE; ly += 7) {
      for (let lx = 0; lx < CHUNK_SIZE; lx += 5) {
        const i = ly * CHUNK_SIZE + lx;
        expect(world.tileAt(-3 * CHUNK_SIZE + lx, -9 * CHUNK_SIZE + ly)).toBe(c.terrain[i]);
        expect(world.resourceAt(-3 * CHUNK_SIZE + lx, -9 * CHUNK_SIZE + ly)).toBe(c.resource[i]);
      }
    }
  });

  it('stores only valid ids and consistent amounts', () => {
    const problems: string[] = [];
    for (const seed of SEEDS.slice(0, 5)) {
      for (let cy = -4; cy < 4; cy++) {
        for (let cx = -4; cx < 4; cx++) {
          const c = generateChunk(seed, cx, cy);
          for (let i = 0; i < CHUNK_AREA; i++) {
            const tile = c.terrain[i]!;
            const res = c.resource[i]!;
            const amount = c.amount[i]!;
            const ok =
              tile < TILES.length &&
              res <= ResourceId.Stone &&
              (res === ResourceId.None ? amount === 0 : amount > 0 && tile !== TileId.Water);
            if (!ok) problems.push(`seed ${seed} chunk (${cx},${cy}) tile ${i}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('generates every terrain type and every ore somewhere', () => {
    const tiles = new Set<number>();
    const ores = new Set<number>();
    for (let cy = -8; cy < 8; cy++) {
      for (let cx = -8; cx < 8; cx++) {
        const c = generateChunk(2024, cx, cy);
        c.terrain.forEach((t) => tiles.add(t));
        c.resource.forEach((r) => ores.add(r));
      }
    }
    expect([...tiles].sort()).toEqual([TileId.Grass, TileId.Sand, TileId.Water, TileId.Rock]);
    expect([...ores].sort()).toEqual([ResourceId.None, ...ORE_IDS]);
  });

  it('generates one chunk in well under 2 ms', () => {
    for (let i = 0; i < 20; i++) generateChunk(5, i, i); // warm up the JIT
    const n = 200;
    const start = performance.now();
    for (let i = 0; i < n; i++) generateChunk(5, i - 100, 37 - i);
    const perChunk = (performance.now() - start) / n;
    expect(perChunk).toBeLessThan(2);
  });
});

describe('resource patches', () => {
  it('never extend past their region', () => {
    for (const seed of SEEDS.slice(0, 5)) {
      for (let ry = -4; ry <= 4; ry++) {
        for (let rx = -4; rx <= 4; rx++) {
          for (const p of regionPatches(seed, rx, ry)) {
            const reach = p.radius + 3;
            expect(regionOf(p.x - reach)).toBe(rx);
            expect(regionOf(p.x + reach)).toBe(rx);
            expect(regionOf(p.y - reach)).toBe(ry);
            expect(regionOf(p.y + reach)).toBe(ry);
          }
        }
      }
    }
    expect(REGION_SIZE % CHUNK_SIZE).toBe(0);
  });

  it('are richer toward the center', () => {
    const world = new World(31337);
    for (const p of startingPatches(31337)) {
      const center = world.amountAt(p.x, p.y);
      expect(world.resourceAt(p.x, p.y)).toBe(p.ore);
      for (let dy = -p.radius - 3; dy <= p.radius + 3; dy++) {
        for (let dx = -p.radius - 3; dx <= p.radius + 3; dx++) {
          if (world.resourceAt(p.x + dx, p.y + dy) === p.ore) {
            expect(world.amountAt(p.x + dx, p.y + dy)).toBeLessThanOrEqual(center);
          }
        }
      }
      // Edge tiles hold noticeably less than the center.
      const edge = world.amountAt(p.x + p.radius - 3, p.y);
      expect(edge).toBeLessThan(center);
    }
  });
});

describe('starting area', () => {
  it.each(SEEDS)('seed %i: spawn is grass and every ore is within 40 tiles', (seed) => {
    const world = new World(seed);
    expect(world.tileAt(0, 0)).toBe(TileId.Grass);

    const found = new Set<number>();
    let water = 0;
    for (let y = -40; y <= 40; y++) {
      for (let x = -40; x <= 40; x++) {
        if (x * x + y * y > 40 * 40) continue;
        found.add(world.resourceAt(x, y));
        if (world.tileAt(x, y) === TileId.Water) water++;
      }
    }
    for (const ore of ORE_IDS) expect(found).toContain(ore);
    expect(water).toBe(0);
  });
});

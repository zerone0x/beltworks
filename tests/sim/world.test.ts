import { describe, expect, it } from 'vitest';
import { ResourceId } from '../../src/data/resources';
import { FNV1A32_OFFSET_BASIS } from '../../src/sim/hash';
import { CHUNK_SIZE } from '../../src/sim/world/chunk';
import { startingPatches } from '../../src/sim/world/generate';
import { CHUNK_COORD_LIMIT, World, chunkKey } from '../../src/sim/world/world';

/** A tile of the given seed's first starting patch, guaranteed to hold ore. */
function oreTile(seed: number): { x: number; y: number; ore: number } {
  const p = startingPatches(seed)[0]!;
  return { x: p.x, y: p.y, ore: p.ore };
}

describe('chunkKey', () => {
  it('is unique for nearby positive and negative coordinates', () => {
    const keys = new Set<number>();
    for (let cy = -20; cy < 20; cy++) {
      for (let cx = -20; cx < 20; cx++) keys.add(chunkKey(cx, cy));
    }
    expect(keys.size).toBe(40 * 40);
    expect(chunkKey(-1, 0)).not.toBe(chunkKey(0, -1));
    expect(chunkKey(CHUNK_COORD_LIMIT - 1, 0)).not.toBe(chunkKey(-CHUNK_COORD_LIMIT, 0));
  });
});

describe('World', () => {
  it('generates chunks lazily and caches them', () => {
    const world = new World(1);
    expect(world.chunkCount).toBe(0);
    expect(world.peekChunk(0, 0)).toBeUndefined();
    const c = world.getChunk(0, 0);
    expect(world.chunkCount).toBe(1);
    expect(world.getChunk(0, 0)).toBe(c);
    expect(world.peekChunk(0, 0)).toBe(c);
    world.tileAt(-1, -1);
    expect(world.chunkCount).toBe(2);
    expect(world.peekChunk(-1, -1)).toBeDefined();
  });

  it('rejects chunk coordinates outside the supported range', () => {
    const world = new World(1);
    expect(() => world.getChunk(CHUNK_COORD_LIMIT, 0)).toThrow(RangeError);
    expect(() => world.getChunk(0, -CHUNK_COORD_LIMIT - 1)).toThrow(RangeError);
    expect(() => world.getChunk(0.5, 0)).toThrow(RangeError);
    expect(() => world.getChunk(CHUNK_COORD_LIMIT - 1, -CHUNK_COORD_LIMIT)).not.toThrow();
  });

  it('addresses tiles across chunk boundaries, including negative coordinates', () => {
    const world = new World(9);
    for (const [x, y] of [
      [0, 0],
      [31, 31],
      [32, 0],
      [-1, 0],
      [-32, -33],
      [-33, 64],
    ] as const) {
      const cx = Math.floor(x / CHUNK_SIZE);
      const cy = Math.floor(y / CHUNK_SIZE);
      const lx = x - cx * CHUNK_SIZE;
      const ly = y - cy * CHUNK_SIZE;
      const chunk = world.getChunk(cx, cy);
      const i = ly * CHUNK_SIZE + lx;
      expect(world.tileAt(x, y)).toBe(chunk.terrain[i]);
      expect(world.resourceAt(x, y)).toBe(chunk.resource[i]);
      expect(world.amountAt(x, y)).toBe(chunk.amount[i]);
    }
  });

  describe('mine', () => {
    it('decrements the amount and returns what was taken', () => {
      const world = new World(5);
      const { x, y, ore } = oreTile(5);
      const before = world.amountAt(x, y);
      expect(world.mine(x, y, 10)).toBe(10);
      expect(world.amountAt(x, y)).toBe(before - 10);
      expect(world.resourceAt(x, y)).toBe(ore);
    });

    it('clears the resource when the tile runs out', () => {
      const world = new World(5);
      const { x, y } = oreTile(5);
      const before = world.amountAt(x, y);
      expect(world.mine(x, y, before + 1000)).toBe(before);
      expect(world.amountAt(x, y)).toBe(0);
      expect(world.resourceAt(x, y)).toBe(ResourceId.None);
      expect(world.mine(x, y, 1)).toBe(0);
    });

    it('returns 0 on tiles without a resource and rejects invalid amounts', () => {
      const world = new World(5);
      expect(world.resourceAt(0, 0)).toBe(ResourceId.None);
      expect(world.mine(0, 0, 5)).toBe(0);
      expect(() => world.mine(0, 0, -1)).toThrow(RangeError);
      expect(() => world.mine(0, 0, 1.5)).toThrow(RangeError);
    });
  });

  describe('hashInto', () => {
    it('chains from a running hash and defaults to the FNV offset basis', () => {
      const world = new World(3);
      expect(world.hashInto()).toBe(world.hashInto(FNV1A32_OFFSET_BASIS));
      expect(world.hashInto(123)).not.toBe(world.hashInto(456));
    });

    it('depends on the seed', () => {
      expect(new World(1).hashInto()).not.toBe(new World(2).hashInto());
    });

    it('ignores which unmodified chunks have been generated', () => {
      const a = new World(4);
      const b = new World(4);
      for (let cx = -5; cx < 5; cx++) b.getChunk(cx, cx);
      expect(a.hashInto()).toBe(b.hashInto());
    });

    it('changes when a chunk is modified', () => {
      const world = new World(4);
      const { x, y } = oreTile(4);
      const before = world.hashInto();
      world.mine(x, y, 1);
      const after = world.hashInto();
      expect(after).not.toBe(before);
      world.mine(x, y, 1);
      expect(world.hashInto()).not.toBe(after);
    });

    it('is independent of the order chunks were generated and modified in', () => {
      const patches = startingPatches(8);
      const a = new World(8);
      const b = new World(8);
      for (const p of patches) a.mine(p.x, p.y, 3);
      b.getChunk(40, -40);
      for (const p of [...patches].reverse()) b.mine(p.x, p.y, 3);
      expect(a.hashInto()).toBe(b.hashInto());
    });
  });
});

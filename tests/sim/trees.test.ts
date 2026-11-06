import { describe, expect, it } from 'vitest';
import { ENTITIES, EntityTypeId } from '../../src/data/entities';
import { ITEMS, ItemId } from '../../src/data/items';
import { ResourceId } from '../../src/data/resources';
import { TileId } from '../../src/data/tiles';
import { TREE_ITEM, TREE_MINING_TICKS, TREE_WOOD } from '../../src/data/trees';
import { BuildResult, placeEntity, simPlacementView } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { Placement, checkPlacement } from '../../src/sim/entities/placement';
import { tileCenter } from '../../src/sim/fixed';
import { hashBuffers } from '../../src/sim/hash';
import { HAND_MINING_TICKS } from '../../src/sim/player';
import { Sim } from '../../src/sim/tick';
import { CHUNK_AREA, CHUNK_SIZE } from '../../src/sim/world/chunk';
import { generateChunk } from '../../src/sim/world/generate';
import { TREE_FADE_RADIUS, TREE_FREE_RADIUS, treeDensity } from '../../src/sim/world/trees';
import { World } from '../../src/sim/world/world';

const SEEDS = [1, 7, 0x5eed_2026, 0xbe_4c_01, 0xdeadbeef];

/** The tree closest to the spawn (ties: smallest y, then x) within `radius` tiles. */
function nearestTree(world: World, radius = 128): { x: number; y: number } {
  let best: { x: number; y: number; d2: number } | null = null;
  for (let y = -radius; y < radius; y++) {
    for (let x = -radius; x < radius; x++) {
      const d2 = x * x + y * y;
      if ((best === null || d2 < best.d2) && world.treeAt(x, y)) best = { x, y, d2 };
    }
  }
  if (!best) throw new Error('no tree found');
  return best;
}

/** A sim with an empty inventory whose player 0 stands on the tile west of the nearest tree. */
function simNextToTree(seed = 1): { sim: Sim; x: number; y: number } {
  const sim = new Sim({ seed, startingKit: [] });
  const { x, y } = nearestTree(sim.state.world);
  sim.state.players.x[0] = tileCenter(x - 1);
  sim.state.players.y[0] = tileCenter(y);
  return { sim, x, y };
}

const steps = (sim: Sim, n: number): void => {
  for (let i = 0; i < n; i++) sim.step();
};
const mineStart = (sim: Sim, x: number, y: number): void => {
  sim.enqueue({ tick: sim.tick, playerId: 0, type: 'MineStart', x, y });
};

describe('tree generation', () => {
  it('is deterministic and matches a pinned hash (update deliberately when changing it)', () => {
    for (const [cx, cy] of [
      [2, 0],
      [-4, 3],
      [5, -6],
    ] as const) {
      expect(generateChunk(9, cx, cy).tree).toEqual(generateChunk(9, cx, cy).tree);
    }
    const treeHash = (seed: number, cx: number, cy: number) =>
      hashBuffers([generateChunk(seed, cx, cy).tree]);
    // Both chunks have trees (297 and 19 of them).
    expect(treeHash(1, 2, 0)).toBe(0x9402ad02);
    expect(treeHash(0xdeadbeef, -3, 5)).toBe(0x18d25274);
  });

  it('only plants on grass without a resource, and only 0 or 1', () => {
    const problems: string[] = [];
    let trees = 0;
    for (const seed of SEEDS) {
      for (let cy = -5; cy < 5; cy++) {
        for (let cx = -5; cx < 5; cx++) {
          const c = generateChunk(seed, cx, cy);
          for (let i = 0; i < CHUNK_AREA; i++) {
            const t = c.tree[i]!;
            if (t === 0) continue;
            trees++;
            if (t !== 1 || c.terrain[i] !== TileId.Grass || c.resource[i] !== ResourceId.None) {
              problems.push(`seed ${seed} chunk (${cx},${cy}) tile ${i}`);
            }
          }
        }
      }
    }
    expect(problems).toEqual([]);
    expect(trees).toBeGreaterThan(1000);
  });

  it.each(SEEDS)('seed %i: keeps the starting area free and grows forests beyond it', (seed) => {
    const world = new World(seed);
    let near = 0;
    let grass = 0;
    let trees = 0;
    for (let y = -160; y < 160; y++) {
      for (let x = -160; x < 160; x++) {
        const d2 = x * x + y * y;
        if (d2 < TREE_FREE_RADIUS * TREE_FREE_RADIUS) {
          if (world.treeAt(x, y)) near++;
        } else if (d2 >= TREE_FADE_RADIUS * TREE_FADE_RADIUS) {
          if (world.tileAt(x, y) === TileId.Grass) grass++;
          if (world.treeAt(x, y)) trees++;
        }
      }
    }
    expect(near).toBe(0);
    // Forests cover a fair share of the grass, but leave most of it open.
    expect(trees * 100).toBeGreaterThan(grass * 5);
    expect(trees * 100).toBeLessThan(grass * 35);
  });

  it('fades in between the free and the full radius', () => {
    let faded = 0;
    let full = 0;
    for (let x = TREE_FREE_RADIUS; x < TREE_FREE_RADIUS + 200; x++) {
      for (let y = -100; y < 100; y++) {
        const d2 = x * x + y * y;
        const density = treeDensity(42, x, y);
        expect(Number.isInteger(density) && density >= 0 && density <= 1000).toBe(true);
        if (d2 < TREE_FADE_RADIUS * TREE_FADE_RADIUS) faded = Math.max(faded, density);
        else full = Math.max(full, density);
      }
    }
    expect(treeDensity(42, 0, 0)).toBe(0);
    expect(faded).toBeGreaterThan(0);
    expect(full).toBeGreaterThan(faded);
  });

  it('keeps chunk generation fast with trees', () => {
    // Forest chunks far from the spawn, where every tile is checked.
    for (let i = 0; i < 20; i++) generateChunk(5, 40 + i, i); // warm up the JIT
    const n = 200;
    const start = performance.now();
    for (let i = 0; i < n; i++) generateChunk(5, 100 + i, 37 - i);
    expect((performance.now() - start) / n).toBeLessThan(2);
  });
});

describe('World trees', () => {
  it('fells a tree once, marks the chunk modified, and changes the hash', () => {
    const world = new World(1);
    const { x, y } = nearestTree(world);
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const before = world.hashInto();
    expect(world.chunkVersion(cx, cy)).toBe(0);
    expect(world.removeTree(x, y)).toBe(true);
    expect(world.treeAt(x, y)).toBe(false);
    expect(world.chunkVersion(cx, cy)).toBe(1);
    expect(world.hashInto()).not.toBe(before);
    // Nothing left to fell: no further change.
    const after = world.hashInto();
    expect(world.removeTree(x, y)).toBe(false);
    expect(world.chunkVersion(cx, cy)).toBe(1);
    expect(world.hashInto()).toBe(after);
    // A modified chunk is kept: the felled tree doesn't grow back.
    expect(world.unloadChunk(cx, cy)).toBe(false);
    expect(world.treeAt(x, y)).toBe(false);
  });

  it('hashes trees independently of the order they were felled in', () => {
    const a = new World(1);
    const b = new World(1);
    const first = nearestTree(a);
    a.removeTree(first.x, first.y);
    const second = nearestTree(a);
    a.removeTree(second.x, second.y);
    b.removeTree(second.x, second.y);
    b.removeTree(first.x, first.y);
    expect(a.hashInto()).toBe(b.hashInto());
  });
});

describe('mining trees', () => {
  it(`fells a tree in TREE_MINING_TICKS ticks for ${String(TREE_WOOD)} wood`, () => {
    expect(TREE_ITEM).toBe(ItemId.Wood);
    expect(TREE_WOOD).toBe(4);
    const { sim, x, y } = simNextToTree();
    const inv = sim.state.players.inventory(0);
    mineStart(sim, x, y);
    // The command applies on the first tick, which already counts as mining.
    steps(sim, TREE_MINING_TICKS - 1);
    expect(inv.count(ItemId.Wood)).toBe(0);
    expect(sim.state.world.treeAt(x, y)).toBe(true);
    steps(sim, 1);
    expect(inv.count(ItemId.Wood)).toBe(TREE_WOOD);
    expect(sim.state.world.treeAt(x, y)).toBe(false);
    // The tile is bare now: mining ends.
    steps(sim, 1);
    expect(sim.state.players.mining[0]).toBe(0);
    steps(sim, 2 * TREE_MINING_TICKS);
    expect(inv.count(ItemId.Wood)).toBe(TREE_WOOD);
    expect(TREE_MINING_TICKS).toBe(HAND_MINING_TICKS);
  });

  it('pauses out of reach like ore', () => {
    const { sim, x, y } = simNextToTree();
    sim.state.players.x[0] = tileCenter(x - 4);
    mineStart(sim, x, y);
    steps(sim, 3 * TREE_MINING_TICKS);
    expect(sim.state.world.treeAt(x, y)).toBe(true);
    expect(sim.state.players.mining[0]).toBe(1);
    sim.state.players.x[0] = tileCenter(x - 1);
    steps(sim, TREE_MINING_TICKS + 1);
    expect(sim.state.world.treeAt(x, y)).toBe(false);
  });

  it('leaves the tree standing when the wood would not all fit', () => {
    const { sim, x, y } = simNextToTree();
    const inv = sim.state.players.inventory(0);
    // Every slot full of stone but the last, which has room for 3 wood.
    inv.add(ItemId.Stone, (inv.slots - 1) * ITEMS[ItemId.Stone].stackSize);
    inv.add(ItemId.Wood, ITEMS[ItemId.Wood].stackSize - (TREE_WOOD - 1));
    mineStart(sim, x, y);
    steps(sim, 2);
    expect(sim.state.players.mining[0]).toBe(0);
    steps(sim, 2 * TREE_MINING_TICKS);
    expect(sim.state.world.treeAt(x, y)).toBe(true);
    expect(inv.count(ItemId.Wood)).toBe(ITEMS[ItemId.Wood].stackSize - (TREE_WOOD - 1));
  });
});

describe('trees and building', () => {
  it('block placement until they are mined', () => {
    const { sim, x, y } = simNextToTree();
    const { state } = sim;
    state.players.inventory(0).add(ItemId.WoodenChest, 2);
    // Stand a little away, so the player isn't in the way of the footprint.
    state.players.y[0] = tileCenter(y + 2);
    const chest = ENTITIES[EntityTypeId.WoodenChest];
    const verdict = () =>
      checkPlacement(
        simPlacementView(state),
        chest,
        x,
        y,
        Direction.North,
        state.players.x[0]!,
        state.players.y[0]!,
      );
    expect(verdict()).toBe(Placement.Tree);
    expect(placeEntity(state, 0, ItemId.WoodenChest, x, y, Direction.North)).toBe(
      BuildResult.Blocked,
    );
    // A larger footprint with only one corner on the tree is blocked too.
    const furnace = ENTITIES[EntityTypeId.StoneFurnace];
    expect(
      checkPlacement(
        simPlacementView(state),
        furnace,
        x - 1,
        y - 1,
        Direction.North,
        state.players.x[0]!,
        state.players.y[0],
      ),
    ).not.toBe(Placement.Ok);
    state.world.removeTree(x, y);
    expect(verdict()).toBe(Placement.Ok);
    expect(placeEntity(state, 0, ItemId.WoodenChest, x, y, Direction.North)).toBe(BuildResult.Ok);
    expect(state.entities.at(x, y)).not.toBe(0);
  });
});

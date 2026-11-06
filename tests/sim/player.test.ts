import { describe, expect, it } from 'vitest';
import { ITEMS, ItemId, MINED_ITEM } from '../../src/data/items';
import { TileId } from '../../src/data/tiles';
import type { Axis } from '../../src/sim/commands';
import { tileCenter, tileToFixed } from '../../src/sim/fixed';
import {
  HAND_MINING_TICKS,
  MINING_REACH,
  PLAYER_DIAGONAL_SPEED,
  PLAYER_HALF_SIZE,
  PLAYER_SPEED,
  inMiningReach,
} from '../../src/sim/player';
import { Sim } from '../../src/sim/tick';
import { startingPatches } from '../../src/sim/world/generate';
import type { World } from '../../src/sim/world/world';

const SEED = 1;
const PATCH = startingPatches(SEED)[0]!;
const ITEM = MINED_ITEM[PATCH.ore];

/** A sim whose player 0 stands on the center of the first starting patch. */
function simAtPatch(): Sim {
  const sim = new Sim({ seed: SEED });
  sim.state.players.x[0] = tileCenter(PATCH.x);
  sim.state.players.y[0] = tileCenter(PATCH.y);
  return sim;
}

const command = (sim: Sim) => ({ tick: sim.tick, playerId: 0 });
const move = (sim: Sim, dx: Axis, dy: Axis): void => {
  sim.enqueue({ ...command(sim), type: 'Move', dx, dy });
};
const mineStart = (sim: Sim, x: number, y: number): void => {
  sim.enqueue({ ...command(sim), type: 'MineStart', x, y });
};
const steps = (sim: Sim, n: number): void => {
  for (let i = 0; i < n; i++) sim.step();
};

/**
 * Finds a vertical shoreline: water at `(wx, wy)` and `(wx, wy + 1)`, with
 * walkable tiles in the three columns to its left on both rows.
 */
function findShore(world: World): { wx: number; wy: number } {
  for (let wy = -200; wy < 200; wy++) {
    for (let wx = -200; wx < 200; wx++) {
      if (world.tileAt(wx, wy) !== TileId.Water || world.tileAt(wx, wy + 1) !== TileId.Water) {
        continue;
      }
      let clear = true;
      for (let dx = 1; dx <= 3; dx++) {
        clear &&= world.isWalkable(wx - dx, wy) && world.isWalkable(wx - dx, wy + 1);
      }
      if (clear) return { wx, wy };
    }
  }
  throw new Error('no shoreline found');
}

describe('player movement', () => {
  it('cannot walk into water, and stops flush against it', () => {
    const sim = new Sim({ seed: SEED });
    const { wx, wy } = findShore(sim.state.world);
    const p = sim.state.players;
    p.x[0] = tileCenter(wx - 1);
    p.y[0] = tileCenter(wy);
    move(sim, 1, 0);
    steps(sim, 1);
    // Still in front of the shore after one step...
    expect(p.x[0]).toBe(tileCenter(wx - 1) + PLAYER_SPEED);
    steps(sim, 20);
    // ...then the right edge of the box rests on the last subtile before the water.
    expect(p.x[0]).toBe(tileToFixed(wx) - PLAYER_HALF_SIZE);
    expect(p.y[0]).toBe(tileCenter(wy));
  });

  it('slides along a shore when pushing into it diagonally', () => {
    const sim = new Sim({ seed: SEED });
    const { wx, wy } = findShore(sim.state.world);
    const p = sim.state.players;
    p.x[0] = tileCenter(wx - 1);
    p.y[0] = tileCenter(wy);
    move(sim, 1, 1);
    // 10 diagonal steps keep the box within rows wy and wy + 1.
    steps(sim, 10);
    expect(p.x[0]).toBe(tileToFixed(wx) - PLAYER_HALF_SIZE);
    expect(p.y[0]).toBe(tileCenter(wy) + 10 * PLAYER_DIAGONAL_SPEED);
  });

  it('walks freely around the spawn', () => {
    const sim = new Sim({ seed: SEED });
    move(sim, -1, -1);
    steps(sim, 100);
    expect([sim.state.players.x[0], sim.state.players.y[0]]).toEqual([
      -100 * PLAYER_DIAGONAL_SPEED,
      -100 * PLAYER_DIAGONAL_SPEED,
    ]);
  });
});

describe('inMiningReach', () => {
  it('compares the squared distance to the tile center with 2.5 tiles', () => {
    expect(MINING_REACH).toBe(640);
    const [px, py] = [tileCenter(0), tileCenter(0)];
    expect(inMiningReach(px, py, 0, 0)).toBe(true);
    expect(inMiningReach(px, py, 2, 0)).toBe(true);
    expect(inMiningReach(px, py, -2, 1)).toBe(true);
    expect(inMiningReach(px, py, 3, 0)).toBe(false);
    expect(inMiningReach(px, py, 2, 2)).toBe(false);
    // Exactly on the boundary counts as in reach, one subtile further does not.
    expect(inMiningReach(tileCenter(5) - MINING_REACH, py, 5, 0)).toBe(true);
    expect(inMiningReach(tileCenter(5) - MINING_REACH - 1, py, 5, 0)).toBe(false);
    // Far-away targets don't overflow into false positives.
    expect(inMiningReach(px, py, 0x7fff_ffff, -0x8000_0000)).toBe(false);
  });
});

describe('hand-mining', () => {
  it('mines one unit every HAND_MINING_TICKS ticks into the inventory', () => {
    const sim = simAtPatch();
    const { world } = sim.state;
    const before = world.amountAt(PATCH.x, PATCH.y);
    mineStart(sim, PATCH.x, PATCH.y);
    steps(sim, HAND_MINING_TICKS - 1);
    const inv = sim.state.players.inventory(0);
    expect(inv.count(ITEM)).toBe(0);
    expect(sim.state.players.mineProgress[0]).toBe(HAND_MINING_TICKS - 1);
    steps(sim, 1);
    expect(inv.count(ITEM)).toBe(1);
    expect(world.amountAt(PATCH.x, PATCH.y)).toBe(before - 1);
    expect(sim.state.players.mineProgress[0]).toBe(0);
    // 2 s at 60 ticks/s is 4 units.
    steps(sim, 3 * HAND_MINING_TICKS);
    expect(inv.count(ITEM)).toBe(4);
    expect(world.amountAt(PATCH.x, PATCH.y)).toBe(before - 4);
    expect(sim.state.players.mining[0]).toBe(1);
  });

  it('stops on MineStop and resets the progress', () => {
    const sim = simAtPatch();
    mineStart(sim, PATCH.x, PATCH.y);
    steps(sim, 20);
    sim.enqueue({ ...command(sim), type: 'MineStop' });
    steps(sim, 100);
    const p = sim.state.players;
    expect([p.mining[0], p.mineProgress[0]]).toEqual([0, 0]);
    expect(p.inventory(0).count(ITEM)).toBe(0);
  });

  it('keeps the progress when re-targeting the same tile, resets it for another one', () => {
    const sim = simAtPatch();
    mineStart(sim, PATCH.x, PATCH.y);
    steps(sim, 20);
    mineStart(sim, PATCH.x, PATCH.y);
    steps(sim, 1);
    expect(sim.state.players.mineProgress[0]).toBe(21);
    mineStart(sim, PATCH.x + 1, PATCH.y);
    steps(sim, 1);
    expect(sim.state.players.mineProgress[0]).toBe(1);
  });

  it('pauses out of reach and resumes when the player comes back', () => {
    const sim = new Sim({ seed: SEED });
    const p = sim.state.players;
    // Stand 3 tiles left of the target, then walk towards it.
    p.x[0] = tileCenter(PATCH.x - 3);
    p.y[0] = tileCenter(PATCH.y);
    mineStart(sim, PATCH.x, PATCH.y);
    steps(sim, 100);
    expect([p.mining[0], p.mineProgress[0]]).toEqual([1, 0]);
    // 768 subtiles away; three steps of 38 are not enough to get within 640, the fourth is.
    move(sim, 1, 0);
    steps(sim, 3);
    expect(p.mineProgress[0]).toBe(0);
    steps(sim, 1);
    expect(p.mineProgress[0]).toBe(1);
    move(sim, 0, 0);
    steps(sim, HAND_MINING_TICKS - 1);
    expect(p.inventory(0).count(ITEM)).toBe(1);
  });

  it('ends when the tile runs out', () => {
    const sim = simAtPatch();
    const { world } = sim.state;
    world.mine(PATCH.x, PATCH.y, world.amountAt(PATCH.x, PATCH.y) - 2);
    mineStart(sim, PATCH.x, PATCH.y);
    steps(sim, 2 * HAND_MINING_TICKS);
    expect(world.amountAt(PATCH.x, PATCH.y)).toBe(0);
    expect(world.resourceAt(PATCH.x, PATCH.y)).toBe(0);
    expect(sim.state.players.inventory(0).count(ITEM)).toBe(2);
    expect(sim.state.players.mining[0]).toBe(1);
    steps(sim, 1);
    expect(sim.state.players.mining[0]).toBe(0);
  });

  it('ends on tiles without a resource', () => {
    const sim = new Sim({ seed: SEED });
    expect(sim.state.world.resourceAt(0, 0)).toBe(0);
    mineStart(sim, 0, 0);
    steps(sim, 1);
    expect(sim.state.players.mining[0]).toBe(0);
  });

  it('stops when the inventory is full', () => {
    const sim = simAtPatch();
    const inv = sim.state.players.inventory(0);
    const other = ([ItemId.IronOre, ItemId.Coal] as const).find((i) => i !== ITEM)!;
    // Fill every slot but one with another item, and leave room for one unit in the last.
    inv.add(other, (inv.slots - 1) * ITEMS[other].stackSize);
    inv.add(ITEM, ITEMS[ITEM].stackSize - 1);
    expect(inv.spaceFor(ITEM)).toBe(1);
    const before = sim.state.world.amountAt(PATCH.x, PATCH.y);
    mineStart(sim, PATCH.x, PATCH.y);
    steps(sim, HAND_MINING_TICKS);
    expect(inv.count(ITEM)).toBe(ITEMS[ITEM].stackSize);
    steps(sim, 1);
    expect(sim.state.players.mining[0]).toBe(0);
    steps(sim, 10 * HAND_MINING_TICKS);
    // Nothing was lost: the world only gave up what fit.
    expect(sim.state.world.amountAt(PATCH.x, PATCH.y)).toBe(before - 1);
  });

  it('mines every ore type into its item', () => {
    const sim = new Sim({ seed: SEED });
    const p = sim.state.players;
    for (const patch of startingPatches(SEED)) {
      p.x[0] = tileCenter(patch.x);
      p.y[0] = tileCenter(patch.y);
      mineStart(sim, patch.x, patch.y);
      steps(sim, HAND_MINING_TICKS);
      expect(p.inventory(0).count(MINED_ITEM[patch.ore])).toBe(1);
    }
  });
});

import { describe, expect, it } from 'vitest';
import { ENTITIES, EntityTypeId, type EntityPrototype } from '../../src/data/entities';
import { TileId } from '../../src/data/tiles';
import { BeltShape, beltTable } from '../../src/sim/belts/belts';
import { UndergroundMode } from '../../src/sim/belts/underground';
import type { Axis } from '../../src/sim/commands';
import { Direction } from '../../src/sim/entities/direction';
import { fixedToTile, tileCenter, tileToFixed } from '../../src/sim/fixed';
import { PLAYER_HALF_SIZE, PLAYER_SPEED, beltDrift } from '../../src/sim/player';
import { Sim } from '../../src/sim/tick';
import type { World } from '../../src/sim/world/world';
import { expectRoundTrip } from './saveRoundTrip';

const { North, East, South, West } = Direction;
const SEED = 1;
const TIERS = [
  {
    belt: ENTITIES[EntityTypeId.TransportBelt],
    underground: ENTITIES[EntityTypeId.UndergroundBelt],
    splitter: ENTITIES[EntityTypeId.Splitter],
  },
  {
    belt: ENTITIES[EntityTypeId.FastTransportBelt],
    underground: ENTITIES[EntityTypeId.FastUndergroundBelt],
    splitter: ENTITIES[EntityTypeId.FastSplitter],
  },
  {
    belt: ENTITIES[EntityTypeId.ExpressTransportBelt],
    underground: ENTITIES[EntityTypeId.ExpressUndergroundBelt],
    splitter: ENTITIES[EntityTypeId.ExpressSplitter],
  },
] as const;
const BELT = TIERS[0].belt;
const CHEST = ENTITIES[EntityTypeId.WoodenChest];
const INSERTER = ENTITIES[EntityTypeId.ElectricInserter];

/** An area of the spawn with walkable tiles all around (checked). */
const X0 = 10;
const Y0 = 10;

function newSim(): Sim {
  const sim = new Sim({ seed: SEED, startingKit: [] });
  for (let y = Y0 - 12; y <= Y0 + 12; y++) {
    for (let x = X0 - 12; x <= X0 + 12; x++) {
      if (!sim.state.world.isWalkable(x, y)) throw new Error(`(${x}, ${y}) isn't walkable`);
    }
  }
  return sim;
}

const add = (sim: Sim, proto: EntityPrototype, x: number, y: number, dir: Direction): number =>
  sim.state.entities.add(proto, x, y, dir);

/** Belts from `(x, y)` on, `n` of them, one after the other in direction `dir`. */
function beltRun(
  sim: Sim,
  proto: EntityPrototype,
  x: number,
  y: number,
  dir: Direction,
  n: number,
): void {
  const dx = [0, 1, 0, -1][dir]!;
  const dy = [-1, 0, 1, 0][dir]!;
  for (let k = 0; k < n; k++) add(sim, proto, x + k * dx, y + k * dy, dir);
}

function putPlayer(sim: Sim, x: number, y: number): void {
  sim.state.players.x[0] = x;
  sim.state.players.y[0] = y;
}

const pos = (sim: Sim): [number, number] => [sim.state.players.x[0]!, sim.state.players.y[0]!];

const move = (sim: Sim, dx: Axis, dy: Axis): void => {
  sim.enqueue({ tick: sim.tick, playerId: 0, type: 'Move', dx, dy });
};

const steps = (sim: Sim, n: number): void => {
  for (let i = 0; i < n; i++) sim.step();
};

describe('belts carry the player (D66)', () => {
  it('at the item speed of each tier (8 / 16 / 24 subtiles per tick), in every direction', () => {
    for (const tier of TIERS) {
      const speed = tier.belt.beltSpeed!;
      for (const dir of [North, East, South, West]) {
        const sim = newSim();
        const dx = [0, 1, 0, -1][dir]!;
        const dy = [-1, 0, 1, 0][dir]!;
        // Ten belts; the player starts in the middle of the first.
        beltRun(sim, tier.belt, X0, Y0, dir, 10);
        const x = tileCenter(X0);
        const y = tileCenter(Y0);
        putPlayer(sim, x, y);
        expect(beltDrift(sim.state.entities, x, y)).toBe((speed << 2) | dir);
        steps(sim, 20);
        expect(pos(sim)).toEqual([x + 20 * speed * dx, y + 20 * speed * dy]);
      }
    }
  });

  it('only from the tile under the player center, and not off anything but belts', () => {
    const sim = newSim();
    add(sim, BELT, X0, Y0, East);
    add(sim, CHEST, X0 + 1, Y0, North);
    const { entities } = sim.state;
    expect(beltDrift(entities, tileToFixed(X0), tileToFixed(Y0))).toBe((8 << 2) | East);
    expect(beltDrift(entities, tileToFixed(X0) + 255, tileToFixed(Y0) + 255)).toBe((8 << 2) | East);
    expect(beltDrift(entities, tileToFixed(X0) - 1, tileCenter(Y0))).toBe(-1);
    expect(beltDrift(entities, tileCenter(X0 + 1), tileCenter(Y0))).toBe(-1);
    // A player next to the belt, overlapping it, stays put.
    putPlayer(sim, tileToFixed(X0) - 1, tileCenter(Y0));
    steps(sim, 30);
    expect(pos(sim)).toEqual([tileToFixed(X0) - 1, tileCenter(Y0)]);
  });

  it('adds to walking: faster with the belt, slower against it, sideways across it', () => {
    for (const tier of TIERS) {
      const speed = tier.belt.beltSpeed!;
      const x = tileCenter(X0);
      const y = tileCenter(Y0);

      const withBelt = newSim();
      beltRun(withBelt, tier.belt, X0, Y0, East, 10);
      putPlayer(withBelt, x, y);
      move(withBelt, 1, 0);
      steps(withBelt, 10);
      expect(pos(withBelt)).toEqual([x + 10 * (PLAYER_SPEED + speed), y]);

      // Against the belt, starting at its far end (East belts from X0 - 9 to X0).
      const against = newSim();
      beltRun(against, tier.belt, X0 - 9, Y0, East, 10);
      putPlayer(against, x, y);
      move(against, -1, 0);
      steps(against, 10);
      expect(pos(against)).toEqual([x - 10 * (PLAYER_SPEED - speed), y]);

      // Across a north-going column: one step onto it, carried north from then on.
      const across = newSim();
      beltRun(across, tier.belt, X0 + 1, Y0, North, 10);
      putPlayer(across, tileToFixed(X0 + 1) - PLAYER_SPEED + 1, y);
      move(across, 1, 0);
      steps(across, 3);
      expect(pos(across)).toEqual([tileToFixed(X0 + 1) + 2 * PLAYER_SPEED + 1, y - 3 * speed]);
    }
  });

  it('round a corner, staying on the belt', () => {
    const sim = newSim();
    // East along row Y0 from X0 to X0 + 3, where it turns north up to row Y0 - 6.
    beltRun(sim, BELT, X0, Y0, East, 3);
    beltRun(sim, BELT, X0 + 3, Y0, North, 7);
    const belts = beltTable(sim.state.entities)!;
    const corner = sim.state.entities.at(X0 + 3, Y0);
    expect(belts.shape(corner)).toBe(BeltShape.CurveFromLeft);
    putPlayer(sim, tileCenter(X0), tileCenter(Y0));
    // 2.5 tiles at 8 subtiles per tick take 80 ticks; the first tick on the
    // curve already carries the player north, and pulls it toward the
    // column's center line at 4 subtiles per tick.
    steps(sim, 80);
    expect(pos(sim)).toEqual([tileToFixed(X0 + 3), tileCenter(Y0)]);
    steps(sim, 1);
    expect(pos(sim)).toEqual([tileToFixed(X0 + 3) + 4, tileCenter(Y0) - 8]);
    // Centered after 32 ticks on the column (128 subtiles), never past it.
    steps(sim, 31);
    expect(pos(sim)).toEqual([tileCenter(X0 + 3), tileCenter(Y0) - 8 * 32]);
    // Carried north along the column, to just past the last belt's end.
    steps(sim, 400);
    const [px, py] = pos(sim);
    expect(px).toBe(tileCenter(X0 + 3));
    expect(fixedToTile(py)).toBe(Y0 - 7);
    expect(py).toBeGreaterThan(tileToFixed(Y0 - 6) - 1 - 8);
  });

  it('off the end of a belt onto free ground, where it stops', () => {
    const sim = newSim();
    beltRun(sim, BELT, X0, Y0, East, 2);
    putPlayer(sim, tileCenter(X0), tileCenter(Y0));
    steps(sim, 300);
    // 384 subtiles to the end in 48 ticks: the center is just past the last belt.
    expect(pos(sim)).toEqual([tileToFixed(X0 + 2), tileCenter(Y0)]);
  });

  it('is stopped by an entity that is not a belt, flush against it', () => {
    const sim = newSim();
    beltRun(sim, BELT, X0, Y0, East, 3);
    add(sim, CHEST, X0 + 3, Y0, North);
    putPlayer(sim, tileCenter(X0), tileCenter(Y0));
    steps(sim, 300);
    expect(pos(sim)).toEqual([tileToFixed(X0 + 3) - PLAYER_HALF_SIZE, tileCenter(Y0)]);
    // The player still walks through it on its own.
    move(sim, 1, 0);
    steps(sim, 10);
    expect(sim.state.players.x[0]).toBeGreaterThan(tileToFixed(X0 + 3));
  });

  it('is not stopped by an entity beside the belt, and pulls the player to its center line', () => {
    const sim = newSim();
    beltRun(sim, BELT, X0, Y0, East, 5);
    add(sim, CHEST, X0 + 1, Y0 + 1, North);
    // Near the bottom edge of the belt: the box reaches into row Y0 + 1,
    // where the chest is just ahead.
    const y = tileToFixed(Y0 + 1) - 10;
    putPlayer(sim, tileCenter(X0), y);
    steps(sim, 1);
    expect(pos(sim)).toEqual([tileCenter(X0) + 8, y - 4]);
    // 118 subtiles to the center line at 4 a tick: centered after 30 ticks.
    steps(sim, 29);
    expect(pos(sim)).toEqual([tileCenter(X0) + 8 * 30, tileCenter(Y0)]);
    steps(sim, 300);
    expect(pos(sim)).toEqual([tileToFixed(X0 + 5), tileCenter(Y0)]);
  });

  it('rides past an inserter on the inside of a corner (both curve directions, both ways)', () => {
    // East (from the west) or west (from the east) along row Y0 into a
    // corner at column CX, then north or south for five tiles. An inserter
    // stands on the inside of the corner, diagonally before the curve: the
    // box comes round the corner half over its column.
    const CX = X0 + 3;
    for (const from of [East, West]) {
      for (const to of [North, South]) {
        const sim = newSim();
        const sx = from === East ? -1 : 1;
        const sy = to === North ? -1 : 1;
        beltRun(sim, BELT, CX + 3 * sx, Y0, from, 3);
        beltRun(sim, BELT, CX, Y0, to, 5);
        const belts = beltTable(sim.state.entities)!;
        expect(belts.shape(sim.state.entities.at(CX, Y0))).not.toBe(BeltShape.Straight);
        add(sim, INSERTER, CX + sx, Y0 + sy, to);
        putPlayer(sim, tileCenter(CX + 3 * sx), tileCenter(Y0));
        steps(sim, 600);
        // Centered on the column, just past the last belt's end.
        const [px, py] = pos(sim);
        expect(px).toBe(tileCenter(CX));
        expect(fixedToTile(py)).toBe(Y0 + 5 * sy);
        if (to === North) expect(py).toBeGreaterThan(tileToFixed(Y0 - 4) - 1 - 8);
        else expect(py).toBeLessThan(tileToFixed(Y0 + 5) + 8);
      }
    }
  });

  it("the reviewer's repro: east (10..12, 10), north (13, 10..6), an inserter at (12, 9)", () => {
    const sim = newSim();
    beltRun(sim, BELT, 10, 10, East, 3);
    beltRun(sim, BELT, 13, 10, North, 5);
    add(sim, INSERTER, 12, 9, North);
    putPlayer(sim, tileCenter(10), tileCenter(10));
    steps(sim, 600);
    const [px, py] = pos(sim);
    expect(px).toBe(tileCenter(13));
    expect(fixedToTile(py)).toBe(5);
  });

  it('carries a player who stepped on from a side lined with inserters', () => {
    for (const side of [North, South]) {
      const sim = newSim();
      const sy = side === North ? -1 : 1;
      beltRun(sim, BELT, X0, Y0, East, 6);
      for (let x = X0 - 1; x <= X0 + 6; x++) add(sim, INSERTER, x, Y0 + sy, side);
      // In the middle of the inserter row; walk onto the belt and stop at once.
      putPlayer(sim, tileCenter(X0), tileCenter(Y0 + sy));
      move(sim, 0, sy === -1 ? 1 : -1);
      steps(sim, 4);
      move(sim, 0, 0);
      const [x1, y1] = pos(sim);
      expect(fixedToTile(y1)).toBe(Y0);
      // The box still reaches into the inserter row.
      expect(fixedToTile(sy === -1 ? y1 - PLAYER_HALF_SIZE : y1 + PLAYER_HALF_SIZE - 1)).toBe(
        Y0 + sy,
      );
      expect(x1).toBeGreaterThan(tileCenter(X0));
      steps(sim, 300);
      expect(pos(sim)).toEqual([tileToFixed(X0 + 6), tileCenter(Y0)]);
    }
  });

  it('still stops the push at an entity ahead after a corner', () => {
    const sim = newSim();
    beltRun(sim, BELT, X0, Y0, East, 3);
    beltRun(sim, BELT, X0 + 3, Y0, North, 3);
    add(sim, CHEST, X0 + 3, Y0 - 3, North);
    putPlayer(sim, tileCenter(X0), tileCenter(Y0));
    steps(sim, 600);
    expect(pos(sim)).toEqual([tileCenter(X0 + 3), tileToFixed(Y0 - 2) + PLAYER_HALF_SIZE]);
  });

  it('is stopped by water, flush against it', () => {
    const sim = new Sim({ seed: SEED, startingKit: [] });
    const { wx, wy } = findShore(sim.state.world);
    beltRun(sim, BELT, wx - 3, wy, East, 3);
    putPlayer(sim, tileCenter(wx - 3), tileCenter(wy));
    steps(sim, 300);
    expect(pos(sim)).toEqual([tileToFixed(wx) - PLAYER_HALF_SIZE, tileCenter(wy)]);
  });

  it('on underground belt ends and splitters, at their tier speed', () => {
    for (const tier of TIERS) {
      const speed = tier.belt.beltSpeed!;
      const sim = newSim();
      // Entrance at X0, exit at X0 + 3, a splitter (rows Y0 - 1 and Y0) at X0 + 4.
      add(sim, tier.underground, X0, Y0, East);
      add(sim, tier.underground, X0 + 3, Y0, East);
      add(sim, tier.splitter, X0 + 4, Y0 - 1, East);
      const belts = beltTable(sim.state.entities)!;
      expect(belts.mode(sim.state.entities.at(X0, Y0))).toBe(UndergroundMode.Entrance);
      expect(belts.mode(sim.state.entities.at(X0 + 3, Y0))).toBe(UndergroundMode.Exit);

      putPlayer(sim, tileCenter(X0), tileCenter(Y0));
      steps(sim, 4);
      expect(pos(sim)).toEqual([tileCenter(X0) + 4 * speed, tileCenter(Y0)]);
      // Off the entrance onto the ground above the tunnel, where it stops.
      steps(sim, 256);
      expect(pos(sim)[0]).toBeLessThan(tileToFixed(X0 + 1) + speed);

      putPlayer(sim, tileCenter(X0 + 3), tileCenter(Y0));
      steps(sim, 4);
      expect(pos(sim)).toEqual([tileCenter(X0 + 3) + 4 * speed, tileCenter(Y0)]);
      // Through the splitter and off its front.
      steps(sim, 256);
      const [px, py] = pos(sim);
      expect(fixedToTile(px)).toBe(X0 + 5);
      expect(px).toBeLessThan(tileToFixed(X0 + 5) + speed);
      expect(py).toBe(tileCenter(Y0));
    }
  });

  it('is deterministic, and survives a save round trip mid-ride', () => {
    const run = (): Sim => {
      const sim = newSim();
      beltRun(sim, TIERS[1].belt, X0, Y0, East, 6);
      beltRun(sim, TIERS[1].belt, X0 + 6, Y0, South, 6);
      putPlayer(sim, tileCenter(X0), tileCenter(Y0) + 37);
      for (let t = 0; t < 60; t++) {
        if (t === 10) move(sim, 1, 0);
        if (t === 20) move(sim, -1, 0);
        if (t === 30) move(sim, 0, 0);
        sim.step();
      }
      return sim;
    };
    const a = run();
    const b = run();
    expect(a.hash()).toBe(b.hash());
    expect(pos(a)).toEqual(pos(b));
    // 160 + 540 - 220 + 480 subtiles east, pulled onto the belts' center
    // line within 5 ticks: still on the belts, mid-ride. The copy rides on,
    // round the corner (and onto the column's center line), exactly like the
    // original.
    expect(pos(a)).toEqual([tileCenter(X0) + 960, tileCenter(Y0)]);
    expect(beltDrift(a.state.entities, ...pos(a))).toBeGreaterThanOrEqual(0);
    expectRoundTrip(a, 120);
  });
});

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

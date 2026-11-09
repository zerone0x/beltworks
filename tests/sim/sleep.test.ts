/**
 * Machine sleep (#73): idle entities cost nothing per tick. A factory where
 * everything waits (a depleted drill, inserters with nothing to move,
 * machines without input, recipe or research, a backed-up belt) steps none
 * of them, tick after tick; the power system only asks its producers. And
 * the incremental power solve (D62) matches asking every entity every tick.
 */
import { describe, expect, it } from 'vitest';
import { ENTITIES, EntityTypeId, type RealEntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { ResourceId } from '../../src/data/resources';
import { ACTIVITY_SYSTEMS, systemActivity } from '../../src/sim/activity';
import { beltTable } from '../../src/sim/belts/belts';
import { BeltLane } from '../../src/sim/belts/line';
import { Direction } from '../../src/sim/entities/direction';
import { InserterState } from '../../src/sim/entities/inserter';
import { MachineState } from '../../src/sim/entities/machine';
import { powerGrid } from '../../src/sim/power/grid';
import {
  buildDeterminismScript,
  createDeterminismSim,
  DETERMINISM_TICKS,
} from '../../src/sim/scenarios/determinism';
import { Sim } from '../../src/sim/tick';
import { CHUNK_MASK, CHUNK_SHIFT, tileIndex } from '../../src/sim/world/chunk';

const { North, East, South } = Direction;

/** Everything idle, on a real boiler and steam engine (built with `entities.add`, no build rules). */
function idleFactory() {
  const sim = new Sim({ seed: 1, startingKit: [] });
  const { entities, world } = sim.state;
  for (let y = -4; y <= 24; y++) {
    for (let x = -4; x <= 32; x++) {
      const chunk = world.getChunk(x >> CHUNK_SHIFT, y >> CHUNK_SHIFT);
      const i = tileIndex(x & CHUNK_MASK, y & CHUNK_MASK);
      chunk.resource[i] = ResourceId.None;
      chunk.amount[i] = 0;
    }
  }
  const add = (type: RealEntityTypeId, x: number, y: number, dir: Direction = North) =>
    entities.add(ENTITIES[type], x, y, dir);
  const boiler = add(EntityTypeId.Boiler, 0, 20);
  const engine = add(EntityTypeId.SteamEngine, -2, 15);
  for (const y of [14, 11, 5, -1]) add(EntityTypeId.SmallElectricPole, 2, y);
  for (const x of [7, 12]) add(EntityTypeId.SmallElectricPole, x, -1);
  expect(entities.insert(boiler, ItemId.Coal, 5)).toBe(5);
  // Electric consumers: a drill on bare ground, an inserter between empty
  // chests, an assembling machine without a recipe, a lab without research.
  const drill = add(EntityTypeId.ElectricMiningDrill, 0, 0, South);
  const source = add(EntityTypeId.WoodenChest, 5, 0);
  const inserter = add(EntityTypeId.ElectricInserter, 6, 0, East);
  add(EntityTypeId.WoodenChest, 7, 0);
  const assembler = add(EntityTypeId.AssemblingMachine1, 9, 0);
  const lab = add(EntityTypeId.Lab, 13, 0);
  // Burner ones: a furnace without input, an inserter without fuel, a drill on bare ground.
  const furnace = add(EntityTypeId.StoneFurnace, 20, 0);
  add(EntityTypeId.WoodenChest, 22, 3);
  const burnerInserter = add(EntityTypeId.BurnerInserter, 23, 3, East);
  add(EntityTypeId.WoodenChest, 24, 3);
  const burnerDrill = add(EntityTypeId.BurnerMiningDrill, 26, 0);
  // A belt whose items have backed up at its end.
  const belts = [20, 21, 22, 23].map((x) => add(EntityTypeId.TransportBelt, x, 6, East));
  for (const belt of belts) entities.insert(belt, ItemId.IronPlate, 2);
  return {
    sim,
    entities,
    grid: powerGrid(entities)!,
    belts: beltTable(entities)!,
    engine,
    drill,
    source,
    inserter,
    assembler,
    lab,
    furnace,
    burnerInserter,
    burnerDrill,
  };
}

describe('idle entities', () => {
  it('are not stepped, and the power system only asks its producers', () => {
    const f = idleFactory();
    for (let t = 0; t < 200; t++) f.sim.step();
    const { entities } = f;
    expect(entities.status(f.drill)).toBe(MachineState.Depleted);
    expect(entities.status(f.inserter)).toBe(InserterState.WaitingForSource);
    expect(entities.status(f.assembler)).toBe(MachineState.NoRecipe);
    expect(entities.status(f.lab)).toBe(MachineState.NoResearch);
    expect(entities.status(f.furnace)).toBe(MachineState.NoInput);
    expect(entities.status(f.burnerInserter)).toBe(InserterState.NoFuel);
    expect(entities.status(f.burnerDrill)).toBe(MachineState.Depleted);
    const net = f.grid.networkOf(f.engine);
    expect(net).not.toBe(0);
    for (const id of [f.drill, f.inserter, f.assembler, f.lab]) {
      expect(f.grid.networkOf(id)).toBe(net);
    }
    for (let t = 0; t < 600; t++) {
      f.sim.step();
      const a = systemActivity(entities);
      for (const system of ACTIVITY_SYSTEMS) {
        if (system === 'power') continue;
        expect(a[system].stepped, `${system} stepped on tick ${String(t)}`).toBe(0);
        expect(a[system].awake, `${system} awake on tick ${String(t)}`).toBe(0);
      }
      // The engine only: every consumer's demand stands while it sleeps.
      expect(a.power).toEqual({ entities: 5, awake: 1, stepped: 1 });
    }
    // Asleep, the inserter still draws its idle drain; nothing else draws anything.
    expect(f.grid.network(net)).toMatchObject({ demand: 7, load: 7 });
    // The belt is one line with its items on it, both lanes asleep.
    expect(systemActivity(entities).belts.entities).toBe(2);
    const [line] = Array.from(f.belts.lines());
    expect(line).toBeDefined();
    expect(line!.lanes[BeltLane.Left].count + line!.lanes[BeltLane.Right].count).toBe(8);
  });

  it('wake when what they wait on changes, and fall asleep again', () => {
    const f = idleFactory();
    for (let t = 0; t < 200; t++) f.sim.step();
    expect(f.entities.insert(f.source, ItemId.IronPlate, 1)).toBe(1);
    f.sim.step();
    let a = systemActivity(f.entities);
    expect(a.inserters.stepped).toBe(1);
    // Woken after the power step: asked from the next tick on, for its working energy.
    f.sim.step();
    a = systemActivity(f.entities);
    expect(a.power.stepped).toBe(2);
    expect(f.grid.member(f.inserter)!.demand).toBe(220);
    // One swing there and back, then it waits again and costs nothing.
    for (let t = 0; t < 120; t++) f.sim.step();
    expect(f.entities.status(f.inserter)).toBe(InserterState.WaitingForSource);
    f.sim.step();
    a = systemActivity(f.entities);
    expect(a.inserters.stepped).toBe(0);
    expect(a.power.stepped).toBe(1);
    expect(f.grid.member(f.inserter)!.demand).toBe(7);
  });
});

describe('the incremental power solve', () => {
  it('matches asking every electric entity every tick, through the determinism scenario', () => {
    const run = (full: boolean): number[] => {
      const sim = createDeterminismSim();
      for (const cmd of buildDeterminismScript()) sim.enqueue(cmd);
      const hashes: number[] = [];
      for (let t = 0; t < DETERMINISM_TICKS; t++) {
        if (full) powerGrid(sim.state.entities)?.pollAllNextTick();
        sim.step();
        if (t % 5 === 0) hashes.push(sim.hash());
      }
      hashes.push(sim.hash());
      return hashes;
    };
    const full = run(true);
    const incremental = run(false);
    const first = incremental.findIndex((h, i) => h !== full[i]);
    expect(first, 'first sample whose hash differs').toBe(-1);
  }, 120_000);
});

import { describe, expect, it } from 'vitest';
import { ENTITIES, EntityTypeId, SAT_ONE } from '../../src/data/entities';
import { ItemId, fuelValue, type ItemStack } from '../../src/data/items';
import { BuildResult, placeEntity, removeEntity, rotateEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { Entities } from '../../src/sim/entities/entities';
import { MachineState } from '../../src/sim/entities/machine';
import type { EntityTypeTable } from '../../src/sim/entities/table';
import { tileCenter } from '../../src/sim/fixed';
import {
  BOILER_MAX_OUTPUT,
  BoilerSlot,
  BoilerTable,
  boilerTable,
} from '../../src/sim/power/boiler';
import { PowerGrid, powerGrid } from '../../src/sim/power/grid';
import { satisfactionFor } from '../../src/sim/power/solver';
import {
  STEAM_ENGINE_MAX_OUTPUT,
  SteamEngineTable,
  boilerOutputRect,
  engineEndRects,
  steamEngineTable,
} from '../../src/sim/power/steamEngine';
import {
  decodeEntityDetail,
  decodePower,
  encodeEntityDetail,
  encodePower,
} from '../../src/sim/snapshot';
import { Sim } from '../../src/sim/tick';

const { North, East, South, West } = Direction;
const POLE = ENTITIES[EntityTypeId.SmallElectricPole];
const BOILER = ENTITIES[EntityTypeId.Boiler];
const ENGINE = ENTITIES[EntityTypeId.SteamEngine];
const COAL = ItemId.Coal;
const COAL_J = 4_000_000;

/** A fake electric consumer on the wooden chest's 1×1 footprint: demands what the test sets. */
class FakeConsumers implements EntityTypeTable {
  readonly type = EntityTypeId.WoodenChest;
  readonly demand = new Map<number, number>();
  add(): void {}
  remove(): void {}
  contents(): readonly ItemStack[] {
    return [];
  }
  hashInto(h: number): number {
    return h;
  }
  powerDemand(id: number): number {
    return this.demand.get(id) ?? 0;
  }
}

/**
 * A boiler facing north on (0..1, 0..2); in front of it, two engines facing
 * north side by side (A on (-2..0, -5..-1), B on (1..3, -5..-1)), and C
 * lined up behind A on (-2..0, -10..-6). A pole on (1, -6) covers all three
 * and a consumer on (2, -7).
 */
function plant() {
  const grid = new PowerGrid();
  const boilers = new BoilerTable();
  const engines = new SteamEngineTable();
  const consumers = new FakeConsumers();
  const entities = new Entities([grid, boilers, engines, consumers]);
  const boiler = (x = 0, y = 0, dir: Direction = North) => entities.add(BOILER, x, y, dir);
  const engine = (x: number, y: number, dir: Direction = North) => entities.add(ENGINE, x, y, dir);
  const consumer = (demand: number) => {
    const id = entities.add(ENTITIES[EntityTypeId.WoodenChest], 2, -7, North);
    consumers.demand.set(id, demand);
    return id;
  };
  const pole = () => entities.add(POLE, 1, -6, North);
  const tick = () => {
    grid.update(entities);
  };
  const fuel = (id: number, count: number, item: number = COAL) => entities.insert(id, item, count);
  return {
    grid,
    boilers,
    engines,
    consumers,
    entities,
    boiler,
    engine,
    consumer,
    pole,
    tick,
    fuel,
  };
}

describe('steam connections', () => {
  it("are the row in front of a boiler's output side and the rows off an engine's ends", () => {
    const f = { x: 0, y: 0, w: 2, h: 3 };
    expect(boilerOutputRect(f, North)).toEqual({ x0: 0, y0: -1, x1: 1, y1: -1 });
    expect(boilerOutputRect(f, South)).toEqual({ x0: 0, y0: 3, x1: 1, y1: 3 });
    const g = { x: 0, y: 0, w: 3, h: 2 };
    expect(boilerOutputRect(g, East)).toEqual({ x0: 3, y0: 0, x1: 3, y1: 1 });
    expect(boilerOutputRect(g, West)).toEqual({ x0: -1, y0: 0, x1: -1, y1: 1 });
    expect(engineEndRects({ x: 0, y: 0, w: 3, h: 5 }, South)).toEqual([
      { x0: 0, y0: -1, x1: 2, y1: -1 },
      { x0: 0, y0: 5, x1: 2, y1: 5 },
    ]);
    expect(engineEndRects({ x: 0, y: 0, w: 5, h: 3 }, East)).toEqual([
      { x0: -1, y0: 0, x1: -1, y1: 2 },
      { x0: 5, y0: 0, x1: 5, y1: 2 },
    ]);
  });

  it('feed two engines side by side in front of a boiler and the one lined up behind them', () => {
    const { engines, boiler, engine } = plant();
    const b = boiler();
    const a = engine(-2, -5);
    const c = engine(-2, -10);
    const bb = engine(1, -5);
    expect(engines.enginesOf(b)).toEqual([a, bb, c]);
    expect([a, bb, c].map((e) => engines.boilerOf(e))).toEqual([b, b, b]);
  });

  it('ignore engines beside a boiler or across an engine, and engines facing the wrong way', () => {
    const { engines, boiler, engine } = plant();
    const b = boiler();
    // East of the boiler, touching its side: not its output side.
    const side = engine(2, 0);
    // In front, but lying across (facing east): its end doesn't face the boiler.
    const across = engine(-4, -3, East);
    expect(engines.enginesOf(b)).toEqual([]);
    expect(engines.boilerOf(side)).toBe(0);
    expect(engines.boilerOf(across)).toBe(0);
  });

  it('follow rotations and removals, and give a contested engine to the lowest boiler id', () => {
    const { entities, engines, boiler, engine } = plant();
    const b = boiler();
    const a = engine(-2, -5);
    const c = engine(-2, -10);
    // A second boiler facing south whose output row is the top end of C.
    const b2 = boiler(-1, -13, South);
    expect(engines.enginesOf(b)).toEqual([a, c]);
    expect(engines.enginesOf(b2)).toEqual([]);
    entities.remove(a);
    expect(engines.enginesOf(b)).toEqual([]);
    expect(engines.enginesOf(b2)).toEqual([c]);
    entities.remove(b2);
    expect(engines.boilerOf(c)).toBe(0);
    // Turning the boiler away from the engines cuts them off.
    const a2 = engine(-2, -5);
    expect(engines.enginesOf(b)).toEqual([a2, c]);
    entities.setDirection(b, South);
    expect(engines.enginesOf(b)).toEqual([]);
  });
});

describe('boiler and steam engines', () => {
  it('supply exactly 30 000 J/tick from 1 boiler and 2 engines', () => {
    const { grid, boilers, engines, boiler, engine, consumer, pole, tick, fuel } = plant();
    const b = boiler();
    const a = engine(-2, -5);
    const bb = engine(1, -5);
    pole();
    const load = consumer(40_000);
    fuel(b, 5);
    tick();
    const net = grid.network(grid.networkOf(load))!;
    expect(net.supply).toBe(30_000);
    expect(net.load).toBe(30_000);
    expect(net.satisfaction).toBe(satisfactionFor(40_000, 30_000));
    expect([engines.output(a), engines.output(bb)]).toEqual([15_000, 15_000]);
    expect(boilers.output(b)).toBe(BOILER_MAX_OUTPUT);
    expect(boilers.status(b)).toBe(MachineState.Working);
    expect(engines.status(a)).toBe(MachineState.Working);
  });

  it('still supply exactly 30 000 J/tick with 3 engines: the third gets nothing', () => {
    const { grid, boilers, engines, boiler, engine, consumer, pole, tick, fuel } = plant();
    const b = boiler();
    const a = engine(-2, -5);
    const bb = engine(1, -5);
    const c = engine(-2, -10);
    pole();
    const load = consumer(45_000);
    fuel(b, 5);
    for (let i = 0; i < 3; i++) {
      tick();
      const net = grid.network(grid.networkOf(load))!;
      expect(net.supply).toBe(30_000);
      expect(net.load).toBe(30_000);
      expect([a, bb, c].map((e) => grid.member(e)!.maxOutput)).toEqual([15_000, 15_000, 0]);
      expect([a, bb, c].map((e) => engines.output(e))).toEqual([15_000, 15_000, 0]);
      expect(boilers.output(b)).toBe(30_000);
    }
    expect(engines.status(c)).toBe(MachineState.NoDemand);
  });

  it('share a partial load among the engines and burn exactly what they deliver', () => {
    const { boilers, engines, boiler, engine, consumer, pole, tick, fuel } = plant();
    const b = boiler();
    const a = engine(-2, -5);
    const bb = engine(1, -5);
    const c = engine(-2, -10);
    pole();
    consumer(20_001);
    fuel(b, 1);
    tick();
    const drawn = [a, bb, c].map((e) => engines.output(e));
    expect(drawn.reduce((s, v) => s + v, 0)).toBe(20_001);
    expect(drawn[2]).toBe(0);
    expect(boilers.output(b)).toBe(20_001);
    expect(boilers.detail(b).energy).toBe(COAL_J - 20_001);
  });

  it('burn coal (4 MJ) for exactly 4 000 000 / draw ticks', () => {
    const { boilers, entities, boiler, engine, consumer, pole, tick, fuel } = plant();
    const b = boiler();
    engine(-2, -5);
    engine(1, -5);
    pole();
    consumer(25_000);
    fuel(b, 1);
    expect(fuelValue(COAL)).toBe(COAL_J);
    const ticks = COAL_J / 25_000; // 160
    for (let i = 0; i < ticks; i++) {
      tick();
      expect(boilers.output(b)).toBe(25_000);
    }
    expect(boilers.detail(b).energy).toBe(0);
    expect(entities.slots(b)).toEqual([{ item: 0, count: 0 }]);
    tick();
    expect(boilers.output(b)).toBe(0);
    expect(boilers.status(b)).toBe(MachineState.NoFuel);
  });

  it('use the last joules of a draw that does not divide a fuel unit, and no more', () => {
    const { grid, boilers, boiler, engine, consumer, pole, tick, fuel } = plant();
    const b = boiler();
    engine(-2, -5);
    engine(1, -5);
    pole();
    const load = consumer(30_000);
    fuel(b, 1);
    // 133 full ticks use 3 990 000 J; the last 10 000 J go on tick 134.
    for (let i = 0; i < 133; i++) tick();
    tick();
    expect(grid.network(grid.networkOf(load))!.supply).toBe(10_000);
    expect(boilers.output(b)).toBe(10_000);
    tick();
    expect(boilers.output(b)).toBe(0);
  });

  it('burn no fuel when nothing is drawn', () => {
    const { boilers, engines, entities, boiler, engine, consumer, pole, tick, fuel } = plant();
    const b = boiler();
    const a = engine(-2, -5);
    pole();
    consumer(0);
    fuel(b, 2);
    for (let i = 0; i < 100; i++) tick();
    expect(boilers.output(b)).toBe(0);
    expect(boilers.detail(b).energy).toBe(0);
    expect(entities.slots(b)).toEqual([{ item: COAL, count: 2 }]);
    expect(boilers.status(b)).toBe(MachineState.NoDemand);
    expect(engines.status(a)).toBe(MachineState.NoDemand);
  });

  it('produce nothing from engines without a boiler, or with an empty one', () => {
    const { grid, engines, boilers, boiler, engine, consumer, pole, tick, fuel } = plant();
    const a = engine(-2, -5);
    pole();
    const load = consumer(10_000);
    tick();
    expect(grid.network(grid.networkOf(load))!.supply).toBe(0);
    expect(engines.output(a)).toBe(0);
    expect(engines.status(a)).toBe(MachineState.NoInput);
    const b = boiler();
    tick();
    expect(grid.network(grid.networkOf(load))!.supply).toBe(0);
    expect(boilers.status(b)).toBe(MachineState.NoFuel);
    expect(engines.status(a)).toBe(MachineState.NoInput);
    fuel(b, 1);
    tick();
    expect(engines.output(a)).toBe(10_000);
  });

  it('give unconnected engines nothing, so the boiler feeds the connected ones', () => {
    const { grid, boilers, engines, entities, boiler, engine, consumer, tick, fuel } = plant();
    const b = boiler();
    const a = engine(-2, -5);
    const bb = engine(1, -5);
    const c = engine(-2, -10);
    // A pole covering C (and the consumer) but not A or B: (1, -8) supplies (-1..3, -10..-6).
    entities.add(POLE, 1, -8, North);
    const load = consumer(45_000);
    fuel(b, 1);
    tick();
    expect([a, bb].map((e) => grid.networkOf(e))).toEqual([0, 0]);
    expect([a, bb, c].map((e) => engines.available(e))).toEqual([0, 0, 15_000]);
    expect(grid.network(grid.networkOf(load))!.load).toBe(15_000);
    expect(boilers.output(b)).toBe(15_000);
    expect(engines.status(a)).toBe(MachineState.NoDemand);
    expect(engines.status(c)).toBe(MachineState.Working);
  });

  it('take fuel through the item hooks, and only fuel', () => {
    const { entities, boiler } = plant();
    const b = boiler();
    expect(entities.accepts(b, COAL)).toBe(true);
    expect(entities.accepts(b, ItemId.Wood)).toBe(true);
    expect(entities.accepts(b, ItemId.IronOre)).toBe(false);
    expect(entities.insertable(b, COAL)).toBe(50);
    expect(entities.insert(b, ItemId.IronPlate, 5)).toBe(0);
    expect(entities.insert(b, COAL, 60)).toBe(50);
    expect(entities.insert(b, ItemId.Wood, 1)).toBe(0);
    expect(entities.outputSlot(b)).toBe(-1);
    expect(entities.take(b, BoilerSlot.Fuel, 20)).toBe(20);
    expect(entities.contents(b)).toEqual([{ item: COAL, count: 30 }]);
  });
});

describe('boiler and steam engines in the game', () => {
  const kit: ItemStack[] = [
    { item: ItemId.Boiler, count: 1 },
    { item: ItemId.SteamEngine, count: 3 },
    { item: ItemId.SmallElectricPole, count: 2 },
    { item: ItemId.BurnerInserter, count: 1 },
    { item: ItemId.WoodenChest, count: 1 },
    { item: COAL, count: 20 },
  ];
  const simAt = (tx: number, ty: number) => {
    const sim = new Sim({ seed: 1, startingKit: kit });
    sim.state.players.x[0] = tileCenter(tx);
    sim.state.players.y[0] = tileCenter(ty);
    return sim;
  };

  it('are placed, rotated and picked up like any entity, and get their tables', () => {
    const sim = simAt(0, 6);
    const { state } = sim;
    const inv = state.players.inventory(0);
    expect(placeEntity(state, 0, ItemId.Boiler, 0, 0, North)).toBe(BuildResult.Ok);
    expect(placeEntity(state, 0, ItemId.SteamEngine, -2, -5, North)).toBe(BuildResult.Ok);
    const b = state.entities.at(0, 0);
    const e = state.entities.at(-2, -5);
    const engines = steamEngineTable(state.entities)!;
    expect(boilerTable(state.entities)!.has(b)).toBe(true);
    expect(engines.boilerOf(e)).toBe(b);
    // The engine is a producer on the grid (not connected yet), the boiler isn't electric.
    expect(powerGrid(state.entities)!.member(e)).toMatchObject({ network: 0, maxOutput: 0 });
    expect(powerGrid(state.entities)!.member(b)).toBeUndefined();
    state.entities.insert(b, COAL, 3);
    inv.remove(COAL, 3);
    expect(rotateEntity(state, 0, 0, 0)).toBe(BuildResult.Ok);
    expect(engines.boilerOf(e)).toBe(0);
    expect(removeEntity(state, 0, 0, 0)).toBe(BuildResult.Ok);
    expect(inv.count(ItemId.Boiler)).toBe(1);
    expect(inv.count(COAL)).toBe(20);
  });

  it('get their boiler fuelled by an inserter', () => {
    const sim = simAt(0, 6);
    const { state } = sim;
    const place = (item: number, x: number, y: number, dir: Direction) => {
      expect(placeEntity(state, 0, item, x, y, dir)).toBe(BuildResult.Ok);
      return state.entities.at(x, y);
    };
    const b = place(ItemId.Boiler, 2, 0, North);
    // The inserter on (4, 1) facing west takes from the chest on (5, 1) and drops into the boiler.
    const chest = place(ItemId.WoodenChest, 5, 1, North);
    const ins = place(ItemId.BurnerInserter, 4, 1, West);
    state.entities.insert(chest, COAL, 5);
    state.entities.insert(ins, COAL, 1);
    for (let i = 0; i < 200; i++) sim.step();
    expect(state.entities.slots(b)[BoilerSlot.Fuel]!.count).toBeGreaterThan(0);
  });

  it('show their output, network and satisfaction in the GUI and the power snapshot', () => {
    const sim = simAt(5, -2);
    const { state } = sim;
    expect(placeEntity(state, 0, ItemId.Boiler, 0, 0, North)).toBe(BuildResult.Ok);
    expect(placeEntity(state, 0, ItemId.SteamEngine, -2, -5, North)).toBe(BuildResult.Ok);
    expect(placeEntity(state, 0, ItemId.SmallElectricPole, 1, -6, North)).toBe(BuildResult.Ok);
    const b = state.entities.at(0, 0);
    const e = state.entities.at(-2, -5);
    state.entities.insert(b, COAL, 1);
    sim.step();
    const grid = powerGrid(state.entities)!;
    const engine = decodeEntityDetail(encodeEntityDetail(state, 0, e)!.buffer);
    expect(engine).toMatchObject({
      status: MachineState.NoDemand,
      power: 0,
      network: grid.networkOf(e),
      satisfaction: SAT_ONE,
    });
    const boiler = decodeEntityDetail(encodeEntityDetail(state, 0, b)!.buffer);
    expect(boiler).toMatchObject({ status: MachineState.NoDemand, power: 0, network: 0 });
    expect(boiler.slots).toEqual([{ item: COAL, count: 1 }]);
    const range = { cx0: -1, cy0: -1, cx1: 0, cy1: 0 };
    const power = decodePower(encodePower(state, range).buffer);
    expect(power.members).toContainEqual({
      id: e,
      network: grid.networkOf(e),
      demand: 0,
      maxOutput: STEAM_ENGINE_MAX_OUTPUT,
      drawn: 0,
    });
  });

  it('hash the steam links and power state', () => {
    const run = (withFuel: boolean) => {
      const sim = simAt(0, 6);
      const { state } = sim;
      placeEntity(state, 0, ItemId.Boiler, 0, 0, North);
      placeEntity(state, 0, ItemId.SteamEngine, -2, -5, North);
      if (withFuel) state.entities.insert(state.entities.at(0, 0), COAL, 1);
      sim.step();
      return sim.hash();
    };
    expect(run(true)).toBe(run(true));
    expect(run(true)).not.toBe(run(false));
  });
});

describe('steam engine prototype numbers', () => {
  it('match the shared M2 design', () => {
    expect(BOILER_MAX_OUTPUT).toBe(30_000);
    expect(STEAM_ENGINE_MAX_OUTPUT).toBe(15_000);
    expect(2 * STEAM_ENGINE_MAX_OUTPUT).toBe(BOILER_MAX_OUTPUT);
    expect([BOILER.width, BOILER.height, ENGINE.width, ENGINE.height]).toEqual([2, 3, 3, 5]);
  });
});

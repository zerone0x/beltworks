import { describe, expect, it } from 'vitest';
import { ENTITIES, EntityTypeId, SAT_ONE, type RealEntityTypeId } from '../../src/data/entities';
import { ItemId, type ItemStack } from '../../src/data/items';
import { ResourceId } from '../../src/data/resources';
import { BuildResult, placeEntity, rotateEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { drillDropTileFor } from '../../src/sim/entities/drill';
import {
  ELECTRIC_DRILL_ENERGY_PER_TICK,
  ELECTRIC_DRILL_MINING_TICKS,
  ElectricDrillSlot,
  electricDrillTable,
} from '../../src/sim/entities/electricDrill';
import {
  ELECTRIC_INSERTER_CYCLE_TICKS,
  ELECTRIC_INSERTER_DRAIN_PER_TICK,
  ELECTRIC_INSERTER_ENERGY_PER_TICK,
  ELECTRIC_INSERTER_SWING_TICKS,
  ElectricInserterSlot,
  electricInserterTable,
} from '../../src/sim/entities/electricInserter';
import { InserterState } from '../../src/sim/entities/inserter';
import { MachineState } from '../../src/sim/entities/machine';
import { createEntityTables } from '../../src/sim/entities/registry';
import type { EntityTypeTable } from '../../src/sim/entities/table';
import { tileCenter } from '../../src/sim/fixed';
import { NOT_GRANTED, PowerBudget } from '../../src/sim/power/consumer';
import { boilerTable } from '../../src/sim/power/boiler';
import { powerGrid } from '../../src/sim/power/grid';
import { poweredEnergy } from '../../src/sim/power/solver';
import {
  decodeEntityDetail,
  decodeInserters,
  displayStatus,
  encodeEntityDetail,
  encodeInserters,
} from '../../src/sim/snapshot';
import { SYSTEMS, Sim } from '../../src/sim/tick';
import { CHUNK_MASK, CHUNK_SHIFT, tileIndex } from '../../src/sim/world/chunk';
import type { World } from '../../src/sim/world/world';

const { North, East, South, West } = Direction;
const PLATE = ItemId.IronPlate;

// Shared M2 design numbers (issue #33).
const DRILL_W = 1_500;
const DRILL_UNIT_TICKS = 120;
const INSERTER_W = 220;
const INSERTER_DRAIN = 7;
const INSERTER_CYCLE = 52;

/**
 * A fake power producer on the steam engine's 3×5 footprint, in place of the
 * real steam engine table: offers exactly what the test sets (to pin the
 * satisfaction down) and records what it is asked to deliver.
 */
class FakeProducers implements EntityTypeTable {
  // Test-only tables are never saved.
  save(): void {}
  load(): void {}
  readonly type = EntityTypeId.SteamEngine;
  readonly max = new Map<number, number>();
  /** Joules delivered per producer, summed over every tick. */
  readonly delivered = new Map<number, number>();
  add(): void {}
  remove(): void {}
  contents(): readonly ItemStack[] {
    return [];
  }
  hashInto(h: number): number {
    return h;
  }
  powerMaxOutput(id: number): number {
    return this.max.get(id) ?? 0;
  }
  powerDraw(id: number, joules: number): void {
    this.delivered.set(id, (this.delivered.get(id) ?? 0) + joules);
  }
}

/** Sets the resource on tile `(x, y)` (test setup only; bypasses the world's bookkeeping). */
function setOre(world: World, x: number, y: number, resource: number, amount: number): void {
  const chunk = world.getChunk(x >> CHUNK_SHIFT, y >> CHUNK_SHIFT);
  const i = tileIndex(x & CHUNK_MASK, y & CHUNK_MASK);
  chunk.resource[i] = amount > 0 ? resource : ResourceId.None;
  chunk.amount[i] = amount;
}

/**
 * A sim whose player 0 stands on tile (0, 0) with plenty of everything, a
 * fake producer table, and helpers. The area around the spawn is cleared of
 * resources.
 */
function setup() {
  const producers = new FakeProducers();
  const sim = new Sim({
    seed: 1,
    startingKit: [
      { item: ItemId.ElectricMiningDrill, count: 4 },
      { item: ItemId.ElectricInserter, count: 10 },
      { item: ItemId.SmallElectricPole, count: 10 },
      { item: ItemId.WoodenChest, count: 10 },
      { item: PLATE, count: 100 },
    ],
    // The real steam engine table makes way for the fake one.
    entityTables: [
      ...createEntityTables().filter((t) => t.type !== EntityTypeId.SteamEngine),
      producers,
    ],
  });
  const { state } = sim;
  state.players.x[0] = tileCenter(0);
  state.players.y[0] = tileCenter(0);
  for (let y = -8; y <= 8; y++) {
    for (let x = -8; x <= 10; x++) setOre(state.world, x, y, ResourceId.None, 0);
  }
  const { entities } = state;
  const grid = powerGrid(entities)!;
  const place = (item: number, x: number, y: number, dir: Direction = North) => {
    expect(placeEntity(state, 0, item, x, y, dir)).toBe(BuildResult.Ok);
    return entities.at(x, y);
  };
  /** A fake producer with its top-left tile at `(x, y)` offering `max` J/tick. */
  const addProducer = (x: number, y: number, max: number) => {
    const id = entities.add(ENTITIES[EntityTypeId.SteamEngine], x, y, North);
    producers.max.set(id, max);
    return id;
  };
  const count = (id: number, item: number) =>
    entities.contents(id).reduce((n, s) => n + (s.item === item ? s.count : 0), 0);
  return {
    sim,
    state,
    entities,
    grid,
    producers,
    place,
    addProducer,
    count,
    step: (n = 1) => {
      for (let i = 0; i < n; i++) sim.step();
    },
  };
}

/**
 * An electric drill on (2..4, 0..2) facing east, dropping into a chest on
 * (5, 1), with `ore` units of iron ore under its center tile. A pole on
 * (1, 4) supplies it; a fake producer on (-3..-1, 3..7) offering `supply`
 * J/tick (none for `null`) shares the pole's network.
 */
function drillRig(options: { supply?: number | null; ore?: number; chest?: boolean } = {}) {
  const s = setup();
  setOre(s.state.world, 3, 1, ResourceId.IronOre, options.ore ?? 100);
  const drill = s.place(ItemId.ElectricMiningDrill, 2, 0, East);
  const chest = options.chest === false ? 0 : s.place(ItemId.WoodenChest, 5, 1);
  const pole = s.place(ItemId.SmallElectricPole, 1, 4);
  const supply = options.supply === undefined ? DRILL_W : options.supply;
  const producer = supply === null ? 0 : s.addProducer(-3, 3, supply);
  const table = electricDrillTable(s.entities)!;
  return { ...s, drill, chest, pole, producer, table };
}

/**
 * Chest on (2, 0) → electric inserter on (3, 0) facing east → chest on
 * (4, 0), the source holding 50 plates. A pole on (3, 2) supplies the
 * inserter; a fake producer on (5..7, 1..5) offering `supply` J/tick (none
 * for `null`) shares its network.
 */
function inserterRig(options: { supply?: number | null } = {}) {
  const s = setup();
  const source = s.place(ItemId.WoodenChest, 2, 0);
  const inserter = s.place(ItemId.ElectricInserter, 3, 0, East);
  const target = s.place(ItemId.WoodenChest, 4, 0);
  s.entities.insert(source, PLATE, 50);
  const pole = s.place(ItemId.SmallElectricPole, 3, 2);
  const supply = options.supply === undefined ? INSERTER_W : options.supply;
  const producer = supply === null ? 0 : s.addProducer(5, 1, supply);
  const table = electricInserterTable(s.entities)!;
  return { ...s, source, inserter, target, pole, producer, table };
}

/** Ticks on which `value()` changed, over `ticks` steps of `step`. */
function changes(ticks: number, step: () => void, value: () => number): number[] {
  const out: number[] = [];
  let before = value();
  for (let t = 0; t < ticks; t++) {
    step();
    const now = value();
    if (now !== before) out.push(t);
    before = now;
  }
  return out;
}

describe('shared M2 numbers', () => {
  it('live in src/data', () => {
    const drill = ENTITIES[EntityTypeId.ElectricMiningDrill];
    expect([drill.width, drill.height, drill.rotatable, drill.miningArea]).toEqual([3, 3, true, 5]);
    expect(drill.energySource).toBe('electric');
    expect(ELECTRIC_DRILL_ENERGY_PER_TICK).toBe(DRILL_W);
    expect(ELECTRIC_DRILL_MINING_TICKS).toBe(DRILL_UNIT_TICKS);
    const inserter = ENTITIES[EntityTypeId.ElectricInserter];
    expect([inserter.width, inserter.height, inserter.rotatable]).toEqual([1, 1, true]);
    expect(ELECTRIC_INSERTER_ENERGY_PER_TICK).toBe(INSERTER_W);
    expect(ELECTRIC_INSERTER_DRAIN_PER_TICK).toBe(INSERTER_DRAIN);
    expect(ELECTRIC_INSERTER_SWING_TICKS).toBe(INSERTER_CYCLE / 2);
    expect(ELECTRIC_INSERTER_CYCLE_TICKS).toBe(INSERTER_CYCLE);
  });
});

describe('power budget', () => {
  it('grants a row for one step only, and gives its satisfaction only when granted', () => {
    const d = inserterRig({ supply: INSERTER_W / 2 });
    d.step();
    const budget = new PowerBudget();
    budget.grow(2);
    expect(budget.grant(1, 220)).toBe(220);
    expect(budget.take(1)).toBe(true);
    expect(budget.take(1)).toBe(false);
    expect(budget.take(0)).toBe(false);
    expect(budget.speed(d.inserter, true, d.entities)).toBe(SAT_ONE / 2);
    expect(budget.speed(d.inserter, false, d.entities)).toBe(NOT_GRANTED);
    // Not an electric entity: never powered.
    expect(budget.speed(d.source, true, d.entities)).toBe(0);
  });
});

describe('electric mining drill', () => {
  it('drops onto the tile in front of the middle of its front edge', () => {
    const proto = ENTITIES[EntityTypeId.ElectricMiningDrill];
    expect(drillDropTileFor(proto, 10, 20, North)).toEqual({ x: 11, y: 19 });
    expect(drillDropTileFor(proto, 10, 20, East)).toEqual({ x: 13, y: 21 });
    expect(drillDropTileFor(proto, 10, 20, South)).toEqual({ x: 11, y: 23 });
    expect(drillDropTileFor(proto, 10, 20, West)).toEqual({ x: 9, y: 21 });
  });

  it('has no fuel slot: takes nothing, and lists only its output', () => {
    const d = drillRig();
    expect(d.entities.slots(d.drill)).toEqual([{ item: 0, count: 0 }]);
    expect(d.entities.accepts(d.drill, ItemId.Coal)).toBe(false);
    expect(d.entities.insertable(d.drill, ItemId.Coal)).toBe(0);
    expect(d.entities.insert(d.drill, ItemId.Coal, 5)).toBe(0);
    expect(d.grid.member(d.drill)?.network).toBe(d.grid.networkOfPole(d.pole));
  });

  it('mines one unit every 120 ticks at full power, drawing 1 500 J per tick', () => {
    const d = drillRig();
    const drops = changes(5 * DRILL_UNIT_TICKS, d.step, () => d.count(d.chest, ItemId.IronOre));
    expect(drops).toEqual([119, 239, 359, 479, 599]);
    expect(d.entities.status(d.drill)).toBe(MachineState.Working);
    const net = d.grid.network(d.grid.networkOf(d.drill))!;
    expect(net).toMatchObject({ demand: DRILL_W, supply: DRILL_W, satisfaction: SAT_ONE });
    expect(net.load).toBe(DRILL_W);
    expect(d.grid.member(d.drill)!.demand).toBe(DRILL_W);
    expect(d.producers.delivered.get(d.producer)).toBe(5 * DRILL_UNIT_TICKS * DRILL_W);
    expect(displayStatus(d.state, d.drill)).toBe(MachineState.Working);
  });

  it('takes 240 ticks per unit at half power, and draws 750 J per tick', () => {
    const d = drillRig({ supply: DRILL_W / 2 });
    const drops = changes(3 * 240, d.step, () => d.count(d.chest, ItemId.IronOre));
    expect(drops).toEqual([239, 479, 719]);
    const net = d.grid.network(d.grid.networkOf(d.drill))!;
    expect(net).toMatchObject({ demand: DRILL_W, supply: DRILL_W / 2, satisfaction: SAT_ONE / 2 });
    expect(poweredEnergy(DRILL_W, net.satisfaction)).toBe(DRILL_W / 2);
    expect(d.producers.delivered.get(d.producer)).toBe(3 * 240 * (DRILL_W / 2));
    // Working, but slower: the renderer and GUI show low power.
    expect(d.entities.status(d.drill)).toBe(MachineState.Working);
    expect(displayStatus(d.state, d.drill)).toBe(MachineState.LowPower);
    expect(decodeEntityDetail(encodeEntityDetail(d.state, 0, d.drill)!.buffer).status).toBe(
      MachineState.LowPower,
    );
  });

  it('runs at any satisfaction: ceil(120 × 65536 / s) ticks per unit at s = 1/3', () => {
    const d = drillRig({ supply: DRILL_W / 3 });
    d.step();
    const s = d.grid.satisfaction(d.drill);
    expect(s).toBe(Math.floor((SAT_ONE * 500) / 1500));
    const per = Math.ceil((DRILL_UNIT_TICKS * SAT_ONE) / s);
    expect(per).toBe(361);
    const drops = changes(2 * per, d.step, () => d.count(d.chest, ItemId.IronOre));
    expect(drops).toEqual([per - 2, 2 * per - 2]);
  });

  it('stops in NoPower at satisfaction 0, stays on the active list, and resumes when power comes', () => {
    const d = drillRig({ supply: 0 });
    d.step(DRILL_UNIT_TICKS * 2);
    expect(d.count(d.chest, ItemId.IronOre)).toBe(0);
    expect(d.entities.status(d.drill)).toBe(MachineState.NoPower);
    expect(displayStatus(d.state, d.drill)).toBe(MachineState.NoPower);
    expect(d.table.activeCount).toBe(1);
    expect(d.table.rawProgress(d.drill)).toBe(0);
    // Its demand still counts: the network wants 1 500 J and gets nothing.
    expect(d.grid.network(d.grid.networkOf(d.drill))).toMatchObject({
      demand: DRILL_W,
      supply: 0,
      satisfaction: 0,
      load: 0,
    });
    d.producers.max.set(d.producer, DRILL_W);
    const drops = changes(DRILL_UNIT_TICKS, d.step, () => d.count(d.chest, ItemId.IronOre));
    expect(drops).toEqual([DRILL_UNIT_TICKS - 1]);
    expect(d.entities.status(d.drill)).toBe(MachineState.Working);
  });

  it('is NoPower when no pole covers it, and starts once one is placed', () => {
    const s = setup();
    setOre(s.state.world, 3, 1, ResourceId.IronOre, 10);
    const drill = s.place(ItemId.ElectricMiningDrill, 2, 0, East);
    const chest = s.place(ItemId.WoodenChest, 5, 1);
    s.step(10);
    expect(s.entities.status(drill)).toBe(MachineState.NoPower);
    expect(s.grid.networkOf(drill)).toBe(0);
    s.addProducer(-3, 3, DRILL_W);
    s.place(ItemId.SmallElectricPole, 1, 4);
    expect(changes(DRILL_UNIT_TICKS, s.step, () => s.count(chest, ItemId.IronOre))).toEqual([
      DRILL_UNIT_TICKS - 1,
    ]);
  });

  it('mines the 5×5 area centered on it, row-major from the tile after the last one', () => {
    const d = drillRig({ ore: 0 });
    const world = d.state.world;
    // Corners and the center of the area (1..5, -1..3), one unit each.
    setOre(world, 5, 3, ResourceId.Stone, 1);
    setOre(world, 1, -1, ResourceId.IronOre, 1);
    setOre(world, 3, 1, ResourceId.CopperOre, 1);
    setOre(world, 5, -1, ResourceId.Coal, 1);
    // Just outside: never mined.
    setOre(world, 0, 1, ResourceId.IronOre, 5);
    setOre(world, 6, 1, ResourceId.IronOre, 5);
    const mined: number[] = [];
    let before = d.entities.contents(d.chest).map((st) => st.item);
    for (let t = 0; t < 5 * DRILL_UNIT_TICKS; t++) {
      d.step();
      const now = d.entities.contents(d.chest).map((st) => st.item);
      for (const item of now) if (!before.includes(item)) mined.push(item);
      before = now;
    }
    expect(mined).toEqual([ItemId.IronOre, ItemId.Coal, ItemId.CopperOre, ItemId.Stone]);
    expect(d.entities.status(d.drill)).toBe(MachineState.Depleted);
    expect(world.amountAt(0, 1)).toBe(5);
    expect(world.amountAt(6, 1)).toBe(5);
    // Depleted drills sleep and ask for nothing.
    expect(d.table.activeCount).toBe(0);
    expect(d.grid.member(d.drill)!.demand).toBe(0);
  });

  it('holds a unit nothing takes, asking for no power while blocked, and wakes for a chest', () => {
    const d = drillRig({ chest: false });
    d.step(DRILL_UNIT_TICKS);
    expect(d.entities.status(d.drill)).toBe(MachineState.OutputFull);
    expect(d.entities.slots(d.drill)[ElectricDrillSlot.Output]).toEqual({
      item: ItemId.IronOre,
      count: 1,
    });
    d.step(5);
    expect(d.table.activeCount).toBe(0);
    expect(d.grid.network(d.grid.networkOf(d.drill))).toMatchObject({
      demand: 0,
      satisfaction: SAT_ONE,
      load: 0,
    });
    const chest = d.place(ItemId.WoodenChest, 5, 1);
    d.step();
    expect(d.count(chest, ItemId.IronOre)).toBe(1);
    expect(d.entities.status(d.drill)).toBe(MachineState.Working);
    // The unit dropped on the tick it woke, and the next one started at once.
    expect(changes(DRILL_UNIT_TICKS, d.step, () => d.count(chest, ItemId.IronOre))).toEqual([
      DRILL_UNIT_TICKS - 2,
    ]);
  });

  it('gives its held unit to the GUI, and drops onto its new drop tile after rotating', () => {
    const d = drillRig({ chest: false });
    d.step(DRILL_UNIT_TICKS);
    expect(d.entities.take(d.drill, ElectricDrillSlot.Output, 1)).toBe(1);
    expect(d.entities.slots(d.drill)).toEqual([{ item: 0, count: 0 }]);
    const south = d.place(ItemId.WoodenChest, 3, 3);
    expect(rotateEntity(d.state, 0, 2, 0)).toBe(BuildResult.Ok);
    expect(d.entities.store.dir(d.drill)).toBe(South);
    d.step(DRILL_UNIT_TICKS);
    expect(d.count(south, ItemId.IronOre)).toBe(1);
  });

  it('shows its state and progress in whole ticks in the GUI detail, without fuel', () => {
    const d = drillRig({ supply: DRILL_W / 2 });
    d.step(61);
    const detail = decodeEntityDetail(encodeEntityDetail(d.state, 0, d.drill)!.buffer);
    expect(detail).toMatchObject({
      type: EntityTypeId.ElectricMiningDrill,
      progress: 30,
      energy: 0,
      burning: 0,
      slots: [{ item: 0, count: 0 }],
    });
    expect(d.table.rawProgress(d.drill)).toBe(61 * (SAT_ONE / 2));
  });

  it('hashes its state', () => {
    const a = drillRig();
    const b = drillRig();
    a.step(10);
    b.step(10);
    expect(a.table.hashInto(0)).toBe(b.table.hashInto(0));
    b.step();
    expect(b.table.hashInto(0)).not.toBe(a.table.hashInto(0));
  });
});

describe('electric inserter', () => {
  it('has no fuel slot: takes nothing, and lists only its hand', () => {
    const d = inserterRig();
    expect(d.entities.slots(d.inserter)).toEqual([{ item: 0, count: 0 }]);
    expect(d.entities.accepts(d.inserter, ItemId.Coal)).toBe(false);
    expect(d.entities.insert(d.inserter, ItemId.Coal, 1)).toBe(0);
  });

  it('moves one item every 52 ticks at full power: picks up on tick 0, drops on tick 26', () => {
    const d = inserterRig();
    const pickups: number[] = [];
    const drops: number[] = [];
    let left = d.count(d.source, PLATE);
    let put = d.count(d.target, PLATE);
    for (let t = 0; t < 5 * INSERTER_CYCLE; t++) {
      d.step();
      if (d.count(d.source, PLATE) !== left) pickups.push(t);
      if (d.count(d.target, PLATE) !== put) drops.push(t);
      left = d.count(d.source, PLATE);
      put = d.count(d.target, PLATE);
    }
    expect(pickups).toEqual([0, 52, 104, 156, 208]);
    expect(drops).toEqual([26, 78, 130, 182, 234]);
    expect(d.entities.status(d.inserter)).toBe(InserterState.Swinging);
    expect(d.table.hand(d.inserter)).toEqual({ held: 0, arm: 0 });
    // 220 J on every tick, all delivered by the producer.
    expect(d.grid.member(d.inserter)!.demand).toBe(INSERTER_W);
    expect(d.producers.delivered.get(d.producer)).toBe(5 * INSERTER_CYCLE * INSERTER_W);
  });

  it('takes 104 ticks per item at half power, drawing 110 J per tick', () => {
    const d = inserterRig({ supply: INSERTER_W / 2 });
    const drops = changes(3 * 104, d.step, () => d.count(d.target, PLATE));
    expect(drops).toEqual([52, 156, 260]);
    expect(d.grid.satisfaction(d.inserter)).toBe(SAT_ONE / 2);
    expect(d.producers.delivered.get(d.producer)).toBe(3 * 104 * (INSERTER_W / 2));
    expect(displayStatus(d.state, d.inserter)).toBe(MachineState.LowPower);
    // Half way out: 13 ticks' worth of arm after 26 ticks.
    const e = inserterRig({ supply: INSERTER_W / 2 });
    e.step(26);
    expect(e.table.hand(e.inserter)).toEqual({ held: PLATE, arm: 13 * SAT_ONE });
    expect(e.entities.detail(e.inserter)!.progress).toBe(13);
  });

  it('does not move at satisfaction 0: NoPower at the source, holding nothing', () => {
    const d = inserterRig({ supply: 0 });
    d.step(100);
    expect(d.entities.status(d.inserter)).toBe(InserterState.NoPower);
    expect(d.table.hand(d.inserter)).toEqual({ held: 0, arm: 0 });
    expect(d.count(d.source, PLATE)).toBe(50);
    expect(d.table.activeCount).toBe(1);
    d.producers.max.set(d.producer, INSERTER_W);
    expect(changes(INSERTER_CYCLE, d.step, () => d.count(d.target, PLATE))).toEqual([26]);
  });

  it('stops mid-swing when the power goes, and goes on from there when it comes back', () => {
    const d = inserterRig();
    d.step(10);
    expect(d.table.hand(d.inserter)).toEqual({ held: PLATE, arm: 10 * SAT_ONE });
    d.producers.max.set(d.producer, 0);
    d.step(50);
    expect(d.entities.status(d.inserter)).toBe(InserterState.NoPower);
    expect(d.table.hand(d.inserter)).toEqual({ held: PLATE, arm: 10 * SAT_ONE });
    d.producers.max.set(d.producer, INSERTER_W);
    expect(changes(20, d.step, () => d.count(d.target, PLATE))).toEqual([16]);
  });

  it('draws its 7 J drain while it sleeps on an empty source, and 220 J once woken', () => {
    const d = inserterRig();
    d.entities.take(d.source, 0, 50);
    d.step(3);
    expect(d.entities.status(d.inserter)).toBe(InserterState.WaitingForSource);
    expect(d.table.activeCount).toBe(0);
    expect(d.grid.member(d.inserter)!.demand).toBe(INSERTER_DRAIN);
    expect(d.grid.network(d.grid.networkOf(d.inserter))).toMatchObject({
      demand: INSERTER_DRAIN,
      satisfaction: SAT_ONE,
      load: INSERTER_DRAIN,
    });
    const before = d.producers.delivered.get(d.producer)!;
    d.step(100);
    expect(d.producers.delivered.get(d.producer)! - before).toBe(100 * INSERTER_DRAIN);
    // Woken before the power step (a command): its demand is counted at once.
    d.entities.insert(d.source, PLATE, 1);
    d.step();
    expect(d.grid.member(d.inserter)!.demand).toBe(INSERTER_W);
    expect(d.table.hand(d.inserter)).toEqual({ held: PLATE, arm: SAT_ONE });
  });

  it('woken after the power step, picks up on that tick but moves only from the next', () => {
    const d = inserterRig();
    d.entities.take(d.source, 0, 50);
    d.step(3);
    expect(d.entities.status(d.inserter)).toBe(InserterState.WaitingForSource);
    // One tick by hand, with a plate arriving in the source between the
    // power step and the inserters (as a drill or belt would deliver it).
    for (const system of SYSTEMS) {
      system.run(d.sim, []);
      if (system.name === 'power') d.entities.insert(d.source, PLATE, 1);
    }
    d.state.tick++;
    expect(d.grid.member(d.inserter)!.demand).toBe(INSERTER_DRAIN);
    expect(d.count(d.source, PLATE)).toBe(0);
    expect(d.table.hand(d.inserter)).toEqual({ held: PLATE, arm: 0 });
    expect(d.entities.status(d.inserter)).toBe(InserterState.Swinging);
    d.step();
    expect(d.grid.member(d.inserter)!.demand).toBe(INSERTER_W);
    expect(d.table.hand(d.inserter)).toEqual({ held: PLATE, arm: SAT_ONE });
    expect(changes(ELECTRIC_INSERTER_SWING_TICKS, d.step, () => d.count(d.target, PLATE))).toEqual([
      ELECTRIC_INSERTER_SWING_TICKS - 1,
    ]);
  });

  it('holds its item at a full target, sleeping on it, and drops once it has room', () => {
    const d = inserterRig();
    // Fill the target: 16 stacks of coal.
    for (let i = 0; i < 16; i++) d.entities.insert(d.target, ItemId.Coal, 50);
    d.step(INSERTER_CYCLE);
    expect(d.entities.status(d.inserter)).toBe(InserterState.WaitingForTarget);
    expect(d.entities.wake.watchersOf(d.target)).toEqual([d.inserter]);
    expect(d.grid.member(d.inserter)!.demand).toBe(INSERTER_DRAIN);
    d.entities.take(d.target, 0, 50);
    d.step();
    expect(d.count(d.target, PLATE)).toBe(1);
  });

  it('lets the hand be emptied through the GUI, and encodes its arm for the renderer', () => {
    const d = inserterRig({ supply: INSERTER_W / 2 });
    d.step(4);
    const range = { cx0: 0, cy0: 0, cx1: 0, cy1: 0 };
    expect(decodeInserters(encodeInserters(d.state, range).buffer)).toEqual([
      {
        x: 3,
        y: 0,
        dir: East,
        arm: 2 * SAT_ONE,
        held: PLATE,
        swing: SAT_ONE / 2,
        span: ELECTRIC_INSERTER_SWING_TICKS * SAT_ONE,
        type: EntityTypeId.ElectricInserter,
      },
    ]);
    expect(d.entities.take(d.inserter, ElectricInserterSlot.Hand, 1)).toBe(1);
    expect(d.entities.slots(d.inserter)).toEqual([{ item: 0, count: 0 }]);
    d.step();
    expect(d.table.hand(d.inserter)).toEqual({ held: 0, arm: 2 * SAT_ONE - SAT_ONE / 2 });
  });

  it('shares the network with a drill: demand adds up, and both slow down together', () => {
    const d = inserterRig({ supply: null });
    setOre(d.state.world, 3, -3, ResourceId.IronOre, 100);
    // A drill on (2..4, -4..-2) facing south, dropping into a chest on
    // (3, -1), tied in by a second pole wired to the first.
    const drill = d.place(ItemId.ElectricMiningDrill, 2, -4, South);
    d.place(ItemId.WoodenChest, 3, -1);
    d.place(ItemId.SmallElectricPole, 6, -3);
    expect(d.grid.networkOf(drill)).toBe(d.grid.networkOf(d.inserter));
    d.addProducer(5, 1, (DRILL_W + INSERTER_W) / 2);
    d.step(2);
    const net = d.grid.network(d.grid.networkOf(drill))!;
    expect(net.demand).toBe(DRILL_W + INSERTER_W);
    expect(net.satisfaction).toBe(SAT_ONE / 2);
    expect(electricDrillTable(d.entities)!.rawProgress(drill)).toBe(SAT_ONE);
    expect(d.table.hand(d.inserter)).toEqual({ held: PLATE, arm: SAT_ONE });
  });
});

/**
 * A real boiler and steam engine (15 000 J/tick) powering `drills` electric
 * drills in a row on (0.., 0..2), each with iron ore under its center tile
 * and facing south, through poles along y = -1 and a chain down to the
 * engine. Built with `entities.add` (no build rules), in the default tables.
 */
function steamPlant(drills: number) {
  const sim = new Sim({ seed: 1, startingKit: [] });
  const { state } = sim;
  const { entities } = state;
  for (let y = -4; y <= 24; y++) {
    for (let x = -4; x <= 3 * drills + 4; x++) setOre(state.world, x, y, ResourceId.None, 0);
  }
  const add = (type: RealEntityTypeId, x: number, y: number, dir: Direction = North) =>
    entities.add(ENTITIES[type], x, y, dir);
  const boiler = add(EntityTypeId.Boiler, 0, 20);
  const engine = add(EntityTypeId.SteamEngine, -2, 15);
  const ids: number[] = [];
  for (let i = 0; i < drills; i++) {
    setOre(state.world, 3 * i + 1, 1, ResourceId.IronOre, 1_000);
    ids.push(add(EntityTypeId.ElectricMiningDrill, 3 * i, 0, South));
  }
  for (let x = 2; x <= 3 * drills; x += 5) add(EntityTypeId.SmallElectricPole, x, -1);
  for (const y of [5, 11, 14]) add(EntityTypeId.SmallElectricPole, 2, y);
  expect(entities.insert(boiler, ItemId.Coal, 5)).toBe(5);
  const grid = powerGrid(entities)!;
  const table = electricDrillTable(entities)!;
  /** Joules the boiler has turned into power so far (fuel burnt minus what is left in its buffer). */
  const burnt = () =>
    (5 - entities.slots(boiler)[0]!.count) * 4_000_000 -
    boilerTable(entities)!.detail(boiler).energy;
  return { sim, entities, grid, table, boiler, engine, drills: ids, burnt };
}

describe('electric consumers on steam power', () => {
  it('run at full speed while the engine keeps up: 10 drills take all of its 15 000 J/tick', () => {
    const p = steamPlant(10);
    p.sim.step();
    const net = p.grid.networkOf(p.drills[0]!);
    expect(net).not.toBe(0);
    for (const d of p.drills) expect(p.grid.networkOf(d)).toBe(net);
    expect(p.grid.networkOf(p.engine)).toBe(net);
    const progress = p.drills.map((d) => p.table.rawProgress(d));
    const burnt = p.burnt();
    for (let i = 0; i < 60; i++) p.sim.step();
    expect(p.grid.network(net)).toMatchObject({
      demand: 10 * DRILL_W,
      supply: 15_000,
      satisfaction: SAT_ONE,
      load: 15_000,
    });
    p.drills.forEach((d, i) => {
      expect(p.table.rawProgress(d) - progress[i]!).toBe(60 * SAT_ONE);
      expect(p.entities.status(d)).toBe(MachineState.Working);
    });
    // The boiler burns exactly what the drills drew.
    expect(p.burnt() - burnt).toBe(60 * 10 * DRILL_W);
  });

  it('slow down together when overloaded: 20 drills on one engine run at half speed', () => {
    const p = steamPlant(20);
    p.sim.step();
    const net = p.grid.networkOf(p.drills[0]!);
    const progress = p.drills.map((d) => p.table.rawProgress(d));
    const burnt = p.burnt();
    for (let i = 0; i < 60; i++) p.sim.step();
    expect(p.grid.network(net)).toMatchObject({
      demand: 20 * DRILL_W,
      supply: 15_000,
      satisfaction: SAT_ONE / 2,
      load: 15_000,
    });
    p.drills.forEach((d, i) => {
      expect(p.table.rawProgress(d) - progress[i]!).toBe(30 * SAT_ONE);
      expect(displayStatus(p.sim.state, d)).toBe(MachineState.LowPower);
    });
    expect(p.burnt() - burnt).toBe(60 * 15_000);
    // A unit every 240 ticks: the first after 240 ticks of mining at half speed.
    const first = p.drills[0]!;
    while (p.entities.slots(first)[ElectricDrillSlot.Output]!.count === 0) p.sim.step();
    expect(p.sim.tick).toBe(240);
  });
});

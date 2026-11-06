import { describe, expect, it } from 'vitest';
import { ENTITIES, EntityTypeId, SAT_ONE, isInserterPrototype } from '../../src/data/entities';
import { ItemId, itemPrototype, type ItemStack } from '../../src/data/items';
import { RECIPES, RecipeId } from '../../src/data/recipes';
import { ResourceId } from '../../src/data/resources';
import { beltTable } from '../../src/sim/belts/belts';
import { BeltLane } from '../../src/sim/belts/line';
import { BuildResult, placeEntity, removeEntity } from '../../src/sim/entities/build';
import { ChestTable } from '../../src/sim/entities/chest';
import { Direction } from '../../src/sim/entities/direction';
import {
  FAST_INSERTER_CYCLE_TICKS,
  LONG_HANDED_INSERTER_CYCLE_TICKS,
  electricInserterTable,
  type ElectricInserterType,
} from '../../src/sim/entities/electricInserter';
import {
  InserterState,
  inserterDropTile,
  inserterPickupTile,
} from '../../src/sim/entities/inserter';
import { createEntityTables } from '../../src/sim/entities/registry';
import type { EntityTypeTable } from '../../src/sim/entities/table';
import { tileCenter } from '../../src/sim/fixed';
import { decodeInserters, encodeInserters } from '../../src/sim/snapshot';
import { Sim } from '../../src/sim/tick';
import { CHUNK_MASK, CHUNK_SHIFT, tileIndex } from '../../src/sim/world/chunk';

const { North, East, South } = Direction;
const PLATE = ItemId.IronPlate;
const ORE = ItemId.IronOre;

// Shared M3 design numbers (issue #47).
const FAST_W = 770;
const FAST_DRAIN = 15;
const FAST_CYCLE = 26;
const LONG_W = 333;
const LONG_DRAIN = 7;
const LONG_CYCLE = 50;
const IRON_CHEST_SLOTS = 32;

/** A fake power producer on the steam engine's footprint that offers exactly what the test sets. */
class FakeProducers implements EntityTypeTable {
  readonly type = EntityTypeId.SteamEngine;
  readonly max = new Map<number, number>();
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

/**
 * A sim whose player 0 stands on tile (0, 0) with plenty of everything, a
 * pole on (3, 2) and a fake producer on (5..7, 3..7) offering `supply` J/tick
 * on its network; the area around the spawn is cleared of resources.
 */
function setup(supply: number) {
  const producers = new FakeProducers();
  const sim = new Sim({
    seed: 1,
    startingKit: [
      { item: ItemId.FastInserter, count: 10 },
      { item: ItemId.LongHandedInserter, count: 10 },
      { item: ItemId.SmallElectricPole, count: 10 },
      { item: ItemId.WoodenChest, count: 10 },
      { item: ItemId.IronChest, count: 10 },
      { item: ItemId.TransportBelt, count: 10 },
      { item: PLATE, count: 100 },
    ],
    entityTables: [
      ...createEntityTables().filter((t) => t.type !== EntityTypeId.SteamEngine),
      producers,
    ],
  });
  const { state } = sim;
  state.players.x[0] = tileCenter(0);
  state.players.y[0] = tileCenter(0);
  for (let y = -8; y <= 8; y++) {
    for (let x = -8; x <= 10; x++) {
      const chunk = state.world.getChunk(x >> CHUNK_SHIFT, y >> CHUNK_SHIFT);
      const i = tileIndex(x & CHUNK_MASK, y & CHUNK_MASK);
      chunk.resource[i] = ResourceId.None;
      chunk.amount[i] = 0;
    }
  }
  const { entities } = state;
  const place = (item: number, x: number, y: number, dir: Direction = North) => {
    expect(placeEntity(state, 0, item, x, y, dir)).toBe(BuildResult.Ok);
    return entities.at(x, y);
  };
  place(ItemId.SmallElectricPole, 3, 2);
  const producer = entities.add(ENTITIES[EntityTypeId.SteamEngine], 5, 3, North);
  producers.max.set(producer, supply);
  const count = (id: number, item: number) =>
    entities.contents(id).reduce((n, s) => n + (s.item === item ? s.count : 0), 0);
  return {
    sim,
    state,
    entities,
    producers,
    producer,
    place,
    count,
    step: (n = 1) => {
      for (let i = 0; i < n; i++) sim.step();
    },
  };
}

/** Ticks (from 0) on which the source lost and the target got an item, over `ticks` steps. */
function transfers(
  s: ReturnType<typeof setup>,
  source: number,
  target: number,
  ticks: number,
): { pickups: number[]; drops: number[] } {
  const pickups: number[] = [];
  const drops: number[] = [];
  let left = s.count(source, PLATE);
  let put = s.count(target, PLATE);
  for (let t = 0; t < ticks; t++) {
    s.step();
    if (s.count(source, PLATE) !== left) pickups.push(t);
    if (s.count(target, PLATE) !== put) drops.push(t);
    left = s.count(source, PLATE);
    put = s.count(target, PLATE);
  }
  return { pickups, drops };
}

/**
 * Chest on (3 − reach, 0) → inserter of `type` on (3, 0) facing east →
 * chest on (3 + reach, 0), the source holding 50 plates.
 */
function rig(type: ElectricInserterType, supply: number) {
  const s = setup(supply);
  const item = ENTITIES[type].item;
  const reach = ENTITIES[type].reach ?? 1;
  const source = s.place(ItemId.WoodenChest, 3 - reach, 0);
  const inserter = s.place(item, 3, 0, East);
  const target = s.place(ItemId.WoodenChest, 3 + reach, 0);
  s.entities.insert(source, PLATE, 50);
  const table = electricInserterTable(s.entities, type)!;
  return { ...s, source, inserter, target, table };
}

describe('shared M3 inserter and chest numbers', () => {
  it('live in src/data', () => {
    const fast = ENTITIES[EntityTypeId.FastInserter];
    expect(fast).toMatchObject({
      width: 1,
      height: 1,
      rotatable: true,
      energySource: 'electric',
      energyPerTick: FAST_W,
      drainPerTick: FAST_DRAIN,
      swingTicks: FAST_CYCLE / 2,
    });
    expect(fast.reach ?? 1).toBe(1);
    expect(FAST_INSERTER_CYCLE_TICKS).toBe(FAST_CYCLE);
    const long = ENTITIES[EntityTypeId.LongHandedInserter];
    expect(long).toMatchObject({
      energySource: 'electric',
      energyPerTick: LONG_W,
      drainPerTick: LONG_DRAIN,
      swingTicks: LONG_CYCLE / 2,
      reach: 2,
    });
    expect(LONG_HANDED_INSERTER_CYCLE_TICKS).toBe(LONG_CYCLE);
    expect(ENTITIES[EntityTypeId.IronChest]).toMatchObject({ slots: IRON_CHEST_SLOTS });
    expect(isInserterPrototype(fast) && isInserterPrototype(long)).toBe(true);
    expect(isInserterPrototype(ENTITIES[EntityTypeId.IronChest])).toBe(false);
  });

  it('have hand recipes', () => {
    expect(RECIPES[RecipeId.FastInserter]).toMatchObject({
      inputs: [
        [ItemId.ElectricInserter, 1],
        [ItemId.ElectronicCircuit, 2],
        [ItemId.IronPlate, 2],
      ],
      outputs: [[ItemId.FastInserter, 1]],
      ticks: 30,
      category: 'hand',
    });
    expect(RECIPES[RecipeId.LongHandedInserter]).toMatchObject({
      inputs: [
        [ItemId.ElectricInserter, 1],
        [ItemId.IronGearWheel, 1],
        [ItemId.IronPlate, 1],
      ],
      outputs: [[ItemId.LongHandedInserter, 1]],
      ticks: 30,
      category: 'hand',
    });
    expect(RECIPES[RecipeId.IronChest]).toMatchObject({
      inputs: [[ItemId.IronPlate, 8]],
      outputs: [[ItemId.IronChest, 1]],
      ticks: 30,
      category: 'hand',
    });
  });
});

describe('fast inserter', () => {
  it('moves one item every 26 ticks at full power, drawing 770 J per tick', () => {
    const d = rig(EntityTypeId.FastInserter, FAST_W);
    const { pickups, drops } = transfers(d, d.source, d.target, 4 * FAST_CYCLE);
    expect(pickups).toEqual([0, 26, 52, 78]);
    expect(drops).toEqual([13, 39, 65, 91]);
    expect(d.producers.delivered.get(d.producer)).toBe(4 * FAST_CYCLE * FAST_W);
  });

  it('takes 52 ticks per item at half power, drawing 385 J per tick', () => {
    const d = rig(EntityTypeId.FastInserter, FAST_W / 2);
    const { drops } = transfers(d, d.source, d.target, 3 * 2 * FAST_CYCLE);
    expect(drops).toEqual([26, 78, 130]);
    expect(d.producers.delivered.get(d.producer)).toBe(3 * 2 * FAST_CYCLE * (FAST_W / 2));
  });

  it('draws its 15 J drain while it sleeps on an empty source, and wakes when it gets items', () => {
    const d = rig(EntityTypeId.FastInserter, FAST_W);
    d.entities.take(d.source, 0, 50);
    d.step(2);
    expect(d.entities.status(d.inserter)).toBe(InserterState.WaitingForSource);
    expect(d.table.activeCount).toBe(0);
    const before = d.producers.delivered.get(d.producer) ?? 0;
    d.step(10);
    expect((d.producers.delivered.get(d.producer) ?? 0) - before).toBe(10 * FAST_DRAIN);
    d.entities.insert(d.source, PLATE, 1);
    expect(d.table.activeCount).toBe(1);
    const { drops } = transfers(d, d.source, d.target, FAST_CYCLE);
    // Woken after the power step: picks up at once, moves from the next tick (D26).
    expect(drops).toEqual([13]);
  });

  it('encodes its type and span for the renderer', () => {
    const d = rig(EntityTypeId.FastInserter, FAST_W);
    d.step(5);
    const [ins] = decodeInserters(
      encodeInserters(d.state, { cx0: 0, cy0: 0, cx1: 0, cy1: 0 }).buffer,
    );
    expect(ins).toMatchObject({
      x: 3,
      y: 0,
      type: EntityTypeId.FastInserter,
      span: (FAST_CYCLE / 2) * SAT_ONE,
      arm: 5 * SAT_ONE,
      held: PLATE,
    });
  });
});

describe('long-handed inserter', () => {
  it('picks up 2 tiles behind and drops 2 tiles in front', () => {
    expect(inserterPickupTile(5, 5, East, 2)).toEqual({ x: 3, y: 5 });
    expect(inserterDropTile(5, 5, East, 2)).toEqual({ x: 7, y: 5 });
    expect(inserterPickupTile(5, 5, North, 2)).toEqual({ x: 5, y: 7 });
    expect(inserterDropTile(5, 5, South, 2)).toEqual({ x: 5, y: 7 });
  });

  it('moves one item every 50 ticks at full power, over the entities next to it', () => {
    const d = rig(EntityTypeId.LongHandedInserter, LONG_W);
    // Chests on the neighbouring tiles, which it reaches over and never touches.
    const near = d.place(ItemId.IronChest, 2, 0);
    const far = d.place(ItemId.IronChest, 4, 0);
    d.entities.insert(near, PLATE, 5);
    const { pickups, drops } = transfers(d, d.source, d.target, 3 * LONG_CYCLE);
    expect(pickups).toEqual([0, 50, 100]);
    expect(drops).toEqual([25, 75, 125]);
    expect(d.count(near, PLATE)).toBe(5);
    expect(d.count(far, PLATE)).toBe(0);
    expect(d.producers.delivered.get(d.producer)).toBe(3 * LONG_CYCLE * LONG_W);
  });

  it('takes 100 ticks per item at half power', () => {
    // Two long-handed inserters on 333 J/tick: satisfaction exactly 1/2.
    const d = rig(EntityTypeId.LongHandedInserter, LONG_W);
    const source = d.place(ItemId.WoodenChest, 1, 1);
    d.place(ItemId.LongHandedInserter, 3, 1, East);
    const target = d.place(ItemId.WoodenChest, 5, 1);
    d.entities.insert(source, PLATE, 50);
    const { drops } = transfers(d, d.source, d.target, 3 * 2 * LONG_CYCLE);
    expect(drops).toEqual([50, 150, 250]);
    expect(d.count(target, PLATE)).toBe(3);
  });

  it('only wakes for entities placed 2 tiles away, not next to it', () => {
    const s = setup(LONG_W);
    const source = s.place(ItemId.WoodenChest, 1, 0);
    s.entities.insert(source, PLATE, 10);
    const inserter = s.place(ItemId.LongHandedInserter, 3, 0, East);
    const table = electricInserterTable(s.entities, EntityTypeId.LongHandedInserter)!;
    s.step(2);
    expect(s.entities.status(inserter)).toBe(InserterState.WaitingForTarget);
    expect(table.activeCount).toBe(0);
    // A chest next to it is not its target.
    s.place(ItemId.WoodenChest, 4, 0);
    expect(table.activeCount).toBe(0);
    const target = s.place(ItemId.IronChest, 5, 0);
    expect(table.activeCount).toBe(1);
    s.step(LONG_CYCLE);
    expect(s.count(target, PLATE)).toBe(1);
    // Removing its source wakes it; it then sleeps waiting for a new one.
    s.step(LONG_CYCLE);
    expect(removeEntity(s.state, 0, 1, 0)).toBe(BuildResult.Ok);
    s.step(LONG_CYCLE);
    expect(s.entities.status(inserter)).toBe(InserterState.WaitingForSource);
    expect(table.activeCount).toBe(0);
  });

  it('picks up from a belt 2 tiles behind and drops onto the far lane of a belt 2 tiles ahead', () => {
    const s = setup(LONG_W);
    // Belts running north on (1, 0) and (5, 0); the inserter on (3, 0) facing east.
    const from = s.place(ItemId.TransportBelt, 1, 0, North);
    const to = s.place(ItemId.TransportBelt, 5, 0, North);
    s.place(ItemId.LongHandedInserter, 3, 0, East);
    expect(s.entities.insert(from, ORE, 1)).toBe(1);
    s.step(LONG_CYCLE / 2 + 1);
    const belts = beltTable(s.entities)!;
    expect(belts.itemsOn(from)).toEqual([]);
    // Reaching across from the west, the far lane of a north belt is its right lane.
    expect(belts.itemsOn(to).map((i) => [i.lane, i.item])).toEqual([[BeltLane.Right, ORE]]);
  });
});

describe('iron chest', () => {
  it('holds 32 stacks, and shares the chest code', () => {
    const s = setup(0);
    const chest = s.place(ItemId.IronChest, 2, 0);
    expect(s.entities.table(EntityTypeId.IronChest)).toBeInstanceOf(ChestTable);
    expect(s.entities.slots(chest)).toHaveLength(IRON_CHEST_SLOTS);
    const stack = itemPrototype(PLATE)!.stackSize;
    expect(s.entities.insert(chest, PLATE, 100 * stack)).toBe(IRON_CHEST_SLOTS * stack);
    expect(s.entities.insertable(chest, PLATE)).toBe(0);
    expect(s.entities.take(chest, IRON_CHEST_SLOTS - 1, 1)).toBe(1);
    expect(s.entities.insertable(chest, PLATE)).toBe(1);
    expect(s.entities.take(chest, IRON_CHEST_SLOTS, 1)).toBe(0);
  });
});

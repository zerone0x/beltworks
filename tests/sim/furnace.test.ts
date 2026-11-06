import { describe, expect, it } from 'vitest';
import { ENTITIES, EntityTypeId, FURNACE_OUTPUT_LIMIT } from '../../src/data/entities';
import { ITEMS, ItemId, fuelValue, type ItemStack } from '../../src/data/items';
import { RECIPES, RecipeId } from '../../src/data/recipes';
import { BuildResult, placeEntity, removeEntity } from '../../src/sim/entities/build';
import { BurnerColumns } from '../../src/sim/entities/burner';
import { Direction } from '../../src/sim/entities/direction';
import { Entities } from '../../src/sim/entities/entities';
import {
  FURNACE_ENERGY_PER_TICK,
  FurnaceSlot,
  FurnaceTable,
  furnaceTable,
  smeltingRecipeFor,
} from '../../src/sim/entities/furnace';
import { MachineState } from '../../src/sim/entities/machine';
import type { EntityTypeTable } from '../../src/sim/entities/table';
import { ChestTable } from '../../src/sim/entities/chest';
import { tileCenter } from '../../src/sim/fixed';
import type { SimState } from '../../src/sim/state';
import { Sim } from '../../src/sim/tick';

const COAL_J = 4_000_000;
const FURNACE_W = 1_500;
const PLATE_TICKS = 192;

/** A sim whose player 0 stands on tile (0, 0) with a furnace at (2, 0)..(3, 1). */
function setup(kit: readonly ItemStack[] = []) {
  const sim = new Sim({
    seed: 1,
    startingKit: [{ item: ItemId.StoneFurnace, count: 1 }, ...kit],
  });
  sim.state.players.x[0] = tileCenter(0);
  sim.state.players.y[0] = tileCenter(0);
  expect(placeEntity(sim.state, 0, ItemId.StoneFurnace, 2, 0, Direction.North)).toBe(
    BuildResult.Ok,
  );
  const id = sim.state.entities.at(2, 0);
  const table = furnaceTable(sim.state.entities)!;
  const { entities } = sim.state;
  const slot = (s: number) => entities.slots(id)[s]!;
  return {
    sim,
    id,
    table,
    entities,
    step: (n: number) => {
      for (let i = 0; i < n; i++) sim.step();
    },
    input: () => slot(FurnaceSlot.Input),
    fuel: () => slot(FurnaceSlot.Fuel),
    output: () => slot(FurnaceSlot.Output),
    detail: () => entities.detail(id)!,
  };
}

describe('shared M1 numbers', () => {
  it('live in src/data', () => {
    expect(fuelValue(ItemId.Coal)).toBe(COAL_J);
    expect(fuelValue(ItemId.Wood)).toBe(2_000_000);
    expect(fuelValue(ItemId.IronOre)).toBe(0);
    expect(fuelValue(999)).toBe(0);
    expect(ENTITIES[EntityTypeId.StoneFurnace].energyPerTick).toBe(FURNACE_W);
    expect(FURNACE_ENERGY_PER_TICK).toBe(FURNACE_W);
    expect(ENTITIES[EntityTypeId.BurnerMiningDrill].energyPerTick).toBe(2_500);
    expect(ENTITIES[EntityTypeId.BurnerInserter].energyPerTick).toBe(1_667);
    expect(ENTITIES[EntityTypeId.WoodenChest].slots).toBe(16);
    expect(FURNACE_OUTPUT_LIMIT).toBe(100);
  });

  it('define the smelting recipes', () => {
    const smelting = RECIPES.filter((r) => r.category === 'smelting');
    expect(smelting.map((r) => [r.inputs, r.outputs, r.ticks])).toEqual([
      [[[ItemId.IronOre, 1]], [[ItemId.IronPlate, 1]], PLATE_TICKS],
      [[[ItemId.CopperOre, 1]], [[ItemId.CopperPlate, 1]], PLATE_TICKS],
      [[[ItemId.Stone, 2]], [[ItemId.StoneBrick, 1]], PLATE_TICKS],
    ]);
    for (const r of RECIPES) {
      for (const [item, count] of [...r.inputs, ...r.outputs]) {
        expect(ITEMS[item]).toBeDefined();
        expect(Number.isInteger(count) && count > 0).toBe(true);
      }
    }
    expect(new Set(RECIPES.map((r) => r.id)).size).toBe(RECIPES.length);
    expect(smeltingRecipeFor(ItemId.IronOre)?.id).toBe(RecipeId.IronPlate);
    expect(smeltingRecipeFor(ItemId.Stone)?.id).toBe(RecipeId.StoneBrick);
    expect(smeltingRecipeFor(ItemId.Coal)).toBeUndefined();
  });
});

describe('BurnerColumns', () => {
  it('burns whole fuel units and keeps the remainder', () => {
    const b = new BurnerColumns();
    b.grow(1);
    expect(b.consume(0, FURNACE_W)).toBe(false);
    expect(b.insert(0, ItemId.IronOre, 5)).toBe(0);
    expect(b.insert(0, ItemId.Coal, 60)).toBe(50);
    expect(b.insertable(0, ItemId.Wood)).toBe(0);
    expect(b.take(0, 49)).toBe(49);
    let ticks = 0;
    while (b.consume(0, FURNACE_W)) ticks++;
    // 4 000 000 J at 1 500 J/tick: 2 666 whole ticks and 1 000 J left over.
    expect(ticks).toBe(2_666);
    expect(b.energy[0]).toBe(1_000);
    expect(b.burning[0]).toBe(ItemId.Coal);
    expect(b.fuelStack(0)).toBeNull();
    // The leftover counts towards the next unit.
    b.insert(0, ItemId.Wood, 1);
    ticks = 0;
    while (b.consume(0, FURNACE_W)) ticks++;
    expect(ticks).toBe(Math.floor((1_000 + 2_000_000) / FURNACE_W));
    expect(b.energy[0]).toBe((1_000 + 2_000_000) % FURNACE_W);
    expect(b.burning[0]).toBe(ItemId.Wood);
  });
});

describe('stone furnace', () => {
  it('starts idle, waiting for input, and off the active list', () => {
    const f = setup();
    expect(f.entities.status(f.id)).toBe(MachineState.NoInput);
    expect(f.table.activeCount).toBe(0);
    expect(f.entities.slots(f.id)).toEqual([
      { item: 0, count: 0 },
      { item: 0, count: 0 },
      { item: 0, count: 0 },
    ]);
  });

  it('routes ores to the input and fuel to the fuel slot', () => {
    const f = setup();
    const { entities, id } = f;
    expect(entities.insertable(id, ItemId.IronOre)).toBe(50);
    expect(entities.insertable(id, ItemId.Coal)).toBe(50);
    expect(entities.insertable(id, ItemId.IronPlate)).toBe(0);
    expect(entities.insertable(id, 999)).toBe(0);
    expect(entities.insert(id, ItemId.Coal, 3)).toBe(3);
    expect(entities.insert(id, ItemId.IronOre, 60)).toBe(50);
    // One input item at a time, one fuel at a time.
    expect(entities.insert(id, ItemId.CopperOre, 1)).toBe(0);
    expect(entities.insert(id, ItemId.Wood, 1)).toBe(0);
    expect(entities.insert(id, ItemId.IronPlate, 1)).toBe(0);
    expect(f.input()).toEqual({ item: ItemId.IronOre, count: 50 });
    expect(f.fuel()).toEqual({ item: ItemId.Coal, count: 3 });
    expect(entities.outputSlot(id)).toBe(-1);
  });

  it('makes exactly one plate every 192 ticks with fuel', () => {
    const f = setup();
    f.entities.insert(f.id, ItemId.Coal, 5);
    f.entities.insert(f.id, ItemId.IronOre, 5);
    expect(f.table.activeCount).toBe(1);
    f.step(1);
    // The first ore is taken out as soon as the plate is started.
    expect(f.input().count).toBe(4);
    expect(f.detail()).toMatchObject({
      status: MachineState.Working,
      recipe: RecipeId.IronPlate,
      progress: 1,
    });
    f.step(PLATE_TICKS - 2);
    expect(f.output().count).toBe(0);
    f.step(1);
    expect(f.output()).toEqual({ item: ItemId.IronPlate, count: 1 });
    expect(f.entities.outputSlot(f.id)).toBe(FurnaceSlot.Output);
    for (let plates = 2; plates <= 5; plates++) {
      f.step(PLATE_TICKS - 1);
      expect(f.output().count).toBe(plates - 1);
      f.step(1);
      expect(f.output().count).toBe(plates);
    }
    // Out of ore: it goes to sleep.
    expect(f.entities.status(f.id)).toBe(MachineState.Working);
    f.step(1);
    expect(f.entities.status(f.id)).toBe(MachineState.NoInput);
    expect(f.table.activeCount).toBe(0);
    // 5 × 192 ticks at 1 500 J out of one coal.
    expect(f.fuel().count).toBe(4);
    expect(f.detail().energy).toBe(COAL_J - 5 * PLATE_TICKS * FURNACE_W);
  });

  it('smelts two stone into one brick', () => {
    const f = setup();
    f.entities.insert(f.id, ItemId.Wood, 1);
    f.entities.insert(f.id, ItemId.Stone, 3);
    f.step(PLATE_TICKS);
    expect(f.output()).toEqual({ item: ItemId.StoneBrick, count: 1 });
    // One stone isn't enough for another brick.
    expect(f.input()).toEqual({ item: ItemId.Stone, count: 1 });
    f.step(1);
    expect(f.entities.status(f.id)).toBe(MachineState.NoInput);
  });

  it('does nothing without fuel, and resumes where it stopped', () => {
    const f = setup();
    f.entities.insert(f.id, ItemId.IronOre, 3);
    f.step(10);
    expect(f.entities.status(f.id)).toBe(MachineState.NoFuel);
    // Nothing is started without energy: the ore stays in the input.
    expect(f.input().count).toBe(3);
    expect(f.detail().progress).toBe(0);
    expect(f.table.activeCount).toBe(0);
    f.entities.insert(f.id, ItemId.Coal, 1);
    f.step(PLATE_TICKS);
    expect(f.output().count).toBe(1);
  });

  it('smelts exactly 2 666 ticks of iron from one coal (13 plates and 170/192 of the 14th)', () => {
    const f = setup();
    f.entities.insert(f.id, ItemId.Coal, 1);
    f.entities.insert(f.id, ItemId.IronOre, 20);
    const workingTicks = Math.floor(COAL_J / FURNACE_W);
    expect(workingTicks).toBe(2_666);
    f.step(workingTicks);
    expect(f.entities.status(f.id)).toBe(MachineState.Working);
    f.step(1);
    expect(f.entities.status(f.id)).toBe(MachineState.NoFuel);
    expect(f.output().count).toBe(Math.floor(workingTicks / PLATE_TICKS));
    expect(f.output().count).toBe(13);
    expect(f.detail()).toMatchObject({
      progress: workingTicks % PLATE_TICKS,
      energy: COAL_J - workingTicks * FURNACE_W,
      recipe: RecipeId.IronPlate,
    });
    expect(f.detail().progress).toBe(170);
    expect(f.detail().energy).toBe(1_000);
    // 14 ores were taken: 13 plates and the one in progress.
    expect(f.input().count).toBe(6);
    // Asleep while out of fuel: more ticks change nothing.
    const hash = f.sim.hash();
    f.step(100);
    expect(f.output().count).toBe(13);
    expect(f.table.activeCount).toBe(0);
    expect(f.sim.hash()).not.toBe(hash); // only the tick counter moved
    // A second coal finishes the 14th plate 22 ticks later.
    f.entities.insert(f.id, ItemId.Coal, 1);
    f.step(PLATE_TICKS - 170 - 1);
    expect(f.output().count).toBe(13);
    f.step(1);
    expect(f.output().count).toBe(14);
    expect(f.detail().energy).toBe(1_000 + COAL_J - 22 * FURNACE_W);
  });

  it('stops when the output holds 100 plates, and resumes once some are taken', () => {
    const f = setup();
    f.entities.insert(f.id, ItemId.Coal, 10);
    f.entities.insert(f.id, ItemId.IronOre, 50);
    f.step(50 * PLATE_TICKS);
    f.entities.insert(f.id, ItemId.IronOre, 50);
    f.step(50 * PLATE_TICKS);
    expect(f.output()).toEqual({ item: ItemId.IronPlate, count: FURNACE_OUTPUT_LIMIT });
    f.entities.insert(f.id, ItemId.IronOre, 1);
    f.step(1);
    expect(f.entities.status(f.id)).toBe(MachineState.OutputFull);
    expect(f.input().count).toBe(1);
    expect(f.table.activeCount).toBe(0);
    f.step(500);
    expect(f.output().count).toBe(FURNACE_OUTPUT_LIMIT);
    expect(f.entities.take(f.id, FurnaceSlot.Output, 1)).toBe(1);
    f.step(PLATE_TICKS);
    expect(f.output().count).toBe(FURNACE_OUTPUT_LIMIT);
    expect(f.input().count).toBe(0);
  });

  it('is blocked by a different item in the output', () => {
    const f = setup();
    f.entities.insert(f.id, ItemId.Coal, 1);
    f.entities.insert(f.id, ItemId.IronOre, 1);
    f.step(PLATE_TICKS);
    f.entities.insert(f.id, ItemId.CopperOre, 1);
    f.step(1);
    expect(f.entities.status(f.id)).toBe(MachineState.OutputFull);
    f.entities.take(f.id, FurnaceSlot.Output, 100);
    f.step(PLATE_TICKS);
    expect(f.output()).toEqual({ item: ItemId.CopperPlate, count: 1 });
  });

  it('refunds its slots and the ore in progress when removed', () => {
    const f = setup();
    const inv = f.sim.state.players.inventory(0);
    f.entities.insert(f.id, ItemId.Coal, 4);
    f.entities.insert(f.id, ItemId.IronOre, 3);
    f.step(PLATE_TICKS + 10);
    // 1 plate out, 1 ore in progress, 1 ore left, 3 coal (one burning).
    expect(f.entities.contents(f.id)).toEqual([
      { item: ItemId.IronOre, count: 1 },
      { item: ItemId.IronOre, count: 1 },
      { item: ItemId.Coal, count: 3 },
      { item: ItemId.IronPlate, count: 1 },
    ]);
    expect(removeEntity(f.sim.state, 0, 3, 1)).toBe(BuildResult.Ok);
    expect(inv.count(ItemId.IronOre)).toBe(2);
    expect(inv.count(ItemId.Coal)).toBe(3);
    expect(inv.count(ItemId.IronPlate)).toBe(1);
    expect(inv.count(ItemId.StoneFurnace)).toBe(1);
    expect(f.table.count).toBe(0);
    expect(f.table.activeCount).toBe(0);
    // The machines system copes with the furnace being gone.
    f.step(5);
  });

  it('keeps rows straight when a furnace in the middle is removed', () => {
    const f = setup([{ item: ItemId.StoneFurnace, count: 2 }]);
    const { state } = f.sim;
    placeEntity(state, 0, ItemId.StoneFurnace, -3, 0, Direction.North);
    placeEntity(state, 0, ItemId.StoneFurnace, 0, 3, Direction.North);
    const [a, b, c] = [f.id, state.entities.at(-3, 0), state.entities.at(0, 3)];
    f.entities.insert(a, ItemId.Coal, 1);
    f.entities.insert(b, ItemId.Coal, 2);
    f.entities.insert(c, ItemId.Wood, 3);
    f.entities.insert(c, ItemId.CopperOre, 1);
    f.entities.insert(b, ItemId.IronOre, 2);
    f.step(1);
    expect(removeEntity(state, 0, 2, 0)).toBe(BuildResult.Ok);
    expect(f.entities.slots(b).map((s) => s.count)).toEqual([1, 1, 0]);
    expect(f.entities.slots(c)).toEqual([
      { item: 0, count: 0 },
      { item: ItemId.Wood, count: 2 },
      { item: 0, count: 0 },
    ]);
    f.step(PLATE_TICKS - 1);
    expect(f.entities.slots(b)[FurnaceSlot.Output]).toEqual({ item: ItemId.IronPlate, count: 1 });
    expect(f.entities.slots(c)[FurnaceSlot.Output]).toEqual({
      item: ItemId.CopperPlate,
      count: 1,
    });
    expect(f.table.activeCount).toBe(2);
  });
});

/** A table for inserters that records its wake-ups. */
class WakeLog implements EntityTypeTable {
  readonly type = EntityTypeId.BurnerInserter;
  readonly woken: number[] = [];
  add(): void {}
  remove(): void {}
  contents(): readonly ItemStack[] {
    return [];
  }
  wake(id: number): void {
    this.woken.push(id);
  }
  hashInto(h: number): number {
    return h;
  }
}

describe('contents changes', () => {
  it('wake the entities subscribed to a furnace or chest', () => {
    const sim = new Sim({ seed: 1 });
    sim.state.players.x[0] = tileCenter(0);
    sim.state.players.y[0] = tileCenter(0);
    const log = new WakeLog();
    const entities = new Entities([new ChestTable(), new FurnaceTable(), log]);
    const state: SimState = { ...sim.state, entities };
    placeEntity(state, 0, ItemId.StoneFurnace, 2, 0, Direction.North);
    placeEntity(state, 0, ItemId.WoodenChest, -2, 0, Direction.North);
    placeEntity(state, 0, ItemId.BurnerInserter, -2, 2, Direction.North);
    const [furnace, chest, inserter] = [1, 2, 3];
    entities.wake.watch(inserter, furnace);
    entities.wake.watch(inserter, chest);
    entities.insert(chest, ItemId.Coal, 1);
    expect(log.woken).toEqual([inserter]);
    // Nothing moved: nobody is woken.
    expect(entities.insert(chest, 999, 1)).toBe(0);
    expect(entities.take(chest, 5, 1)).toBe(0);
    expect(log.woken).toHaveLength(1);
    entities.insert(furnace, ItemId.Coal, 1);
    entities.insert(furnace, ItemId.IronOre, 1);
    expect(log.woken).toHaveLength(3);
    const table = furnaceTable(entities)!;
    // Starting the plate burns a coal and takes the ore; finishing it fills the output.
    table.update(entities);
    expect(log.woken).toHaveLength(5);
    for (let i = 1; i < PLATE_TICKS; i++) table.update(entities);
    expect(log.woken).toHaveLength(6);
    expect(entities.slots(furnace)[FurnaceSlot.Output]!.count).toBe(1);
  });
});

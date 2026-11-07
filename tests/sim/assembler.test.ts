import { describe, expect, it } from 'vitest';
import {
  ENTITIES,
  EntityTypeId,
  SAT_ONE,
  craftingTicks,
  type RealEntityTypeId,
} from '../../src/data/entities';
import { ItemId, type ItemStack } from '../../src/data/items';
import {
  ASSEMBLER_MAX_INPUTS,
  ASSEMBLER_MAX_OUTPUTS,
  ASSEMBLER_RECIPES,
  HAND_RECIPES,
  RECIPES,
  RecipeId,
  recipePrototype,
} from '../../src/data/recipes';
import { ResourceId } from '../../src/data/resources';
import { assemblerTable } from '../../src/sim/entities/assembler';
import { BuildResult, placeEntity, removeEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { electricInserterTable } from '../../src/sim/entities/electricInserter';
import { InserterState } from '../../src/sim/entities/inserter';
import { MachineState } from '../../src/sim/entities/machine';
import { createEntityTables } from '../../src/sim/entities/registry';
import type { EntityTypeTable } from '../../src/sim/entities/table';
import { TransferResult, insertIntoEntity, setEntityRecipe } from '../../src/sim/entities/transfer';
import { tileCenter } from '../../src/sim/fixed';
import { powerGrid } from '../../src/sim/power/grid';
import { forceOf, isRecipeUnlocked } from '../../src/sim/research/unlocks';
import { TECH_IDS, TechId, unlockingTechnology } from '../../src/data/technologies';
import {
  ENTITY_STRIDE,
  EntityField,
  decodeEntityDetail,
  displayStatus,
  encodeEntities,
  encodeEntityDetail,
} from '../../src/sim/snapshot';
import { Sim } from '../../src/sim/tick';
import { CHUNK_MASK, CHUNK_SHIFT, tileIndex } from '../../src/sim/world/chunk';

const { North, East } = Direction;
const PLATE = ItemId.IronPlate;
const GEAR = ItemId.IronGearWheel;
const AM1 = EntityTypeId.AssemblingMachine1;
const AM2 = EntityTypeId.AssemblingMachine2;

/** A fake power producer (on the steam engine's footprint) offering exactly what the test sets. */
class FakeProducers implements EntityTypeTable {
  readonly type = EntityTypeId.SteamEngine;
  readonly max = new Map<number, number>();
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
  powerDraw(): void {}
}

/**
 * A sim whose player 0 stands on tile (0, 0) with plenty of everything, a
 * fake producer table, no resources around the spawn, and helpers.
 */
function setup(kit: ItemStack[] = []) {
  const producers = new FakeProducers();
  const sim = new Sim({
    seed: 1,
    startingKit: [
      { item: ItemId.AssemblingMachine1, count: 4 },
      { item: ItemId.AssemblingMachine2, count: 4 },
      { item: ItemId.ElectricInserter, count: 10 },
      { item: ItemId.SmallElectricPole, count: 10 },
      { item: ItemId.WoodenChest, count: 10 },
      { item: PLATE, count: 200 },
      ...kit,
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
  const addProducer = (x: number, y: number, max: number) => {
    const id = entities.add(ENTITIES[EntityTypeId.SteamEngine], x, y, North);
    producers.max.set(id, max);
    return id;
  };
  const count = (id: number, item: number) =>
    entities.contents(id).reduce((n, s) => n + (s.item === item ? s.count : 0), 0);
  const inventory = state.players.inventory(0);
  return {
    sim,
    state,
    entities,
    grid: powerGrid(entities)!,
    producers,
    place,
    addProducer,
    count,
    inventory,
    step: (n = 1) => {
      for (let i = 0; i < n; i++) sim.step();
    },
  };
}

/**
 * An assembling machine of type `type` on (2..4, 0..2), set to `recipe`, a
 * pole on (1, 4) over it, and a fake producer on (-3..-1, 3..7) offering
 * `supply` J/tick (none for `null`) on the pole's network.
 */
function rig(
  options: {
    type?: RealEntityTypeId;
    recipe?: number;
    supply?: number | null;
    pole?: boolean;
    kit?: ItemStack[];
  } = {},
) {
  const s = setup(options.kit);
  const type = options.type ?? AM1;
  const proto = ENTITIES[type];
  const id = s.place(proto.item, 2, 0);
  const table = assemblerTable(s.entities, type)!;
  const pole = options.pole === false ? 0 : s.place(ItemId.SmallElectricPole, 1, 4);
  const supply = options.supply === undefined ? (proto.energyPerTick ?? 0) : options.supply;
  const producer = supply === null ? 0 : s.addProducer(-3, 3, supply);
  const recipe = options.recipe ?? RecipeId.IronGearWheel;
  if (recipe !== 0) expect(setEntityRecipe(s.state, 0, id, recipe)).toBe(TransferResult.Ok);
  return { ...s, id, table, pole, producer, proto };
}

/** Ticks (0-based, counted from the first step) on which `value()` changed, over `ticks` steps. */
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

/** Ticks on which machine `r.id` finished a craft over `ticks` ticks, its inputs kept topped up. */
function craftTicks(r: ReturnType<typeof rig>, ticks: number): number[] {
  const recipe = recipePrototype(r.entities.selectedRecipe(r.id))!;
  const fed = () => {
    for (const [item, count] of recipe.inputs) r.entities.insert(r.id, item, count * 2);
    r.step();
  };
  const product = recipe.outputs[0]![0];
  let made = 0;
  return changes(ticks, fed, () => {
    // Keep the output from filling up: count what was taken.
    const n = r.count(r.id, product);
    const slot = r.entities.outputSlot(r.id);
    if (slot >= 0) {
      made += r.entities.take(r.id, slot, n);
    }
    return made;
  });
}

describe('shared M3 assembler numbers', () => {
  it('live in src/data', () => {
    const am1 = ENTITIES[AM1];
    const am2 = ENTITIES[AM2];
    for (const p of [am1, am2]) {
      expect([p.width, p.height, p.rotatable, p.energySource]).toEqual([3, 3, false, 'electric']);
    }
    expect(am1.energyPerTick).toBe(1_250);
    expect(am2.energyPerTick).toBe(2_500);
    expect(am1.craftingSpeed).toEqual({ num: 1, den: 2 });
    expect(am2.craftingSpeed).toEqual({ num: 3, den: 4 });
    // Recipe ticks × 2, and × 4/3 rounded up.
    expect(craftingTicks(30, am1.craftingSpeed)).toBe(60);
    expect(craftingTicks(30, am2.craftingSpeed)).toBe(40);
    expect(craftingTicks(120, am2.craftingSpeed)).toBe(160);
    expect(craftingTicks(25, am2.craftingSpeed)).toBe(34);
    expect(craftingTicks(30, undefined)).toBe(30);
  });

  it('have hand recipes for both machines', () => {
    const r1 = RECIPES[RecipeId.AssemblingMachine1];
    const r2 = RECIPES[RecipeId.AssemblingMachine2];
    expect(r1).toMatchObject({
      inputs: [
        [ItemId.ElectronicCircuit, 3],
        [GEAR, 5],
        [PLATE, 9],
      ],
      outputs: [[ItemId.AssemblingMachine1, 1]],
      ticks: 30,
      category: 'hand',
    });
    expect(r2).toMatchObject({
      inputs: [
        [ItemId.ElectronicCircuit, 2],
        [GEAR, 5],
        [PLATE, 20],
        [ItemId.AssemblingMachine1, 1],
      ],
      outputs: [[ItemId.AssemblingMachine2, 1]],
      ticks: 30,
      category: 'hand',
    });
    expect(HAND_RECIPES).toContain(r1);
    expect(HAND_RECIPES).toContain(r2);
  });

  it('make every recipe but smelting, and every such recipe fits their slots', () => {
    expect(ASSEMBLER_RECIPES.map((r) => r.id)).toEqual(HAND_RECIPES.map((r) => r.id));
    expect(ASSEMBLER_RECIPES.map((r) => r.id)).not.toContain(RecipeId.IronPlate);
    for (const r of ASSEMBLER_RECIPES) {
      expect(r.inputs.length).toBeLessThanOrEqual(ASSEMBLER_MAX_INPUTS);
      expect(r.outputs.length).toBeLessThanOrEqual(ASSEMBLER_MAX_OUTPUTS);
      // Each slot holds one item: no recipe lists an item twice.
      expect(new Set(r.inputs.map(([item]) => item)).size).toBe(r.inputs.length);
    }
  });
});

describe('assembling machine crafting', () => {
  it.each([
    { name: 'machine 1 at satisfaction 1', type: AM1, half: false, every: 60 },
    { name: 'machine 1 at satisfaction 1/2', type: AM1, half: true, every: 120 },
    { name: 'machine 2 at satisfaction 1', type: AM2, half: false, every: 40 },
    { name: 'machine 2 at satisfaction 1/2', type: AM2, half: true, every: 80 },
  ])('makes a gear every $every ticks: $name', ({ type, half, every }) => {
    const draw = ENTITIES[type].energyPerTick!;
    const r = rig({ type, supply: half ? draw / 2 : draw });
    // The first craft starts on tick 0 and is done on its last tick.
    expect(craftTicks(r, 4 * every)).toEqual([
      every - 1,
      2 * every - 1,
      3 * every - 1,
      4 * every - 1,
    ]);
    expect(r.grid.satisfaction(r.id)).toBe(half ? SAT_ONE / 2 : SAT_ONE);
    expect(r.grid.member(r.id)!.demand).toBe(draw);
    expect(displayStatus(r.state, r.id)).toBe(half ? MachineState.LowPower : MachineState.Working);
  });

  it('takes the ingredients when a craft starts and gives the products when it ends', () => {
    const r = rig();
    expect(r.entities.insert(r.id, PLATE, 3)).toBe(3);
    r.step();
    expect(r.table.crafting(r.id)).toBe(true);
    expect(r.entities.slots(r.id)).toEqual([
      { item: PLATE, count: 1 },
      { item: 0, count: 0 },
    ]);
    // A craft in progress counts as contents (refunded on removal).
    expect(r.count(r.id, PLATE)).toBe(3);
    expect(r.table.rawProgress(r.id)).toBe(SAT_ONE);
    r.step(59);
    expect(r.entities.slots(r.id)).toEqual([
      { item: PLATE, count: 1 },
      { item: GEAR, count: 1 },
    ]);
    // One plate is not enough for another: it sleeps, asking for no power.
    r.step();
    expect(r.entities.status(r.id)).toBe(MachineState.NoInput);
    expect(r.table.activeCount).toBe(0);
    r.step();
    expect(r.grid.member(r.id)!.demand).toBe(0);
  });

  it('limits each input slot to twice the recipe, from inserters and by hand alike', () => {
    const r = rig({ pole: false, supply: null });
    expect(r.entities.accepts(r.id, PLATE)).toBe(true);
    expect(r.entities.accepts(r.id, ItemId.CopperPlate)).toBe(false);
    expect(r.entities.insertable(r.id, PLATE)).toBe(4);
    expect(r.entities.insert(r.id, PLATE, 10)).toBe(4);
    expect(r.entities.insertable(r.id, PLATE)).toBe(0);
    expect(r.entities.insert(r.id, PLATE, 1)).toBe(0);
    expect(r.entities.insert(r.id, ItemId.CopperPlate, 1)).toBe(0);
    // The hand's Insert command goes through the same hook: nothing more fits.
    expect(insertIntoEntity(r.state, 0, r.id, PLATE, 50)).toBe(TransferResult.NoRoom);
    expect(r.inventory.count(PLATE)).toBe(200);
    // A four-ingredient recipe: 2 × 20 plates, 2 × 1 machine (behind research).
    r.state.research.markResearched(0, TechId.Automation2);
    expect(setEntityRecipe(r.state, 0, r.id, RecipeId.AssemblingMachine2)).toBe(TransferResult.Ok);
    expect(r.inventory.count(PLATE)).toBe(204);
    expect(insertIntoEntity(r.state, 0, r.id, PLATE, 100)).toBe(TransferResult.Ok);
    expect(r.inventory.count(PLATE)).toBe(164);
    expect(r.entities.insertable(r.id, ItemId.AssemblingMachine1)).toBe(2);
    expect(r.entities.insertable(r.id, ItemId.ElectronicCircuit)).toBe(4);
    expect(r.entities.insertable(r.id, GEAR)).toBe(10);
    expect(r.entities.slots(r.id).map((s) => s.count)).toEqual([0, 0, 40, 0, 0]);
    // Without power it never starts: NoPower, and it stays on the active list.
    expect(r.entities.insert(r.id, ItemId.AssemblingMachine1, 1)).toBe(1);
    r.inventory.add(ItemId.ElectronicCircuit, 2);
    r.inventory.add(GEAR, 5);
    expect(insertIntoEntity(r.state, 0, r.id, ItemId.ElectronicCircuit, 2)).toBe(TransferResult.Ok);
    expect(insertIntoEntity(r.state, 0, r.id, GEAR, 5)).toBe(TransferResult.Ok);
    r.step(3);
    expect(r.entities.status(r.id)).toBe(MachineState.NoPower);
    expect(r.table.activeCount).toBe(1);
    expect(r.table.crafting(r.id)).toBe(false);
  });

  it('stops while the output slot has no room for another craft, and goes on once it has', () => {
    const r = rig({ supply: 100_000 });
    // Gears stack to 100: a hundred crafts fill the slot.
    const filled = changes(
      60 * 102,
      () => {
        r.entities.insert(r.id, PLATE, 4);
        r.step();
      },
      () => r.count(r.id, GEAR),
    );
    expect(filled).toHaveLength(100);
    expect(filled.at(-1)).toBe(60 * 100 - 1);
    expect(r.entities.slots(r.id)[1]).toEqual({ item: GEAR, count: 100 });
    expect(r.entities.status(r.id)).toBe(MachineState.OutputFull);
    expect(r.table.activeCount).toBe(0);
    expect(r.grid.member(r.id)!.demand).toBe(0);
    expect(r.entities.slots(r.id)[0]).toEqual({ item: PLATE, count: 4 });
    // Taking one gear makes room for one craft.
    expect(r.entities.take(r.id, r.entities.outputSlot(r.id), 1)).toBe(1);
    r.step();
    expect(r.table.crafting(r.id)).toBe(true);
    r.step(60);
    expect(r.entities.slots(r.id)[1]).toEqual({ item: GEAR, count: 100 });
    expect(r.entities.status(r.id)).toBe(MachineState.OutputFull);
  });

  it('is NoRecipe without a recipe, takes nothing and has no slots', () => {
    const r = rig({ recipe: 0 });
    r.step();
    expect(r.entities.status(r.id)).toBe(MachineState.NoRecipe);
    expect(r.entities.slots(r.id)).toEqual([]);
    expect(r.entities.accepts(r.id, PLATE)).toBe(false);
    expect(r.entities.insert(r.id, PLATE, 1)).toBe(0);
    expect(r.entities.outputSlot(r.id)).toBe(-1);
    expect(r.grid.member(r.id)!.demand).toBe(0);
    expect(r.table.activeCount).toBe(0);
  });
});

describe('SetRecipe', () => {
  it('refunds the slots and the craft in progress, and is refused if the refund does not fit', () => {
    const r = rig({ supply: 100_000 });
    r.entities.insert(r.id, PLATE, 4);
    r.step(70);
    // One gear made, the second craft under way, nothing in the input slot.
    expect(r.table.crafting(r.id)).toBe(true);
    expect(r.entities.slots(r.id)).toEqual([
      { item: 0, count: 0 },
      { item: GEAR, count: 1 },
    ]);
    const plates = r.inventory.count(PLATE);
    // An inventory with no free slot (and full stacks): refused, nothing changes.
    const full = setup();
    const inv = full.inventory;
    inv.clear();
    for (let i = 0; i < inv.slots; i++) inv.add(ItemId.Stone, 50);
    const hash = r.sim.hash();
    // Swap the inventories' contents for the check (same player id 0 in each sim).
    const saved = Array.from(r.inventory.items);
    const savedCounts = Array.from(r.inventory.counts);
    r.inventory.items.set(inv.items);
    r.inventory.counts.set(inv.counts);
    expect(setEntityRecipe(r.state, 0, r.id, RecipeId.CopperCable)).toBe(TransferResult.NoRoom);
    expect(r.entities.selectedRecipe(r.id)).toBe(RecipeId.IronGearWheel);
    r.inventory.items.set(saved);
    r.inventory.counts.set(savedCounts);
    expect(r.sim.hash()).toBe(hash);
    // With room: the gear and the two plates of the craft come back.
    r.sim.enqueue({
      tick: r.sim.tick,
      playerId: 0,
      type: 'SetRecipe',
      entity: r.id,
      recipe: RecipeId.CopperCable,
    });
    r.step();
    expect(r.entities.selectedRecipe(r.id)).toBe(RecipeId.CopperCable);
    expect(r.inventory.count(PLATE)).toBe(plates + 2);
    expect(r.inventory.count(GEAR)).toBe(1);
    expect(r.table.crafting(r.id)).toBe(false);
    expect(r.entities.slots(r.id)).toEqual([
      { item: 0, count: 0 },
      { item: 0, count: 0 },
    ]);
    expect(r.entities.status(r.id)).toBe(MachineState.NoInput);
    // Recipe 0 clears it.
    expect(setEntityRecipe(r.state, 0, r.id, 0)).toBe(TransferResult.Ok);
    expect(r.entities.status(r.id)).toBe(MachineState.NoRecipe);
  });

  it('ignores recipes the machine cannot make, other entities, and players out of reach', () => {
    const r = rig();
    const chest = r.place(ItemId.WoodenChest, 6, 0);
    expect(setEntityRecipe(r.state, 0, r.id, RecipeId.IronPlate)).toBe(TransferResult.BadRecipe);
    expect(setEntityRecipe(r.state, 0, r.id, 999)).toBe(TransferResult.BadRecipe);
    expect(setEntityRecipe(r.state, 0, chest, RecipeId.IronGearWheel)).toBe(
      TransferResult.BadRecipe,
    );
    expect(setEntityRecipe(r.state, 0, 12_345, RecipeId.IronGearWheel)).toBe(
      TransferResult.NoEntity,
    );
    // The same recipe again changes nothing (no refund either).
    r.entities.insert(r.id, PLATE, 4);
    expect(setEntityRecipe(r.state, 0, r.id, RecipeId.IronGearWheel)).toBe(TransferResult.Ok);
    expect(r.count(r.id, PLATE)).toBe(4);
    r.state.players.x[0] = tileCenter(-30);
    expect(setEntityRecipe(r.state, 0, r.id, RecipeId.CopperCable)).toBe(TransferResult.OutOfReach);
    expect(r.entities.selectedRecipe(r.id)).toBe(RecipeId.IronGearWheel);
  });

  it('only offers recipes that are unlocked', () => {
    const r = rig();
    const locked = ASSEMBLER_RECIPES.filter((x) => unlockingTechnology(x.id) !== TechId.None);
    expect(locked.map((x) => x.id)).toContain(RecipeId.AssemblingMachine1);
    for (const recipe of ASSEMBLER_RECIPES) {
      expect(isRecipeUnlocked(r.state, 0, recipe.id)).toBe(!locked.includes(recipe));
    }
    expect(isRecipeUnlocked(r.state, 0, 999)).toBe(false);
    expect(isRecipeUnlocked(r.state, forceOf(r.state, 7), RecipeId.IronGearWheel)).toBe(false);
    // A locked recipe is refused, and works once researched.
    expect(setEntityRecipe(r.state, 0, r.id, RecipeId.AssemblingMachine1)).toBe(
      TransferResult.BadRecipe,
    );
    expect(r.entities.selectedRecipe(r.id)).toBe(RecipeId.IronGearWheel);
    const options = () =>
      decodeEntityDetail(encodeEntityDetail(r.state, 0, r.id)!.buffer).recipeOptions;
    expect(options()).toEqual(
      ASSEMBLER_RECIPES.filter((x) => !locked.includes(x)).map((x) => x.id),
    );
    for (const tech of TECH_IDS) r.state.research.markResearched(0, tech);
    expect(options()).toEqual(ASSEMBLER_RECIPES.map((x) => x.id));
    expect(setEntityRecipe(r.state, 0, r.id, RecipeId.AssemblingMachine1)).toBe(TransferResult.Ok);
    expect(setEntityRecipe(r.state, 0, r.id, RecipeId.IronGearWheel)).toBe(TransferResult.Ok);
    r.entities.insert(r.id, PLATE, 3);
    const detail = decodeEntityDetail(encodeEntityDetail(r.state, 0, r.id)!.buffer);
    expect(detail.recipe).toBe(RecipeId.IronGearWheel);
    expect(detail.slots).toEqual([
      { item: PLATE, count: 3 },
      { item: 0, count: 0 },
    ]);
    const chest = r.place(ItemId.WoodenChest, 6, 0);
    expect(decodeEntityDetail(encodeEntityDetail(r.state, 0, chest)!.buffer).recipeOptions).toEqual(
      [],
    );
    // The renderer gets each machine's recipe with the entity records.
    const records = encodeEntities(r.state, { cx0: -1, cy0: -1, cx1: 0, cy1: 0 });
    const ids: number[] = [];
    for (let o = 0; o < records.length; o += ENTITY_STRIDE) {
      if (records[o + EntityField.id] === r.id) ids.push(records[o + EntityField.recipe]!);
    }
    expect(ids).toEqual([RecipeId.IronGearWheel]);
  });

  it('refunds a craft in progress when the machine is removed', () => {
    const r = rig({ supply: 100_000 });
    r.entities.insert(r.id, PLATE, 3);
    r.step(5);
    const plates = r.inventory.count(PLATE);
    expect(removeEntity(r.state, 0, 2, 0)).toBe(BuildResult.Ok);
    expect(r.inventory.count(PLATE)).toBe(plates + 3);
    expect(r.inventory.count(ItemId.AssemblingMachine1)).toBe(4);
    expect(r.table.count).toBe(0);
  });

  it('hashes the recipe, slots and progress', () => {
    const a = rig();
    const b = rig();
    expect(a.sim.hash()).toBe(b.sim.hash());
    a.entities.insert(a.id, PLATE, 1);
    expect(a.sim.hash()).not.toBe(b.sim.hash());
    b.entities.insert(b.id, PLATE, 1);
    expect(a.sim.hash()).toBe(b.sim.hash());
    setEntityRecipe(a.state, 0, a.id, RecipeId.CopperCable);
    setEntityRecipe(b.state, 0, b.id, RecipeId.TransportBelt);
    expect(a.sim.hash()).not.toBe(b.sim.hash());
  });
});

describe('assembling machines with inserters', () => {
  /**
   * Chest on (0, 1) with `plates` plates → electric inserter on (1, 1) →
   * assembling machine 1 on (2..4, 0..2), set to gears → electric inserter
   * on (5, 1) → chest on (6, 1). Poles on (1, 3) and (5, 3); a producer
   * with plenty of power on (-3..-1, 3..7).
   */
  function chain(plates: number, recipe: number = RecipeId.IronGearWheel) {
    const s = setup();
    const source = s.place(ItemId.WoodenChest, 0, 1);
    const feed = s.place(ItemId.ElectricInserter, 1, 1, East);
    const id = s.place(ItemId.AssemblingMachine1, 2, 0);
    const take = s.place(ItemId.ElectricInserter, 5, 1, East);
    const target = s.place(ItemId.WoodenChest, 6, 1);
    s.place(ItemId.SmallElectricPole, 1, 3);
    s.place(ItemId.SmallElectricPole, 5, 3);
    s.addProducer(-3, 3, 100_000);
    if (recipe !== 0) setEntityRecipe(s.state, 0, id, recipe);
    s.entities.insert(source, PLATE, plates);
    const table = assemblerTable(s.entities, AM1)!;
    const inserters = electricInserterTable(s.entities)!;
    return { ...s, source, feed, id, take, target, table, inserters };
  }

  it('turns plates from a chest into gears in another chest, conserving every plate', () => {
    const c = chain(40);
    const total = () =>
      [c.source, c.feed, c.id, c.take, c.target].reduce(
        (n, e) => n + c.count(e, PLATE) + 2 * c.count(e, GEAR),
        0,
      );
    for (let t = 0; t < 3_000; t++) {
      c.step();
      expect(total()).toBe(40);
    }
    // 20 gears; the feeding inserter (52 ticks a plate) sets the pace.
    expect(c.count(c.target, GEAR)).toBe(20);
    expect(c.count(c.source, PLATE)).toBe(0);
    // Everything sleeps: the machine asks for nothing, the inserters for their drain.
    expect(c.entities.status(c.id)).toBe(MachineState.NoInput);
    expect(c.table.activeCount).toBe(0);
    expect(c.grid.member(c.id)!.demand).toBe(0);
    expect(c.entities.status(c.feed)).toBe(InserterState.WaitingForSource);
    expect(c.entities.status(c.take)).toBe(InserterState.WaitingForSource);
  });

  it('starts a craft as soon as an inserter drops its last ingredient, moving from the next tick', () => {
    const c = chain(2);
    // The inserter drops the first plate at the end of its swing, the second one a cycle later.
    let started = -1;
    for (let t = 0; t < 200 && started < 0; t++) {
      c.step();
      if (c.table.crafting(c.id)) started = t;
    }
    expect(started).toBeGreaterThan(0);
    // Woken after the power step: the ingredients are taken, but no progress yet.
    expect(c.table.rawProgress(c.id)).toBe(0);
    expect(c.entities.status(c.id)).toBe(MachineState.Working);
    c.step();
    expect(c.table.rawProgress(c.id)).toBe(SAT_ONE);
    expect(c.grid.member(c.id)!.demand).toBe(1_250);
  });

  it('takes several ingredients from one mixed chest without getting stuck holding one (D45)', () => {
    const c = chain(0, 0);
    c.state.research.markResearched(0, TechId.LogisticSciencePack);
    expect(setEntityRecipe(c.state, 0, c.id, RecipeId.LogisticSciencePack)).toBe(TransferResult.Ok);
    // The inserters come first in the chest, so a pickup that ignored the
    // machine's room would fill its inserter slot, then hold a third
    // inserter forever while the belt slot stays empty.
    c.entities.insert(c.source, ItemId.ElectricInserter, 4);
    c.entities.insert(c.source, ItemId.TransportBelt, 4);
    const ticks = craftingTicks(RECIPES[RecipeId.LogisticSciencePack].ticks, { num: 1, den: 2 });
    c.step(4 * ticks + 600);
    expect(c.count(c.target, ItemId.LogisticSciencePack)).toBe(4);
    expect(
      c.count(c.source, ItemId.ElectricInserter) + c.count(c.source, ItemId.TransportBelt),
    ).toBe(0);
    // While the machine had no room, the inserter slept on both the chest and the machine.
    c.entities.insert(c.source, ItemId.ElectricInserter, 5);
    c.step(400);
    expect(c.count(c.id, ItemId.ElectricInserter)).toBe(2);
    expect(c.inserters.hand(c.feed).held).toBe(0);
    expect(c.entities.status(c.feed)).toBe(InserterState.WaitingForSource);
    expect(c.entities.wake.watchersOf(c.id)).toContain(c.feed);
    expect(c.inserters.activeCount).toBe(0);
    // Once a belt arrives the machine starts a craft, and the inserter tops its slot up again.
    c.entities.insert(c.source, ItemId.TransportBelt, 1);
    c.step(400);
    expect(c.table.crafting(c.id)).toBe(true);
    expect(c.entities.slots(c.id)[0]).toEqual({ item: ItemId.ElectricInserter, count: 2 });
    expect(c.count(c.source, ItemId.ElectricInserter)).toBe(2);
  });

  it('wakes the inserters around it when its recipe changes', () => {
    const c = chain(10, 0);
    c.step(5);
    // Nothing the machine takes yet: the feeding inserter waits on its source.
    expect(c.entities.status(c.feed)).toBe(InserterState.WaitingForSource);
    expect(c.inserters.activeCount).toBe(0);
    setEntityRecipe(c.state, 0, c.id, RecipeId.IronGearWheel);
    c.step(200);
    expect(c.count(c.id, PLATE) + c.count(c.target, GEAR)).toBeGreaterThan(0);
    expect(c.count(c.source, PLATE)).toBeLessThan(10);
  });
});

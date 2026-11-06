import { describe, expect, it } from 'vitest';
import { ItemId, type ItemStack } from '../../src/data/items';
import { RECIPES, RecipeId } from '../../src/data/recipes';
import { countItems, maxCraftable, planCraft } from '../../src/sim/crafting/plan';
import { CRAFT_QUEUE_LENGTH, CraftFlag } from '../../src/sim/crafting/queue';
import { validateCommandInput, type CommandInput } from '../../src/sim/commands';
import { Inventory } from '../../src/sim/inventory';
import { decodeCraftQueue, encodeCraftQueue } from '../../src/sim/snapshot';
import { Sim } from '../../src/sim/tick';

const SEED = 7;

function sim(kit: readonly ItemStack[], players = 1): Sim {
  return new Sim({ seed: SEED, players, startingKit: kit });
}

/** Runs `cmd` on the next tick (which also advances crafting by one tick). */
function run(s: Sim, cmd: CommandInput): void {
  s.enqueue({ ...cmd, tick: s.tick });
  s.step();
}

function steps(s: Sim, n: number): void {
  for (let i = 0; i < n; i++) s.step();
}

const inv = (s: Sim, id = 0) => s.state.players.inventory(id);

/** The queue of player `id` as `[recipe, crafts, intermediate]` triples. */
function queue(s: Sim, id = 0): [number, number, boolean][] {
  return decodeCraftQueue(encodeCraftQueue(s.state, id).buffer).entries.map((e) => [
    e.recipe,
    e.crafts,
    (e.flags & CraftFlag.Intermediate) !== 0,
  ]);
}

describe('crafting commands', () => {
  it('validate their fields', () => {
    expect(validateCommandInput({ playerId: 0, type: 'Craft', recipe: 3, count: 5 })).toBeNull();
    expect(
      validateCommandInput({ playerId: 0, type: 'Craft', recipe: 3, count: 0 }),
    ).not.toBeNull();
    expect(
      validateCommandInput({ playerId: 0, type: 'Craft', recipe: -1, count: 1 }),
    ).not.toBeNull();
    expect(
      validateCommandInput({ playerId: 0, type: 'Craft', recipe: 1, count: 0x10000 }),
    ).not.toBeNull();
    expect(validateCommandInput({ playerId: 0, type: 'CancelCraft', index: 0 })).toBeNull();
    expect(validateCommandInput({ playerId: 0, type: 'CancelCraft', index: 1.5 })).not.toBeNull();
  });
});

describe('hand-crafting', () => {
  it('reserves the inputs when queued and takes exactly `ticks` ticks per craft', () => {
    const s = sim([{ item: ItemId.Stone, count: 12 }]);
    run(s, { playerId: 0, type: 'Craft', recipe: RecipeId.StoneFurnace, count: 2 });
    // Inputs are gone at once; the queue holds the craft.
    expect(inv(s).count(ItemId.Stone)).toBe(2);
    expect(queue(s)).toEqual([[RecipeId.StoneFurnace, 2, false]]);
    // The command's tick counts as the first tick of the craft: 30 ticks in all.
    steps(s, 28);
    expect(inv(s).count(ItemId.StoneFurnace)).toBe(0);
    expect(s.state.crafting.progress[0]).toBe(29);
    s.step();
    expect(inv(s).count(ItemId.StoneFurnace)).toBe(1);
    expect(s.state.crafting.progress[0]).toBe(0);
    steps(s, 29);
    expect(inv(s).count(ItemId.StoneFurnace)).toBe(1);
    s.step();
    expect(inv(s).count(ItemId.StoneFurnace)).toBe(2);
    expect(queue(s)).toEqual([]);
    expect(s.tick).toBe(60);
  });

  it('queues only what the inventory allows, and ignores what it cannot', () => {
    const s = sim([
      { item: ItemId.IronPlate, count: 5 },
      { item: ItemId.Stone, count: 4 },
    ]);
    run(s, { playerId: 0, type: 'Craft', recipe: RecipeId.IronGearWheel, count: 10 });
    expect(queue(s)).toEqual([[RecipeId.IronGearWheel, 2, false]]);
    expect(inv(s).count(ItemId.IronPlate)).toBe(1);
    const hash = s.hash();
    // Not enough stone, an unknown recipe, a smelting recipe: all ignored.
    s.enqueue({
      tick: s.tick,
      playerId: 0,
      type: 'Craft',
      recipe: RecipeId.StoneFurnace,
      count: 1,
    });
    s.enqueue({ tick: s.tick, playerId: 0, type: 'Craft', recipe: 999, count: 1 });
    s.enqueue({ tick: s.tick, playerId: 0, type: 'Craft', recipe: RecipeId.IronPlate, count: 1 });
    s.enqueue({ tick: s.tick, playerId: 0, type: 'CancelCraft', index: 5 });
    const twin = sim([
      { item: ItemId.IronPlate, count: 5 },
      { item: ItemId.Stone, count: 4 },
    ]);
    run(twin, { playerId: 0, type: 'Craft', recipe: RecipeId.IronGearWheel, count: 10 });
    expect(twin.hash()).toBe(hash);
    s.step();
    twin.step();
    expect(s.hash()).toBe(twin.hash());
  });

  it('auto-queues intermediates before the craft that needs them', () => {
    const s = sim([
      { item: ItemId.IronPlate, count: 20 },
      { item: ItemId.Stone, count: 7 },
    ]);
    run(s, { playerId: 0, type: 'Craft', recipe: RecipeId.BurnerMiningDrill, count: 1 });
    expect(queue(s)).toEqual([
      [RecipeId.IronGearWheel, 3, true],
      [RecipeId.StoneFurnace, 1, true],
      [RecipeId.BurnerMiningDrill, 1, false],
    ]);
    // 3 gears (6 plates) + 3 plates, 5 stone.
    expect(inv(s).count(ItemId.IronPlate)).toBe(11);
    expect(inv(s).count(ItemId.Stone)).toBe(2);
    // 3 × 30 + 30 + 120 ticks; the intermediates never show up in the inventory.
    steps(s, 3 * 30 + 30 - 1);
    expect(queue(s)).toEqual([[RecipeId.BurnerMiningDrill, 1, false]]);
    expect(inv(s).count(ItemId.IronGearWheel)).toBe(0);
    expect(inv(s).count(ItemId.StoneFurnace)).toBe(0);
    steps(s, 119);
    expect(inv(s).count(ItemId.BurnerMiningDrill)).toBe(0);
    s.step();
    expect(inv(s).count(ItemId.BurnerMiningDrill)).toBe(1);
    expect(s.tick).toBe(240);
    expect(queue(s)).toEqual([]);
  });

  it('uses what the inventory has before queueing intermediates', () => {
    const s = sim([
      { item: ItemId.IronPlate, count: 5 },
      { item: ItemId.IronGearWheel, count: 2 },
      { item: ItemId.StoneFurnace, count: 1 },
    ]);
    run(s, { playerId: 0, type: 'Craft', recipe: RecipeId.BurnerMiningDrill, count: 3 });
    // Only one drill: 2 gears + 1 made from 2 plates, then 3 plates.
    expect(queue(s)).toEqual([
      [RecipeId.IronGearWheel, 1, true],
      [RecipeId.BurnerMiningDrill, 1, false],
    ]);
    expect(inv(s).count(ItemId.IronPlate)).toBe(0);
    expect(inv(s).count(ItemId.IronGearWheel)).toBe(0);
    expect(inv(s).count(ItemId.StoneFurnace)).toBe(0);
  });

  it('refunds a cancelled craft, including what its intermediates already made', () => {
    const kit = [
      { item: ItemId.IronPlate, count: 20 },
      { item: ItemId.Stone, count: 7 },
    ];
    const s = sim(kit);
    run(s, { playerId: 0, type: 'Craft', recipe: RecipeId.BurnerMiningDrill, count: 1 });
    run(s, { playerId: 0, type: 'Craft', recipe: RecipeId.IronGearWheel, count: 2 });
    expect(queue(s)).toHaveLength(4);
    // Two gears are done and the third is under way.
    steps(s, 70);
    expect(queue(s)[0]).toEqual([RecipeId.IronGearWheel, 1, true]);
    // Cancelling an intermediate cancels the drill it is for (the whole group).
    run(s, { playerId: 0, type: 'CancelCraft', index: 1 });
    expect(queue(s)).toEqual([[RecipeId.IronGearWheel, 2, false]]);
    // Plates: 20 - 9 (drill) - 4 (gears) + refund of 3 plates, 1 unmade gear (2 plates)...
    expect(inv(s).count(ItemId.IronPlate)).toBe(20 - 4 - 6 - 3 + 3 + 2);
    // ...and the two gears made so far come back as gears; the stone comes back as stone.
    expect(inv(s).count(ItemId.IronGearWheel)).toBe(2);
    expect(inv(s).count(ItemId.Stone)).toBe(7);
    // The progress made on the cancelled front entry is lost; the next entry starts afresh.
    expect(s.state.crafting.progress[0]).toBe(1);

    // Cancel the last one too: everything is back.
    run(s, { playerId: 0, type: 'CancelCraft', index: 0 });
    expect(queue(s)).toEqual([]);
    expect(inv(s).count(ItemId.IronPlate)).toBe(16);
    expect(inv(s).count(ItemId.IronGearWheel)).toBe(2);
    expect(s.state.crafting.progress[0]).toBe(0);
  });

  it('keeps finished outputs at the front of the queue while the inventory is full', () => {
    const s = sim([{ item: ItemId.Stone, count: 10 }]);
    run(s, { playerId: 0, type: 'Craft', recipe: RecipeId.StoneFurnace, count: 2 });
    // Fill every slot with something else.
    const inventory = inv(s);
    for (let i = 0; i < inventory.slots; i++) {
      if (inventory.items[i] === 0) {
        inventory.items[i] = ItemId.Coal;
        inventory.counts[i] = 50;
      }
    }
    steps(s, 100);
    expect(inventory.count(ItemId.StoneFurnace)).toBe(0);
    expect(queue(s)).toEqual([[RecipeId.StoneFurnace, 2, false]]);
    expect(s.state.crafting.progress[0]).toBe(30);
    // Make room: the finished furnace lands on the next tick, the next one 30 ticks later.
    inventory.remove(ItemId.Coal, 50);
    s.step();
    expect(inventory.count(ItemId.StoneFurnace)).toBe(1);
    expect(queue(s)).toEqual([[RecipeId.StoneFurnace, 1, false]]);
    steps(s, 29);
    expect(inventory.count(ItemId.StoneFurnace)).toBe(1);
    s.step();
    // Furnaces stack, so the second one fits next to the first.
    expect(inventory.count(ItemId.StoneFurnace)).toBe(2);
  });

  it('refuses a cancel whose refund does not fit', () => {
    const s = sim([{ item: ItemId.Stone, count: 50 }]);
    run(s, { playerId: 0, type: 'Craft', recipe: RecipeId.StoneFurnace, count: 10 });
    const inventory = inv(s);
    for (let i = 0; i < inventory.slots; i++) {
      if (inventory.items[i] === 0) {
        inventory.items[i] = ItemId.Coal;
        inventory.counts[i] = 50;
      }
    }
    run(s, { playerId: 0, type: 'CancelCraft', index: 0 });
    expect(queue(s)).toEqual([[RecipeId.StoneFurnace, 10, false]]);
    expect(inventory.count(ItemId.Stone)).toBe(0);
  });

  it('keeps each player to its own queue and at most CRAFT_QUEUE_LENGTH entries', () => {
    const s = sim([{ item: ItemId.Stone, count: 50 }], 2);
    for (let i = 0; i < CRAFT_QUEUE_LENGTH + 2; i++) {
      s.enqueue({ tick: 0, playerId: 1, type: 'Craft', recipe: RecipeId.StoneFurnace, count: 1 });
    }
    s.step();
    expect(queue(s, 0)).toEqual([]);
    expect(queue(s, 1)).toHaveLength(10);
    expect(inv(s, 0).count(ItemId.Stone)).toBe(50);
    expect(inv(s, 1).count(ItemId.Stone)).toBe(0);
    const t = sim([{ item: ItemId.IronPlate, count: 100 }]);
    for (let i = 0; i < CRAFT_QUEUE_LENGTH + 2; i++) {
      t.enqueue({ tick: 0, playerId: 0, type: 'Craft', recipe: RecipeId.IronGearWheel, count: 1 });
    }
    t.step();
    expect(queue(t)).toHaveLength(CRAFT_QUEUE_LENGTH);
    expect(inv(t).count(ItemId.IronPlate)).toBe(100 - 2 * CRAFT_QUEUE_LENGTH);
  });

  it('is part of the state hash', () => {
    const a = sim([{ item: ItemId.Stone, count: 10 }]);
    const b = sim([{ item: ItemId.Stone, count: 10 }]);
    run(a, { playerId: 0, type: 'Craft', recipe: RecipeId.StoneFurnace, count: 1 });
    // Same inventory, different queue.
    b.state.players.inventory(0).remove(ItemId.Stone, 5);
    b.step();
    expect(a.hash()).not.toBe(b.hash());
  });
});

describe('planCraft and maxCraftable', () => {
  const have = (stacks: [number, number][]) => new Map<number, number>(stacks);

  it('match what the queue accepts', () => {
    const drill = RECIPES[RecipeId.BurnerMiningDrill];
    const avail = have([
      [ItemId.IronPlate, 40],
      [ItemId.Stone, 12],
      [ItemId.StoneFurnace, 1],
    ]);
    // 9 plates per drill; furnaces: 1 + 12 / 5 = 3.
    expect(maxCraftable(drill, avail, CRAFT_QUEUE_LENGTH)).toBe(3);
    expect(maxCraftable(drill, avail, CRAFT_QUEUE_LENGTH, 2)).toBe(2);
    // One drill needs two entries (gears and the drill), more need three.
    expect(maxCraftable(drill, avail, 2)).toBe(1);
    expect(maxCraftable(drill, avail, 1)).toBe(0);
    const plan = planCraft(drill, 3, avail)!;
    expect(plan.entries.map((e) => [e.recipe.id, e.crafts, e.intermediate])).toEqual([
      [RecipeId.IronGearWheel, 9, true],
      [RecipeId.StoneFurnace, 2, true],
      [RecipeId.BurnerMiningDrill, 3, false],
    ]);
    expect([...plan.take]).toEqual([
      [ItemId.IronPlate, 27],
      [ItemId.StoneFurnace, 1],
      [ItemId.Stone, 10],
    ]);
    expect(planCraft(drill, 4, avail)).toBeNull();
    expect(planCraft(drill, 0, avail)).toBeNull();
  });

  it('count items over inventory columns', () => {
    const inventory = new Inventory(4);
    inventory.add(ItemId.Stone, 70);
    inventory.add(ItemId.Coal, 3);
    expect([...countItems(inventory.items, inventory.counts)]).toEqual([
      [ItemId.Stone, 70],
      [ItemId.Coal, 3],
    ]);
  });
});

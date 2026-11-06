import { describe, expect, it } from 'vitest';
import { ITEM_IDS, ItemId, itemPrototype } from '../../src/data/items';
import {
  HAND_RECIPES,
  RAW_ITEMS,
  RECIPES,
  RECIPE_IDS,
  RecipeId,
  SMELTING_TICKS,
  handRecipeFor,
  recipePrototype,
  smeltingRecipeFor,
  type Recipe,
} from '../../src/data/recipes';
import { intermediateRecipeFor } from '../../src/sim/crafting/plan';

/** Items obtainable from raw items through any chain of recipes of the given categories. */
function obtainable(categories: readonly Recipe['category'][]): Set<number> {
  const have = new Set<number>(RAW_ITEMS);
  for (let changed = true; changed;) {
    changed = false;
    for (const id of RECIPE_IDS) {
      const r = RECIPES[id];
      if (!categories.includes(r.category) || !r.inputs.every(([item]) => have.has(item))) {
        continue;
      }
      for (const [item] of r.outputs) {
        if (!have.has(item)) {
          have.add(item);
          changed = true;
        }
      }
    }
  }
  return have;
}

describe('recipe prototypes', () => {
  it('are keyed by their own id and only use known items and positive integers', () => {
    expect(RECIPE_IDS).toEqual(
      Object.keys(RECIPES)
        .map(Number)
        .sort((a, b) => a - b),
    );
    for (const id of RECIPE_IDS) {
      const r = RECIPES[id];
      expect(r.id).toBe(id);
      expect(Number.isInteger(r.ticks) && r.ticks >= 1 && r.ticks <= 0xffff).toBe(true);
      expect(r.inputs.length).toBeGreaterThan(0);
      expect(r.outputs.length).toBeGreaterThan(0);
      for (const [item, count] of [...r.inputs, ...r.outputs]) {
        expect(itemPrototype(item)).toBeDefined();
        expect(Number.isInteger(count) && count >= 1).toBe(true);
      }
      // No item is listed twice on one side.
      expect(new Set(r.inputs.map(([item]) => item)).size).toBe(r.inputs.length);
      expect(new Set(r.outputs.map(([item]) => item)).size).toBe(r.outputs.length);
    }
    expect(recipePrototype(RecipeId.None)).toBeUndefined();
    expect(recipePrototype(999)).toBeUndefined();
  });

  it('have the M1 hand recipes', () => {
    const hand = (id: number) => {
      const r = RECIPES[id as keyof typeof RECIPES];
      expect(r.category).toBe('hand');
      return { inputs: r.inputs, outputs: r.outputs, ticks: r.ticks };
    };
    expect(hand(RecipeId.IronGearWheel)).toEqual({
      inputs: [[ItemId.IronPlate, 2]],
      outputs: [[ItemId.IronGearWheel, 1]],
      ticks: 30,
    });
    expect(hand(RecipeId.WoodenChest)).toEqual({
      inputs: [[ItemId.Wood, 2]],
      outputs: [[ItemId.WoodenChest, 1]],
      ticks: 30,
    });
    expect(hand(RecipeId.StoneFurnace)).toEqual({
      inputs: [[ItemId.Stone, 5]],
      outputs: [[ItemId.StoneFurnace, 1]],
      ticks: 30,
    });
    expect(hand(RecipeId.BurnerMiningDrill)).toEqual({
      inputs: [
        [ItemId.IronGearWheel, 3],
        [ItemId.IronPlate, 3],
        [ItemId.StoneFurnace, 1],
      ],
      outputs: [[ItemId.BurnerMiningDrill, 1]],
      ticks: 120,
    });
    expect(hand(RecipeId.TransportBelt)).toEqual({
      inputs: [
        [ItemId.IronGearWheel, 1],
        [ItemId.IronPlate, 1],
      ],
      outputs: [[ItemId.TransportBelt, 2]],
      ticks: 30,
    });
    expect(hand(RecipeId.BurnerInserter)).toEqual({
      inputs: [
        [ItemId.IronPlate, 1],
        [ItemId.IronGearWheel, 1],
      ],
      outputs: [[ItemId.BurnerInserter, 1]],
      ticks: 30,
    });
    expect(HAND_RECIPES.map((r) => r.id)).toEqual([4, 5, 6, 7, 8, 9]);
  });

  it('smelt ores and stone in 192 ticks, picked by the input item', () => {
    expect(SMELTING_TICKS).toBe(192);
    const smelt = (item: number) => {
      const r = smeltingRecipeFor(item);
      return r && { inputs: r.inputs, outputs: r.outputs, ticks: r.ticks, category: r.category };
    };
    expect(smelt(ItemId.IronOre)).toEqual({
      inputs: [[ItemId.IronOre, 1]],
      outputs: [[ItemId.IronPlate, 1]],
      ticks: 192,
      category: 'smelting',
    });
    expect(smelt(ItemId.CopperOre)).toMatchObject({ outputs: [[ItemId.CopperPlate, 1]] });
    expect(smelt(ItemId.Stone)).toEqual({
      inputs: [[ItemId.Stone, 2]],
      outputs: [[ItemId.StoneBrick, 1]],
      ticks: 192,
      category: 'smelting',
    });
    expect(smelt(ItemId.Coal)).toBeUndefined();
    for (const id of RECIPE_IDS) {
      if (RECIPES[id].category === 'smelting') expect(RECIPES[id].inputs).toHaveLength(1);
    }
  });

  it('craft every hand recipe input from raw resources, by hand or by smelting', () => {
    const have = obtainable(['hand', 'smelting']);
    for (const r of HAND_RECIPES) {
      for (const [item] of r.inputs) {
        expect(have.has(item), `${itemPrototype(item)!.name} is not obtainable`).toBe(true);
      }
    }
    // In fact every item is.
    expect(ITEM_IDS.filter((item) => !have.has(item))).toEqual([]);
    // And no raw item is made by a recipe.
    for (const item of RAW_ITEMS) {
      expect(RECIPE_IDS.some((id) => RECIPES[id].outputs.some(([o]) => o === item))).toBe(false);
    }
  });

  it('can auto-queue every hand-made input of a hand recipe as an intermediate', () => {
    for (const r of HAND_RECIPES) {
      for (const [item] of r.inputs) {
        if (handRecipeFor(item)) {
          expect(intermediateRecipeFor(item)).toBe(handRecipeFor(item));
        }
      }
    }
    expect(handRecipeFor(ItemId.IronGearWheel)?.id).toBe(RecipeId.IronGearWheel);
    // Plates are smelted, not hand-crafted.
    expect(handRecipeFor(ItemId.IronPlate)).toBeUndefined();
    // Belts come in twos, so they can't be auto-queued exactly.
    expect(intermediateRecipeFor(ItemId.TransportBelt)).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { ItemId } from '../../src/data/items';
import { HAND_RECIPES, RECIPES, RecipeId } from '../../src/data/recipes';
import { CRAFT_QUEUE_LENGTH } from '../../src/sim/crafting/queue';
import { craftableCounts, recipeName, recipeTitle } from '../../src/ui/crafting';

describe('crafting panel helpers', () => {
  it('name and describe recipes by their output', () => {
    expect(HAND_RECIPES.map(recipeName)).toEqual([
      'iron-gear-wheel',
      'wooden-chest',
      'stone-furnace',
      'burner-mining-drill',
      'transport-belt',
      'burner-inserter',
      'copper-cable',
      'electronic-circuit',
      'small-electric-pole',
      'boiler',
      'steam-engine',
      'electric-mining-drill',
      'electric-inserter',
      'assembling-machine-1',
      'assembling-machine-2',
      'iron-chest',
      'fast-inserter',
      'long-handed-inserter',
      'fast-transport-belt',
      'express-transport-belt',
      'underground-belt',
      'fast-underground-belt',
      'express-underground-belt',
    ]);
    expect(recipeTitle(RECIPES[RecipeId.TransportBelt])).toBe(
      '2 × Transport belt ← 1 × Iron gear wheel, 1 × Iron plate (0.5 s)',
    );
  });

  it('count craftable recipes, intermediates included, limited by the free queue entries', () => {
    const slots = [
      { item: ItemId.Stone, count: 50 },
      { item: ItemId.Stone, count: 3 },
      { item: ItemId.IronPlate, count: 20 },
      { item: 0, count: 0 },
    ];
    const at = (counts: number[], id: number) => counts[HAND_RECIPES.findIndex((r) => r.id === id)];
    const counts = craftableCounts(slots, 0);
    expect(at(counts, RecipeId.StoneFurnace)).toBe(10);
    expect(at(counts, RecipeId.IronGearWheel)).toBe(10);
    expect(at(counts, RecipeId.WoodenChest)).toBe(0);
    // 9 plates and a furnace each.
    expect(at(counts, RecipeId.BurnerMiningDrill)).toBe(2);
    // A drill takes three entries (gears, furnace, drill), and only two are free.
    expect(at(craftableCounts(slots, CRAFT_QUEUE_LENGTH - 2), RecipeId.BurnerMiningDrill)).toBe(0);
    expect(at(craftableCounts(slots, CRAFT_QUEUE_LENGTH), RecipeId.StoneFurnace)).toBe(0);
  });
});

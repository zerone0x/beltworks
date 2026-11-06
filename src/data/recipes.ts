/**
 * Recipe prototypes: what machines (and, later, the player) turn into what.
 *
 * Recipe ids are stored in entity tables (a furnace remembers the recipe it
 * is smelting), so they must stay stable: changing an id breaks saves and
 * state hashes. All amounts and durations are integers; durations are in
 * ticks at 60 ticks/s.
 */

import { ItemId, type RealItemId } from './items';

/** Numeric recipe ids. 0 means "no recipe". */
export const RecipeId = {
  None: 0,
  IronPlate: 1,
  CopperPlate: 2,
  StoneBrick: 3,
} as const;

export type RecipeId = (typeof RecipeId)[keyof typeof RecipeId];

/** Ids of real recipes, i.e. every id except {@link RecipeId.None}. */
export type RealRecipeId = Exclude<RecipeId, typeof RecipeId.None>;

/** Where a recipe is made: by hand, or in a furnace. */
export type RecipeCategory = 'hand' | 'smelting';

/** An amount of one item in a recipe: `[item, count]`. */
export type RecipeAmount = readonly [item: RealItemId, count: number];

export interface Recipe {
  readonly id: RealRecipeId;
  readonly inputs: readonly RecipeAmount[];
  readonly outputs: readonly RecipeAmount[];
  /** Crafting time in ticks. */
  readonly ticks: number;
  readonly category: RecipeCategory;
}

/** Ticks a stone furnace takes per smelting recipe (3.2 s). */
const SMELTING_TICKS = 192;

/** Every recipe, in id order. */
export const RECIPES: readonly Recipe[] = [
  {
    id: RecipeId.IronPlate,
    inputs: [[ItemId.IronOre, 1]],
    outputs: [[ItemId.IronPlate, 1]],
    ticks: SMELTING_TICKS,
    category: 'smelting',
  },
  {
    id: RecipeId.CopperPlate,
    inputs: [[ItemId.CopperOre, 1]],
    outputs: [[ItemId.CopperPlate, 1]],
    ticks: SMELTING_TICKS,
    category: 'smelting',
  },
  {
    id: RecipeId.StoneBrick,
    inputs: [[ItemId.Stone, 2]],
    outputs: [[ItemId.StoneBrick, 1]],
    ticks: SMELTING_TICKS,
    category: 'smelting',
  },
];

const BY_ID = new Map<number, Recipe>(RECIPES.map((r) => [r.id, r]));

/** The recipe with id `id`, or `undefined` for 0 and unknown ids. */
export function recipe(id: number): Recipe | undefined {
  return BY_ID.get(id);
}

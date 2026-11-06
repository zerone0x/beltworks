/**
 * Recipe prototypes: how items turn into other items.
 *
 * Recipe ids are stored in simulation state (the hand-crafting queue as
 * uint16s, furnaces as uint8s; later assemblers), where 0 means "no recipe".
 * They must stay stable: changing an id breaks saves and state hashes.
 *
 * Every amount and duration is an integer; durations are in ticks (60 per
 * second).
 */

import { ItemId, MINED_ITEM, type RealItemId } from './items';
import { ORE_IDS } from './resources';

/** Numeric recipe ids. `None` (0) marks "no recipe". */
export const RecipeId = {
  None: 0,
  // Smelting recipes.
  IronPlate: 1,
  CopperPlate: 2,
  StoneBrick: 3,
  // Hand recipes.
  IronGearWheel: 4,
  WoodenChest: 5,
  StoneFurnace: 6,
  BurnerMiningDrill: 7,
  TransportBelt: 8,
  BurnerInserter: 9,
  // Hand recipes for power (M2).
  CopperCable: 10,
  ElectronicCircuit: 11,
  SmallElectricPole: 12,
  Boiler: 13,
  SteamEngine: 14,
  ElectricMiningDrill: 15,
  ElectricInserter: 16,
} as const;

export type RecipeId = (typeof RecipeId)[keyof typeof RecipeId];

/** Ids of real recipes, i.e. every id except {@link RecipeId.None}. */
export type RealRecipeId = Exclude<RecipeId, typeof RecipeId.None>;

/** Where a recipe is made: by hand (the crafting queue) or in a furnace. */
export type RecipeCategory = 'hand' | 'smelting';

/** An amount of one item in a recipe: `[item, count]`, with `count >= 1`. */
export type RecipeStack = readonly [item: RealItemId, count: number];

export interface Recipe {
  readonly id: RealRecipeId;
  /** Consumed when a craft starts (for hand recipes: when it is queued). */
  readonly inputs: readonly RecipeStack[];
  /** Produced when a craft finishes. */
  readonly outputs: readonly RecipeStack[];
  /** Duration of one craft, in ticks. */
  readonly ticks: number;
  readonly category: RecipeCategory;
}

/** Ticks a stone furnace takes per smelting craft (3.2 s); shared M1 design number. */
export const SMELTING_TICKS = 192;

/** Recipe prototypes keyed by id. There is no entry for id 0 ("no recipe"). */
export const RECIPES: Readonly<Record<RealRecipeId, Recipe>> = {
  [RecipeId.IronPlate]: {
    id: RecipeId.IronPlate,
    inputs: [[ItemId.IronOre, 1]],
    outputs: [[ItemId.IronPlate, 1]],
    ticks: SMELTING_TICKS,
    category: 'smelting',
  },
  [RecipeId.CopperPlate]: {
    id: RecipeId.CopperPlate,
    inputs: [[ItemId.CopperOre, 1]],
    outputs: [[ItemId.CopperPlate, 1]],
    ticks: SMELTING_TICKS,
    category: 'smelting',
  },
  [RecipeId.StoneBrick]: {
    id: RecipeId.StoneBrick,
    inputs: [[ItemId.Stone, 2]],
    outputs: [[ItemId.StoneBrick, 1]],
    ticks: SMELTING_TICKS,
    category: 'smelting',
  },
  [RecipeId.IronGearWheel]: {
    id: RecipeId.IronGearWheel,
    inputs: [[ItemId.IronPlate, 2]],
    outputs: [[ItemId.IronGearWheel, 1]],
    ticks: 30,
    category: 'hand',
  },
  [RecipeId.WoodenChest]: {
    id: RecipeId.WoodenChest,
    inputs: [[ItemId.Wood, 2]],
    outputs: [[ItemId.WoodenChest, 1]],
    ticks: 30,
    category: 'hand',
  },
  [RecipeId.StoneFurnace]: {
    id: RecipeId.StoneFurnace,
    inputs: [[ItemId.Stone, 5]],
    outputs: [[ItemId.StoneFurnace, 1]],
    ticks: 30,
    category: 'hand',
  },
  [RecipeId.BurnerMiningDrill]: {
    id: RecipeId.BurnerMiningDrill,
    inputs: [
      [ItemId.IronGearWheel, 3],
      [ItemId.IronPlate, 3],
      [ItemId.StoneFurnace, 1],
    ],
    outputs: [[ItemId.BurnerMiningDrill, 1]],
    ticks: 120,
    category: 'hand',
  },
  [RecipeId.TransportBelt]: {
    id: RecipeId.TransportBelt,
    inputs: [
      [ItemId.IronGearWheel, 1],
      [ItemId.IronPlate, 1],
    ],
    outputs: [[ItemId.TransportBelt, 2]],
    ticks: 30,
    category: 'hand',
  },
  [RecipeId.BurnerInserter]: {
    id: RecipeId.BurnerInserter,
    inputs: [
      [ItemId.IronPlate, 1],
      [ItemId.IronGearWheel, 1],
    ],
    outputs: [[ItemId.BurnerInserter, 1]],
    ticks: 30,
    category: 'hand',
  },
  [RecipeId.CopperCable]: {
    id: RecipeId.CopperCable,
    inputs: [[ItemId.CopperPlate, 1]],
    outputs: [[ItemId.CopperCable, 2]],
    ticks: 30,
    category: 'hand',
  },
  [RecipeId.ElectronicCircuit]: {
    id: RecipeId.ElectronicCircuit,
    inputs: [
      [ItemId.CopperCable, 3],
      [ItemId.IronPlate, 1],
    ],
    outputs: [[ItemId.ElectronicCircuit, 1]],
    ticks: 30,
    category: 'hand',
  },
  [RecipeId.SmallElectricPole]: {
    id: RecipeId.SmallElectricPole,
    inputs: [
      [ItemId.Wood, 1],
      [ItemId.CopperCable, 2],
    ],
    outputs: [[ItemId.SmallElectricPole, 2]],
    ticks: 30,
    category: 'hand',
  },
  [RecipeId.Boiler]: {
    id: RecipeId.Boiler,
    inputs: [
      [ItemId.StoneFurnace, 1],
      [ItemId.IronPlate, 4],
    ],
    outputs: [[ItemId.Boiler, 1]],
    ticks: 30,
    category: 'hand',
  },
  [RecipeId.SteamEngine]: {
    id: RecipeId.SteamEngine,
    inputs: [
      [ItemId.IronGearWheel, 8],
      [ItemId.IronPlate, 15],
    ],
    outputs: [[ItemId.SteamEngine, 1]],
    ticks: 60,
    category: 'hand',
  },
  [RecipeId.ElectricMiningDrill]: {
    id: RecipeId.ElectricMiningDrill,
    inputs: [
      [ItemId.ElectronicCircuit, 3],
      [ItemId.IronGearWheel, 5],
      [ItemId.IronPlate, 10],
    ],
    outputs: [[ItemId.ElectricMiningDrill, 1]],
    ticks: 120,
    category: 'hand',
  },
  [RecipeId.ElectricInserter]: {
    id: RecipeId.ElectricInserter,
    inputs: [
      [ItemId.ElectronicCircuit, 1],
      [ItemId.IronGearWheel, 1],
      [ItemId.IronPlate, 1],
    ],
    outputs: [[ItemId.ElectricInserter, 1]],
    ticks: 30,
    category: 'hand',
  },
};

/** Every real recipe id, in id order. */
export const RECIPE_IDS: readonly RealRecipeId[] = [
  RecipeId.IronPlate,
  RecipeId.CopperPlate,
  RecipeId.StoneBrick,
  RecipeId.IronGearWheel,
  RecipeId.WoodenChest,
  RecipeId.StoneFurnace,
  RecipeId.BurnerMiningDrill,
  RecipeId.TransportBelt,
  RecipeId.BurnerInserter,
  RecipeId.CopperCable,
  RecipeId.ElectronicCircuit,
  RecipeId.SmallElectricPole,
  RecipeId.Boiler,
  RecipeId.SteamEngine,
  RecipeId.ElectricMiningDrill,
  RecipeId.ElectricInserter,
];

/** The hand recipes, in id order (the order of the crafting panel). */
export const HAND_RECIPES: readonly Recipe[] = RECIPE_IDS.map((id) => RECIPES[id]).filter(
  (r) => r.category === 'hand',
);

/**
 * Items that no recipe makes: what players mine from resource patches, and
 * wood (from trees, see src/data/trees.ts).
 */
export const RAW_ITEMS: readonly RealItemId[] = [
  ...ORE_IDS.map((ore) => MINED_ITEM[ore]),
  ItemId.Wood,
];

/** The prototype of recipe `id`, or `undefined` for 0 and unknown ids. */
export function recipePrototype(id: number): Recipe | undefined {
  return (RECIPES as Readonly<Record<number, Recipe | undefined>>)[id];
}

const HAND_RECIPE_FOR = new Map<number, Recipe>();
for (const recipe of HAND_RECIPES) {
  for (const [item] of recipe.outputs) {
    if (!HAND_RECIPE_FOR.has(item)) HAND_RECIPE_FOR.set(item, recipe);
  }
}

/** The (first, in id order) hand recipe that makes `item`, or `undefined` if none does. */
export function handRecipeFor(item: number): Recipe | undefined {
  return HAND_RECIPE_FOR.get(item);
}

const SMELTING_RECIPE_FOR = new Map<number, Recipe>();
for (const id of RECIPE_IDS) {
  const recipe = RECIPES[id];
  if (recipe.category === 'smelting') SMELTING_RECIPE_FOR.set(recipe.inputs[0]![0], recipe);
}

/**
 * The smelting recipe a furnace runs for input item `item`, or `undefined` if
 * the item can't be smelted. Each smelting recipe has a single input item.
 */
export function smeltingRecipeFor(item: number): Recipe | undefined {
  return SMELTING_RECIPE_FOR.get(item);
}

/**
 * Item prototypes: everything that can sit in an inventory slot.
 *
 * Item ids are stored directly in inventory arrays (`Uint16Array`), where 0
 * means "empty slot". They must stay stable: changing an id breaks saves and
 * state hashes.
 */

import { ResourceId, type OreId } from './resources';

/** Numeric item ids. `None` (0) marks an empty inventory slot. */
export const ItemId = {
  None: 0,
  IronOre: 1,
  CopperOre: 2,
  Coal: 3,
  Stone: 4,
  WoodenChest: 5,
  StoneFurnace: 6,
  BurnerMiningDrill: 7,
  TransportBelt: 8,
  BurnerInserter: 9,
  Wood: 10,
  IronPlate: 11,
  CopperPlate: 12,
  StoneBrick: 13,
} as const;

export type ItemId = (typeof ItemId)[keyof typeof ItemId];

/** Ids of real items, i.e. every id except {@link ItemId.None}. */
export type RealItemId = Exclude<ItemId, typeof ItemId.None>;

/** An amount of one item, e.g. an entry of a starting kit or of an entity's contents. */
export interface ItemStack {
  readonly item: RealItemId;
  readonly count: number;
}

/** Largest stack size an inventory slot can hold (counts are stored as uint16). */
export const MAX_STACK_SIZE = 0xffff;

export interface ItemPrototype {
  readonly id: RealItemId;
  /** Internal name, e.g. `iron-ore`. */
  readonly name: string;
  /** Human-readable name for the UI. */
  readonly label: string;
  /** Most units one inventory slot can hold, in [1, MAX_STACK_SIZE]. */
  readonly stackSize: number;
  /** Display color as 0xRRGGBB, used by the inventory and hotbar. */
  readonly color: number;
  /** Energy released by burning one unit, in joules (integer); absent for items that aren't fuel. */
  readonly fuelValue?: number;
}

/** Joules in one megajoule. */
const MJ = 1_000_000;

/** Item prototypes keyed by id. There is no entry for id 0 ("empty"). */
export const ITEMS: Readonly<Record<RealItemId, ItemPrototype>> = {
  [ItemId.IronOre]: {
    id: ItemId.IronOre,
    name: 'iron-ore',
    label: 'Iron ore',
    stackSize: 50,
    color: 0x8aa2b4,
  },
  [ItemId.CopperOre]: {
    id: ItemId.CopperOre,
    name: 'copper-ore',
    label: 'Copper ore',
    stackSize: 50,
    color: 0xc0703e,
  },
  [ItemId.Coal]: {
    id: ItemId.Coal,
    name: 'coal',
    label: 'Coal',
    stackSize: 50,
    color: 0x4a4a4a,
    fuelValue: 4 * MJ,
  },
  [ItemId.Stone]: {
    id: ItemId.Stone,
    name: 'stone',
    label: 'Stone',
    stackSize: 50,
    color: 0xa89a7c,
  },
  // Items that place entities (see src/data/entities.ts); colors match the entities.
  [ItemId.WoodenChest]: {
    id: ItemId.WoodenChest,
    name: 'wooden-chest',
    label: 'Wooden chest',
    stackSize: 50,
    color: 0x9a6a3a,
  },
  [ItemId.StoneFurnace]: {
    id: ItemId.StoneFurnace,
    name: 'stone-furnace',
    label: 'Stone furnace',
    stackSize: 50,
    color: 0x8c7f6a,
  },
  [ItemId.BurnerMiningDrill]: {
    id: ItemId.BurnerMiningDrill,
    name: 'burner-mining-drill',
    label: 'Burner mining drill',
    stackSize: 50,
    color: 0x6d6f78,
  },
  [ItemId.TransportBelt]: {
    id: ItemId.TransportBelt,
    name: 'transport-belt',
    label: 'Transport belt',
    stackSize: 100,
    color: 0xd9b23a,
  },
  [ItemId.BurnerInserter]: {
    id: ItemId.BurnerInserter,
    name: 'burner-inserter',
    label: 'Burner inserter',
    stackSize: 50,
    color: 0xb5562f,
  },
  [ItemId.Wood]: {
    id: ItemId.Wood,
    name: 'wood',
    label: 'Wood',
    stackSize: 100,
    color: 0x7a5530,
    fuelValue: 2 * MJ,
  },
  // Smelting results (see src/data/recipes.ts).
  [ItemId.IronPlate]: {
    id: ItemId.IronPlate,
    name: 'iron-plate',
    label: 'Iron plate',
    stackSize: 100,
    color: 0xb4bcc4,
  },
  [ItemId.CopperPlate]: {
    id: ItemId.CopperPlate,
    name: 'copper-plate',
    label: 'Copper plate',
    stackSize: 100,
    color: 0xd9844a,
  },
  [ItemId.StoneBrick]: {
    id: ItemId.StoneBrick,
    name: 'stone-brick',
    label: 'Stone brick',
    stackSize: 100,
    color: 0xb09060,
  },
};

/** Every real item id, in id order. */
export const ITEM_IDS: readonly RealItemId[] = [
  ItemId.IronOre,
  ItemId.CopperOre,
  ItemId.Coal,
  ItemId.Stone,
  ItemId.WoodenChest,
  ItemId.StoneFurnace,
  ItemId.BurnerMiningDrill,
  ItemId.TransportBelt,
  ItemId.BurnerInserter,
  ItemId.Wood,
  ItemId.IronPlate,
  ItemId.CopperPlate,
  ItemId.StoneBrick,
];

/** The prototype of item `id`, or `undefined` for 0 and unknown ids. */
export function itemPrototype(id: number): ItemPrototype | undefined {
  return (ITEMS as Readonly<Record<number, ItemPrototype | undefined>>)[id];
}

/** Joules released by burning one unit of `item`, or 0 if it isn't fuel (or unknown). */
export function fuelValue(item: number): number {
  return itemPrototype(item)?.fuelValue ?? 0;
}

/** The item a player gets for mining one unit of each resource. */
export const MINED_ITEM: Readonly<Record<OreId, RealItemId>> = {
  [ResourceId.IronOre]: ItemId.IronOre,
  [ResourceId.CopperOre]: ItemId.CopperOre,
  [ResourceId.Coal]: ItemId.Coal,
  [ResourceId.Stone]: ItemId.Stone,
};

/** The item mined from resource `resource`, or `undefined` for 0 and unknown ids. */
export function minedItem(resource: number): RealItemId | undefined {
  return (MINED_ITEM as Readonly<Record<number, RealItemId | undefined>>)[resource];
}

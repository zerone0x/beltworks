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
} as const;

export type ItemId = (typeof ItemId)[keyof typeof ItemId];

/** Ids of real items, i.e. every id except {@link ItemId.None}. */
export type RealItemId = Exclude<ItemId, typeof ItemId.None>;

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
}

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
  [ItemId.Coal]: { id: ItemId.Coal, name: 'coal', label: 'Coal', stackSize: 50, color: 0x4a4a4a },
  [ItemId.Stone]: {
    id: ItemId.Stone,
    name: 'stone',
    label: 'Stone',
    stackSize: 50,
    color: 0xa89a7c,
  },
};

/** Every real item id, in id order. */
export const ITEM_IDS: readonly RealItemId[] = [
  ItemId.IronOre,
  ItemId.CopperOre,
  ItemId.Coal,
  ItemId.Stone,
];

/** The prototype of item `id`, or `undefined` for 0 and unknown ids. */
export function itemPrototype(id: number): ItemPrototype | undefined {
  return (ITEMS as Readonly<Record<number, ItemPrototype | undefined>>)[id];
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

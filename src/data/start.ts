/**
 * What a new game starts with.
 */

import { ItemId, type ItemStack } from './items';

/**
 * The starting kit every player gets in a new game, in hotbar order. It makes
 * the M1 loop (drill → belt → inserter → furnace → chest) reachable before
 * crafting exists.
 */
export const STARTING_KIT: readonly ItemStack[] = [
  { item: ItemId.TransportBelt, count: 10 },
  { item: ItemId.BurnerInserter, count: 4 },
  { item: ItemId.BurnerMiningDrill, count: 2 },
  { item: ItemId.StoneFurnace, count: 2 },
  { item: ItemId.WoodenChest, count: 2 },
  { item: ItemId.Coal, count: 10 },
];

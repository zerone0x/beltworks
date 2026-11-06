/**
 * What a new game starts with.
 */

import { ItemId, type ItemStack } from './items';

/**
 * The starting kit every player gets in a new game, in hotbar order. It makes
 * the M1 loop (drill → belt → inserter → furnace → chest) reachable before
 * crafting exists, and carries small electric poles because the trees for
 * their wood only grow far from the spawn (docs/DECISIONS.md, D23), a
 * boiler with two steam engines because those take 69 iron plates to craft
 * (D24), and electric mining drills and inserters because they need
 * electronic circuits (D27). New entries go at the end, so the hotbar keys
 * of the others stay put; the electric inserters come past the 10 hotbar
 * slots, in the inventory.
 */
export const STARTING_KIT: readonly ItemStack[] = [
  { item: ItemId.TransportBelt, count: 10 },
  { item: ItemId.BurnerInserter, count: 4 },
  { item: ItemId.BurnerMiningDrill, count: 2 },
  { item: ItemId.StoneFurnace, count: 2 },
  { item: ItemId.WoodenChest, count: 2 },
  { item: ItemId.Coal, count: 10 },
  { item: ItemId.SmallElectricPole, count: 10 },
  { item: ItemId.Boiler, count: 1 },
  { item: ItemId.SteamEngine, count: 2 },
  { item: ItemId.ElectricMiningDrill, count: 2 },
  { item: ItemId.ElectricInserter, count: 4 },
];

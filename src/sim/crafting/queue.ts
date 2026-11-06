/**
 * The hand-crafting queue: struct-of-arrays state for every player's queue,
 * the `Craft` / `CancelCraft` commands, and the crafting system.
 *
 * - `Craft {recipe, count}` queues as many of `count` crafts of a hand recipe
 *   as the inventory allows (see src/sim/crafting/plan.ts). Their inputs are
 *   reserved: taken out of the inventory right away. Inputs the player lacks
 *   but can make are auto-queued as intermediate entries before the craft.
 * - Each tick, the player's front entry makes progress; a craft takes exactly
 *   `recipe.ticks` ticks. When a craft finishes, its outputs go to the
 *   inventory; if they don't fit they wait (the craft stays finished at the
 *   front and blocks the queue) until there is room. Intermediates don't go to
 *   the inventory: they are used by the craft they were queued for.
 * - `CancelCraft {index}` removes queue entry `index` and refunds its inputs.
 *   An entry and the intermediates queued for it form a group that is
 *   cancelled together (cancelling an intermediate cancels its craft too).
 *   The cancel is ignored if the refund doesn't fit in the inventory.
 *
 * Refunds need no record of what intermediates made so far: every unit an
 * intermediate makes is used inside its group, so what a group holds is
 * always the inputs of all its remaining crafts minus the outputs its
 * remaining intermediates will still make.
 */

import type { ItemStack, RealItemId } from '../../data/items';
import { recipePrototype, type Recipe } from '../../data/recipes';
import { fnv1a32 } from '../hash';
import type { Inventory } from '../inventory';
import type { PlayerTable } from '../player';
import { countItems, maxCraftable, planCraft } from './plan';

/** Queue entries per player. */
export const CRAFT_QUEUE_LENGTH = 32;

/** Bits of {@link CraftingTable.flags}. */
export const CraftFlag = {
  /** The entry is an intermediate, made for the next non-intermediate entry. */
  Intermediate: 1,
} as const;

export class CraftingTable {
  readonly count: number;
  /** Entries in each player's queue, in [0, CRAFT_QUEUE_LENGTH]. */
  readonly length: Uint8Array;
  /** Ticks spent on the front entry's current craft, in [0, recipe.ticks]; `ticks` means finished but blocked. */
  readonly progress: Uint16Array;
  /**
   * Entries of every player, `CRAFT_QUEUE_LENGTH` consecutive slots each,
   * front first. Slots past a queue's length are all zero.
   */
  readonly recipe: Uint16Array;
  /** Crafts left in the entry. */
  readonly crafts: Uint16Array;
  readonly flags: Uint8Array;

  constructor(count: number) {
    this.count = count;
    this.length = new Uint8Array(count);
    this.progress = new Uint16Array(count);
    this.recipe = new Uint16Array(count * CRAFT_QUEUE_LENGTH);
    this.crafts = new Uint16Array(count * CRAFT_QUEUE_LENGTH);
    this.flags = new Uint8Array(count * CRAFT_QUEUE_LENGTH);
  }

  /** Number of entries in player `id`'s queue. */
  size(id: number): number {
    return this.length[id]!;
  }

  /**
   * Queues up to `count` crafts of hand recipe `recipeId` for player `id`,
   * taking the inputs from `inventory`. Returns the number of crafts queued
   * (0 if none could be: an unknown or non-hand recipe, missing items, or a
   * full queue).
   */
  queue(id: number, inventory: Inventory, recipeId: number, count: number): number {
    const recipe = recipePrototype(recipeId);
    if (!recipe || recipe.category !== 'hand') {
      return 0;
    }
    const available = countItems(inventory.items, inventory.counts);
    const free = CRAFT_QUEUE_LENGTH - this.length[id]!;
    const n = maxCraftable(recipe, available, free, count);
    const plan = n > 0 ? planCraft(recipe, n, available) : null;
    if (!plan) {
      return 0;
    }
    for (const [item, units] of plan.take) {
      inventory.remove(item, units);
    }
    const base = id * CRAFT_QUEUE_LENGTH;
    for (const entry of plan.entries) {
      const at = base + this.length[id]!;
      this.recipe[at] = entry.recipe.id;
      this.crafts[at] = entry.crafts;
      this.flags[at] = entry.intermediate ? CraftFlag.Intermediate : 0;
      this.length[id] = this.length[id]! + 1;
    }
    return n;
  }

  /**
   * The group of entry `index` of player `id`'s queue: `[first, last]`, where
   * `last` is the first non-intermediate entry at or after `index` and the
   * group's intermediates run back from it. `null` if there is no such entry.
   */
  group(id: number, index: number): [number, number] | null {
    const len = this.length[id]!;
    if (!Number.isInteger(index) || index < 0 || index >= len) {
      return null;
    }
    const base = id * CRAFT_QUEUE_LENGTH;
    let last = index;
    while (last < len && this.isIntermediate(base + last)) last++;
    if (last === len) {
      // Can't happen: a group always ends with its own craft.
      return null;
    }
    let first = last;
    while (first > 0 && this.isIntermediate(base + first - 1)) first--;
    return [first, last];
  }

  /** What cancelling the group `[first, last]` of player `id` gives back, as item → units. */
  refund(id: number, first: number, last: number): Map<RealItemId, number> {
    const out = new Map<RealItemId, number>();
    const base = id * CRAFT_QUEUE_LENGTH;
    for (let i = first; i <= last; i++) {
      const recipe = this.recipeAt(base + i);
      const n = this.crafts[base + i]!;
      for (const [item, count] of recipe.inputs) {
        out.set(item, (out.get(item) ?? 0) + count * n);
      }
      if (this.isIntermediate(base + i)) {
        for (const [item, count] of recipe.outputs) {
          out.set(item, (out.get(item) ?? 0) - count * n);
        }
      }
    }
    for (const [item, units] of out) {
      if (units <= 0) out.delete(item);
    }
    return out;
  }

  /**
   * Cancels entry `index` of player `id`'s queue together with its group,
   * refunding the group's items to `inventory`. Returns whether it did;
   * nothing changes if there is no such entry or the refund doesn't fit.
   */
  cancel(id: number, inventory: Inventory, index: number): boolean {
    const group = this.group(id, index);
    if (!group) {
      return false;
    }
    const [first, last] = group;
    const refund: ItemStack[] = [...this.refund(id, first, last)].map(([item, count]) => ({
      item,
      count,
    }));
    if (!inventory.fitsAll(refund)) {
      return false;
    }
    for (const { item, count } of refund) {
      inventory.add(item, count);
    }
    if (first === 0) {
      this.progress[id] = 0;
    }
    this.removeEntries(id, first, last - first + 1);
    return true;
  }

  /** Advances player `id`'s front craft by one tick (see the module comment). */
  update(id: number, inventory: Inventory): void {
    if (this.length[id] === 0) {
      return;
    }
    const front = id * CRAFT_QUEUE_LENGTH;
    const recipe = this.recipeAt(front);
    if (this.progress[id]! < recipe.ticks) {
      this.progress[id] = this.progress[id]! + 1;
    }
    if (this.progress[id]! < recipe.ticks) {
      return;
    }
    if (!this.isIntermediate(front)) {
      const outputs = recipe.outputs.map(([item, count]) => ({ item, count }));
      if (!inventory.fitsAll(outputs)) {
        // Finished, waiting for room.
        return;
      }
      for (const { item, count } of outputs) {
        inventory.add(item, count);
      }
    }
    this.progress[id] = 0;
    this.crafts[front] = this.crafts[front]! - 1;
    if (this.crafts[front] === 0) {
      this.removeEntries(id, 0, 1);
    }
  }

  /** Folds every field into a running FNV-1a hash, in a fixed order. */
  hashInto(h: number): number {
    h = fnv1a32(Uint32Array.of(this.count, CRAFT_QUEUE_LENGTH), h);
    for (const column of [this.length, this.progress, this.recipe, this.crafts, this.flags]) {
      h = fnv1a32(column, h);
    }
    return h;
  }

  private isIntermediate(slot: number): boolean {
    return (this.flags[slot]! & CraftFlag.Intermediate) !== 0;
  }

  private recipeAt(slot: number): Recipe {
    const recipe = recipePrototype(this.recipe[slot]!);
    if (!recipe) {
      throw new Error(`crafting queue holds unknown recipe ${String(this.recipe[slot])}`);
    }
    return recipe;
  }

  /** Removes `n` entries of player `id`'s queue starting at `from`, keeping the rest in order. */
  private removeEntries(id: number, from: number, n: number): void {
    const base = id * CRAFT_QUEUE_LENGTH;
    const len = this.length[id]!;
    for (const column of [this.recipe, this.crafts, this.flags]) {
      column.copyWithin(base + from, base + from + n, base + len);
      column.fill(0, base + len - n, base + len);
    }
    this.length[id] = len - n;
  }
}

/** Crafting system: advances every player's front craft by one tick. */
export function updateCrafting(crafting: CraftingTable, players: PlayerTable): void {
  for (let i = 0; i < crafting.count; i++) {
    crafting.update(i, players.inventory(i));
  }
}

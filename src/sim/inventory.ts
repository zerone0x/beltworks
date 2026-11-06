/**
 * Inventories: a fixed number of slots, each holding one stack of a single
 * item. Stack sizes come from the item prototypes in src/data/items.ts.
 *
 * An `Inventory` is a view over two uint16 columns (item id and count per
 * slot), so a table of many inventories can keep all of them in two flat typed
 * arrays (see `PlayerTable`). Everything is integer-only.
 */

import { ItemId, itemPrototype } from '../data/items';
import { fnv1a32 } from './hash';

/** Slots in a player inventory. */
export const PLAYER_INVENTORY_SLOTS = 40;

function stackSizeOf(item: number): number {
  if (item === ItemId.None) {
    throw new RangeError('item id 0 is "empty", not an item');
  }
  const proto = itemPrototype(item);
  if (!proto) {
    throw new RangeError(`unknown item id ${String(item)}`);
  }
  return proto.stackSize;
}

function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RangeError(`item amount must be a non-negative integer, got ${String(amount)}`);
  }
}

export class Inventory {
  /** Item id per slot; 0 marks an empty slot. */
  readonly items: Uint16Array;
  /** Units per slot; 0 exactly where the slot is empty. */
  readonly counts: Uint16Array;

  /**
   * Wraps existing columns (they must have the same length), or allocates
   * fresh ones when given a slot count.
   */
  constructor(slots: number);
  constructor(items: Uint16Array, counts: Uint16Array);
  constructor(slotsOrItems: number | Uint16Array, counts?: Uint16Array) {
    if (typeof slotsOrItems === 'number') {
      if (!Number.isInteger(slotsOrItems) || slotsOrItems < 1) {
        throw new RangeError(`slot count must be a positive integer, got ${String(slotsOrItems)}`);
      }
      this.items = new Uint16Array(slotsOrItems);
      this.counts = new Uint16Array(slotsOrItems);
    } else {
      if (counts?.length !== slotsOrItems.length) {
        throw new RangeError('item and count columns must have the same length');
      }
      this.items = slotsOrItems;
      this.counts = counts;
    }
  }

  get slots(): number {
    return this.items.length;
  }

  /** Total units of `item` across all slots. */
  count(item: number): number {
    let n = 0;
    for (let i = 0; i < this.items.length; i++) {
      if (this.items[i] === item) n += this.counts[i]!;
    }
    return n;
  }

  /** How many more units of `item` fit: room on its stacks plus whole empty slots. */
  spaceFor(item: number): number {
    const stack = stackSizeOf(item);
    let n = 0;
    for (let i = 0; i < this.items.length; i++) {
      const slotItem = this.items[i]!;
      if (slotItem === ItemId.None) n += stack;
      else if (slotItem === item) n += stack - this.counts[i]!;
    }
    return n;
  }

  /**
   * Adds up to `amount` units of `item` and returns how many were added (less
   * than `amount` when the inventory fills up). Existing stacks of the item are
   * topped up first, in slot order, then empty slots are used in slot order.
   */
  add(item: number, amount: number): number {
    const stack = stackSizeOf(item);
    assertAmount(amount);
    const { items, counts } = this;
    let left = amount;
    for (let i = 0; i < items.length && left > 0; i++) {
      if (items[i] !== item) continue;
      const put = Math.min(left, stack - counts[i]!);
      counts[i] = counts[i]! + put;
      left -= put;
    }
    for (let i = 0; i < items.length && left > 0; i++) {
      if (items[i] !== ItemId.None) continue;
      const put = Math.min(left, stack);
      items[i] = item;
      counts[i] = put;
      left -= put;
    }
    return amount - left;
  }

  /**
   * Removes up to `amount` units of `item` and returns how many were removed.
   * Units are taken from the last slots first, so the front of the inventory
   * (the hotbar) stays put; emptied slots become empty.
   */
  remove(item: number, amount: number): number {
    stackSizeOf(item);
    assertAmount(amount);
    const { items, counts } = this;
    let left = amount;
    for (let i = items.length - 1; i >= 0 && left > 0; i--) {
      if (items[i] !== item) continue;
      const take = Math.min(left, counts[i]!);
      counts[i] = counts[i]! - take;
      if (counts[i] === 0) items[i] = ItemId.None;
      left -= take;
    }
    return amount - left;
  }

  /** Empties every slot. */
  clear(): void {
    this.items.fill(0);
    this.counts.fill(0);
  }

  /** Folds the slots into a running FNV-1a hash. */
  hashInto(h: number): number {
    return fnv1a32(this.counts, fnv1a32(this.items, h));
  }
}

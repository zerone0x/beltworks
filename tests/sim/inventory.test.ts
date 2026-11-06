import { describe, expect, it } from 'vitest';
import { ITEMS, ItemId } from '../../src/data/items';
import { Inventory, PLAYER_INVENTORY_SLOTS } from '../../src/sim/inventory';

const STACK = ITEMS[ItemId.IronOre].stackSize;

describe('Inventory', () => {
  it('starts empty, with the player inventory size', () => {
    const inv = new Inventory(PLAYER_INVENTORY_SLOTS);
    expect(PLAYER_INVENTORY_SLOTS).toBe(40);
    expect(STACK).toBe(50);
    expect(inv.slots).toBe(40);
    expect(inv.count(ItemId.IronOre)).toBe(0);
    expect(inv.spaceFor(ItemId.IronOre)).toBe(40 * STACK);
  });

  it('stacks the same item into one slot up to the stack size', () => {
    const inv = new Inventory(4);
    expect(inv.add(ItemId.IronOre, 3)).toBe(3);
    expect(inv.add(ItemId.IronOre, 7)).toBe(7);
    expect(Array.from(inv.items)).toEqual([ItemId.IronOre, 0, 0, 0]);
    expect(Array.from(inv.counts)).toEqual([10, 0, 0, 0]);
    // A different item takes the next empty slot.
    inv.add(ItemId.Coal, 1);
    expect(Array.from(inv.items)).toEqual([ItemId.IronOre, ItemId.Coal, 0, 0]);
  });

  it('overflows into the next empty slots, topping up existing stacks first', () => {
    const inv = new Inventory(4);
    inv.add(ItemId.Coal, 1);
    inv.add(ItemId.IronOre, STACK - 5);
    // 5 fill the iron stack in slot 1, the rest overflow into slots 2 and 3.
    expect(inv.add(ItemId.IronOre, 5 + STACK + 2)).toBe(5 + STACK + 2);
    expect(Array.from(inv.items)).toEqual([
      ItemId.Coal,
      ItemId.IronOre,
      ItemId.IronOre,
      ItemId.IronOre,
    ]);
    expect(Array.from(inv.counts)).toEqual([1, STACK, STACK, 2]);
    expect(inv.count(ItemId.IronOre)).toBe(2 * STACK + 2);
  });

  it('reuses a slot freed earlier in the inventory', () => {
    const inv = new Inventory(3);
    inv.add(ItemId.Stone, 1);
    inv.add(ItemId.Coal, 1);
    inv.remove(ItemId.Stone, 1);
    inv.add(ItemId.IronOre, 1);
    expect(Array.from(inv.items)).toEqual([ItemId.IronOre, ItemId.Coal, 0]);
  });

  it('adds only what fits when full, and reports the space left', () => {
    const inv = new Inventory(2);
    inv.add(ItemId.Coal, STACK);
    expect(inv.spaceFor(ItemId.IronOre)).toBe(STACK);
    expect(inv.spaceFor(ItemId.Coal)).toBe(STACK);
    expect(inv.add(ItemId.IronOre, STACK + 10)).toBe(STACK);
    expect(inv.spaceFor(ItemId.IronOre)).toBe(0);
    expect(inv.spaceFor(ItemId.Coal)).toBe(0);
    expect(inv.add(ItemId.IronOre, 1)).toBe(0);
    expect(inv.add(ItemId.Coal, 1)).toBe(0);
    expect(Array.from(inv.counts)).toEqual([STACK, STACK]);
  });

  it('removes from the last slots first and empties drained slots', () => {
    const inv = new Inventory(4);
    inv.add(ItemId.IronOre, STACK + 10);
    inv.add(ItemId.Coal, 4);
    expect(inv.remove(ItemId.IronOre, 15)).toBe(15);
    expect(Array.from(inv.items)).toEqual([ItemId.IronOre, 0, ItemId.Coal, 0]);
    expect(Array.from(inv.counts)).toEqual([STACK - 5, 0, 4, 0]);
    // Asking for more than there is removes what there is.
    expect(inv.remove(ItemId.IronOre, 1000)).toBe(STACK - 5);
    expect(inv.remove(ItemId.Stone, 1)).toBe(0);
    expect(Array.from(inv.items)).toEqual([0, 0, ItemId.Coal, 0]);
  });

  it('wraps existing columns, so tables can keep many inventories in flat arrays', () => {
    const items = new Uint16Array(6);
    const counts = new Uint16Array(6);
    const second = new Inventory(items.subarray(3), counts.subarray(3));
    second.add(ItemId.Stone, 2);
    expect(Array.from(items)).toEqual([0, 0, 0, ItemId.Stone, 0, 0]);
    expect(Array.from(counts)).toEqual([0, 0, 0, 2, 0, 0]);
    expect(() => new Inventory(items, counts.subarray(1))).toThrow(RangeError);
  });

  it('rejects unknown items and bad amounts', () => {
    const inv = new Inventory(2);
    expect(() => inv.add(ItemId.None, 1)).toThrow(RangeError);
    expect(() => inv.add(999, 1)).toThrow(RangeError);
    expect(() => inv.spaceFor(999)).toThrow(RangeError);
    expect(() => inv.add(ItemId.Coal, -1)).toThrow(RangeError);
    expect(() => inv.add(ItemId.Coal, 1.5)).toThrow(RangeError);
    expect(() => inv.remove(ItemId.Coal, -1)).toThrow(RangeError);
    expect(() => new Inventory(0)).toThrow(RangeError);
    expect(inv.add(ItemId.Coal, 0)).toBe(0);
  });

  it('hashes its contents', () => {
    const a = new Inventory(3);
    const b = new Inventory(3);
    expect(a.hashInto(1)).toBe(b.hashInto(1));
    a.add(ItemId.Coal, 1);
    expect(a.hashInto(1)).not.toBe(b.hashInto(1));
    b.add(ItemId.Coal, 1);
    expect(a.hashInto(1)).toBe(b.hashInto(1));
  });
});

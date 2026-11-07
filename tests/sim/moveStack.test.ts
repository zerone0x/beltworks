import { describe, expect, it } from 'vitest';
import { ITEMS, ItemId } from '../../src/data/items';
import { validateCommandInput } from '../../src/sim/commands';
import { Inventory } from '../../src/sim/inventory';
import { Sim } from '../../src/sim/tick';
import { reload, stepTogether } from './saveRoundTrip';

const slots = (inv: Inventory) =>
  Array.from(inv.items, (item, i) => (item === 0 ? null : [item, inv.counts[i]]));

describe('Inventory.move (the cursor stack, D52)', () => {
  it('moves a whole stack or part of one into an empty slot', () => {
    const inv = new Inventory(4);
    inv.add(ItemId.Coal, 30);
    expect(inv.move(0, 2, 30)).toBe(30);
    expect(slots(inv)).toEqual([null, null, [ItemId.Coal, 30], null]);
    expect(inv.move(2, 1, 12)).toBe(12);
    expect(slots(inv)).toEqual([null, [ItemId.Coal, 12], [ItemId.Coal, 18], null]);
    // More than the slot holds moves what there is.
    expect(inv.move(1, 3, 100)).toBe(12);
    expect(slots(inv)).toEqual([null, null, [ItemId.Coal, 18], [ItemId.Coal, 12]]);
  });

  it('tops up a stack of the same item, as far as it fits', () => {
    const stack = ITEMS[ItemId.Coal].stackSize;
    const inv = new Inventory(3);
    inv.add(ItemId.Coal, stack);
    inv.move(0, 1, stack - 10);
    inv.add(ItemId.Coal, stack - 10);
    expect(slots(inv)).toEqual([[ItemId.Coal, stack], [ItemId.Coal, stack - 10], null]);
    // Onto a full stack: nothing moves.
    expect(inv.move(1, 0, 5)).toBe(0);
    expect(inv.move(0, 1, stack)).toBe(10);
    expect(slots(inv)).toEqual([[ItemId.Coal, stack - 10], [ItemId.Coal, stack], null]);
  });

  it('swaps whole stacks of different items, and refuses to split onto another item', () => {
    const inv = new Inventory(3);
    inv.add(ItemId.Coal, 7);
    inv.add(ItemId.IronPlate, 20);
    expect(inv.move(0, 1, 3)).toBe(0);
    expect(slots(inv)).toEqual([[ItemId.Coal, 7], [ItemId.IronPlate, 20], null]);
    expect(inv.move(0, 1, 7)).toBe(7);
    expect(slots(inv)).toEqual([[ItemId.IronPlate, 20], [ItemId.Coal, 7], null]);
  });

  it('ignores empty sources, the same slot and slots out of range', () => {
    const inv = new Inventory(2);
    inv.add(ItemId.Coal, 5);
    expect(inv.move(1, 0, 5)).toBe(0);
    expect(inv.move(0, 0, 5)).toBe(0);
    expect(inv.move(0, 2, 5)).toBe(0);
    expect(inv.move(9, 0, 5)).toBe(0);
    expect(slots(inv)).toEqual([[ItemId.Coal, 5], null]);
  });
});

describe('MoveStack command', () => {
  it('is validated like the other commands', () => {
    expect(
      validateCommandInput({ playerId: 0, type: 'MoveStack', from: 0, to: 39, count: 1 }),
    ).toBeNull();
    expect(
      validateCommandInput({ playerId: 0, type: 'MoveStack', from: -1, to: 3, count: 1 }),
    ).not.toBeNull();
    expect(
      validateCommandInput({ playerId: 0, type: 'MoveStack', from: 0, to: 3, count: 0 }),
    ).not.toBeNull();
  });

  it('moves stacks in the player inventory on its tick, and survives a save while pending', () => {
    const sim = new Sim({ seed: 1 });
    const inv = sim.state.players.inventory(0);
    const before = Array.from(inv.items);
    const first = before[0]!;
    const count = inv.counts[0]!;
    expect(first).not.toBe(0);
    const to = inv.items.indexOf(0);
    sim.enqueue({ tick: 2, playerId: 0, type: 'MoveStack', from: 0, to, count });
    // Saved with the command still queued: the copy applies it on the same tick.
    const copy = reload(sim);
    stepTogether(sim, copy, 4);
    for (const s of [sim, copy]) {
      const moved = s.state.players.inventory(0);
      expect(moved.items[0]).toBe(0);
      expect(moved.items[to]).toBe(first);
      expect(moved.counts[to]).toBe(count);
    }
  });
});

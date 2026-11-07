import { describe, expect, it } from 'vitest';
import { ENTITIES, EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import {
  followSelection,
  ghostOrigin,
  hotbarHighlight,
  hotbarSlotForKey,
  isPlaceableSlot,
  resolveSelection,
  slotWithItem,
} from '../../src/render/buildInput';
import { NO_PINS, hotbarSlots, pinItem, pinNames, pinsFromNames } from '../../src/ui/inventory';
import { TILE_PX } from '../../src/render/camera';
import { EntityIndex } from '../../src/render/entityIndex';
import { Direction } from '../../src/sim/entities/direction';
import { MachineState } from '../../src/sim/entities/machine';
import { ENTITY_STRIDE } from '../../src/sim/snapshot';

const belt = ENTITIES[EntityTypeId.TransportBelt];
const furnace = ENTITIES[EntityTypeId.StoneFurnace];

/** Entity records `[id, type, x, y, dir, status]` as sent in a snapshot (status defaults to 0). */
function records(
  ...entities: (
    [number, number, number, number, number] | [number, number, number, number, number, number]
  )[]
): ArrayBuffer {
  // Status (default 0) and recipe (0) follow the first five fields.
  return Int32Array.from(entities.flatMap((e) => [...e.slice(0, 5), e[5] ?? 0, 0])).buffer;
}

describe('hotbarSlotForKey', () => {
  it('maps 1–9 to slots 0–8 and 0 to slot 9', () => {
    expect(hotbarSlotForKey('Digit1')).toBe(0);
    expect(hotbarSlotForKey('Digit9')).toBe(8);
    expect(hotbarSlotForKey('Digit0')).toBe(9);
    expect(hotbarSlotForKey('KeyR')).toBeNull();
    expect(hotbarSlotForKey('Numpad1')).toBeNull();
  });
});

describe('selecting inventory slots', () => {
  const empty = { item: 0, count: 0 };
  /** 12 slots: belts in slot 0 and 11, coal in slot 1, electric inserters in slot 10. */
  const slots = [
    { item: ItemId.TransportBelt, count: 5 },
    { item: ItemId.Coal, count: 3 },
    ...Array.from({ length: 8 }, () => empty),
    { item: ItemId.ElectricInserter, count: 4 },
    { item: ItemId.TransportBelt, count: 7 },
  ];

  it('finds the first slot holding an item, hotbar first', () => {
    expect(slotWithItem(slots, ItemId.TransportBelt)).toBe(0);
    expect(slotWithItem(slots, ItemId.ElectricInserter)).toBe(10);
    expect(slotWithItem(slots, ItemId.WoodenChest)).toBeNull();
    expect(slotWithItem([{ item: ItemId.WoodenChest, count: 0 }], ItemId.WoodenChest)).toBeNull();
  });

  it('only counts slots with an item that places an entity', () => {
    expect(isPlaceableSlot(slots, 0)).toBe(true);
    expect(isPlaceableSlot(slots, 10)).toBe(true);
    expect(isPlaceableSlot(slots, 1)).toBe(false);
    expect(isPlaceableSlot(slots, 2)).toBe(false);
    expect(isPlaceableSlot(slots, 40)).toBe(false);
  });

  it('keeps a picked-up stack on its item', () => {
    expect(followSelection(slots, 10, ItemId.ElectricInserter)).toBe(10);
    // Run out, or another item in the slot: dropped when no other slot has it.
    const used = slots.map((s, i) => (i === 10 ? empty : s));
    expect(followSelection(used, 10, ItemId.ElectricInserter)).toBeNull();
    const replaced = slots.map((s, i) => (i === 10 ? { item: ItemId.IronOre, count: 1 } : s));
    expect(followSelection(replaced, 10, ItemId.ElectricInserter)).toBeNull();
    // Moves to another slot holding it, the hotbar included.
    const noBelts = slots.map((s, i) => (i === 11 ? empty : s));
    expect(followSelection(noBelts, 11, ItemId.TransportBelt)).toBe(0);
  });

  it('leaves unpinned hotbar selections on their slot', () => {
    const hotbar = { kind: 'hotbar', index: 3 } as const;
    expect(resolveSelection([], NO_PINS, hotbar)).toEqual({ selection: hotbar, slot: 3 });
    expect(resolveSelection(slots, NO_PINS, { kind: 'hotbar', index: 1 }).slot).toBe(1);
    expect(hotbarHighlight(hotbar, NO_PINS)).toBe(3);
  });

  it('takes a pinned hotbar slot from the first stack of its item, and keeps it while there is none', () => {
    const pins = pinItem(NO_PINS, 4, ItemId.ElectricInserter);
    const hotbar = { kind: 'hotbar', index: 4 } as const;
    expect(resolveSelection(slots, pins, hotbar)).toEqual({ selection: hotbar, slot: 10 });
    const used = slots.map((s, i) => (i === 10 ? empty : s));
    expect(resolveSelection(used, pins, hotbar)).toEqual({ selection: hotbar, slot: null });
    expect(hotbarHighlight(hotbar, pins)).toBe(4);
  });

  it('drops a picked-up stack once the inventory has none of it', () => {
    const picked = { kind: 'slot', slot: 10, item: ItemId.ElectricInserter, count: 2 } as const;
    expect(resolveSelection(slots, NO_PINS, picked)).toEqual({ selection: picked, slot: 10 });
    const used = slots.map((s, i) => (i === 10 ? empty : s));
    expect(resolveSelection(used, NO_PINS, picked)).toEqual({ selection: null, slot: null });
    // Picked up in the hotbar's slots: highlighted there unless the hotbar slot is pinned.
    const front = { kind: 'slot', slot: 1, item: ItemId.Coal, count: 1 } as const;
    expect(hotbarHighlight(front, NO_PINS)).toBe(1);
    expect(hotbarHighlight(front, pinItem(NO_PINS, 1, ItemId.IronOre))).toBeNull();
  });
});

describe('hotbar pins', () => {
  const empty = { item: 0, count: 0 };
  const slots = [
    { item: ItemId.TransportBelt, count: 5 },
    { item: ItemId.Coal, count: 3 },
    ...Array.from({ length: 8 }, () => empty),
    { item: ItemId.Coal, count: 4 },
  ];

  it('show the inventory slot of their index until an item is pinned', () => {
    expect(hotbarSlots(slots, NO_PINS)).toEqual(slots.slice(0, 10));
    const pins = pinItem(NO_PINS, 0, ItemId.Coal);
    const shown = hotbarSlots(slots, pins);
    expect(shown[0]).toEqual({ item: ItemId.Coal, count: 7 });
    expect(shown[1]).toEqual(slots[1]);
    // A pinned item the inventory has none of shows as an empty slot (the hotbar draws it faintly).
    expect(hotbarSlots(slots, pinItem(NO_PINS, 2, ItemId.Lab))[2]).toEqual(empty);
  });

  it('pin each item once, unpin with 0, and store as item names', () => {
    let pins = pinItem(NO_PINS, 0, ItemId.Coal);
    pins = pinItem(pins, 5, ItemId.Coal);
    expect(pins[0]).toBe(0);
    expect(pins[5]).toBe(ItemId.Coal);
    expect(pinItem(pins, 5, 0)).toEqual(NO_PINS);
    const names = pinNames(pins);
    expect(names[5]).toBe('coal');
    expect(names[0]).toBe('');
    expect(pinsFromNames(names)).toEqual(pins);
    expect(pinsFromNames(undefined)).toEqual(NO_PINS);
    expect(pinsFromNames(['no-such-item'])).toEqual(NO_PINS);
  });
});

describe('ghostOrigin', () => {
  it('puts a 1×1 ghost on the tile under the cursor', () => {
    expect(ghostOrigin(belt, Direction.North, 3.2 * TILE_PX, -0.1 * TILE_PX)).toEqual({
      x: 3,
      y: -1,
    });
  });

  it('centers a 2×2 ghost on the nearest tile corner', () => {
    expect(ghostOrigin(furnace, Direction.North, 3.7 * TILE_PX, 3.3 * TILE_PX)).toEqual({
      x: 3,
      y: 2,
    });
    expect(ghostOrigin(furnace, Direction.North, -0.4 * TILE_PX, -0.6 * TILE_PX)).toEqual({
      x: -1,
      y: -2,
    });
  });
});

describe('EntityIndex', () => {
  it('indexes every tile of each footprint', () => {
    const index = new EntityIndex();
    expect(index.at(0, 0)).toBeNull();
    expect(
      index.apply(
        records(
          [1, EntityTypeId.StoneFurnace, -1, -1, Direction.North],
          [2, EntityTypeId.TransportBelt, 5, 0, Direction.West],
        ),
      ),
    ).toBe(true);
    expect(index.entities).toHaveLength(2);
    for (const [x, y] of [
      [-1, -1],
      [0, -1],
      [-1, 0],
      [0, 0],
    ]) {
      expect(index.at(x!, y!)?.id).toBe(1);
    }
    expect(index.at(1, 0)).toBeNull();
    expect(index.at(5, 0)).toMatchObject({ id: 2, proto: belt, w: 1, h: 1, dir: Direction.West });
  });

  it('only reports a change when the records differ', () => {
    const index = new EntityIndex();
    const a = records([1, EntityTypeId.WoodenChest, 0, 0, 0]);
    expect(index.apply(a)).toBe(true);
    const version = index.version;
    expect(index.apply(records([1, EntityTypeId.WoodenChest, 0, 0, 0]))).toBe(false);
    expect(index.version).toBe(version);
    expect(index.apply(new ArrayBuffer(0))).toBe(true);
    expect(index.at(0, 0)).toBeNull();
    expect(index.version).toBe(version + 1);
  });

  it('keeps unknown entity types as 1×1 without a prototype', () => {
    const index = new EntityIndex();
    index.apply(records([3, 200, 7, 7, 0]));
    expect(index.at(7, 7)).toMatchObject({ id: 3, type: 200, proto: undefined });
    expect(new Int32Array(records([3, 200, 7, 7, 0])).length).toBe(ENTITY_STRIDE);
  });

  it('carries the machine state and finds entities by id', () => {
    const index = new EntityIndex();
    index.apply(records([4, EntityTypeId.StoneFurnace, 0, 0, 0, MachineState.Working]));
    expect(index.byId(4)).toMatchObject({ status: MachineState.Working, w: 2 });
    expect(index.byId(5)).toBeNull();
    // A state change alone is a change to redraw.
    expect(index.apply(records([4, EntityTypeId.StoneFurnace, 0, 0, 0, MachineState.NoFuel]))).toBe(
      true,
    );
  });
});

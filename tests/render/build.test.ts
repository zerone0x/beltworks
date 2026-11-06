import { describe, expect, it } from 'vitest';
import { ENTITIES, EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import {
  followSelection,
  ghostOrigin,
  hotbarSlotForKey,
  isPlaceableSlot,
  slotWithItem,
} from '../../src/render/buildInput';
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
  return Int32Array.from(entities.flatMap((e) => [...e.slice(0, 5), e[5] ?? 0])).buffer;
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

  it('keeps a selection past the hotbar on its item', () => {
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

  it('leaves hotbar selections on their slot', () => {
    expect(followSelection([], 3, ItemId.TransportBelt)).toBe(3);
    expect(followSelection(slots, 1, ItemId.TransportBelt)).toBe(1);
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

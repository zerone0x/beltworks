import { describe, expect, it } from 'vitest';
import { ITEMS, ItemId } from '../../src/data/items';
import { BuildResult, placeEntity, removeEntity } from '../../src/sim/entities/build';
import { ChestTable } from '../../src/sim/entities/chest';
import { Direction } from '../../src/sim/entities/direction';
import { FurnaceSlot } from '../../src/sim/entities/furnace';
import { TransferResult, insertIntoEntity, takeFromEntity } from '../../src/sim/entities/transfer';
import { tileCenter } from '../../src/sim/fixed';
import { Sim } from '../../src/sim/tick';

function setup() {
  const sim = new Sim({ seed: 1 });
  const { state } = sim;
  state.players.x[0] = tileCenter(0);
  state.players.y[0] = tileCenter(0);
  expect(placeEntity(state, 0, ItemId.WoodenChest, 2, 0, Direction.North)).toBe(BuildResult.Ok);
  const id = state.entities.at(2, 0);
  return { sim, state, id, entities: state.entities, inv: state.players.inventory(0) };
}

describe('wooden chest', () => {
  it('has 16 slots that fill like an inventory', () => {
    const { entities, id } = setup();
    const table = entities.table(1) as ChestTable;
    expect(table.slotsPerChest).toBe(16);
    expect(entities.slots(id)).toHaveLength(16);
    expect(entities.insertable(id, ItemId.Coal)).toBe(16 * 50);
    expect(entities.insertable(id, 999)).toBe(0);
    expect(entities.insert(id, ItemId.Coal, 70)).toBe(70);
    expect(entities.insert(id, ItemId.Stone, 5)).toBe(5);
    expect(entities.slots(id).slice(0, 4)).toEqual([
      { item: ItemId.Coal, count: 50 },
      { item: ItemId.Coal, count: 20 },
      { item: ItemId.Stone, count: 5 },
      { item: 0, count: 0 },
    ]);
    expect(entities.insertable(id, ItemId.Coal)).toBe(30 + 13 * 50);
    expect(entities.insert(id, ItemId.IronOre, 10_000)).toBe(13 * 50);
    expect(entities.insertable(id, ItemId.Stone)).toBe(45);
    expect(entities.take(id, 1, 5)).toBe(5);
    expect(entities.take(id, 1, 100)).toBe(15);
    expect(entities.slots(id)[1]).toEqual({ item: 0, count: 0 });
    expect(entities.outputSlot(id)).toBe(0);
    expect(entities.take(id, 16, 1)).toBe(0);
    expect(entities.take(id, -1, 1)).toBe(0);
  });

  it('refunds its contents when removed', () => {
    const { state, id, entities, inv } = setup();
    entities.insert(id, ItemId.Coal, 30);
    entities.insert(id, ItemId.IronOre, 7);
    const coal = inv.count(ItemId.Coal);
    expect(removeEntity(state, 0, 2, 0)).toBe(BuildResult.Ok);
    expect(inv.count(ItemId.Coal)).toBe(coal + 30);
    expect(inv.count(ItemId.IronOre)).toBe(7);
    expect(inv.count(ItemId.WoodenChest)).toBe(2);
    expect(entities.count).toBe(0);
  });

  it("blocks removal when its contents don't fit, and keeps them", () => {
    const { state, id, entities, inv } = setup();
    entities.insert(id, ItemId.IronOre, 16 * 50);
    // 16 stacks of ore need 16 free slots; leave fewer.
    inv.add(ItemId.Stone, inv.spaceFor(ItemId.Stone) - 10 * ITEMS[ItemId.Stone].stackSize);
    expect(removeEntity(state, 0, 2, 0)).toBe(BuildResult.InventoryFull);
    expect(entities.count).toBe(1);
    expect(entities.contents(id).reduce((n, s) => n + s.count, 0)).toBe(800);
    expect(inv.count(ItemId.IronOre)).toBe(0);
  });

  it('keeps the other rows intact when a chest is removed', () => {
    const { state, id, entities } = setup();
    placeEntity(state, 0, ItemId.WoodenChest, -2, 0, Direction.North);
    const other = entities.at(-2, 0);
    entities.insert(id, ItemId.Coal, 1);
    entities.insert(other, ItemId.Stone, 3);
    expect(removeEntity(state, 0, 2, 0)).toBe(BuildResult.Ok);
    expect(entities.contents(other)).toEqual([{ item: ItemId.Stone, count: 3 }]);
  });
});

describe('Insert and Take', () => {
  it('move items between the inventory and an entity', () => {
    const { state, id, inv } = setup();
    expect(insertIntoEntity(state, 0, id, ItemId.Coal, 4)).toBe(TransferResult.Ok);
    expect(inv.count(ItemId.Coal)).toBe(6);
    // More than the player has: moves what there is.
    expect(insertIntoEntity(state, 0, id, ItemId.Coal, 500)).toBe(TransferResult.Ok);
    expect(inv.count(ItemId.Coal)).toBe(0);
    expect(insertIntoEntity(state, 0, id, ItemId.Coal, 1)).toBe(TransferResult.NothingToMove);
    expect(insertIntoEntity(state, 0, id, 999, 1)).toBe(TransferResult.NothingToMove);
    expect(takeFromEntity(state, 0, id, 0, 3)).toBe(TransferResult.Ok);
    expect(inv.count(ItemId.Coal)).toBe(3);
    expect(takeFromEntity(state, 0, id, 0, 100)).toBe(TransferResult.Ok);
    expect(inv.count(ItemId.Coal)).toBe(10);
    expect(takeFromEntity(state, 0, id, 0, 1)).toBe(TransferResult.NothingToMove);
    expect(takeFromEntity(state, 0, id, 99, 1)).toBe(TransferResult.NothingToMove);
  });

  it('route fuel and ore into a furnace, and refuse what it does not take', () => {
    const sim = new Sim({
      seed: 1,
      startingKit: [
        { item: ItemId.StoneFurnace, count: 1 },
        { item: ItemId.Coal, count: 10 },
        { item: ItemId.IronOre, count: 8 },
        { item: ItemId.Stone, count: 4 },
      ],
    });
    const { state } = sim;
    state.players.x[0] = tileCenter(0);
    state.players.y[0] = tileCenter(0);
    placeEntity(state, 0, ItemId.StoneFurnace, 2, 0, Direction.North);
    const id = state.entities.at(2, 0);
    const inv = state.players.inventory(0);
    expect(insertIntoEntity(state, 0, id, ItemId.Coal, 10)).toBe(TransferResult.Ok);
    expect(insertIntoEntity(state, 0, id, ItemId.IronOre, 8)).toBe(TransferResult.Ok);
    expect(insertIntoEntity(state, 0, id, ItemId.Stone, 4)).toBe(TransferResult.NoRoom);
    expect(inv.count(ItemId.Stone)).toBe(4);
    expect(state.entities.slots(id)).toEqual([
      { item: ItemId.IronOre, count: 8 },
      { item: ItemId.Coal, count: 10 },
      { item: 0, count: 0 },
    ]);
    for (let i = 0; i < 2 * 192; i++) sim.step();
    expect(takeFromEntity(state, 0, id, FurnaceSlot.Output, 100)).toBe(TransferResult.Ok);
    expect(inv.count(ItemId.IronPlate)).toBe(2);
    expect(takeFromEntity(state, 0, id, FurnaceSlot.Fuel, 3)).toBe(TransferResult.Ok);
    expect(inv.count(ItemId.Coal)).toBe(3);
  });

  it('take only what fits into the inventory', () => {
    const { state, id, entities, inv } = setup();
    entities.insert(id, ItemId.IronOre, 50);
    inv.add(ItemId.IronOre, 45);
    inv.add(ItemId.Stone, inv.spaceFor(ItemId.Stone));
    expect(takeFromEntity(state, 0, id, 0, 50)).toBe(TransferResult.Ok);
    expect(inv.count(ItemId.IronOre)).toBe(50);
    expect(entities.slots(id)[0]).toEqual({ item: ItemId.IronOre, count: 45 });
    expect(takeFromEntity(state, 0, id, 0, 50)).toBe(TransferResult.NoRoom);
  });

  it('need the entity and reach', () => {
    const { state, id } = setup();
    expect(insertIntoEntity(state, 0, 999, ItemId.Coal, 1)).toBe(TransferResult.NoEntity);
    expect(insertIntoEntity(state, 0, 0, ItemId.Coal, 1)).toBe(TransferResult.NoEntity);
    state.players.x[0] = tileCenter(-20);
    expect(insertIntoEntity(state, 0, id, ItemId.Coal, 1)).toBe(TransferResult.OutOfReach);
    expect(takeFromEntity(state, 0, id, 0, 1)).toBe(TransferResult.OutOfReach);
    // Belts take items onto their lanes (two at a time at most), but have no slots to take from.
    state.players.x[0] = tileCenter(0);
    placeEntity(state, 0, ItemId.TransportBelt, 3, 0, Direction.North);
    const belt = state.entities.at(3, 0);
    expect(insertIntoEntity(state, 0, belt, ItemId.Coal, 5)).toBe(TransferResult.Ok);
    expect(state.entities.contents(belt)).toEqual([{ item: ItemId.Coal, count: 2 }]);
    expect(insertIntoEntity(state, 0, belt, ItemId.Coal, 1)).toBe(TransferResult.NoRoom);
    expect(takeFromEntity(state, 0, belt, 0, 1)).toBe(TransferResult.NothingToMove);
  });

  it('apply through the Sim and are ignored deterministically when they do not apply', () => {
    const a = setup();
    const b = setup();
    const cmd = { tick: 0, playerId: 0 } as const;
    for (const c of [
      { type: 'Insert', entity: 77, item: ItemId.Coal, count: 1 },
      { type: 'Insert', entity: b.id, item: ItemId.IronOre, count: 1 },
      { type: 'Take', entity: b.id, slot: 3, count: 1 },
      { type: 'Insert', entity: b.id, item: ItemId.Coal, count: 1, playerId: 5 },
    ] as const) {
      b.sim.enqueue({ ...cmd, ...c });
    }
    a.sim.step();
    b.sim.step();
    expect(b.sim.hash()).toBe(a.sim.hash());
    b.sim.enqueue({ ...cmd, tick: 1, type: 'Insert', entity: b.id, item: ItemId.Coal, count: 2 });
    b.sim.enqueue({ ...cmd, tick: 1, type: 'Take', entity: b.id, slot: 0, count: 1 });
    a.sim.step();
    b.sim.step();
    expect(b.inv.count(ItemId.Coal)).toBe(9);
    expect(b.entities.slots(b.id)[0]).toEqual({ item: ItemId.Coal, count: 1 });
    expect(b.sim.hash()).not.toBe(a.sim.hash());
  });
});

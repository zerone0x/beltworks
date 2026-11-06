import { describe, expect, it } from 'vitest';
import { EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { RecipeId } from '../../src/data/recipes';
import { placeEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { MachineState } from '../../src/sim/entities/machine';
import { tileCenter } from '../../src/sim/fixed';
import { PLAYER_INVENTORY_SLOTS } from '../../src/sim/inventory';
import {
  CHUNK_RECORD_BYTES,
  decodeChunks,
  decodeEntityDetail,
  decodeInventory,
  encodeChunks,
  encodeEntityDetail,
  encodeInventory,
} from '../../src/sim/snapshot';
import { Sim } from '../../src/sim/tick';
import { generateChunk } from '../../src/sim/world/generate';

describe('encodeChunks / decodeChunks', () => {
  it('round-trips chunk coordinates, terrain, resources and amounts', () => {
    // The starting region has ore patches, so resources and amounts are non-trivial.
    const chunks = [generateChunk(3, 0, 0), generateChunk(3, -1, 0), generateChunk(3, -700, 512)];
    const buffer = encodeChunks(chunks);
    expect(buffer.byteLength).toBe(3 * CHUNK_RECORD_BYTES);
    const decoded = decodeChunks(buffer);
    expect(decoded).toHaveLength(3);
    decoded.forEach((d, i) => {
      const c = chunks[i]!;
      expect([d.cx, d.cy]).toEqual([c.cx, c.cy]);
      expect(d.terrain).toEqual(c.terrain);
      expect(d.resource).toEqual(c.resource);
      expect(d.amount).toEqual(c.amount);
    });
    expect(chunks[0]!.amount.some((a) => a > 0)).toBe(true);
  });

  it('handles an empty batch and rejects truncated buffers', () => {
    expect(decodeChunks(encodeChunks([]))).toEqual([]);
    expect(() => decodeChunks(new ArrayBuffer(CHUNK_RECORD_BYTES - 4))).toThrow(RangeError);
  });
});

describe('encodeInventory / decodeInventory', () => {
  it('round-trips one player inventory as [item, count] slots', () => {
    const sim = new Sim({ seed: 1, players: 2, startingKit: [] });
    sim.state.players.inventory(1).add(ItemId.Coal, 60);
    sim.state.players.inventory(1).add(ItemId.Stone, 3);
    const encoded = encodeInventory(sim.state, 1);
    expect(encoded.length).toBe(2 * PLAYER_INVENTORY_SLOTS);
    const slots = decodeInventory(encoded.buffer);
    expect(slots).toHaveLength(PLAYER_INVENTORY_SLOTS);
    expect(slots.slice(0, 4)).toEqual([
      { item: ItemId.Coal, count: 50 },
      { item: ItemId.Coal, count: 10 },
      { item: ItemId.Stone, count: 3 },
      { item: 0, count: 0 },
    ]);
    // Player 0's inventory is separate.
    expect(decodeInventory(encodeInventory(sim.state, 0).buffer)[0]).toEqual({ item: 0, count: 0 });
    // A copy: later changes don't show up in it.
    sim.state.players.inventory(1).remove(ItemId.Stone, 3);
    expect(decodeInventory(encoded.buffer)[2]).toEqual({ item: ItemId.Stone, count: 3 });
  });
});

describe('encodeEntityDetail / decodeEntityDetail', () => {
  it('round-trips the GUI data of a furnace and a chest', () => {
    const sim = new Sim({ seed: 1, startingKit: [] });
    const { state } = sim;
    const inv = state.players.inventory(0);
    inv.add(ItemId.StoneFurnace, 1);
    inv.add(ItemId.WoodenChest, 1);
    state.players.x[0] = tileCenter(0);
    state.players.y[0] = tileCenter(0);
    placeEntity(state, 0, ItemId.StoneFurnace, 2, 0, Direction.North);
    placeEntity(state, 0, ItemId.WoodenChest, -2, 0, Direction.North);
    const [furnace, chest] = [state.entities.at(2, 0), state.entities.at(-2, 0)];
    state.entities.insert(furnace, ItemId.Coal, 2);
    state.entities.insert(furnace, ItemId.IronOre, 4);
    for (let i = 0; i < 10; i++) sim.step();
    const detail = decodeEntityDetail(encodeEntityDetail(state, 0, furnace)!.buffer);
    expect(detail).toEqual({
      id: furnace,
      type: EntityTypeId.StoneFurnace,
      reachable: true,
      status: MachineState.Working,
      recipe: RecipeId.IronPlate,
      progress: 10,
      energy: 4_000_000 - 10 * 1_500,
      burning: ItemId.Coal,
      slots: [
        { item: ItemId.IronOre, count: 3 },
        { item: ItemId.Coal, count: 1 },
        { item: 0, count: 0 },
      ],
    });
    state.entities.insert(chest, ItemId.Stone, 3);
    const chestDetail = decodeEntityDetail(encodeEntityDetail(state, 0, chest)!.buffer);
    expect(chestDetail.status).toBe(MachineState.Idle);
    expect(chestDetail.slots).toHaveLength(16);
    expect(chestDetail.slots[0]).toEqual({ item: ItemId.Stone, count: 3 });
    // Out of reach, and gone.
    state.players.x[0] = tileCenter(-30);
    expect(decodeEntityDetail(encodeEntityDetail(state, 0, chest)!.buffer).reachable).toBe(false);
    expect(encodeEntityDetail(state, 0, 999)).toBeNull();
  });
});

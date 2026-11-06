import { describe, expect, it } from 'vitest';
import { ItemId } from '../../src/data/items';
import { PLAYER_INVENTORY_SLOTS } from '../../src/sim/inventory';
import {
  CHUNK_RECORD_BYTES,
  decodeChunks,
  decodeInventory,
  encodeChunks,
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
    const sim = new Sim({ seed: 1, players: 2 });
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

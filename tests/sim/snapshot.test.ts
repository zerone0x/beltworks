import { describe, expect, it } from 'vitest';
import { CHUNK_RECORD_BYTES, decodeChunks, encodeChunks } from '../../src/sim/snapshot';
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

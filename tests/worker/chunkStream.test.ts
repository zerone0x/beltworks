import { describe, expect, it } from 'vitest';
import { startingPatches } from '../../src/sim/world/generate';
import { CHUNK_COORD_LIMIT, World } from '../../src/sim/world/world';
import { ChunkStreamer, chunkWindow, sanitizeViewport } from '../../src/worker/chunkStream';
import { CHUNK_MARGIN, MAX_VIEWPORT_TILES, type ChunkRect } from '../../src/worker/protocol';

const area = (r: ChunkRect): number => (r.cx1 - r.cx0 + 1) * (r.cy1 - r.cy0 + 1);
const coords = (chunks: { cx: number; cy: number }[]): string[] =>
  chunks.map((c) => `${String(c.cx)},${String(c.cy)}`).sort();

describe('chunkWindow', () => {
  it('covers the viewport plus the margin, including negative tiles', () => {
    // Tiles [-40, 39] x [-20, 19] span chunks -2..1 and -1..0.
    expect(chunkWindow({ x: -40, y: -20, w: 80, h: 40 })).toEqual({
      cx0: -2 - CHUNK_MARGIN,
      cy0: -1 - CHUNK_MARGIN,
      cx1: 1 + CHUNK_MARGIN,
      cy1: 0 + CHUNK_MARGIN,
    });
    // Exactly one chunk.
    expect(chunkWindow({ x: 32, y: 0, w: 32, h: 32 }, 0)).toEqual({
      cx0: 1,
      cy0: 0,
      cx1: 1,
      cy1: 0,
    });
    // An empty viewport still covers the chunk at its origin.
    expect(chunkWindow({ x: 33, y: 0, w: 0, h: 0 }, 0)).toEqual({ cx0: 1, cy0: 0, cx1: 1, cy1: 0 });
  });

  it('stays inside the supported chunk range', () => {
    const far = CHUNK_COORD_LIMIT * 32;
    const r = chunkWindow({ x: far, y: -far - 1000, w: 100, h: 100 });
    expect(r.cx0).toBe(CHUNK_COORD_LIMIT - 1);
    expect(r.cx1).toBe(CHUNK_COORD_LIMIT - 1);
    expect(r.cy0).toBe(-CHUNK_COORD_LIMIT);
  });
});

describe('sanitizeViewport', () => {
  it('accepts integer viewports and clamps their size', () => {
    expect(sanitizeViewport({ x: -5, y: 7, w: 10, h: 0 })).toEqual({ x: -5, y: 7, w: 10, h: 0 });
    expect(sanitizeViewport({ x: 0, y: 0, w: 1e9, h: 5 })).toEqual({
      x: 0,
      y: 0,
      w: MAX_VIEWPORT_TILES,
      h: 5,
    });
  });

  it('rejects malformed viewports', () => {
    for (const bad of [
      null,
      {},
      { x: 0.5, y: 0, w: 1, h: 1 },
      { x: 0, y: 0, w: -1, h: 1 },
      { x: 0, y: 0, w: 1, h: Number.NaN },
      { x: 2 ** 40, y: 0, w: 1, h: 1 },
      { x: '0', y: 0, w: 1, h: 1 },
    ]) {
      expect(() => sanitizeViewport(bad)).toThrow(TypeError);
    }
  });
});

describe('ChunkStreamer', () => {
  it('sends nothing before the first viewport', () => {
    expect(new ChunkStreamer(new World(1)).collect()).toBeNull();
  });

  it('sends every chunk of the window once, nearest to the center first', () => {
    const streamer = new ChunkStreamer(new World(1), 100);
    streamer.setViewport({ x: -16, y: -16, w: 32, h: 32 });
    const first = streamer.collect()!;
    expect(first.chunks).toHaveLength(area(first.window));
    // The viewport straddles chunks -1..0 on both axes; those four come first.
    expect(coords(first.chunks.slice(0, 4))).toEqual(['-1,-1', '-1,0', '0,-1', '0,0']);
    expect(streamer.sentCount).toBe(area(first.window));
    expect(streamer.collect()!.chunks).toEqual([]);
  });

  it('spreads a large window over several snapshots', () => {
    const streamer = new ChunkStreamer(new World(1), 5);
    streamer.setViewport({ x: 0, y: 0, w: 64, h: 64 });
    const seen: string[] = [];
    let batch = streamer.collect()!;
    while (batch.chunks.length > 0) {
      expect(batch.chunks.length).toBeLessThanOrEqual(5);
      seen.push(...coords(batch.chunks));
      batch = streamer.collect()!;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(area(batch.window));
  });

  it('only sends chunks that entered the window when the view moves', () => {
    const streamer = new ChunkStreamer(new World(1), 100);
    streamer.setViewport({ x: 0, y: 0, w: 32, h: 32 });
    streamer.collect();
    streamer.setViewport({ x: 32, y: 0, w: 32, h: 32 });
    const moved = streamer.collect()!;
    // The window moves from chunks -1..1 to 0..2: one new column on the right.
    expect(coords(moved.chunks)).toEqual(['2,-1', '2,0', '2,1']);
    expect(streamer.sentCount).toBe(area(moved.window));
  });

  it('forgets chunks that left the window, resends them on return, and keeps memory bounded', () => {
    const world = new World(1);
    const streamer = new ChunkStreamer(world, 1000);
    const at = (x: number): void => {
      streamer.setViewport({ x, y: 0, w: 40, h: 30 });
      streamer.collect();
    };
    at(0);
    const windowSize = streamer.sentCount;
    for (let x = 0; x < 50 * 32; x += 64) at(x);
    expect(streamer.sentCount).toBe(windowSize);
    // Unmodified chunks that left the window were released from the world too.
    expect(world.chunkCount).toBe(windowSize);
    streamer.setViewport({ x: 0, y: 0, w: 40, h: 30 });
    expect(streamer.collect()!.chunks).toHaveLength(windowSize);
  });

  it('resends chunks that changed since they were sent', () => {
    const world = new World(4);
    const { x, y } = startingPatches(4)[0]!;
    const streamer = new ChunkStreamer(world, 100);
    streamer.setViewport({ x: -20, y: -20, w: 40, h: 40 });
    streamer.collect();
    expect(world.mine(x, y, 5)).toBe(5);
    const batch = streamer.collect()!;
    expect(coords(batch.chunks)).toEqual([`${String(x >> 5)},${String(y >> 5)}`]);
    expect(batch.chunks[0]!.amount).toBe(world.getChunk(x >> 5, y >> 5).amount);
    expect(streamer.collect()!.chunks).toEqual([]);
  });

  it('keeps modified chunks in the world when they leave the window', () => {
    const world = new World(4);
    const { x, y } = startingPatches(4)[0]!;
    world.mine(x, y, 1);
    const hash = world.hashInto();
    const streamer = new ChunkStreamer(world, 100);
    streamer.setViewport({ x: -20, y: -20, w: 40, h: 40 });
    streamer.collect();
    streamer.setViewport({ x: 5000, y: 5000, w: 40, h: 40 });
    streamer.collect();
    expect(world.peekChunk(x >> 5, y >> 5)).toBeDefined();
    expect(world.hashInto()).toBe(hash);
  });
});

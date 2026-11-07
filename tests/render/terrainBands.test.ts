import type { Renderer } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { SETTLE_MS, TerrainLayer } from '../../src/render/terrainLayer';
import type { TerrainArt } from '../../src/render/terrainArt';
import { encodeChunks } from '../../src/sim/snapshot';
import { CHUNK_SIZE } from '../../src/sim/world/chunk';
import { generateChunk } from '../../src/sim/world/generate';

/** A terrain art that records its bakes instead of drawing them. */
function fakeArt() {
  const bakes: { cx: number; cy: number; texels: number; from: number; to: number }[] = [];
  const art = {
    bake: (
      _renderer: unknown,
      _plan: unknown,
      x0: number,
      y0: number,
      texels: number,
      _target: unknown,
      from = 0,
      to = CHUNK_SIZE,
    ) => {
      bakes.push({ cx: x0 / CHUNK_SIZE, cy: y0 / CHUNK_SIZE, texels, from, to });
    },
  };
  return { art: art as unknown as TerrainArt, bakes };
}

/** A layer with the rendered look and the 3 × 3 chunks around the origin. */
function setup() {
  const layer = new TerrainLayer();
  layer.maxTexels = 16;
  const { art, bakes } = fakeArt();
  layer.setArt(art, {} as Renderer);
  const chunks = [];
  for (let cy = -1; cy <= 1; cy++) {
    for (let cx = -1; cx <= 1; cx++) chunks.push(generateChunk(1, cx, cy));
  }
  layer.applySnapshot({ cx0: -1, cy0: -1, cx1: 1, cy1: 1 }, encodeChunks(chunks));
  return { layer, bakes };
}

describe('terrain bakes', () => {
  // A view inside chunk (0, 0), within the bake margin of chunks -1.
  const view = { x: 2, y: 2, w: 12, h: 12 };

  it('fill holes on screen whole, then the chunks around the view a chunk per frame when still', () => {
    const { layer, bakes } = setup();
    layer.update(undefined, view, 1, 0);
    // The chunk on screen, whole, in one frame.
    expect(bakes).toEqual([{ cx: 0, cy: 0, texels: 16, from: 0, to: CHUNK_SIZE }]);
    bakes.length = 0;
    // Standing still, the rest go whole too (one per frame at 16 texels per tile).
    for (let t = 1; t < 20; t++) layer.update(undefined, view, 1, SETTLE_MS * 2 + t);
    expect(bakes.length).toBeGreaterThan(0);
    expect(bakes.every((b) => b.from === 0 && b.to === CHUNK_SIZE)).toBe(true);
    expect(layer.stats().pendingBakes).toBe(0);
  });

  it('bake the chunks around a moving view in bands of tile rows', () => {
    const { layer, bakes } = setup();
    layer.update(undefined, view, 1, 0);
    bakes.length = 0;
    // The view keeps moving (by a tile each frame) within chunk (0, 0).
    for (let t = 1; t <= 12; t++) {
      layer.update(undefined, { ...view, x: view.x + (t % 2) }, 1, t * 16);
    }
    expect(bakes.length).toBeGreaterThan(0);
    // A quarter of a chunk per frame at 16 texels per tile: 8 rows.
    for (const b of bakes) expect(b.to - b.from).toBe(8);
    const first = bakes.filter((b) => b.cx === bakes[0]!.cx && b.cy === bakes[0]!.cy);
    expect(first.slice(0, 4).map((b) => [b.from, b.to])).toEqual([
      [0, 8],
      [8, 16],
      [16, 24],
      [24, 32],
    ]);
  });

  it('fill holes in bands too while the view moves, holes first', () => {
    const { layer, bakes } = setup();
    layer.update(undefined, view, 1, 0);
    bakes.length = 0;
    // A step east brings chunk (1, 0) on screen without a texture.
    layer.update(undefined, { ...view, x: 30 }, 1, 16);
    expect(bakes).toEqual([{ cx: 1, cy: 0, texels: 16, from: 0, to: 8 }]);
    expect(layer.stats().sprites).toBe(1);
    for (let t = 2; t <= 4; t++) layer.update(undefined, { ...view, x: 30 }, 1, t * 16);
    expect(bakes.map((b) => [b.cx, b.cy, b.to])).toEqual([
      [1, 0, 8],
      [1, 0, 16],
      [1, 0, 24],
      [1, 0, 32],
    ]);
    expect(layer.stats().sprites).toBe(2);
  });

  it('start a banded bake over when its chunk changes', () => {
    const { layer, bakes } = setup();
    layer.update(undefined, view, 1, 0);
    layer.update(undefined, { ...view, x: 3 }, 1, 16);
    const job = bakes[bakes.length - 1]!;
    expect(job.to).toBe(8);
    // That chunk's trees change at the edge it shares with chunk (0, 0).
    const changed = generateChunk(1, job.cx, job.cy);
    changed.tree.fill(0);
    changed.tree[0] = 1;
    layer.applySnapshot(null, encodeChunks([changed]));
    layer.update(undefined, view, 1, 32);
    expect(bakes[bakes.length - 1]).toEqual({ ...job, from: 0, to: 8 });
  });
});

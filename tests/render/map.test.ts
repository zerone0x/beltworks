import { describe, expect, it } from 'vitest';
import { EntityTypeId, entityPrototype } from '../../src/data/entities';
import { ResourceId } from '../../src/data/resources';
import { TILES, TileId } from '../../src/data/tiles';
import { EntityIndex } from '../../src/render/entityIndex';
import { MAP_FADE_MS, MAP_ZOOM, stepMapBlend, wantsMapMode } from '../../src/render/mapLayer';
import { MAP_CHUNK_BYTES, MapStore, mapChunkPixels, mapTileColor } from '../../src/render/mapStore';
import {
  MINIMAP_TILES,
  REGION_CHUNKS,
  minimapState,
  minimapTile,
  regionCovers,
  regionFor,
} from '../../src/ui/minimap';
import { ENTITY_STRIDE, type ChunkData } from '../../src/sim/snapshot';
import { CHUNK_AREA, CHUNK_SIZE } from '../../src/sim/world/chunk';
import type { ChunkRect } from '../../src/worker/protocol';

function chunk(cx: number, cy: number, terrain: number = TileId.Grass): ChunkData {
  return {
    cx,
    cy,
    terrain: new Uint8Array(CHUNK_AREA).fill(terrain),
    resource: new Uint8Array(CHUNK_AREA),
    amount: new Uint32Array(CHUNK_AREA),
    tree: new Uint8Array(CHUNK_AREA),
  };
}

/** Entity records as a snapshot carries them: `[id, type, x, y, dir]`. */
function records(...entities: [number, number, number, number, number?][]): ArrayBuffer {
  const out = new Int32Array(entities.length * ENTITY_STRIDE);
  entities.forEach(([id, type, x, y, dir = 0], i) => {
    out.set([id, type, x, y, dir, 0, 0], i * ENTITY_STRIDE);
  });
  return out.buffer;
}

/** The colour at tile `(lx, ly)` of a chunk's map pixels, as 0xRRGGBB. */
function at(px: Uint8Array, lx: number, ly: number): number {
  const o = (ly * CHUNK_SIZE + lx) * 4;
  expect(px[o + 3]).toBe(0xff);
  return (px[o]! << 16) | (px[o + 1]! << 8) | px[o + 2]!;
}

const window = (cx0: number, cy0: number, cx1: number, cy1: number): ChunkRect => ({
  cx0,
  cy0,
  cx1,
  cy1,
});

describe('map colours', () => {
  it('colours terrain, ore and trees, then entity footprints over them', () => {
    const data = chunk(1, 0);
    data.terrain[1] = TileId.Water;
    data.resource[2] = ResourceId.IronOre;
    data.tree[3] = 1;
    const index = new EntityIndex();
    // A wooden chest at local (5, 5), an assembling machine (3×3) at local (10, 10).
    index.apply(
      records([1, EntityTypeId.WoodenChest, 37, 5], [2, EntityTypeId.AssemblingMachine1, 42, 10]),
    );
    const px = mapChunkPixels(data, index.entities);
    expect(px.length).toBe(MAP_CHUNK_BYTES);
    expect(at(px, 0, 0)).toBe(TILES[TileId.Grass]!.color);
    expect(at(px, 1, 0)).toBe(TILES[TileId.Water]!.color);
    expect(at(px, 2, 0)).toBe(mapTileColor(TileId.Grass, ResourceId.IronOre, 0));
    expect(at(px, 2, 0)).not.toBe(TILES[TileId.Grass]!.color);
    expect(at(px, 3, 0)).toBe(mapTileColor(TileId.Grass, 0, 1));
    const chest = entityPrototype(EntityTypeId.WoodenChest)!.color;
    expect(at(px, 5, 5)).toBe(chest);
    const machine = entityPrototype(EntityTypeId.AssemblingMachine1)!.color;
    // Its right column and bottom row are darker, so machines side by side stay apart.
    expect(at(px, 10, 10)).toBe(machine);
    expect(at(px, 11, 11)).toBe(machine);
    expect(at(px, 12, 10)).not.toBe(machine);
    expect(at(px, 10, 12)).toBe(at(px, 12, 10));
    expect(at(px, 13, 10)).toBe(TILES[TileId.Grass]!.color);
  });

  it('clips footprints that cross a chunk edge', () => {
    const index = new EntityIndex();
    // A 3×3 machine whose top-left tile is the last one of chunk (0, 0).
    index.apply(records([1, EntityTypeId.AssemblingMachine1, 31, 31]));
    const machine = entityPrototype(EntityTypeId.AssemblingMachine1)!.color;
    const left = mapChunkPixels(chunk(0, 0), index.entities);
    expect(at(left, 31, 31)).toBe(machine);
    expect(at(left, 30, 31)).toBe(TILES[TileId.Grass]!.color);
    const right = mapChunkPixels(chunk(1, 1), index.entities);
    // Its middle tile, then its bottom-right corner (an edge: darker).
    expect(at(right, 0, 0)).toBe(machine);
    expect(at(right, 1, 1)).not.toBe(machine);
    expect(at(right, 2, 2)).toBe(TILES[TileId.Grass]!.color);
  });
});

describe('MapStore', () => {
  it('builds arrived chunks, a budget per update', () => {
    const store = new MapStore();
    store.applyChunks(window(0, 0, 2, 0), [chunk(0, 0), chunk(1, 0), chunk(2, 0)]);
    expect(store.size).toBe(3);
    expect(store.pending).toBe(3);
    expect(store.update(2)).toBe(2);
    expect(store.update(2)).toBe(1);
    expect(store.update()).toBe(0);
    expect(store.isCurrent(0, 0)).toBe(true);
    expect(store.get(5, 5)).toBeUndefined();
  });

  it('rebuilds only the chunks whose entities changed', () => {
    const store = new MapStore();
    const index = new EntityIndex();
    store.applyChunks(window(0, 0, 2, 0), [chunk(0, 0), chunk(1, 0), chunk(2, 0)]);
    index.apply(records([1, EntityTypeId.WoodenChest, 1, 1], [2, EntityTypeId.WoodenChest, 40, 1]));
    store.applyEntities(index);
    store.update();
    const versions = () => [0, 1, 2].map((cx) => store.get(cx, 0)!.version);
    expect(versions()).toEqual([1, 1, 1]);

    // A state change only (same ids, places, directions): nothing to rebuild.
    index.apply(
      new Int32Array([
        1,
        EntityTypeId.WoodenChest,
        1,
        1,
        0,
        1,
        0,
        2,
        EntityTypeId.WoodenChest,
        40,
        1,
        0,
        1,
        0,
      ]).buffer,
    );
    store.applyEntities(index);
    expect(store.update()).toBe(0);

    // A belt placed in chunk 2: only chunk 2 is rebuilt.
    index.apply(
      records(
        [1, EntityTypeId.WoodenChest, 1, 1],
        [2, EntityTypeId.WoodenChest, 40, 1],
        [3, EntityTypeId.TransportBelt, 70, 3],
      ),
    );
    store.applyEntities(index);
    expect(store.update()).toBe(1);
    expect(versions()).toEqual([1, 1, 2]);
    const belt = entityPrototype(EntityTypeId.TransportBelt)!.color;
    expect(at(store.get(2, 0)!.pixels, 6, 3)).toBe(belt);

    // The chest in chunk 1 removed: chunk 1 goes back to grass.
    index.apply(
      records([1, EntityTypeId.WoodenChest, 1, 1], [3, EntityTypeId.TransportBelt, 70, 3]),
    );
    store.applyEntities(index);
    expect(store.update()).toBe(1);
    expect(versions()).toEqual([1, 2, 2]);
    expect(at(store.get(1, 0)!.pixels, 8, 1)).toBe(TILES[TileId.Grass]!.color);
  });

  it('keeps explored chunks outside the window unchanged', () => {
    const store = new MapStore();
    const index = new EntityIndex();
    store.applyChunks(window(0, 0, 0, 0), [chunk(0, 0)]);
    index.apply(records([1, EntityTypeId.WoodenChest, 1, 1]));
    store.applyEntities(index);
    store.update();
    // The view moved away: the snapshot no longer carries chunk 0 or its chest.
    store.applyChunks(window(5, 0, 5, 0), [chunk(5, 0)]);
    index.apply(records());
    store.applyEntities(index);
    store.update();
    const explored = store.get(0, 0)!;
    expect(explored.data).toBeNull();
    expect(explored.version).toBe(1);
    expect(at(explored.pixels, 1, 1)).toBe(entityPrototype(EntityTypeId.WoodenChest)!.color);
  });

  it('keeps at most its limit, dropping the explored chunks furthest from the window first', () => {
    const store = new MapStore(16);
    for (let cx = 0; cx < 40; cx++) {
      store.applyChunks(window(cx, 0, cx, 0), [chunk(cx, 0)]);
      store.update();
      expect(store.size).toBeLessThanOrEqual(16 + 2);
    }
    expect(store.get(39, 0)).toBeDefined();
    expect(store.get(30, 0)).toBeDefined();
    expect(store.get(0, 0)).toBeUndefined();
  });
});

describe('map mode', () => {
  it('switches below MAP_ZOOM, or when forced', () => {
    expect(wantsMapMode(MAP_ZOOM)).toBe(false);
    expect(wantsMapMode(MAP_ZOOM * 0.99)).toBe(true);
    expect(wantsMapMode(0.125)).toBe(true);
    expect(wantsMapMode(1, true)).toBe(true);
    expect(wantsMapMode(0.125, false)).toBe(false);
  });

  it('fades in over MAP_FADE_MS and back out', () => {
    const frame = MAP_FADE_MS / 5;
    let blend = 0;
    blend = stepMapBlend(blend, true, frame);
    expect(blend).toBeCloseTo(0.2);
    for (let i = 0; i < 4; i++) blend = stepMapBlend(blend, true, frame);
    expect(blend).toBe(1);
    blend = stepMapBlend(blend, true, frame);
    expect(blend).toBe(1);
    blend = stepMapBlend(blend, false, frame);
    expect(blend).toBeCloseTo(0.8);
    // A stall still fades over a few frames rather than jumping.
    expect(stepMapBlend(1, false, 5000)).toBeGreaterThan(0);
  });
});

describe('minimap geometry', () => {
  it('maps its pixels to tiles around the center, one tile per pixel', () => {
    const center = { x: 100, y: -40 };
    expect(minimapTile(center, MINIMAP_TILES / 2, MINIMAP_TILES / 2)).toEqual(center);
    expect(minimapTile(center, 0, 0)).toEqual({
      x: 100 - MINIMAP_TILES / 2,
      y: -40 - MINIMAP_TILES / 2,
    });
  });

  it('keeps a backing region that covers the minimap', () => {
    for (const center of [
      { x: 0, y: 0 },
      { x: 31.9, y: -0.1 },
      { x: -1000.5, y: 777 },
    ]) {
      const region = regionFor(center);
      expect(regionCovers(region, center)).toBe(true);
      // Still covered a chunk's worth of panning later.
      expect(regionCovers(region, { x: center.x + CHUNK_SIZE / 2, y: center.y })).toBe(true);
    }
    expect(regionCovers(regionFor({ x: 0, y: 0 }), { x: REGION_CHUNKS * CHUNK_SIZE, y: 0 })).toBe(
      false,
    );
  });

  it('derives the view rectangle from the camera', () => {
    const state = minimapState(
      { x: 64, y: -32, zoom: 0.5, width: 1280, height: 720 },
      { x: 32, y: 32 },
    );
    expect(state.center).toEqual({ x: 2, y: -1 });
    expect(state.viewW).toBe(80);
    expect(state.viewH).toBe(45);
    expect(state.player).toEqual({ x: 1, y: 1 });
  });
});

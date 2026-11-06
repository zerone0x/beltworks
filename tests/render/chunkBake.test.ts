import { describe, expect, it } from 'vitest';
import { RESOURCES, ResourceId } from '../../src/data/resources';
import { TILES, TileId } from '../../src/data/tiles';
import {
  CHUNK_TEXTURE_SIZE,
  MISSING_COLOR,
  TEXELS_PER_TILE,
  bakeChunkPixels,
  dotCount,
} from '../../src/render/chunkBake';
import type { ChunkData } from '../../src/sim/snapshot';
import { CHUNK_AREA, tileIndex } from '../../src/sim/world/chunk';
import { generateChunk } from '../../src/sim/world/generate';

function blankChunk(terrain: number = TileId.Grass): ChunkData {
  return {
    cx: 0,
    cy: 0,
    terrain: new Uint8Array(CHUNK_AREA).fill(terrain),
    resource: new Uint8Array(CHUNK_AREA),
    amount: new Uint32Array(CHUNK_AREA),
  };
}

/** RGB of texel `(x, y)` as 0xRRGGBB, asserting it is opaque. */
function texel(px: Uint8Array, x: number, y: number): number {
  const o = (y * CHUNK_TEXTURE_SIZE + x) * 4;
  expect(px[o + 3]).toBe(0xff);
  return (px[o]! << 16) | (px[o + 1]! << 8) | px[o + 2]!;
}

/** Distinct colors inside the texels of local tile `(lx, ly)`. */
function tileColors(px: Uint8Array, lx: number, ly: number): Set<number> {
  const colors = new Set<number>();
  for (let y = 0; y < TEXELS_PER_TILE; y++) {
    for (let x = 0; x < TEXELS_PER_TILE; x++) {
      colors.add(texel(px, lx * TEXELS_PER_TILE + x, ly * TEXELS_PER_TILE + y));
    }
  }
  return colors;
}

const brightness = (c: number): number => ((c >> 16) & 0xff) + ((c >> 8) & 0xff) + (c & 0xff);

describe('bakeChunkPixels', () => {
  it('fills each plain tile with its flat terrain color', () => {
    const chunk = blankChunk();
    chunk.terrain[tileIndex(3, 4)] = TileId.Water;
    chunk.terrain[tileIndex(31, 31)] = TileId.Rock;
    const px = bakeChunkPixels(chunk);
    expect(px.length).toBe(CHUNK_TEXTURE_SIZE * CHUNK_TEXTURE_SIZE * 4);
    expect(tileColors(px, 0, 0)).toEqual(new Set([TILES[TileId.Grass]!.color]));
    expect(tileColors(px, 3, 4)).toEqual(new Set([TILES[TileId.Water]!.color]));
    expect(tileColors(px, 31, 31)).toEqual(new Set([TILES[TileId.Rock]!.color]));
  });

  it('draws resources as a tint plus darker dots, more dots on richer tiles', () => {
    const chunk = blankChunk();
    const poor = tileIndex(1, 1);
    const rich = tileIndex(2, 1);
    chunk.resource[poor] = ResourceId.IronOre;
    chunk.amount[poor] = 100;
    chunk.resource[rich] = ResourceId.IronOre;
    chunk.amount[rich] = 5000;
    const px = bakeChunkPixels(chunk);

    const colors = tileColors(px, 1, 1);
    expect(colors.size).toBe(2);
    const [a, b] = [...colors] as [number, number];
    const [dot, tint] = brightness(a) < brightness(b) ? [a, b] : [b, a];
    expect(colors.has(TILES[TileId.Grass]!.color)).toBe(false);
    expect(brightness(dot)).toBeLessThan(brightness(RESOURCES[ResourceId.IronOre].color));
    expect(brightness(dot)).toBeLessThan(brightness(tint));

    const countDots = (lx: number): number => {
      let n = 0;
      for (let y = 0; y < TEXELS_PER_TILE; y++) {
        for (let x = 0; x < TEXELS_PER_TILE; x++) {
          if (texel(px, lx * TEXELS_PER_TILE + x, TEXELS_PER_TILE + y) === dot) n++;
        }
      }
      return n;
    };
    expect(countDots(1)).toBe(4 * dotCount(100));
    expect(countDots(2)).toBe(4 * dotCount(5000));
    expect(dotCount(5000)).toBeGreaterThan(dotCount(100));
  });

  it('flags unknown ids in magenta', () => {
    const px = bakeChunkPixels(blankChunk(200));
    expect(texel(px, 0, 0)).toBe(MISSING_COLOR);
  });

  it('is deterministic and reuses the output buffer', () => {
    const chunk = generateChunk(1, 0, 0);
    const a = bakeChunkPixels(chunk);
    const out = new Uint8Array(a.length);
    const b = bakeChunkPixels(chunk, out);
    expect(b).toBe(out);
    expect(b).toEqual(a);
    expect(() => bakeChunkPixels(chunk, new Uint8Array(4))).toThrow(RangeError);
  });
});

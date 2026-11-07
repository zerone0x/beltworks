import { describe, expect, it } from 'vitest';
import { CULL_GRID, CULL_MARGIN, cullRect, overlaps, sameRect } from '../../src/render/cull';
import { EntityIndex } from '../../src/render/entityIndex';
import { EntityTypeId } from '../../src/data/entities';
import { ENTITY_STRIDE } from '../../src/sim/snapshot';

describe('cull rectangle', () => {
  it('covers the screen plus the margin, snapped outwards to the grid', () => {
    const r = cullRect({ x: 10, y: -3, w: 40, h: 23 });
    expect(r.x0).toBeLessThanOrEqual(10 - CULL_MARGIN);
    expect(r.y0).toBeLessThanOrEqual(-3 - CULL_MARGIN);
    expect(r.x1).toBeGreaterThanOrEqual(50 + CULL_MARGIN);
    expect(r.y1).toBeGreaterThanOrEqual(20 + CULL_MARGIN);
    for (const v of [r.x0, r.y0, r.x1, r.y1]) expect(Math.abs(v % CULL_GRID)).toBe(0);
    expect(r).toEqual({ x0: 0, y0: -8, x1: 56, y1: 24 });
  });

  it('stays the same while the view moves within a grid cell', () => {
    const a = cullRect({ x: 10, y: 0, w: 40, h: 23 });
    expect(sameRect(a, cullRect({ x: 11, y: 0, w: 40, h: 23 }))).toBe(true);
    expect(sameRect(a, cullRect({ x: 13, y: 0, w: 40, h: 23 }))).toBe(false);
  });

  it('tests footprints against the rectangle', () => {
    const r = { x0: 0, y0: 0, x1: 8, y1: 8 };
    expect(overlaps(r, 7, 7)).toBe(true);
    expect(overlaps(r, 8, 0)).toBe(false);
    expect(overlaps(r, -3, -3, 3, 3)).toBe(false);
    expect(overlaps(r, -3, -3, 4, 4)).toBe(true);
  });
});

describe('entity index versions', () => {
  const records = (status: number, x = 0) => {
    const out = new Int32Array(2 * ENTITY_STRIDE);
    out.set([1, EntityTypeId.StoneFurnace, x, 0, 0, status, 0], 0);
    out.set([2, EntityTypeId.WoodenChest, 5, 5, 0, 0, 0], ENTITY_STRIDE);
    return out.buffer;
  };

  it('only bumps the structure version when entities come, go, move or turn', () => {
    const index = new EntityIndex();
    index.apply(records(0));
    const furnace = index.entities[0]!;
    const structure = index.structureVersion;
    const version = index.version;
    // A new state: same views, updated in place.
    expect(index.apply(records(1))).toBe(true);
    expect(index.version).toBe(version + 1);
    expect(index.structureVersion).toBe(structure);
    expect(index.entities[0]).toBe(furnace);
    expect(furnace.status).toBe(1);
    expect(index.at(0, 0)).toBe(furnace);
    // Nothing new: nothing bumped.
    expect(index.apply(records(1))).toBe(false);
    // A move: new views.
    expect(index.apply(records(1, 3))).toBe(true);
    expect(index.structureVersion).toBe(structure + 1);
    expect(index.entities[0]).not.toBe(furnace);
    expect(index.byId(1)?.x).toBe(3);
  });
});

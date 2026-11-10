import { Sprite, Texture } from 'pixi.js';
import { describe, expect, it, vi } from 'vitest';
import { TILE_PX } from '../../src/render/camera';
import type { EntityIndex, EntityView } from '../../src/render/entityIndex';
import { EntitySpriteLayer } from '../../src/render/entitySprites';
import type { ModelSprites, SpriteAtlas } from '../../src/render/sprites';

// The alpha filter compiles a shader, which needs a DOM; the depth order doesn't.
vi.mock('pixi.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('pixi.js')>()),
  AlphaFilter: class {},
}));

const frame = { texture: Texture.EMPTY, ax: 0, ay: 0 };
const model: ModelSprites = {
  footprint: [1, 1],
  directions: 1,
  scale: 1,
  shadow: [frame],
  layers: [{ name: 'body', fps: 0, show: 'always', advance: 'never', frames: [[frame]] }],
  points: {},
};
const atlas = { model: () => model } as unknown as SpriteAtlas;

/** A building of `h` tiles at tile `(x, y)`; `id` doubles as its label. */
const building = (id: number, x: number, y: number, h = 1): EntityView =>
  ({ id, type: 0, proto: { name: 'chest' }, x, y, w: 1, h, dir: 0, status: 0, recipe: 0 }) as never;

/** The layer drawing `buildings`, and the labels of its children in order ('P1', 'P2' for actors). */
function setup(buildings: EntityView[]) {
  const layer = new EntitySpriteLayer();
  layer.setAtlas(atlas);
  layer.draw({ entities: buildings, structureVersion: 1 } as unknown as EntityIndex, 16);
  const order = (actors: Record<string, Sprite>) => {
    const labels = new Map<Sprite, string>(Object.entries(actors).map(([k, s]) => [s, k]));
    return layer.container.children.map((c) => labels.get(c as Sprite) ?? 'b');
  };
  return { layer, order };
}

describe('players among the buildings', () => {
  it('stands behind a building whose bottom edge is south of its feet, in front of one north of them', () => {
    // Building rows 0 and 2 (bottom edges at 1 and 3 tiles); a player's feet at 1.5 tiles.
    const { layer, order } = setup([building(1, 0, 0), building(2, 0, 2)]);
    const p = new Sprite();
    layer.placeActors([{ sprite: p, y: 1.5 * TILE_PX }]);
    expect(order({ P: p })).toEqual(['b', 'P', 'b']);
    layer.placeActors([{ sprite: p, y: 0.5 * TILE_PX }]);
    expect(order({ P: p })).toEqual(['P', 'b', 'b']);
    layer.placeActors([{ sprite: p, y: 5 * TILE_PX }]);
    expect(order({ P: p })).toEqual(['b', 'b', 'P']);
  });

  it('stands in front of a building when its feet are on its bottom edge', () => {
    const { layer, order } = setup([building(1, 0, 0)]);
    const p = new Sprite();
    layer.placeActors([{ sprite: p, y: TILE_PX }]);
    expect(order({ P: p })).toEqual(['b', 'P']);
  });

  it('keeps several players in order of their feet and leaves no stale ones', () => {
    const { layer, order } = setup([building(1, 0, 0), building(2, 0, 2)]);
    const a = new Sprite();
    const b = new Sprite();
    const c = new Sprite();
    layer.placeActors([
      { sprite: c, y: 9 * TILE_PX },
      { sprite: a, y: 0.2 * TILE_PX },
      { sprite: b, y: 0.4 * TILE_PX },
    ]);
    expect(order({ A: a, B: b, C: c })).toEqual(['A', 'B', 'b', 'b', 'C']);
    layer.placeActors([{ sprite: b, y: 2 * TILE_PX }]);
    expect(order({ A: a, B: b, C: c })).toEqual(['b', 'B', 'b']);
  });
});

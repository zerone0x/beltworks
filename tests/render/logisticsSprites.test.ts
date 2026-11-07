import { readFileSync } from 'node:fs';
import { Sprite, Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { ENTITIES, EntityTypeId, type EntityPrototype } from '../../src/data/entities';
import {
  BELT_SURFACE,
  UNDERGROUND_TIER,
  beltSprites,
  shapeSuffix,
  surfaceFrame,
} from '../../src/render/beltSprites';
import { TILE_PX } from '../../src/render/camera';
import { ghostFrames } from '../../src/render/entityLayer';
import { BeltDrawOrder } from '../../src/render/beltLayer';
import { armFrame, placeArmShadow, restAngle } from '../../src/render/entitySprites';
import { armAngle, armLength } from '../../src/render/inserterLayer';
import { POLE_TOP, WIRE_SAG, wireEnd, wirePath } from '../../src/render/powerLayer';
import {
  HEIGHT_ON_SCREEN,
  SHADOW_OFFSET,
  SpriteAtlas,
  parseAtlasIndex,
  type AtlasIndex,
  type AtlasModelIndex,
} from '../../src/render/sprites';
import { BeltShape } from '../../src/sim/belts/belts';
import { UndergroundMode } from '../../src/sim/belts/underground';
import { Direction } from '../../src/sim/entities/direction';

const read = (name: string): AtlasIndex =>
  parseAtlasIndex(
    JSON.parse(readFileSync(new URL(`../../public/sprites/${name}.json`, import.meta.url), 'utf8')),
  );

const TIERS = ['transport-belt', 'fast-transport-belt', 'express-transport-belt'];
const UNDERGROUNDS = ['underground-belt', 'fast-underground-belt', 'express-underground-belt'];
const INSERTERS = [
  EntityTypeId.BurnerInserter,
  EntityTypeId.ElectricInserter,
  EntityTypeId.FastInserter,
  EntityTypeId.LongHandedInserter,
];
const SHAPES = ['', ':curve-left', ':curve-right'];

describe('the committed logistics atlas (public/sprites/logistics.json)', () => {
  const index = read('logistics');
  const byName = new Map<string, EntityPrototype>(Object.values(ENTITIES).map((p) => [p.name, p]));

  it('has every belt tier and shape, the undergrounds, the inserters and the pole', () => {
    expect(Object.keys(index.models).sort()).toEqual(
      [
        ...SHAPES.map((s) => BELT_SURFACE + s),
        ...TIERS.flatMap((t) => SHAPES.map((s) => t + s)),
        ...UNDERGROUNDS.flatMap((u) => [`${u}:entrance`, `${u}:exit`]),
        ...INSERTERS.map((t) => ENTITIES[t].name),
        'small-electric-pole',
      ].sort(),
    );
  });

  it('matches the prototypes (the belt surface belongs to every belt)', () => {
    for (const [name, model] of Object.entries(index.models)) {
      const base = name.split(':')[0]!;
      const proto = byName.get(base === BELT_SURFACE ? 'transport-belt' : base);
      expect(proto, name).toBeDefined();
      expect(model.footprint, name).toEqual([proto!.width, proto!.height]);
      expect(model.directions, name).toBe(proto!.rotatable ? 4 : 1);
      expect(model.layers[0]!.show, name).toBe('always');
    }
  });

  it('animates the belt surface over at least 16 frames, with no shadow', () => {
    for (const s of SHAPES) {
      const model = index.models[BELT_SURFACE + s]!;
      for (const frames of model.layers[0]!.frames)
        expect(frames.length).toBeGreaterThanOrEqual(16);
      for (const f of model.shadow) expect(index.frames[f]!.slice(3, 5)).toEqual([2, 2]);
    }
  });

  it('gives each inserter 32 arm angles shared by all directions, reaching as far as its arm', () => {
    for (const type of INSERTERS) {
      const model: AtlasModelIndex = index.models[ENTITIES[type].name]!;
      const arm = model.layers.find((l) => l.name === 'arm')!;
      expect(arm.frames[0]).toHaveLength(32);
      for (const frames of arm.frames) expect(frames).toEqual(arm.frames[0]);
      const [handX, handY] = model.points.hand![0]!;
      expect(handX / index.tilePx).toBeCloseTo(armLength(type), 2);
      // The hand hangs below the pivot.
      expect(handY).toBeGreaterThan(model.points.pivot![0]![1]);
    }
  });

  it('hangs the pole wires from insulators west and east, high above the ground', () => {
    const { points } = index.models['small-electric-pole']!;
    const [west] = points['wire-west']!;
    const [east] = points['wire-east']!;
    expect(west![0]).toBeLessThan(0);
    expect(east![0]).toBe(-west![0]);
    expect(west![1]).toBeLessThan(-index.tilePx);
  });

  it('fits the sheet limits, with frames on even texels', () => {
    expect(index.tilePx).toBe(64);
    for (const [, x, y, w, h] of index.frames) {
      for (const v of [x, y, w, h]) expect(v % 2).toBe(0);
      expect(x + w).toBeLessThanOrEqual(4096);
      expect(y + h).toBeLessThanOrEqual(4096);
    }
  });
});

/** An atlas with one-frame models of the given names (`surface` layers for belt surfaces). */
function fakeAtlas(names: string[]): SpriteAtlas {
  const models: Record<string, AtlasModelIndex> = {};
  for (const name of names) {
    const layer = name.startsWith(BELT_SURFACE) ? 'surface' : 'body';
    models[name] = {
      footprint: [1, 1],
      directions: 4,
      points: {},
      shadow: [0, 0, 0, 0],
      layers: [
        { name: layer, fps: 0, show: 'always', advance: 'never', frames: [[0], [0], [0], [0]] },
      ],
    };
  }
  const index: AtlasIndex = {
    version: 1,
    tilePx: 64,
    sheets: ['x.png'],
    frames: [[0, 0, 0, 2, 2, 1, 1]],
    models,
  };
  return new SpriteAtlas(index, [Texture.WHITE]);
}

describe('belt sprites', () => {
  it('names curves by shape', () => {
    expect(shapeSuffix(BeltShape.Straight)).toBe('');
    expect(shapeSuffix(BeltShape.CurveFromLeft)).toBe(':curve-left');
    expect(shapeSuffix(BeltShape.CurveFromRight)).toBe(':curve-right');
  });

  it('runs the surface one loop per slat (a quarter tile), forwards', () => {
    expect(surfaceFrame(16, 0)).toBe(0);
    expect(surfaceFrame(16, 1 / 64)).toBe(1);
    expect(surfaceFrame(16, 0.125)).toBe(8);
    expect(surfaceFrame(16, 0.25)).toBe(0);
    expect(surfaceFrame(16, 1000.25 + 3 / 64)).toBe(3);
    expect(surfaceFrame(1, 0.1)).toBe(0);
    // A yellow belt moves 8/256 tile a tick: 2 frames a tick; an express one (24) 6.
    expect(surfaceFrame(16, 8 / 256)).toBe(2);
    expect(surfaceFrame(16, 24 / 256)).toBe(6);
  });

  it('picks surface, side frames and hood by tier, shape and underground mode', () => {
    const atlas = fakeAtlas([
      ...SHAPES.map((s) => BELT_SURFACE + s),
      ...TIERS.flatMap((t) => SHAPES.map((s) => t + s)),
      ...UNDERGROUNDS.flatMap((u) => [`${u}:entrance`, `${u}:exit`]),
    ]);
    const curve = beltSprites(atlas, 'fast-transport-belt', BeltShape.CurveFromLeft)!;
    expect(curve.surfaceModel).toBe(atlas.model('belt-surface:curve-left'));
    expect(curve.frame).toBe(atlas.model('fast-transport-belt:curve-left'));
    expect(curve.hood).toBeNull();
    const exit = beltSprites(
      atlas,
      'express-underground-belt',
      BeltShape.Straight,
      UndergroundMode.Exit,
    )!;
    expect(exit.frame).toBe(atlas.model('express-transport-belt'));
    expect(exit.hood).toBe(atlas.model('express-underground-belt:exit'));
    expect(
      beltSprites(atlas, 'underground-belt', BeltShape.Straight, UndergroundMode.Entrance)!.hood,
    ).toBe(atlas.model('underground-belt:entrance'));
    for (const u of UNDERGROUNDS) expect(TIERS).toContain(UNDERGROUND_TIER[u]);
    // Placeholders for anything missing.
    expect(beltSprites(null, 'transport-belt', BeltShape.Straight)).toBeNull();
    expect(beltSprites(atlas, 'wooden-chest', BeltShape.Straight)).toBeNull();
    expect(beltSprites(fakeAtlas(['transport-belt']), 'transport-belt', 0)).toBeNull();
  });

  it('shows a belt ghost with its surface and side frames', () => {
    const atlas = fakeAtlas([BELT_SURFACE, 'transport-belt']);
    const proto = ENTITIES[EntityTypeId.TransportBelt];
    const frames = ghostFrames(atlas, { proto, x: 0, y: 0, dir: Direction.East, valid: true });
    expect(frames.map((f) => f.model)).toEqual([
      atlas.model(BELT_SURFACE),
      atlas.model('transport-belt'),
    ]);
  });
});

describe('inserter arm sprites', () => {
  it('picks the nearest of the pre-rendered angles and turns the rest of the way', () => {
    const step = (2 * Math.PI) / 32;
    expect(armFrame(0, 32)).toEqual({ frame: 0, rest: 0 });
    const a = armFrame(5 * step + 0.3 * step, 32);
    expect(a.frame).toBe(5);
    expect(a.rest).toBeCloseTo(0.3 * step, 12);
    const b = armFrame(5 * step + 0.7 * step, 32);
    expect(b.frame).toBe(6);
    expect(b.rest).toBeCloseTo(-0.3 * step, 12);
    // Past a full turn wraps around.
    expect(armFrame(2 * Math.PI + step, 32).frame).toBe(1);
    expect(armFrame(2 * Math.PI - 0.1 * step, 32).frame).toBe(0);
  });

  it('rests at the pickup tile, where the swing starts', () => {
    for (const dir of [Direction.North, Direction.East, Direction.South, Direction.West]) {
      expect(restAngle(dir)).toBeCloseTo(armAngle(dir, 0), 12);
      expect(armAngle(dir, 1) - armAngle(dir, 0)).toBeCloseTo(Math.PI, 12);
    }
  });
});

describe('inserter arm shadows', () => {
  it('copy the arm, moved from where it shows down to the ground and along the light', () => {
    const atlas = fakeAtlas(['burner-inserter']);
    const model = atlas.model('burner-inserter')!;
    model.points.pivot = [[0, -40]];
    const arm = new Sprite();
    arm.scale.set(model.scale);
    arm.pivot.set(3, 4);
    arm.position.set(100, 200);
    arm.rotation = 0.1;
    const shadow = new Sprite();
    placeArmShadow(model, arm, shadow);
    expect(shadow.texture).toBe(arm.texture);
    expect(shadow.rotation).toBe(0.1);
    expect([shadow.pivot.x, shadow.pivot.y]).toEqual([3, 4]);
    // Lower than the pivot (the beam slopes down), and offset like any shadow of that height.
    const lift = shadow.position.y - 200 - ((shadow.position.x - 100) / 0.8) * 0.36;
    expect(lift).toBeGreaterThan(0);
    expect(lift).toBeLessThan(40 * model.scale);
    expect(shadow.position.x - 100).toBeCloseTo((lift / HEIGHT_ON_SCREEN) * SHADOW_OFFSET.x, 9);
  });
});

describe('belt draw order', () => {
  const belt = (x: number, y: number) => ({ x, y, dir: 0, shape: 0, type: 0, mode: 0, items: [] });

  it('is north to south, so each belt covers the end face of the one north of it', () => {
    const order = new BeltDrawOrder();
    // A north-going line placed from its south end, as the snapshot lists it.
    const line = [belt(0, 3), belt(0, 2), belt(1, 2), belt(0, 1)];
    expect(order.sort(line).map((b) => [b.x, b.y])).toEqual([
      [0, 1],
      [0, 2],
      [1, 2],
      [0, 3],
    ]);
    // The same positions in the next snapshot (new records) keep the order; new positions re-sort.
    const next = [belt(0, 3), belt(0, 2), belt(1, 2), belt(0, 1)];
    expect(order.sort(next)[0]).toBe(next[3]);
    expect(order.sort([belt(0, 3), belt(0, -5)]).map((b) => b.y)).toEqual([-5, 3]);
  });
});

describe('pole wires', () => {
  const POLE = ENTITIES[EntityTypeId.SmallElectricPole];
  const atlas = (() => {
    const index: AtlasIndex = {
      version: 1,
      tilePx: 64,
      sheets: ['x.png'],
      frames: [[0, 0, 0, 2, 2, 1, 1]],
      models: {
        'small-electric-pole': {
          footprint: [1, 1],
          directions: 1,
          points: { 'wire-west': [[-16, -80]], 'wire-east': [[16, -80]] },
          shadow: [0],
          layers: [{ name: 'body', fps: 0, show: 'always', advance: 'working', frames: [[0]] }],
        },
      },
    };
    return new SpriteAtlas(index, [Texture.WHITE]);
  })();

  it("attach to the insulator facing the other pole, or the placeholder's crossbar", () => {
    const scale = TILE_PX / 64;
    expect(wireEnd(atlas, POLE, 2, 0, 0)).toEqual({
      x: 2.5 * TILE_PX - 16 * scale,
      y: 16,
      lift: 80 * scale,
    });
    expect(wireEnd(atlas, POLE, 2, 0, 1000)).toEqual({
      x: 2.5 * TILE_PX + 16 * scale,
      y: 16,
      lift: 80 * scale,
    });
    expect(wireEnd(null, POLE, 2, 0, 0)).toEqual({
      x: 2.5 * TILE_PX,
      y: 16,
      lift: POLE_TOP * TILE_PX,
    });
  });

  it('sag in the middle, and cast their shadow down and to the right', () => {
    const a = { x: 0, y: 0, lift: 40 };
    const b = { x: 7 * TILE_PX, y: 0, lift: 40 };
    const path = wirePath(a, b);
    expect(path.slice(0, 2)).toEqual([0, -40]);
    expect(path.slice(-2)).toEqual([7 * TILE_PX, -40]);
    // The middle point's y (points are [x, y] pairs).
    const mid = path.length / 2;
    expect(path[mid]).toBeCloseTo(-40 + WIRE_SAG * 7 * TILE_PX * HEIGHT_ON_SCREEN, 9);
    const shadow = wirePath(a, b, true);
    const height = 40 / HEIGHT_ON_SCREEN;
    expect(shadow[0]).toBeCloseTo(height * SHADOW_OFFSET.x, 9);
    expect(shadow[1]).toBeCloseTo(height * SHADOW_OFFSET.y, 9);
  });
});

describe('merged atlases', () => {
  it('holds the models of every atlas that loaded', () => {
    const merged = SpriteAtlas.merge([fakeAtlas(['a', 'b']), null, fakeAtlas(['c'])])!;
    expect(merged.modelNames.sort()).toEqual(['a', 'b', 'c']);
    expect(SpriteAtlas.merge([null, null])).toBeNull();
  });
});

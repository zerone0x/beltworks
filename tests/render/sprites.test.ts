import { readFileSync } from 'node:fs';
import { Texture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { ENTITIES, type EntityPrototype } from '../../src/data/entities';
import { ITEMS, ITEM_IDS } from '../../src/data/items';
import { TILE_PX } from '../../src/render/camera';
import { ICON_PX, RENDERED_ICON_SCALE } from '../../src/render/itemIcons';
import {
  ATLAS_VERSION,
  SpriteAtlas,
  animationSpeed,
  frameAt,
  isWorking,
  layerShown,
  modelDirection,
  parseAtlasIndex,
  type AtlasIndex,
} from '../../src/render/sprites';
import { MachineState } from '../../src/sim/entities/machine';

const committed = (): AtlasIndex =>
  parseAtlasIndex(
    JSON.parse(
      readFileSync(new URL('../../public/sprites/entities.json', import.meta.url), 'utf8'),
    ),
  );

function tinyIndex(): AtlasIndex {
  return {
    version: ATLAS_VERSION,
    tilePx: 64,
    sheets: ['entities-0.png'],
    frames: [
      [0, 0, 0, 10, 10, 5, 8],
      [0, 10, 0, 10, 10, 4, 4],
      [0, 20, 0, 10, 10, 2, 2],
    ],
    models: {
      thing: {
        footprint: [1, 1],
        directions: 1,
        points: { icon: [[0, -20]] },
        shadow: [0],
        layers: [
          { name: 'body', fps: 0, show: 'always', advance: 'working', frames: [[1]] },
          { name: 'spin', fps: 10, show: 'working', advance: 'working', frames: [[1, 2]] },
        ],
      },
    },
  };
}

describe('sprite atlas index', () => {
  it('accepts a well-formed index and rejects other versions and missing frames', () => {
    expect(parseAtlasIndex(tinyIndex()).models.thing!.layers).toHaveLength(2);
    expect(() => parseAtlasIndex({ ...tinyIndex(), version: 99 })).toThrow();
    expect(() => parseAtlasIndex(null)).toThrow();
    const broken = tinyIndex();
    broken.models.thing!.layers[1]!.frames = [[1, 7]];
    expect(() => parseAtlasIndex(broken)).toThrow(/missing frames/);
    const wrongDirections = tinyIndex();
    wrongDirections.models.thing!.directions = 4;
    expect(() => parseAtlasIndex(wrongDirections)).toThrow();
  });

  it('maps frames to textures on their sheet, scaled to world pixels', () => {
    const atlas = new SpriteAtlas(tinyIndex(), [Texture.WHITE]);
    const model = atlas.model('thing')!;
    expect(atlas.model('other')).toBeNull();
    expect(atlas.model(undefined)).toBeNull();
    expect(atlas.modelNames).toEqual(['thing']);
    expect(model.scale).toBe(TILE_PX / 64);
    expect(model.shadow[0]).toMatchObject({ ax: 5, ay: 8 });
    expect(model.layers[1]!.frames[0]![1]!.texture.frame).toMatchObject({ x: 20, y: 0, width: 10 });
    expect(model.points.icon![0]).toEqual([0, -20]);
  });
});

describe('sprite state', () => {
  it('counts working and low power as working, at full and half animation speed', () => {
    expect(isWorking(MachineState.Working)).toBe(true);
    expect(isWorking(MachineState.LowPower)).toBe(true);
    for (const s of [MachineState.Idle, MachineState.NoFuel, MachineState.NoPower]) {
      expect(isWorking(s)).toBe(false);
      expect(animationSpeed(s)).toBe(0);
    }
    expect(animationSpeed(MachineState.Working)).toBe(1);
    expect(animationSpeed(MachineState.LowPower)).toBe(0.5);
  });

  it('shows layers by state', () => {
    expect(layerShown({ show: 'always' }, false)).toBe(true);
    expect(layerShown({ show: 'working' }, false)).toBe(false);
    expect(layerShown({ show: 'working' }, true)).toBe(true);
    expect(layerShown({ show: 'idle' }, true)).toBe(false);
  });

  it('loops animation frames at their frame rate', () => {
    expect(frameAt(1, 10, 5)).toBe(0);
    expect(frameAt(8, 0, 5)).toBe(0);
    expect(frameAt(8, 16, 0)).toBe(0);
    expect(frameAt(8, 16, 0.25)).toBe(4);
    expect(frameAt(8, 16, 0.5)).toBe(0);
    expect(frameAt(8, 16, 0.5625)).toBe(1);
  });

  it('picks the model direction for an entity direction', () => {
    expect(modelDirection({ directions: 4 }, 3)).toBe(3);
    expect(modelDirection({ directions: 1 }, 3)).toBe(0);
  });
});

describe('the committed atlas (public/sprites, `npm run art`)', () => {
  const index = committed();
  const byName = new Map<string, EntityPrototype>(Object.values(ENTITIES).map((p) => [p.name, p]));

  it('has a model for each entity drawn with sprites, matching their prototypes', () => {
    expect(Object.keys(index.models).sort()).toEqual([
      'assembling-machine-1',
      'assembling-machine-2',
      'burner-mining-drill',
      'iron-chest',
      'lab',
      'stone-furnace',
      'wooden-chest',
    ]);
    for (const [name, model] of Object.entries(index.models)) {
      const proto = byName.get(name);
      expect(proto, name).toBeDefined();
      expect(model.footprint, name).toEqual([proto!.width, proto!.height]);
      expect(model.directions, name).toBe(proto!.rotatable ? 4 : 1);
      expect(model.layers[0]!.show, name).toBe('always');
    }
  });

  it('animates what the issue asks for', () => {
    const layer = (model: string, name: string) =>
      index.models[model]!.layers.find((l) => l.name === name)!;
    expect(layer('stone-furnace', 'fire').show).toBe('working');
    expect(layer('lab', 'glow').show).toBe('working');
    expect(layer('lab', 'ring').frames[0]!.length).toBeGreaterThan(1);
    expect(layer('burner-mining-drill', 'head').frames.every((fs) => fs.length > 1)).toBe(true);
    for (const m of ['assembling-machine-1', 'assembling-machine-2']) {
      expect(layer(m, 'rotor').frames[0]!.length).toBeGreaterThan(1);
      expect(index.models[m]!.points.icon).toHaveLength(1);
    }
  });

  it('fits the sheet limits, with frames inside their sheets on even texels', () => {
    expect(index.tilePx).toBe(64);
    expect(index.sheets.length).toBeGreaterThan(0);
    for (const [, x, y, w, h] of index.frames) {
      for (const v of [x, y, w, h]) expect(v % 2).toBe(0);
      expect(x + w).toBeLessThanOrEqual(4096);
      expect(y + h).toBeLessThanOrEqual(4096);
    }
  });
});

describe('the committed power atlas (public/sprites/power.json)', () => {
  const index = parseAtlasIndex(
    JSON.parse(readFileSync(new URL('../../public/sprites/power.json', import.meta.url), 'utf8')),
  );
  const byName = new Map<string, EntityPrototype>(Object.values(ENTITIES).map((p) => [p.name, p]));
  const layer = (model: string, name: string) =>
    index.models[model]!.layers.find((l) => l.name === name)!;

  it('has the power entities, matching their prototypes', () => {
    expect(Object.keys(index.models).sort()).toEqual([
      'boiler',
      'electric-mining-drill',
      'steam-engine',
    ]);
    for (const [name, model] of Object.entries(index.models)) {
      const proto = byName.get(name)!;
      expect(model.footprint, name).toEqual([proto.width, proto.height]);
      expect(model.directions, name).toBe(4);
    }
  });

  it('animates the fire, the engine and the drill', () => {
    expect(layer('boiler', 'fire')).toMatchObject({ show: 'working', advance: 'always' });
    // A full turn of the crank: the game runs it at the engine's output (generatorLayer.ts).
    expect(layer('steam-engine', 'motion').frames.every((fs) => fs.length === 16)).toBe(true);
    expect(layer('electric-mining-drill', 'head').frames.every((fs) => fs.length > 1)).toBe(true);
    expect(layer('electric-mining-drill', 'lights').show).toBe('working');
  });

  it('fits the sheet limits', () => {
    for (const [, x, y, w, h] of index.frames) {
      expect(x + w).toBeLessThanOrEqual(4096);
      expect(y + h).toBeLessThanOrEqual(4096);
    }
  });
});

describe('the committed icons atlas (public/sprites/icons.json)', () => {
  const index = parseAtlasIndex(
    JSON.parse(readFileSync(new URL('../../public/sprites/icons.json', import.meta.url), 'utf8')),
  );

  it('has an icon for every item, four texels per icon pixel', () => {
    expect(index.icons!.size).toBe(ICON_PX * RENDERED_ICON_SCALE);
    const names = ITEM_IDS.map((id) => ITEMS[id].name).sort();
    expect(Object.keys(index.icons!.items).sort()).toEqual(names);
  });
});

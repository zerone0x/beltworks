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

/**
 * Each icon's color signature in the committed sheet: its mean color (red,
 * green, blue, weighted by alpha) and how much of each quarter of its cell it
 * covers (top left, top right, bottom left, bottom right; 0–255). Re-rendering
 * an icon on purpose changes its signature: the test prints the new one.
 */
const ICON_SIGNATURES: Record<string, number[]> = {
  'assembling-machine-1': [106, 107, 87, 171, 173, 192, 192],
  'assembling-machine-2': [76, 106, 100, 178, 178, 196, 196],
  'automation-science-pack': [174, 80, 75, 103, 103, 146, 145],
  boiler: [87, 87, 86, 112, 113, 144, 144],
  'burner-inserter': [110, 78, 69, 87, 80, 172, 24],
  'burner-mining-drill': [112, 86, 74, 169, 194, 209, 209],
  coal: [66, 67, 68, 75, 39, 93, 95],
  'copper-cable': [150, 92, 50, 136, 95, 136, 123],
  'copper-ore': [165, 105, 67, 78, 76, 107, 100],
  'copper-plate': [190, 124, 75, 113, 124, 153, 142],
  'electric-inserter': [69, 97, 132, 87, 80, 172, 24],
  'electric-mining-drill': [79, 93, 109, 166, 166, 182, 182],
  'electronic-circuit': [84, 123, 77, 161, 161, 161, 161],
  'express-splitter': [61, 104, 146, 180, 180, 172, 172],
  'express-transport-belt': [76, 115, 152, 204, 204, 198, 198],
  'express-underground-belt': [67, 104, 139, 143, 143, 137, 137],
  'fast-inserter': [127, 78, 77, 87, 82, 172, 24],
  'fast-splitter': [146, 69, 64, 180, 180, 172, 172],
  'fast-transport-belt': [137, 81, 77, 204, 204, 198, 198],
  'fast-underground-belt': [146, 75, 70, 143, 143, 137, 137],
  'iron-chest': [96, 105, 114, 176, 176, 167, 167],
  'iron-gear-wheel': [125, 136, 145, 145, 145, 145, 145],
  'iron-ore': [101, 117, 131, 92, 106, 139, 124],
  'iron-plate': [163, 173, 182, 113, 124, 153, 142],
  lab: [134, 141, 147, 169, 169, 178, 178],
  'logistic-science-pack': [82, 153, 83, 103, 103, 146, 145],
  'long-handed-inserter': [77, 113, 80, 58, 48, 97, 8],
  'small-electric-pole': [100, 81, 57, 61, 61, 32, 32],
  splitter: [159, 136, 65, 180, 180, 172, 172],
  'steam-engine': [78, 82, 83, 93, 77, 131, 131],
  stone: [157, 146, 122, 155, 92, 152, 144],
  'stone-brick': [147, 125, 90, 176, 183, 195, 169],
  'stone-furnace': [102, 97, 89, 200, 200, 199, 199],
  'transport-belt': [131, 118, 78, 204, 204, 198, 198],
  'underground-belt': [164, 141, 71, 143, 143, 137, 137],
  wood: [106, 81, 58, 111, 111, 135, 135],
  'wooden-chest': [119, 91, 66, 203, 203, 200, 200],
};
/** How far (Euclidean) an icon's signature may be from the table above. */
const SIGNATURE_TOLERANCE = 6;

const signatureDistance = (a: readonly number[], b: readonly number[]) =>
  Math.hypot(...a.map((v, i) => v - b[i]!));

describe('the committed icons atlas (public/sprites/icons.json)', () => {
  const index = parseAtlasIndex(
    JSON.parse(readFileSync(new URL('../../public/sprites/icons.json', import.meta.url), 'utf8')),
  );
  const size = index.icons!.size;
  const loadSheet = async () => {
    // The art tools' PNG reader, imported by URL so TypeScript doesn't look for its types.
    const { decodePng } = (await import(
      new URL('../../tools/art/png.js', import.meta.url).href
    )) as { decodePng: (file: Uint8Array) => { width: number; data: Uint8Array } };
    return decodePng(readFileSync(new URL('../../public/sprites/icons-0.png', import.meta.url)));
  };

  it('has an icon for every item, four texels per icon pixel', () => {
    expect(size).toBe(ICON_PX * RENDERED_ICON_SCALE);
    const names = ITEM_IDS.map((id) => ITEMS[id].name).sort();
    expect(Object.keys(index.icons!.items).sort()).toEqual(names);
  });

  it('has a rendered icon in every cell it names, each its own (the sheet matches the index)', async () => {
    const sheet = await loadSheet();
    const cells = new Set<string>();
    for (const [name, [s, x, y]] of Object.entries(index.icons!.items)) {
      expect(s).toBe(0);
      cells.add(`${String(x)},${String(y)}`);
      let opaque = 0;
      for (let dy = 0; dy < size; dy++) {
        for (let dx = 0; dx < size; dx++) {
          if (sheet.data[((y + dy) * sheet.width + x + dx) * 4 + 3]! > 0) opaque++;
        }
      }
      expect(opaque, name).toBeGreaterThan((size * size) / 8);
    }
    expect(cells.size).toBe(Object.keys(index.icons!.items).length);
  });

  it('has each item’s own icon in its cell (a shifted or reordered sheet fails)', async () => {
    // The signatures are far enough apart that the tolerance can't take one icon for another.
    const names = Object.keys(ICON_SIGNATURES);
    expect(names.sort()).toEqual(Object.keys(index.icons!.items).sort());
    for (const a of names) {
      for (const b of names) {
        if (a < b) {
          expect(
            signatureDistance(ICON_SIGNATURES[a]!, ICON_SIGNATURES[b]!),
            `${a} vs ${b}`,
          ).toBeGreaterThan(2 * SIGNATURE_TOLERANCE);
        }
      }
    }
    const sheet = await loadSheet();
    for (const [name, [, x, y]] of Object.entries(index.icons!.items)) {
      let r = 0;
      let g = 0;
      let b = 0;
      let alpha = 0;
      const quarters = [0, 0, 0, 0];
      for (let dy = 0; dy < size; dy++) {
        for (let dx = 0; dx < size; dx++) {
          const i = ((y + dy) * sheet.width + x + dx) * 4;
          const a = sheet.data[i + 3]! / 255;
          r += sheet.data[i]! * a;
          g += sheet.data[i + 1]! * a;
          b += sheet.data[i + 2]! * a;
          alpha += a;
          quarters[(dy < size / 2 ? 0 : 2) + (dx < size / 2 ? 0 : 1)]! += a;
        }
      }
      const signature = [
        r / alpha,
        g / alpha,
        b / alpha,
        ...quarters.map((q) => (q / ((size * size) / 4)) * 255),
      ].map(Math.round);
      const expected = ICON_SIGNATURES[name]!;
      expect(
        signatureDistance(signature, expected),
        `${name}: signature ${JSON.stringify(signature)}, expected ${JSON.stringify(expected)}`,
      ).toBeLessThanOrEqual(SIGNATURE_TOLERANCE);
    }
  });
});

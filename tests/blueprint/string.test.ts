/**
 * Blueprint strings (D59): `BW<version>.<base64url(gzip(JSON))>`, read back
 * exactly, older formats migrated, newer ones and anything damaged refused
 * with a message.
 */

import { describe, expect, it } from 'vitest';
import { normalize, rotateBlueprint, type Blueprint } from '../../src/blueprint/blueprint';
import { BlueprintLibrary, LIBRARY_KEY, parseLibrary } from '../../src/blueprint/library';
import {
  BLUEPRINT_VERSION,
  BlueprintError,
  MAX_BLUEPRINT_JSON_BYTES,
  MAX_STRING_LENGTH,
  TOO_LARGE_MESSAGE,
  blueprintToJson,
  decodeBlueprint,
  encodeBlueprint,
  fromBase64Url,
  recipeName,
  toBase64Url,
} from '../../src/blueprint/string';
import { ENTITIES, EntityTypeId } from '../../src/data/entities';
import { ASSEMBLER_RECIPES, RecipeId } from '../../src/data/recipes';
import { DAMAGED_SAVE_MESSAGE, TooLargeError, gunzip, gzip } from '../../src/save/compress';
import { UndergroundMode } from '../../src/sim/belts/underground';
import { Direction } from '../../src/sim/entities/direction';

const { North, East, South, West } = Direction;
const E = ENTITIES;

/** One of everything a string has to carry: multi-tile, turned, a recipe, both underground modes. */
const SAMPLE: Blueprint = normalize('Gear line “β”', [
  {
    proto: E[EntityTypeId.AssemblingMachine1],
    x: 0,
    y: 0,
    dir: North,
    recipe: RecipeId.IronGearWheel,
    mode: 0,
  },
  { proto: E[EntityTypeId.BurnerInserter], x: 3, y: 1, dir: West, recipe: 0, mode: 0 },
  { proto: E[EntityTypeId.Boiler], x: 4, y: 0, dir: East, recipe: 0, mode: 0 },
  { proto: E[EntityTypeId.Splitter], x: 4, y: 3, dir: South, recipe: 0, mode: 0 },
  {
    proto: E[EntityTypeId.UndergroundBelt],
    x: 0,
    y: 3,
    dir: East,
    recipe: 0,
    mode: UndergroundMode.Entrance,
  },
  {
    proto: E[EntityTypeId.UndergroundBelt],
    x: 2,
    y: 3,
    dir: East,
    recipe: 0,
    mode: UndergroundMode.Exit,
  },
])!;

const plain = (bp: Blueprint) => ({
  label: bp.label,
  width: bp.width,
  height: bp.height,
  entities: bp.entities.map((e) => ({ ...e, proto: e.proto.name })),
});

/** A string of format `version` holding `doc` (any JSON), as some other version would write it. */
async function stringOf(doc: unknown, version = BLUEPRINT_VERSION): Promise<string> {
  const bytes = await gzip(new TextEncoder().encode(JSON.stringify(doc)));
  return `BW${String(version)}.${toBase64Url(bytes)}`;
}

/** The message `decodeBlueprint(text)` refuses `text` with. */
async function refusal(text: string): Promise<string> {
  try {
    await decodeBlueprint(text);
  } catch (err) {
    expect(err).toBeInstanceOf(BlueprintError);
    return (err as Error).message;
  }
  throw new Error(`accepted ${text.slice(0, 40)}`);
}

describe('base64url', () => {
  it('round-trips every length and byte, without padding or + and /', () => {
    for (let n = 0; n < 70; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 97 + n * 31) & 255);
      const text = toBase64Url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(text.length).toBe(Math.ceil((n * 8) / 6));
      expect([...fromBase64Url(text)]).toEqual([...bytes]);
    }
    expect(toBase64Url(Uint8Array.of(0xfb, 0xff))).toBe('-_8');
  });
});

describe('blueprint strings', () => {
  it('read back exactly what was written', async () => {
    const text = await encodeBlueprint(SAMPLE);
    expect(text).toMatch(/^BW1\.[A-Za-z0-9_-]+$/);
    expect(plain(await decodeBlueprint(text))).toEqual(plain(SAMPLE));
    // Turned blueprints too, and around whitespace (a string pasted from chat).
    const turned = rotateBlueprint(SAMPLE);
    expect(plain(await decodeBlueprint(`\n  ${await encodeBlueprint(turned)}  \n`))).toEqual(
      plain(turned),
    );
  });

  it('are compact', async () => {
    const chest = E[EntityTypeId.WoodenChest];
    const big = normalize(
      '',
      Array.from({ length: 400 }, (_, i) => ({
        proto: chest,
        x: i % 20,
        y: Math.floor(i / 20),
        dir: North,
        recipe: 0,
        mode: 0 as const,
      })),
    )!;
    const text = await encodeBlueprint(big);
    expect(text.length).toBeLessThan(JSON.stringify(blueprintToJson(big)).length / 4);
    expect((await decodeBlueprint(text)).entities).toHaveLength(400);
  });

  it('name assembler recipes uniquely', () => {
    const names = ASSEMBLER_RECIPES.map(recipeName);
    expect(new Set(names).size).toBe(names.length);
  });

  it('read defaults: north, no recipe, an entrance', async () => {
    const bp = await decodeBlueprint(
      await stringOf({ entities: [{ name: 'underground-belt', x: 3, y: 2 }] }),
    );
    expect(plain(bp)).toEqual({
      label: '',
      width: 1,
      height: 1,
      entities: [
        {
          proto: 'underground-belt',
          x: 0,
          y: 0,
          dir: North,
          recipe: 0,
          mode: UndergroundMode.Entrance,
        },
      ],
    });
  });

  describe('versions', () => {
    it('refuse a string from a newer version, saying so', async () => {
      const text = await stringOf(blueprintToJson(SAMPLE), BLUEPRINT_VERSION + 1);
      expect(await refusal(text)).toMatch(
        /newer version of Beltworks \(format 2; this one reads up to 1\)/,
      );
    });

    it('refuse format 0 and strings without a version', async () => {
      expect(await refusal(await stringOf(blueprintToJson(SAMPLE), 0))).toMatch(
        /Unknown blueprint string format 0/,
      );
      expect(await refusal('BW.abc')).toMatch(/isn’t a Beltworks blueprint string/);
    });

    it('call a far newer format newer, not foreign', async () => {
      expect(await refusal('BW999999999.abc')).toMatch(
        /newer version of Beltworks \(format 999999999;/,
      );
    });

    it('migrate older formats step by step, and refuse a gap in the migrations', async () => {
      // Pretend this build writes format 3: format 1 renamed `label` to `title`
      // in format 2, and format 3 renamed it back (so the format-1 reader
      // can check the result). A format-1 string runs both migrations, in order.
      const seen: number[] = [];
      const formats = {
        version: 3,
        migrations: {
          1: (doc: unknown) => {
            seen.push(1);
            const { label, ...rest } = doc as { label: string };
            return { ...rest, title: label };
          },
          2: (doc: unknown) => {
            seen.push(2);
            const { title, ...rest } = doc as { title: string };
            return { ...rest, label: title };
          },
        },
      };
      const v1 = await encodeBlueprint(SAMPLE);
      expect(plain(await decodeBlueprint(v1, formats))).toEqual(plain(SAMPLE));
      expect(seen).toEqual([1, 2]);
      // A format-2 string only runs the second.
      seen.length = 0;
      const { label, ...rest } = blueprintToJson(SAMPLE);
      const v2 = await stringOf({ ...rest, title: label }, 2);
      expect(plain(await decodeBlueprint(v2, formats))).toEqual(plain(SAMPLE));
      expect(seen).toEqual([2]);
      await expect(decodeBlueprint(v1, { version: 2, migrations: {} })).rejects.toThrow(
        /Can’t read blueprint string format 1/,
      );
    });
  });

  describe('corrupt strings', () => {
    it('are refused with a message, never half-read', async () => {
      const good = await encodeBlueprint(SAMPLE);
      const payload = good.slice(4);
      const cases: [string, RegExp][] = [
        ['', /isn’t a Beltworks blueprint string/],
        ['hello world', /isn’t a Beltworks blueprint string/],
        [`bw1.${payload}`, /isn’t a Beltworks blueprint string/],
        [`BW1.${payload.slice(0, 1)}`, /damaged/],
        [`BW1.${payload}!`, /characters that don’t belong/],
        [`BW1.${payload.replace(/[+/=]/g, '')}====`, /characters that don’t belong/],
        // Cut short, or a byte changed in the middle: the gzip stream (or its CRC) fails.
        [`BW1.${payload.slice(0, Math.floor(payload.length / 2))}`, /damaged/],
        [
          `BW1.${payload.slice(0, 20)}${payload[20] === 'A' ? 'B' : 'A'}${payload.slice(21)}`,
          /damaged/,
        ],
        // Not gzip at all.
        [`BW1.${toBase64Url(new TextEncoder().encode('{"entities":[]}'))}`, /damaged/],
      ];
      for (const [text, message] of cases) {
        expect(await refusal(text), text.slice(0, 30)).toMatch(message);
      }
    });

    it('are refused when the data inside is no valid blueprint', async () => {
      const ok = { name: 'wooden-chest', x: 0, y: 0 };
      const cases: [unknown, RegExp][] = [
        [null, /holds no blueprint/],
        [[ok], /holds no blueprint/],
        [{ entities: [] }, /no entities/],
        [{ label: 3, entities: [ok] }, /name isn’t text/],
        [{ entities: [{ ...ok, name: 'warp-drive' }] }, /unknown type \(warp-drive\)/],
        [{ entities: [{ ...ok, x: -1 }] }, /bad position/],
        [{ entities: [{ ...ok, x: 1.5 }] }, /bad position/],
        [{ entities: [{ ...ok, y: '2' }] }, /bad position/],
        [{ entities: [{ ...ok, dir: 4 }] }, /bad direction/],
        [{ entities: [{ ...ok, recipe: 'iron-gear-wheel' }] }, /recipe it can’t make/],
        [
          { entities: [{ name: 'assembling-machine-1', x: 0, y: 0, recipe: 'iron-plate' }] },
          /recipe it can’t make \(iron-plate\)/,
        ],
        [{ entities: [{ ...ok, io: 'out' }] }, /bad underground setting/],
        [
          { entities: [{ name: 'underground-belt', x: 0, y: 0, io: 'up' }] },
          /bad underground setting/,
        ],
        [{ entities: [ok, { name: 'stone-furnace', x: 0, y: 0 }] }, /overlaps another entity/],
        [{ entities: [{ name: 'lab', x: 998, y: 0 }] }, /outside the largest blueprint/],
        [{ entities: Array.from({ length: 10_001 }, () => ok) }, /at most 10000/],
      ];
      for (const [doc, message] of cases) {
        expect(await refusal(await stringOf(doc)), JSON.stringify(doc).slice(0, 60)).toMatch(
          message,
        );
      }
      // Valid JSON in another encoding than UTF-8 is damaged data too.
      const latin1 = await gzip(Uint8Array.of(0x7b, 0xff, 0x7d));
      expect(await refusal(`BW1.${toBase64Url(latin1)}`)).toMatch(/isn’t readable/);
    });
  });
});

// Every test here inflates at most about 1 MB: never test the caps with real
// gigabyte bombs (that takes the whole machine's memory), set small caps instead.
describe('size limits', () => {
  /** About 1 MB of JSON (a label of spaces) that gzips to a few KB: a small bomb. */
  const bombDoc = { label: ' '.repeat(1 << 20), entities: [{ name: 'wooden-chest', x: 0, y: 0 }] };

  it('gunzip stops at its cap', async () => {
    const zeros = await gzip(new Uint8Array(1 << 20));
    expect(zeros.length).toBeLessThan(4096);
    await expect(gunzip(zeros, 64 * 1024)).rejects.toBeInstanceOf(TooLargeError);
    expect((await gunzip(zeros, 1 << 20)).length).toBe(1 << 20);
    // No cap (saves): everything, as before.
    expect((await gunzip(zeros)).length).toBe(1 << 20);
    // A cap doesn't hide damage: a stream cut short is damaged, not too large.
    await expect(gunzip(zeros.slice(0, zeros.length - 8), 2 << 20)).rejects.toThrow(
      DAMAGED_SAVE_MESSAGE,
    );
  });

  it('refuse a string that inflates past the cap, saying it is too large', async () => {
    const bomb = await stringOf(bombDoc);
    const small = { version: BLUEPRINT_VERSION, migrations: {}, maxJsonBytes: 64 * 1024 };
    await expect(decodeBlueprint(bomb, small)).rejects.toThrow(TOO_LARGE_MESSAGE);
    await expect(decodeBlueprint(bomb, small)).rejects.toBeInstanceOf(BlueprintError);
    // Under the default cap the same string is read (its label cut to length).
    expect((await decodeBlueprint(bomb)).entities).toHaveLength(1);
  });

  it('refuse a string longer than the limit before reading it', async () => {
    const text = await encodeBlueprint(SAMPLE);
    const short = { version: BLUEPRINT_VERSION, migrations: {}, maxLength: text.length - 1 };
    await expect(decodeBlueprint(text, short)).rejects.toThrow(TOO_LARGE_MESSAGE);
    expect(await refusal(`BW1.${'A'.repeat(MAX_STRING_LENGTH)}`)).toBe(TOO_LARGE_MESSAGE);
  });

  it('leave plenty of room for the largest real blueprint', async () => {
    // The longest records there are: 10 000 assembling machines with the
    // longest recipe name, turned, at three-digit positions.
    const machine = E[EntityTypeId.AssemblingMachine2];
    const recipe = [...ASSEMBLER_RECIPES].sort(
      (a, b) => recipeName(b).length - recipeName(a).length,
    )[0]!;
    const big = normalize(
      'x'.repeat(80),
      Array.from({ length: 10_000 }, (_, i) => ({
        proto: machine,
        x: (i % 100) * 3,
        y: Math.floor(i / 100) * 3,
        dir: North,
        recipe: recipe.id,
        mode: 0 as const,
      })),
    )!;
    const json = blueprintToJson(big);
    for (const e of json.entities) {
      e.x += 699;
      e.y += 699;
      e.dir = 3;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(json)).length;
    expect(bytes).toBeLessThan(1_000_000);
    expect(bytes * 4).toBeLessThan(MAX_BLUEPRINT_JSON_BYTES);
    const text = await stringOf(json);
    expect(text.length * 4).toBeLessThan(MAX_STRING_LENGTH);
    expect((await decodeBlueprint(text)).entities).toHaveLength(10_000);
  });
});

describe('the blueprint library', () => {
  /** A `localStorage` stand-in. */
  const memory = () => {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  };

  it('keeps blueprint strings by name across page loads', async () => {
    const storage = memory();
    const lib = new BlueprintLibrary(storage);
    const text = await encodeBlueprint(SAMPLE);
    const a = lib.add('Gears', text, SAMPLE.entities.length);
    lib.add('Other', text, 1);
    lib.remove(lib.entries[1]!.id);
    const again = new BlueprintLibrary(storage);
    expect(again.entries).toEqual([a]);
    expect(plain(await decodeBlueprint(again.get(a.id)!.text))).toEqual(plain(SAMPLE));
    // New ids never repeat old ones.
    expect(again.add('Third', text, 1).id).not.toBe(a.id);
    expect(JSON.parse(storage.data.get(LIBRARY_KEY)!)).toMatchObject({ version: 1 });
  });

  it('survives broken or missing storage', () => {
    const storage = memory();
    storage.data.set(LIBRARY_KEY, '{not json');
    expect(new BlueprintLibrary(storage).entries).toEqual([]);
    expect(new BlueprintLibrary(null).add('x', 'BW1.x', 1).name).toBe('x');
    expect(
      parseLibrary({
        version: 1,
        entries: [
          { id: 'b1', name: 'ok', entities: 1, text: 'BW1.a' },
          { id: 'b1', name: 'dup', entities: 1, text: 'BW1.a' },
          { id: 'b2', name: 5, entities: 1, text: 'BW1.a' },
          null,
        ],
      }).map((e) => e.name),
    ).toEqual(['ok']);
    expect(parseLibrary({ version: 2, entries: [] })).toEqual([]);
  });
});

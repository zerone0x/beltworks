/**
 * Blueprint strings (D59): a blueprint as text to copy, paste and share,
 * `BW<version>.<payload>`, where the payload is the blueprint as JSON,
 * gzipped (`CompressionStream`, as for saves: src/save/compress.ts) and
 * base64url-encoded without padding, so a string survives URLs, chat and
 * forms. Entities, recipes and modes are written by name, not by id, so a
 * string stays readable when ids are renumbered.
 *
 * Format 1 (the JSON):
 * `{"label": "...", "entities": [{"name": "transport-belt", "x": 0, "y": 0,
 * "dir": 1, "recipe": "iron-gear-wheel", "io": "out"}, ...]}`; `dir`
 * defaults to 0 (north), `recipe` to none, and `io` (underground belts only:
 * `in` an entrance, `out` an exit) to `in`.
 *
 * A string of an older format goes through `MIGRATIONS` (format n to n + 1,
 * on the parsed JSON) before it is read; one from a newer format is refused
 * with a message saying so. Anything else that isn't exactly a valid
 * blueprint throws a `BlueprintError` saying what is wrong.
 */

import { ENTITIES, ENTITY_TYPE_IDS, type EntityPrototype } from '../data/entities';
import { itemPrototype } from '../data/items';
import { ASSEMBLER_RECIPES, type Recipe } from '../data/recipes';
import { TooLargeError, gunzip, gzip, isGzip } from '../save/compress';
import { UndergroundMode } from '../sim/belts/underground';
import { Direction } from '../sim/entities/direction';
import { footprintSize } from '../sim/entities/store';
import {
  MAX_BLUEPRINT_ENTITIES,
  MAX_BLUEPRINT_SIZE,
  normalize,
  validRecipe,
  type Blueprint,
  type BlueprintEntity,
} from './blueprint';

/** The format blueprint strings are written in. */
export const BLUEPRINT_VERSION = 1;
/** Longest label kept, in characters. */
export const MAX_LABEL_LENGTH = 80;
/**
 * Most bytes of JSON a string may inflate to. The largest real blueprint
 * (`MAX_BLUEPRINT_ENTITIES` entities with the longest names, positions,
 * directions and recipes) is under 1 MB of JSON, so 4 MiB leaves plenty of
 * headroom, while a "decompression bomb" (a short string that inflates to
 * gigabytes) is stopped once 4 MiB are out, without inflating the rest.
 */
export const MAX_BLUEPRINT_JSON_BYTES = 4 * 1024 * 1024;
/**
 * Longest string read, in characters: 1 000 000 base64url characters are
 * 750 KB of gzip, several times what the largest real blueprint compresses to.
 */
export const MAX_STRING_LENGTH = 1_000_000;
/** What a string longer than `MAX_STRING_LENGTH`, or inflating past `MAX_BLUEPRINT_JSON_BYTES`, is told. */
export const TOO_LARGE_MESSAGE = `The blueprint string is too large (one holds at most ${String(MAX_BLUEPRINT_ENTITIES)} entities)`;

/** A blueprint string that can't be read, with a message for the player. */
export class BlueprintError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'BlueprintError';
  }
}

/**
 * Upgrades from older formats: `MIGRATIONS[n]` turns the parsed JSON of
 * format `n` into format `n + 1`. Empty while there is only format 1.
 */
export const MIGRATIONS: Readonly<Record<number, (doc: unknown) => unknown>> = {};

const ENTITY_BY_NAME = new Map<string, EntityPrototype>(
  ENTITY_TYPE_IDS.map((id) => [ENTITIES[id].name, ENTITIES[id]]),
);

/** Name of an assembler recipe in strings: its first output's item name (as in the recipe picker). */
export function recipeName(recipe: Recipe): string {
  return itemPrototype(recipe.outputs[0]![0])!.name;
}

const RECIPE_BY_NAME = new Map<string, number>(ASSEMBLER_RECIPES.map((r) => [recipeName(r), r.id]));
const RECIPE_NAME = new Map<number, string>(ASSEMBLER_RECIPES.map((r) => [r.id, recipeName(r)]));

// --- base64url ---

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const DECODE = new Map([...ALPHABET].map((c, i) => [c, i]));

/** `bytes` in base64url without padding. */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    const chars = Math.min(4, Math.ceil(((bytes.length - i) * 8) / 6));
    for (let k = 0; k < chars; k++) out += ALPHABET[(n >> (18 - 6 * k)) & 63];
  }
  return out;
}

/** The bytes of base64url text `text` (no padding); throws a `BlueprintError` on anything else. */
export function fromBase64Url(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new BlueprintError('The blueprint string is damaged (cut off)');
  const out = new Uint8Array(Math.floor((text.length * 6) / 8));
  let bits = 0;
  let value = 0;
  let o = 0;
  for (const c of text) {
    const v = DECODE.get(c);
    if (v === undefined) {
      throw new BlueprintError('The blueprint string has characters that don’t belong in it');
    }
    value = ((value << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (value >> bits) & 0xff;
    }
  }
  return out;
}

// --- encoding ---

interface EntityJson {
  name: string;
  x: number;
  y: number;
  dir?: number;
  recipe?: string;
  io?: 'in' | 'out';
}

/** The JSON document of `bp` (format `BLUEPRINT_VERSION`). */
export function blueprintToJson(bp: Blueprint): { label: string; entities: EntityJson[] } {
  return {
    label: bp.label,
    entities: bp.entities.map((e) => {
      const out: EntityJson = { name: e.proto.name, x: e.x, y: e.y };
      if (e.dir !== Direction.North) out.dir = e.dir;
      if (e.recipe !== 0) out.recipe = RECIPE_NAME.get(e.recipe)!;
      if (e.mode === UndergroundMode.Exit) out.io = 'out';
      return out;
    }),
  };
}

/** `bp` as a blueprint string. */
export async function encodeBlueprint(bp: Blueprint): Promise<string> {
  if (typeof CompressionStream !== 'function') {
    throw new BlueprintError('This browser cannot compress blueprint strings');
  }
  const json = new TextEncoder().encode(JSON.stringify(blueprintToJson(bp)));
  return `BW${String(BLUEPRINT_VERSION)}.${toBase64Url(await gzip(json))}`;
}

// --- decoding ---

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** The blueprint of a format-`BLUEPRINT_VERSION` JSON document; throws a `BlueprintError` if it isn't one. */
export function blueprintFromJson(doc: unknown): Blueprint {
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new BlueprintError('The blueprint string holds no blueprint');
  }
  const { label: rawLabel, entities: raw } = doc as { label?: unknown; entities?: unknown };
  if (rawLabel !== undefined && typeof rawLabel !== 'string') {
    throw new BlueprintError('The blueprint’s name isn’t text');
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new BlueprintError('The blueprint has no entities');
  }
  if (raw.length > MAX_BLUEPRINT_ENTITIES) {
    throw new BlueprintError(
      `The blueprint has ${String(raw.length)} entities; at most ${String(MAX_BLUEPRINT_ENTITIES)} are allowed`,
    );
  }
  const used = new Set<number>();
  const entities = raw.map((item: unknown, i): BlueprintEntity => {
    const where = `Entity ${String(i + 1)} of the blueprint`;
    if (typeof item !== 'object' || item === null) throw new BlueprintError(`${where} is broken`);
    const e = item as Record<string, unknown>;
    const proto = typeof e.name === 'string' ? ENTITY_BY_NAME.get(e.name) : undefined;
    if (!proto)
      throw new BlueprintError(
        `${where} is of an unknown type (${typeof e.name === 'string' ? e.name : 'no name'})`,
      );
    if (!isInt(e.x, 0, MAX_BLUEPRINT_SIZE - 1) || !isInt(e.y, 0, MAX_BLUEPRINT_SIZE - 1)) {
      throw new BlueprintError(`${where} has a bad position`);
    }
    if (e.dir !== undefined && !isInt(e.dir, 0, 3)) {
      throw new BlueprintError(`${where} has a bad direction`);
    }
    const dir = proto.rotatable ? ((e.dir ?? 0) as Direction) : Direction.North;
    let recipe = 0;
    if (e.recipe !== undefined) {
      recipe = (typeof e.recipe === 'string' && RECIPE_BY_NAME.get(e.recipe)) || 0;
      if (recipe === 0 || !validRecipe(proto, recipe)) {
        throw new BlueprintError(
          `${where} has a recipe it can’t make (${typeof e.recipe === 'string' ? e.recipe : 'not a name'})`,
        );
      }
    }
    const underground = proto.undergroundMaxGap !== undefined;
    if (e.io !== undefined && (!underground || (e.io !== 'in' && e.io !== 'out'))) {
      throw new BlueprintError(`${where} has a bad underground setting`);
    }
    const mode = !underground
      ? UndergroundMode.None
      : e.io === 'out'
        ? UndergroundMode.Exit
        : UndergroundMode.Entrance;
    const { w, h } = footprintSize(proto, dir);
    if (e.x + w > MAX_BLUEPRINT_SIZE || e.y + h > MAX_BLUEPRINT_SIZE) {
      throw new BlueprintError(`${where} lies outside the largest blueprint`);
    }
    for (let ty = e.y; ty < e.y + h; ty++) {
      for (let tx = e.x; tx < e.x + w; tx++) {
        const key = ty * MAX_BLUEPRINT_SIZE + tx;
        if (used.has(key)) throw new BlueprintError(`${where} overlaps another entity`);
        used.add(key);
      }
    }
    return { proto, x: e.x, y: e.y, dir, recipe, mode };
  });
  const label = (rawLabel ?? '').slice(0, MAX_LABEL_LENGTH);
  return normalize(label, entities)!;
}

/**
 * The format a reader writes, the migrations it has from older ones and its
 * size limits (tests can pretend to be newer, or set small limits).
 */
export interface BlueprintFormats {
  readonly version: number;
  readonly migrations: Readonly<Record<number, (doc: unknown) => unknown>>;
  /** Longest string read, in characters (default `MAX_STRING_LENGTH`). */
  readonly maxLength?: number;
  /** Most bytes of JSON a string may inflate to (default `MAX_BLUEPRINT_JSON_BYTES`). */
  readonly maxJsonBytes?: number;
}

/**
 * Reads a blueprint string (surrounding whitespace is ignored); throws a
 * `BlueprintError` saying what is wrong with anything that isn't one.
 */
export async function decodeBlueprint(
  text: string,
  formats: BlueprintFormats = { version: BLUEPRINT_VERSION, migrations: MIGRATIONS },
): Promise<Blueprint> {
  const {
    version: current,
    migrations,
    maxLength = MAX_STRING_LENGTH,
    maxJsonBytes = MAX_BLUEPRINT_JSON_BYTES,
  } = formats;
  const trimmed = text.trim();
  if (trimmed.length > maxLength) throw new BlueprintError(TOO_LARGE_MESSAGE);
  // Up to 15 digits (exact as a number), so a far newer format is reported as one.
  const m = /^BW(\d{1,15})\.(.*)$/s.exec(trimmed);
  if (!m)
    throw new BlueprintError('This isn’t a Beltworks blueprint string (it should start with BW1.)');
  const version = Number(m[1]);
  if (version > current) {
    throw new BlueprintError(
      `The blueprint string was made by a newer version of Beltworks (format ${String(version)}; this one reads up to ${String(current)})`,
    );
  }
  if (version < 1) throw new BlueprintError(`Unknown blueprint string format ${String(version)}`);
  const bytes = fromBase64Url(m[2]!);
  if (!isGzip(bytes)) throw new BlueprintError('The blueprint string is damaged');
  let json: Uint8Array;
  try {
    json = await gunzip(bytes, maxJsonBytes);
  } catch (err) {
    if (err instanceof TooLargeError) throw new BlueprintError(TOO_LARGE_MESSAGE, { cause: err });
    throw new BlueprintError(
      'The blueprint string is damaged (its compressed data can’t be read)',
      {
        cause: err,
      },
    );
  }
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(json));
  } catch (err) {
    throw new BlueprintError('The blueprint string is damaged (its data isn’t readable)', {
      cause: err,
    });
  }
  for (let v = version; v < current; v++) {
    const migrate = migrations[v];
    if (!migrate) throw new BlueprintError(`Can’t read blueprint string format ${String(v)}`);
    doc = migrate(doc);
  }
  return blueprintFromJson(doc);
}

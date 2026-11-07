/**
 * The save container (src/sim/save/save.ts has the format): packing and
 * unpacking sections, the format version and migrations, and the `meta`
 * section. It doesn't import the simulation, so the main thread can check a
 * save file (version, what it holds) without bundling the simulation.
 */

import { fnv1a32 } from '../hash';
import { SaveError, SaveReader, SaveWriter } from './codec';
import type { Migration } from './migrations';

/**
 * The save format this build writes and the newest it reads. Bump it (and
 * add a migration) whenever a section's layout changes.
 */
export const SAVE_VERSION = 1;

const MAGIC = Uint8Array.of(0x42, 0x57, 0x53, 0x56); // "BWSV"

/** A decoded container: the format version and the bytes of each section. */
export interface SaveDocument {
  version: number;
  readonly sections: Map<string, Uint8Array>;
}

/** What the `meta` section says about a save (for save slots and imports). */
export interface SaveMeta {
  /** Ticks the game had run. */
  tick: number;
  seed: number;
  players: number;
  /** Entities on the map. */
  entities: number;
}

/** Reads the `meta` section of a save without loading it. */
export function readSaveMeta(bytes: Uint8Array): SaveMeta & { version: number } {
  const doc = decodeSave(bytes);
  const meta = doc.sections.get('meta');
  if (!meta) throw new SaveError('save is missing its meta section');
  const r = new SaveReader(meta, 'meta');
  const value = r.json() as Partial<SaveMeta> | null;
  const num = (v: unknown): number => (typeof v === 'number' ? v : 0);
  return {
    version: doc.version,
    tick: num(value?.tick),
    seed: num(value?.seed),
    players: num(value?.players),
    entities: num(value?.entities),
  };
}

/**
 * Brings `doc` up to format `version` by running the migrations from its
 * version on, one version at a time. Refuses saves from newer versions.
 */
export function migrateSave(
  doc: SaveDocument,
  version: number,
  migrations: readonly Migration[],
): void {
  if (doc.version > version) {
    throw new SaveError(
      `This save was made by a newer version of Beltworks (save format ${String(doc.version)}); ` +
        `this version reads save formats up to ${String(version)}. Update the game to load it.`,
    );
  }
  while (doc.version < version) {
    const migration = migrations.find((m) => m.from === doc.version);
    if (!migration) {
      throw new SaveError(`No migration from save format ${String(doc.version)}`);
    }
    migration.migrate(doc);
    doc.version = migration.from + 1;
  }
}

/** Packs a save document into the container format (see the file comment). */
export function encodeSave(doc: SaveDocument): Uint8Array {
  const w = new SaveWriter();
  w.raw(MAGIC);
  w.u32(doc.version);
  w.u32(doc.sections.size);
  for (const [name, bytes] of doc.sections) {
    w.str(name);
    w.blob(bytes);
  }
  const body = w.bytes();
  w.u32(fnv1a32(body));
  return w.bytes();
}

/** Unpacks the container format. Throws a `SaveError` unless it is an intact save. */
export function decodeSave(bytes: Uint8Array): SaveDocument {
  if (bytes.length < MAGIC.length + 12 || MAGIC.some((b, i) => bytes[i] !== b)) {
    throw new SaveError('Not a Beltworks save file');
  }
  const body = bytes.subarray(0, bytes.length - 4);
  const stored = new DataView(bytes.buffer, bytes.byteOffset + body.length, 4).getUint32(0, true);
  if (fnv1a32(body) !== stored) {
    throw new SaveError('The save file is damaged (checksum mismatch)');
  }
  const r = new SaveReader(body, 'save');
  r.raw(MAGIC.length);
  const version = r.u32();
  const sections = new Map<string, Uint8Array>();
  for (let n = r.u32(); n > 0; n--) {
    const name = r.str();
    if (sections.has(name)) throw new SaveError(`save has two "${name}" sections`);
    sections.set(name, r.blob());
  }
  r.end();
  return { version, sections };
}

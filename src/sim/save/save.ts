/**
 * Saves: the complete simulation state as versioned binary
 * (docs/ARCHITECTURE.md, "Saves and blueprints").
 *
 * A save is a container of named sections, each the bytes one part of the
 * state wrote with its `save` hook (src/sim/save/codec.ts), next to its
 * `hashInto` hook:
 *
 * | Section | Written by |
 * |---|---|
 * | `meta` | JSON for save slots and imports: tick, seed, players, entities (not read back into the state) |
 * | `sim` | tick, seed, PRNG state, number of players |
 * | `commands` | commands queued for ticks that haven't run yet (JSON) |
 * | `players`, `crafting` | `PlayerTable`, `CraftingTable` |
 * | `world` | `World`: the modified chunks (everything else follows from the seed) |
 * | `entities` | `Entities`: the generic store, the occupancy index's origin order, the subscriptions |
 * | `table:<prototype name>` | each per-type entity table (`EntityTypeTable.save`) |
 * | `research` | `ResearchState` |
 *
 * Container: the magic `BWSV`, the format version (`SAVE_VERSION`), the
 * section count, then per section its name and length-prefixed bytes, and
 * an FNV-1a checksum of everything before it. The worker gzips the result
 * (src/save/compress.ts); this module stays synchronous and pure.
 *
 * **The round-trip rule:** every piece of simulation state is saved, or is
 * derived data that `load` rebuilds exactly. `loadSim(saveSim(sim))` must
 * hash the same and then behave identically, tick for tick; the round-trip
 * tests (tests/sim/save.test.ts, tests/bench/save.test.ts) run both for
 * hundreds of ticks and compare hashes every tick, so a PR that adds state
 * without saving it fails CI.
 *
 * **Versions:** a change to what a section holds bumps `SAVE_VERSION` and
 * adds a migration (src/sim/save/migrations.ts) that rewrites older saves'
 * sections into the new layout. Saves from newer versions are refused with
 * a message saying so. Ids from src/data (entity types, items, recipes,
 * technologies) are saved as numbers, so they must never be renumbered
 * without a migration.
 */

import { entityPrototype } from '../../data/entities';
import { validateCommand, type Command } from '../commands';
import { createEntityTables } from '../entities/registry';
import type { EntityTypeTable } from '../entities/table';
import { Rng } from '../rng';
import { createSimState, type SimState } from '../state';
import { Sim } from '../tick';
import { SaveError, SaveReader, SaveWriter } from './codec';
import {
  SAVE_VERSION,
  decodeSave,
  encodeSave,
  migrateSave,
  type SaveDocument,
  type SaveMeta,
} from './container';
import { MIGRATIONS, type Migration } from './migrations';

export {
  SAVE_VERSION,
  decodeSave,
  encodeSave,
  migrateSave,
  readSaveMeta,
  type SaveDocument,
  type SaveMeta,
} from './container';

export interface LoadOptions {
  /**
   * The newest format this build reads (default `SAVE_VERSION`); older
   * saves are migrated up to it. Tests pass a later one to simulate a
   * schema change.
   */
  version?: number;
  /** Migrations to apply (default `MIGRATIONS`). */
  migrations?: readonly Migration[];
  /** The per-type tables of the loaded simulation (default `createEntityTables()`). */
  entityTables?: () => readonly EntityTypeTable[];
}

/** The section a per-type table saves into. */
export function tableSection(table: EntityTypeTable): string {
  return `table:${entityPrototype(table.type)?.name ?? String(table.type)}`;
}

/** What a save of `sim` made now would say about itself (its `meta` section). */
export function saveMetaOf(sim: Sim): SaveMeta {
  const { state } = sim;
  return {
    tick: state.tick,
    seed: state.seed,
    players: state.players.count,
    entities: state.entities.count,
  };
}

/** Writes `sim`'s complete state as a save document (see the file comment). */
export function saveDocument(sim: Sim): SaveDocument {
  const { state } = sim;
  const sections = new Map<string, Uint8Array>();
  const section = (name: string, write: (w: SaveWriter) => void): void => {
    const w = new SaveWriter();
    write(w);
    sections.set(name, w.bytes());
  };
  section('meta', (w) => {
    w.json(saveMetaOf(sim));
  });
  section('sim', (w) => {
    w.u53(state.tick);
    w.u32(state.seed);
    w.column(state.rng.getState());
    w.u32(state.players.count);
  });
  section('commands', (w) => {
    w.json(sim.pendingCommandList());
  });
  section('players', (w) => {
    state.players.save(w);
  });
  section('crafting', (w) => {
    state.crafting.save(w);
  });
  section('world', (w) => {
    state.world.save(w);
  });
  section('entities', (w) => {
    state.entities.save(w);
  });
  for (const table of state.entities.tables) {
    section(tableSection(table), (w) => {
      table.save(w);
    });
  }
  section('research', (w) => {
    state.research.save(w);
  });
  return { version: SAVE_VERSION, sections };
}

/** Serializes `sim` into an (uncompressed) save. */
export function saveSim(sim: Sim): Uint8Array {
  return encodeSave(saveDocument(sim));
}

/**
 * Restores a simulation from a save made by `saveSim` (migrating older
 * formats). Throws a `SaveError` for anything that isn't a readable save.
 */
export function loadSim(bytes: Uint8Array, options: LoadOptions = {}): Sim {
  const doc = decodeSave(bytes);
  migrateSave(doc, options.version ?? SAVE_VERSION, options.migrations ?? MIGRATIONS);
  return simFromDocument(doc, options.entityTables ?? createEntityTables);
}

/** Builds a simulation from a document already at `SAVE_VERSION`'s layout. */
function simFromDocument(doc: SaveDocument, tables: () => readonly EntityTypeTable[]): Sim {
  const used = new Set<string>(['meta']);
  const read = <T>(name: string, fn: (r: SaveReader) => T): T => {
    const bytes = doc.sections.get(name);
    if (!bytes) throw new SaveError(`save is missing its "${name}" section`);
    used.add(name);
    const r = new SaveReader(bytes, name);
    const out = fn(r);
    r.end();
    return out;
  };

  const header = read('sim', (r) => ({
    tick: r.u53(),
    seed: r.u32(),
    rng: r.column(new Uint32Array(0), 4),
    players: r.u32(),
  }));
  if (header.players < 1 || header.players > 0x1_0000) {
    throw new SaveError(`sim: ${String(header.players)} players`);
  }
  let rng: Rng;
  try {
    rng = Rng.fromState(header.rng);
  } catch {
    throw new SaveError('sim: invalid PRNG state');
  }
  const fresh = createSimState({
    seed: header.seed,
    players: header.players,
    startingKit: [],
    entityTables: tables(),
  });
  const state: SimState = { ...fresh, tick: header.tick, rng };

  read('players', (r) => {
    state.players.load(r);
  });
  read('crafting', (r) => {
    state.crafting.load(r);
  });
  read('world', (r) => {
    state.world.load(r);
  });
  read('entities', (r) => {
    state.entities.load(r);
  });
  for (const table of state.entities.tables) {
    read(tableSection(table), (r) => {
      table.load(r, state.entities);
    });
  }
  read('research', (r) => {
    state.research.load(r);
  });
  const commands = read('commands', (r) => r.json());

  for (const name of doc.sections.keys()) {
    if (!used.has(name)) throw new SaveError(`save has an unknown "${name}" section`);
  }

  const sim = new Sim({ seed: header.seed }, state);
  if (!Array.isArray(commands)) throw new SaveError('commands: not a list');
  for (const cmd of commands as unknown[]) {
    const error = validateCommand(cmd);
    if (error !== null) throw new SaveError(`commands: ${error}`);
    try {
      sim.enqueue(cmd as Command);
    } catch (err) {
      throw new SaveError(`commands: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return sim;
}

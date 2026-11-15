/**
 * Save migrations: each one rewrites a save document of format `from` into
 * format `from + 1` (src/sim/save/save.ts runs them in order up to
 * `SAVE_VERSION`).
 *
 * When a change alters what a section holds (a new column in a table, a
 * new field in the world, a renamed table):
 * 1. bump `SAVE_VERSION`;
 * 2. add a migration here from the previous version that rewrites the
 *    affected sections with a `SaveReader` (old layout) and a `SaveWriter`
 *    (new layout), filling new state with the value a fresh entity or game
 *    would have (or deriving it, when it can be);
 * 3. keep the committed fixture saves loading (tests/sim/save.test.ts loads
 *    every file in tests/fixtures/saves/ through the migrations).
 *
 * Migrations work on the document, never on live objects, so they keep
 * working however the tables change later. Example (a column appended to a
 * table, one `u16` per row; the row count is the first id list's length):
 *
 * ```ts
 * {
 *   from: 1,
 *   describe: 'iron chests get a bar limit',
 *   migrate(doc) {
 *     const old = doc.sections.get('table:iron-chest')!;
 *     const r = new SaveReader(old, 'table:iron-chest');
 *     const slots = r.u32();
 *     const rows = r.u32();
 *     const w = new SaveWriter();
 *     w.raw(old);
 *     w.column(new Uint16Array(rows)); // no limit
 *     doc.sections.set('table:iron-chest', w.bytes());
 *   },
 * }
 * ```
 */

import { SaveReader, SaveWriter } from './codec';
import type { SaveDocument } from './container';

export interface Migration {
  /** The format it reads; it leaves the document in format `from + 1`. */
  readonly from: number;
  /** What changed, for the changelog and error messages. */
  readonly describe: string;
  migrate(doc: SaveDocument): void;
}

/**
 * 1 → 2 (D74): the research section gets the levels done of each repeatable
 * technology, a `u32` column laid out like the units (forces × technology
 * slots). Older saves had no repeatable technology: every level is 0.
 */
const RESEARCH_LEVELS: Migration = {
  from: 1,
  describe: 'research keeps the levels done of repeatable technologies',
  migrate(doc) {
    const name = 'research';
    const old = doc.sections.get(name);
    if (!old) return; // loading reports the missing section
    const r = new SaveReader(old, name);
    const forces = r.u32();
    const slots = r.u32();
    const w = new SaveWriter();
    w.raw(old);
    w.column(new Uint32Array(forces * slots));
    doc.sections.set(name, w.bytes());
  },
};

/** Science pack slots per lab before the military science pack (D76). */
const LAB_SLOTS_V2 = 2;
/** Science pack slots per lab since format 3: red, green and military. */
const LAB_SLOTS_V3 = 3;

/**
 * 2 → 3 (D76): labs get a third pack slot, for the military science pack.
 * The `table:lab` section's last column (packs, slots per lab row after
 * row) widens from 2 to 3 per lab; the new slot starts empty. The columns
 * before it (the lab and active id lists, unit technology, progress,
 * state) are copied as they are.
 */
const LAB_MILITARY_SLOT: Migration = {
  from: 2,
  describe: 'labs get a slot for military science packs',
  migrate(doc) {
    const name = 'table:lab';
    const old = doc.sections.get(name);
    if (!old) return; // loading reports the missing section
    const r = new SaveReader(old, name);
    const w = new SaveWriter();
    const ids = r.column(new Uint32Array(0));
    const n = ids.length;
    w.column(ids);
    w.column(r.column(new Uint32Array(0))); // active
    w.column(r.column(new Uint16Array(0), n)); // technology of the unit in progress
    w.column(r.column(new Uint32Array(0), n)); // progress
    w.column(r.column(new Uint8Array(0), n)); // state
    const packs = r.column(new Uint16Array(0), n * LAB_SLOTS_V2);
    r.end();
    const wide = new Uint16Array(n * LAB_SLOTS_V3);
    for (let row = 0; row < n; row++) {
      for (let i = 0; i < LAB_SLOTS_V2; i++) {
        wide[row * LAB_SLOTS_V3 + i] = packs[row * LAB_SLOTS_V2 + i]!;
      }
    }
    w.column(wide);
    doc.sections.set(name, w.bytes());
  },
};

/** Every migration, oldest first. Format 1 is the first release of saves (#86). */
export const MIGRATIONS: readonly Migration[] = [RESEARCH_LEVELS, LAB_MILITARY_SLOT];

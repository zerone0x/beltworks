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

/** Every migration, oldest first. Format 1 is the first release of saves (#86). */
export const MIGRATIONS: readonly Migration[] = [RESEARCH_LEVELS];

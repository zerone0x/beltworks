/**
 * The per-type entity tables of a new simulation. Each entity type that gets
 * behavior registers its table here (see table.ts); types without a table are
 * plain placeholders that only exist in the generic store.
 */

import type { EntityTypeTable } from './table';

/** Creates a fresh set of per-type tables for a new `SimState`. */
export function createEntityTables(): EntityTypeTable[] {
  // M1 placeholders: chest, furnace, drill, belt and inserter tables arrive
  // with their behavior in later issues.
  return [];
}

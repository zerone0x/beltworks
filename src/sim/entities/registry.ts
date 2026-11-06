/**
 * The per-type entity tables of a new simulation. Each entity type that gets
 * behavior registers its table here (see table.ts); types without a table are
 * plain placeholders that only exist in the generic store.
 */

import { BeltTable } from '../belts/belts';
import { PowerGrid } from '../power/grid';
import { ChestTable } from './chest';
import { DrillTable } from './drill';
import { FurnaceTable } from './furnace';
import { InserterTable } from './inserter';
import type { EntityTypeTable } from './table';

/** Creates a fresh set of per-type tables for a new `SimState`. */
export function createEntityTables(): EntityTypeTable[] {
  return [
    new ChestTable(),
    new FurnaceTable(),
    new DrillTable(),
    new BeltTable(),
    new InserterTable(),
    new PowerGrid(),
  ];
}

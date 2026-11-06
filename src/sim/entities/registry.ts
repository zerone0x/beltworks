/**
 * The per-type entity tables of a new simulation. Each entity type that gets
 * behavior registers its table here (see table.ts); types without a table are
 * plain placeholders that only exist in the generic store.
 */

import { BeltTable } from '../belts/belts';
import { BoilerTable } from '../power/boiler';
import { PowerGrid } from '../power/grid';
import { SteamEngineTable } from '../power/steamEngine';
import { ChestTable } from './chest';
import { DrillTable } from './drill';
import { ElectricDrillTable } from './electricDrill';
import { ElectricInserterTable } from './electricInserter';
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
    new BoilerTable(),
    new SteamEngineTable(),
    new ElectricDrillTable(),
    new ElectricInserterTable(),
  ];
}

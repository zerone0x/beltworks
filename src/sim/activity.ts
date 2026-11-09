/**
 * How much of the factory each system works on (#73): per system, how many
 * entities it has, how many are awake (on its active list, after the
 * latest tick) and how many it stepped in the latest tick. Idle entities
 * should cost nothing, so on a factory that runs steadily `stepped` stays
 * far below `entities` for every system but the belts carrying items.
 *
 * Belts count lanes (two per line); the power system counts electric
 * entities, `awake` and `stepped` both being those it asked for their
 * demand or output (every producer, and only the awake consumers, D62).
 * Inserters can be stepped without staying awake: woken because items
 * moved near their tile, they look and go back to sleep within the tick.
 * These are read from counters the systems keep as they run: diagnostics,
 * not state (never hashed or saved; 0 until a loaded game has run a tick).
 * The bench reports them (tools/bench) and the worker sends them to the
 * debug overlay.
 */

import { BeltTable } from './belts/belts';
import { AssemblerTable } from './entities/assembler';
import { MiningDrillTable } from './entities/drill';
import type { Entities } from './entities/entities';
import { FurnaceTable } from './entities/furnace';
import { InserterTableBase } from './entities/inserter';
import { PowerGrid } from './power/grid';
import { LabTable } from './research/lab';

/** The systems counted, in tick order. */
export const ACTIVITY_SYSTEMS = [
  'power',
  'drills',
  'belts',
  'inserters',
  'furnaces',
  'assemblers',
  'labs',
] as const;

export type ActivitySystem = (typeof ACTIVITY_SYSTEMS)[number];

export interface SystemActivity {
  /** Entities of the system (belts: lanes; power: electric entities). */
  entities: number;
  /** On the system's active list after the latest tick (power: asked in it). */
  awake: number;
  /** Stepped (power: asked) during the latest tick. */
  stepped: number;
}

export type Activity = Record<ActivitySystem, SystemActivity>;

/** An all-zero {@link Activity}, to read into. */
export function emptyActivity(): Activity {
  const out = {} as Activity;
  for (const s of ACTIVITY_SYSTEMS) out[s] = { entities: 0, awake: 0, stepped: 0 };
  return out;
}

function add(out: SystemActivity, entities: number, awake: number, stepped: number): void {
  out.entities += entities;
  out.awake += awake;
  out.stepped += stepped;
}

/**
 * Reads the activity of every system of `entities` after the latest tick
 * into `out` (allocation-free, so the bench can read it every tick).
 */
export function readActivity(entities: Entities, out: Activity): Activity {
  for (const s of ACTIVITY_SYSTEMS) {
    const a = out[s];
    a.entities = 0;
    a.awake = 0;
    a.stepped = 0;
  }
  // Each table is registered once per type, and the belt table for every belt type.
  let belts: BeltTable | null = null;
  const tables = entities.tables;
  for (let i = 0; i < tables.length; i++) {
    const t = tables[i]!;
    if (t instanceof PowerGrid) {
      add(out.power, t.memberCount, t.polledMembers, t.polledMembers);
    } else if (t instanceof MiningDrillTable) {
      add(out.drills, t.count, t.activeCount, t.steppedCount);
    } else if (t instanceof BeltTable) {
      belts = t;
    } else if (t instanceof InserterTableBase) {
      add(out.inserters, t.count, t.activeCount, t.steppedCount);
    } else if (t instanceof FurnaceTable) {
      add(out.furnaces, t.count, t.activeCount, t.steppedCount);
    } else if (t instanceof AssemblerTable) {
      add(out.assemblers, t.count, t.activeCount, t.steppedCount);
    } else if (t instanceof LabTable) {
      add(out.labs, t.count, t.activeCount, t.steppedCount);
    }
  }
  if (belts) add(out.belts, 2 * belts.lineCount, belts.activeLanes, belts.steppedLanes);
  return out;
}

/** The activity of every system of `entities` after the latest tick. */
export function systemActivity(entities: Entities): Activity {
  return readActivity(entities, emptyActivity());
}

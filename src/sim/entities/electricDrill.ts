/**
 * Electric mining drills: 3×3, mining the 5×5 tiles centered on them, one
 * unit per `ELECTRIC_DRILL_MINING_TICKS` (120) working ticks at full power,
 * drawing `ELECTRIC_DRILL_ENERGY_PER_TICK` (1 500) J per working tick. The
 * mining, output and sleep logic is the burner drill's (`MiningDrillTable`
 * in drill.ts); only the energy source differs.
 *
 * Power: progress is kept in 1/`SAT_ONE` ticks. Each working tick a drill
 * advances by its network's satisfaction `s` and draws `1 500 × s /
 * SAT_ONE` J (the solver's `poweredEnergy`), so at half power a unit takes
 * 240 ticks, at satisfaction 0 (or not connected) it stops in `NoPower`.
 * `NoPower` drills stay on the active list, since power can come back on any
 * tick without anything waking them.
 *
 * Demand (`powerDemand`, asked by the power step before the drills run):
 * 1 500 J for a drill that may work this tick (on the active list, and any
 * unit it holds has room in front), else 0: sleeping drills, and drills
 * holding a unit nothing takes, ask for nothing. A drill only works on a
 * tick its demand was granted (see src/sim/power/consumer.ts).
 *
 * No fuel slot: the one slot is the held output unit, and nothing can be
 * inserted.
 */

import { ENTITIES, EntityTypeId, SAT_ONE } from '../../data/entities';
import { PowerBudget } from '../power/consumer';
import { MiningDrillTable } from './drill';
import type { Entities } from './entities';
import { MachineState } from './machine';
import type { EntityDetail, Slot } from './table';

/** Slot indices of an electric mining drill, in the order `slots` lists them. */
export const ElectricDrillSlot = {
  /** The mined unit waiting to be dropped (at most one). */
  Output: 0,
} as const;

const ELECTRIC_DRILL = ENTITIES[EntityTypeId.ElectricMiningDrill];
/** Joules an electric drill draws per working tick at full power. */
export const ELECTRIC_DRILL_ENERGY_PER_TICK = ELECTRIC_DRILL.energyPerTick ?? 0;
/** Working ticks per mined unit at full power. */
export const ELECTRIC_DRILL_MINING_TICKS = ELECTRIC_DRILL.miningTicks ?? 1;

export class ElectricDrillTable extends MiningDrillTable {
  protected readonly noEnergyState = MachineState.NoPower;
  protected readonly heldSlot = ElectricDrillSlot.Output;
  private readonly budget = new PowerBudget();
  /** Whether the row being stepped was granted its energy this tick (latched by `beginStep`). */
  private granted = false;

  constructor() {
    super(ELECTRIC_DRILL, SAT_ONE);
  }

  /** `progress` in whole ticks at full power; no fuel. */
  detail(id: number): EntityDetail {
    const row = this.row(id);
    return {
      status: this.state[row]! as MachineState,
      recipe: 0,
      progress: this.progressTicks(row),
      energy: 0,
      burning: 0,
    };
  }

  /** Mining progress in 1/`SAT_ONE` ticks (for tests and tools). */
  rawProgress(id: number): number {
    return this.progress[this.row(id)]!;
  }

  slots(id: number): Slot[] {
    const held = this.held[this.row(id)]!;
    return [{ item: held, count: held !== 0 ? 1 : 0 }];
  }

  /** Nothing goes in: no fuel slot. */
  accepts(): boolean {
    return false;
  }

  insertable(): number {
    return 0;
  }

  insert(): number {
    return 0;
  }

  take(id: number, slot: number, count: number, entities: Entities): number {
    const n = slot === ElectricDrillSlot.Output && count > 0 ? this.takeHeld(this.row(id)) : 0;
    if (n > 0) this.changed(id, entities);
    return n;
  }

  /** Its working energy while it may work this tick, else nothing (see the file comment). */
  powerDemand(id: number, entities: Entities): number {
    const row = this.row(id);
    return this.mayWork(row, id, entities)
      ? this.budget.grant(row, ELECTRIC_DRILL_ENERGY_PER_TICK)
      : 0;
  }

  protected override beginStep(row: number): void {
    this.granted = this.budget.take(row);
  }

  protected energize(_row: number, id: number, entities: Entities): number {
    return this.budget.speed(id, this.granted, entities);
  }

  protected override growRows(rows: number): void {
    this.budget.grow(rows);
  }

  protected override moveRow(from: number, to: number): void {
    this.budget.moveRow(from, to);
  }

  protected override clearRow(row: number): void {
    this.budget.clearRow(row);
  }
}

/** The electric drill table of `entities`, if one is registered. */
export function electricDrillTable(entities: Entities): ElectricDrillTable | undefined {
  const table = entities.table(EntityTypeId.ElectricMiningDrill);
  return table instanceof ElectricDrillTable ? table : undefined;
}

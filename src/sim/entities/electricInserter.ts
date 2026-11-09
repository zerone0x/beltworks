/**
 * Electric inserters: the burner inserter's behavior (`InserterTableBase` in
 * inserter.ts: geometry, sources and targets, the state machine, sleep) with
 * the electric timing and energy numbers and no fuel slot. The fast and
 * long-handed inserters are electric inserters too: one
 * `ElectricInserterTable` per type, built from its prototype, which sets the
 * swing time, the working energy, the drain and the reach (see
 * src/data/entities.ts). The numbers below are the electric inserter's; the
 * fast inserter swings 13 ticks each way (a 26-tick cycle) for 770 J/tick
 * with a 15 J drain, the long-handed one 25 ticks (a 50-tick cycle, reach 2)
 * for 333 J/tick with a 7 J drain.
 *
 * Timing: the arm swings `ELECTRIC_INSERTER_SWING_TICKS` (26) ticks each way
 * at full power, so with a source and a target that are always ready it
 * moves one item every `ELECTRIC_INSERTER_CYCLE_TICKS` (52) ticks. The arm
 * position is kept in 1/`SAT_ONE` ticks and moves by the network's
 * satisfaction `s` per tick, stopping exactly at either end (no overshoot is
 * carried over), so at half power a cycle takes 104 ticks. At satisfaction 0,
 * or not connected, the inserter is `NoPower`: at the pickup end it doesn't
 * pick anything up, mid-swing the arm stops where it is. `NoPower`
 * inserters stay on the active list, since power can come back on any tick
 * without anything waking them. Dropping at the drop end needs no power.
 *
 * Energy (`powerDemand`, asked by the power step before the inserters run):
 * - an inserter on the active list (swinging, or woken to look again) asks
 *   for its type's `energyPerTick` (220 J for the electric inserter), and
 *   draws `220 × s / SAT_ONE` (the solver's `poweredEnergy`);
 * - a sleeping one (waiting for its source or target) asks for its idle
 *   drain, `drainPerTick` (7 J for the electric inserter), every tick it is
 *   connected: the power step asks every connected consumer each tick, so
 *   the drain costs no wake-ups. Not connected, it draws nothing.
 * The arm only moves on a tick its working energy was granted (see
 * src/sim/power/consumer.ts). One woken after the power step (by the belts
 * or the drills) still picks up or drops on that tick, so it doesn't miss an
 * item passing on a belt, but starts moving on the next tick: one tick later
 * than a burner inserter would.
 *
 * Slots: just the hand. Nothing can be inserted (no fuel slot).
 */

import { ENTITIES, EntityTypeId, SAT_ONE, type EntityPrototype } from '../../data/entities';
import { powerGrid } from '../power/grid';
import { PowerBudget } from '../power/consumer';
import type { Entities } from './entities';
import { InserterState, InserterTableBase } from './inserter';
import type { MachineState } from './machine';
import type { SparseSet } from './sparseSet';
import type { EntityDetail, Slot } from './table';

/** Slot indices of an electric inserter, in the order `slots` lists them. */
export const ElectricInserterSlot = {
  /** The item in the hand (at most one). */
  Hand: 0,
} as const;

const ELECTRIC_INSERTER = ENTITIES[EntityTypeId.ElectricInserter];
/** Joules an electric inserter draws per tick its arm moves, at full power. */
export const ELECTRIC_INSERTER_ENERGY_PER_TICK = ELECTRIC_INSERTER.energyPerTick ?? 0;
/** Joules an idle (sleeping) electric inserter draws per tick while connected. */
export const ELECTRIC_INSERTER_DRAIN_PER_TICK = ELECTRIC_INSERTER.drainPerTick ?? 0;
/** Ticks from the pickup end to the drop end (and back) at full power. */
export const ELECTRIC_INSERTER_SWING_TICKS = ELECTRIC_INSERTER.swingTicks ?? 1;
/** Ticks of one pickup → drop → return cycle at full power. */
export const ELECTRIC_INSERTER_CYCLE_TICKS = 2 * ELECTRIC_INSERTER_SWING_TICKS;

const FAST_INSERTER = ENTITIES[EntityTypeId.FastInserter];
/** Ticks from the pickup end to the drop end (and back) of a fast inserter at full power. */
export const FAST_INSERTER_SWING_TICKS = FAST_INSERTER.swingTicks ?? 1;
/** Ticks of one fast inserter cycle at full power. */
export const FAST_INSERTER_CYCLE_TICKS = 2 * FAST_INSERTER_SWING_TICKS;

const LONG_HANDED_INSERTER = ENTITIES[EntityTypeId.LongHandedInserter];
/** Ticks from the pickup end to the drop end (and back) of a long-handed inserter at full power. */
export const LONG_HANDED_INSERTER_SWING_TICKS = LONG_HANDED_INSERTER.swingTicks ?? 1;
/** Ticks of one long-handed inserter cycle at full power. */
export const LONG_HANDED_INSERTER_CYCLE_TICKS = 2 * LONG_HANDED_INSERTER_SWING_TICKS;

/** Entity types whose table is an `ElectricInserterTable`. */
export type ElectricInserterType =
  | typeof EntityTypeId.ElectricInserter
  | typeof EntityTypeId.FastInserter
  | typeof EntityTypeId.LongHandedInserter;

export class ElectricInserterTable extends InserterTableBase {
  protected readonly noEnergyState = InserterState.NoPower;
  /** Joules per tick asked for on the active list, at full power. */
  readonly energyPerTick: number;
  /** Joules per tick asked for while asleep and connected. */
  readonly drainPerTick: number;
  private readonly budget = new PowerBudget();
  /** Whether the row being stepped was granted its energy this tick (latched by `beginStep`). */
  private granted = false;

  constructor(proto: EntityPrototype = ELECTRIC_INSERTER) {
    super(proto, SAT_ONE);
    this.energyPerTick = proto.energyPerTick ?? 0;
    this.drainPerTick = proto.drainPerTick ?? 0;
  }

  /** `progress` is the arm position, in whole ticks (at full power) from the pickup end; no fuel. */
  detail(id: number): EntityDetail {
    const row = this.row(id);
    return {
      status: this.state[row]! as MachineState,
      recipe: 0,
      progress: this.armTicks(row),
      energy: 0,
      burning: 0,
    };
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
    const row = this.row(id);
    const n =
      slot === ElectricInserterSlot.Hand && count > 0 ? this.takeHand(row, id, entities) : 0;
    if (n > 0) this.changed(id, entities);
    return n;
  }

  /** Working energy on the active list, the idle drain while asleep (see the file comment). */
  powerDemand(id: number): number {
    const row = this.row(id);
    return this.isActive(id) ? this.budget.grant(row, this.energyPerTick) : this.drainPerTick;
  }

  /** Asleep, an inserter always asks for its idle drain (if connected). */
  powerAwake(): SparseSet {
    return this.active;
  }

  protected override beginStep(row: number): void {
    this.granted = this.budget.take(row);
  }

  protected canSwing(_row: number, id: number, entities: Entities): boolean {
    return this.budget.speed(id, this.granted, entities) !== 0;
  }

  /** Without power it waits for nothing: it stays on the active list. */
  protected noEnergyWatch(): number {
    return 0;
  }

  protected energize(_row: number, id: number, entities: Entities): number {
    return this.budget.speed(id, this.granted, entities);
  }

  protected swingStep(id: number, entities: Entities): number {
    return powerGrid(entities)?.satisfaction(id) ?? 0;
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

/**
 * The table of electric inserter type `type` (the electric inserter by
 * default, or the fast or long-handed one) of `entities`, if one is
 * registered.
 */
export function electricInserterTable(
  entities: Entities,
  type: ElectricInserterType = EntityTypeId.ElectricInserter,
): ElectricInserterTable | undefined {
  const table = entities.table(type);
  return table instanceof ElectricInserterTable ? table : undefined;
}

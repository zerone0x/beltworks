/**
 * The power budget of an electric consumer type (electric mining drills and
 * inserters): which of its rows asked its network for their working energy
 * in this tick's power step.
 *
 * The power system (grid.ts) runs before every consumer and sums what each
 * one reports through `powerDemand`. A consumer that reports its working
 * energy is granted it here; when its own system runs later in the tick it
 * works at speed `s` (the network's satisfaction) only if it was granted
 * that tick. One woken after the power step (an inserter whose belt source
 * got an item during the belt step, say) did not take part in this tick's
 * demand, so it may still make its choices (pick up, drop) but does not move
 * until the next tick, when its demand is counted. That way a consumer never
 * uses energy its network did not deliver (docs/DECISIONS.md, D26).
 *
 * The flags only live within a tick: `powerDemand` sets them and the
 * consumer's step clears them (`take`), so between ticks every flag is 0 and
 * there is nothing to hash.
 */

import { SAT_ONE } from '../../data/entities';
import type { Entities } from '../entities/entities';
import { growTo } from '../entities/sparseSet';
import { powerGrid } from './grid';

/** Returned by {@link PowerBudget.speed} for a powered row that was not granted this tick. */
export const NOT_GRANTED = -1;

export class PowerBudget {
  private granted = new Uint8Array(0);

  /** Makes room for at least `rows` rows. New rows are not granted. */
  grow(rows: number): void {
    this.granted = growTo(this.granted, rows);
  }

  /** Copies row `from` into row `to` (swap-remove). */
  moveRow(from: number, to: number): void {
    this.granted[to] = this.granted[from]!;
  }

  /** Clears row `row`. */
  clearRow(row: number): void {
    this.granted[row] = 0;
  }

  /** Grants row `row` its working energy for this tick; returns `joules` (its demand). */
  grant(row: number, joules: number): number {
    this.granted[row] = 1;
    return joules;
  }

  /** Whether row `row` was granted this tick; clears the grant. Call once at the start of each step. */
  take(row: number): boolean {
    const granted = this.granted[row] === 1;
    this.granted[row] = 0;
    return granted;
  }

  /**
   * How fast entity `id` (row granted `granted` this tick) works this tick,
   * in units of 1/`SAT_ONE`: its network's satisfaction; 0 without power
   * (not connected, or satisfaction 0); {@link NOT_GRANTED} when there is
   * power but its demand was not part of this tick's power step.
   */
  speed(id: number, granted: boolean, entities: Entities): number {
    const s = powerGrid(entities)?.satisfaction(id) ?? 0;
    if (s === 0) return 0;
    return granted ? Math.min(s, SAT_ONE) : NOT_GRANTED;
  }
}

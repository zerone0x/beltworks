/**
 * The arithmetic of the power solver, as pure integer functions (the grid in
 * grid.ts applies them to every network each tick).
 *
 * Rounding, all towards zero, chosen so that energy is never created:
 * - Satisfaction is `floor(supply × SAT_ONE / demand)`, capped at `SAT_ONE`.
 *   A tiny supply against a huge demand can round to 0.
 * - The network's load (energy actually delivered) is `min(supply, demand)`,
 *   split among its producers in proportion to their maximum output with
 *   cumulative rounding, so the shares add up to the load exactly and none
 *   exceeds its producer's maximum.
 * - A consumer at satisfaction `s` gets `floor(demand × s / SAT_ONE)` (see
 *   `poweredEnergy`); the sum over a network's consumers can fall short of
 *   the load by less than one joule per consumer, which is lost.
 */

import { SAT_ONE } from '../../data/entities';
import { mulDiv } from '../fixed';

/**
 * Satisfaction of a network with `demand` and `supply` joules this tick:
 * `min(1, supply / demand)` in units of 1/`SAT_ONE`, rounded down. A network
 * with no demand is fully satisfied if it has any supply (so a consumer that
 * starts working runs at once), else 0.
 */
export function satisfactionFor(demand: number, supply: number): number {
  if (demand === 0) return supply > 0 ? SAT_ONE : 0;
  if (supply >= demand) return SAT_ONE;
  return mulDiv(supply, SAT_ONE, demand);
}

/**
 * Joules a producer delivers this tick when the producers before it in the
 * network (in iteration order) have `before` joules of maximum output and it
 * has `max`: its share of `load` out of the network's `supply`, rounded so
 * that the shares of all producers add up to `load` exactly (each one gets
 * `floor(load × (before + max) / supply) − floor(load × before / supply)`).
 * `load` must not exceed `supply`.
 */
export function producerShare(load: number, supply: number, before: number, max: number): number {
  if (load === 0 || max === 0) return 0;
  return mulDiv(load, before + max, supply) - mulDiv(load, before, supply);
}

/** Joules a consumer wanting `demand` gets at satisfaction `satisfaction`, rounded down. */
export function poweredEnergy(demand: number, satisfaction: number): number {
  return satisfaction >= SAT_ONE ? demand : mulDiv(demand, satisfaction, SAT_ONE);
}

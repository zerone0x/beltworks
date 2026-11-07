/**
 * Research state per force (a team of players; one for now): the current
 * research, the units researched of every technology, and from those the
 * researched set. Labs (lab.ts) do the work: each unit they finish counts
 * for the technology it was started for (`completeUnit`). See
 * docs/ARCHITECTURE.md, "Research".
 *
 * - The current research can be any technology that isn't researched yet
 *   and whose prerequisites all are (`SetResearch {tech}`; 0 stops
 *   researching). Switching keeps every technology's progress, so going
 *   back to one picks up where it stopped.
 * - A technology is researched once its units reach `units`. If it was the
 *   current research, the force then researches nothing until the player
 *   picks something new.
 *
 * Integers only, hashed with the rest of the state.
 */

import { TECH_SLOTS, technologyPrototype } from '../../data/technologies';
import { fnv1a32 } from '../hash';

export class ResearchState {
  /** Number of forces. */
  readonly forces: number;
  /** Each force's current research (a technology id, 0 for none). */
  readonly current: Uint16Array;
  /** Units researched, `TECH_SLOTS` per force, indexed by technology id. */
  readonly units: Uint32Array;

  constructor(forces = 1) {
    this.forces = forces;
    this.current = new Uint16Array(forces);
    this.units = new Uint32Array(forces * TECH_SLOTS);
  }

  /** Whether `force` is a force of this state. */
  hasForce(force: number): boolean {
    return Number.isInteger(force) && force >= 0 && force < this.forces;
  }

  /** Force `force`'s current research, or 0 (also for unknown forces). */
  currentOf(force: number): number {
    return this.hasForce(force) ? this.current[force]! : 0;
  }

  /** Units of technology `tech` force `force` has researched (0 for unknown ids). */
  unitsDone(force: number, tech: number): number {
    return this.hasForce(force) && technologyPrototype(tech)
      ? this.units[force * TECH_SLOTS + tech]!
      : 0;
  }

  /** Whether force `force` has researched technology `tech` (false for unknown ids). */
  isResearched(force: number, tech: number): boolean {
    const t = technologyPrototype(tech);
    return t !== undefined && this.unitsDone(force, tech) >= t.units;
  }

  /**
   * Whether force `force` can research technology `tech` now: it exists,
   * isn't researched yet, and every prerequisite is.
   */
  isAvailable(force: number, tech: number): boolean {
    const t = technologyPrototype(tech);
    return (
      t !== undefined &&
      this.hasForce(force) &&
      !this.isResearched(force, tech) &&
      t.prerequisites.every((p) => this.isResearched(force, p))
    );
  }

  /**
   * Makes `tech` force `force`'s current research (0 stops researching).
   * Returns whether the current research changed; false (and nothing
   * changes) when `tech` isn't available or already is the current one.
   */
  setCurrent(force: number, tech: number): boolean {
    if (!this.hasForce(force) || this.current[force] === tech) return false;
    if (tech !== 0 && !this.isAvailable(force, tech)) return false;
    this.current[force] = tech;
    return true;
  }

  /**
   * A lab finished a unit of technology `tech` for force `force`. Returns
   * whether that completed the technology (it is then researched, and stops
   * being the current research).
   */
  completeUnit(force: number, tech: number): boolean {
    const t = technologyPrototype(tech);
    if (!t || !this.hasForce(force) || this.isResearched(force, tech)) return false;
    const k = force * TECH_SLOTS + tech;
    this.units[k] = this.units[k]! + 1;
    if (this.units[k] < t.units) return false;
    if (this.current[force] === tech) this.current[force] = 0;
    return true;
  }

  /** Marks technology `tech` researched for force `force`, without labs (new games for tests). */
  markResearched(force: number, tech: number): void {
    const t = technologyPrototype(tech);
    if (!t || !this.hasForce(force)) return;
    this.units[force * TECH_SLOTS + tech] = t.units;
    if (this.current[force] === tech) this.current[force] = 0;
  }

  /** Folds the state into a running FNV-1a hash. */
  hashInto(h: number): number {
    h = fnv1a32(Uint32Array.of(this.forces, TECH_SLOTS), h);
    h = fnv1a32(this.current, h);
    return fnv1a32(this.units, h);
  }
}

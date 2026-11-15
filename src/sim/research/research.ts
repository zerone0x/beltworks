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
 * - A repeatable technology (D74) is never researched: its units count
 *   towards its next level, and when they reach that level's units
 *   (`technologyUnits`) the level is done, its units start again from 0
 *   and it stays the current research. The levels done are kept per force
 *   (`levels`); each one of a technology with `labSpeedPerLevel` makes the
 *   labs research faster (`labSpeedBonus`).
 *
 * Integers only, hashed with the rest of the state.
 */

import {
  TECH_IDS,
  TECH_SLOTS,
  technologyPrototype,
  technologyUnits,
} from '../../data/technologies';
import { fnv1a32 } from '../hash';
import { SaveError, type SaveReader, type SaveWriter } from '../save/codec';

export class ResearchState {
  /** Number of forces. */
  readonly forces: number;
  /** Each force's current research (a technology id, 0 for none). */
  readonly current: Uint16Array;
  /**
   * Units researched, `TECH_SLOTS` per force, indexed by technology id (for
   * a repeatable technology: units of the level being researched).
   */
  readonly units: Uint32Array;
  /** Levels done of each repeatable technology, laid out like `units` (0 for the others). */
  readonly levels: Uint32Array;

  constructor(forces = 1) {
    this.forces = forces;
    this.current = new Uint16Array(forces);
    this.units = new Uint32Array(forces * TECH_SLOTS);
    this.levels = new Uint32Array(forces * TECH_SLOTS);
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

  /** Levels force `force` has done of repeatable technology `tech` (0 for any other id). */
  levelsDone(force: number, tech: number): number {
    return this.hasForce(force) && technologyPrototype(tech)?.repeatable
      ? this.levels[force * TECH_SLOTS + tech]!
      : 0;
  }

  /**
   * Units force `force` needs of technology `tech` to research it, or (for a
   * repeatable one) its next level (0 for unknown ids).
   */
  unitsNeeded(force: number, tech: number): number {
    const t = technologyPrototype(tech);
    return t ? technologyUnits(t, this.levelsDone(force, tech)) : 0;
  }

  /**
   * Whether force `force` has researched technology `tech` (false for
   * unknown ids, and always for a repeatable one: it has no last level).
   */
  isResearched(force: number, tech: number): boolean {
    const t = technologyPrototype(tech);
    return t !== undefined && !t.repeatable && this.unitsDone(force, tech) >= t.units;
  }

  /**
   * Percent force `force`'s labs research faster than their base speed: the
   * sum over repeatable technologies of levels done × `labSpeedPerLevel`.
   */
  labSpeedBonus(force: number): number {
    let bonus = 0;
    for (const tech of TECH_IDS) {
      const per = technologyPrototype(tech)!.labSpeedPerLevel ?? 0;
      if (per > 0) bonus += per * this.levelsDone(force, tech);
    }
    return bonus;
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
   * being the current research) or, for a repeatable one, a level (the next
   * level starts from 0 units, and it stays the current research).
   */
  completeUnit(force: number, tech: number): boolean {
    const t = technologyPrototype(tech);
    if (!t || !this.hasForce(force) || this.isResearched(force, tech)) return false;
    const k = force * TECH_SLOTS + tech;
    this.units[k] = this.units[k]! + 1;
    if (this.units[k] < technologyUnits(t, this.levels[k]!)) return false;
    if (t.repeatable) {
      this.units[k] = 0;
      this.levels[k] = this.levels[k]! + 1;
      return true;
    }
    if (this.current[force] === tech) this.current[force] = 0;
    return true;
  }

  /**
   * Marks technology `tech` researched for force `force`, without labs (new
   * games for tests). Does nothing to a repeatable technology (`setLevels`).
   */
  markResearched(force: number, tech: number): void {
    const t = technologyPrototype(tech);
    if (!t || t.repeatable || !this.hasForce(force)) return;
    this.units[force * TECH_SLOTS + tech] = t.units;
    if (this.current[force] === tech) this.current[force] = 0;
  }

  /**
   * Sets the levels force `force` has done of repeatable technology `tech`,
   * and its units towards the next one to 0, without labs (tests and tools).
   */
  setLevels(force: number, tech: number, levels: number): void {
    const t = technologyPrototype(tech);
    if (!t?.repeatable || !this.hasForce(force)) return;
    if (!Number.isInteger(levels) || levels < 0 || levels > 0xffff_ffff) {
      throw new RangeError(`levels must be a uint32, got ${String(levels)}`);
    }
    this.levels[force * TECH_SLOTS + tech] = levels;
    this.units[force * TECH_SLOTS + tech] = 0;
  }

  /** Folds the state into a running FNV-1a hash. */
  hashInto(h: number): number {
    h = fnv1a32(Uint32Array.of(this.forces, TECH_SLOTS), h);
    h = fnv1a32(this.current, h);
    h = fnv1a32(this.units, h);
    return fnv1a32(this.levels, h);
  }

  /** Writes the state to a save (its own section; `levels` since save format 2, D74). */
  save(w: SaveWriter): void {
    w.u32(this.forces);
    w.u32(TECH_SLOTS);
    w.column(this.current);
    w.column(this.units);
    w.column(this.levels);
  }

  /** Restores what `save` wrote into this fresh state (same number of forces). */
  load(r: SaveReader): void {
    const forces = r.u32();
    if (forces !== this.forces) {
      throw new SaveError(`research: ${String(forces)} forces in the save`);
    }
    const slots = r.u32();
    if (slots > TECH_SLOTS) {
      throw new SaveError(`research: more technologies in the save than this version has`);
    }
    r.columnInto(this.current);
    // Technologies added since the save was made start unresearched.
    const units = r.column(this.units, forces * slots);
    const levels = r.column(this.levels, forces * slots);
    for (let f = 0; f < forces; f++) {
      this.units.set(units.subarray(f * slots, (f + 1) * slots), f * TECH_SLOTS);
      this.levels.set(levels.subarray(f * slots, (f + 1) * slots), f * TECH_SLOTS);
    }
  }
}

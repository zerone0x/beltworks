/**
 * Labs: 3×3 electric consumers that research their force's current
 * technology (research.ts) from the science packs in their slots. One slot
 * per science pack type (`SCIENCE_PACKS`), each holding up to a stack; a lab
 * takes every pack type whatever is being researched, from inserters and by
 * hand alike (the generic item hooks). Inserters never take packs back out.
 *
 * Each lab works on one unit at a time. Each tick a lab on the active list:
 * 1. Without a unit in progress needs a technology to work on: the current
 *    research, with units left that no other lab is already researching
 *    (`NoResearch` otherwise); one of each of its packs (`NoInput`); and
 *    power (`NoPower` at satisfaction 0 or without a pole). Then it takes
 *    the packs, which starts a unit of that technology.
 * 2. Advances the unit by its network's satisfaction `s` (in 1/`SAT_ONE`
 *    ticks); after the technology's `ticksPerUnit` working ticks at full
 *    power the unit counts for that technology (`ResearchState.completeUnit`)
 *    and the next one starts on the next tick. Progress past the end of a
 *    unit is not carried over. So one lab researches a unit in exactly
 *    `ticksPerUnit` ticks at full power (twice that at half power), and
 *    `n` labs research `n` units at once: a technology of `u` units takes
 *    `ceil(u / n) × ticksPerUnit` ticks.
 *
 * A unit in progress always finishes for the technology it was started for,
 * even if the player switches research meanwhile (its packs are spent), so
 * switching loses nothing. Removing a lab refunds its packs and those of its
 * unit in progress, and the unit is freed for other labs.
 *
 * Power (D26): `powerDemand` asks for `energyPerTick` (1 000 J, 60 kW) while
 * the lab is on the active list with a unit in progress or one it can start,
 * else 0 (no drain). It only advances on a tick its demand was granted; one
 * woken after the power step (an inserter dropped its packs) starts its unit
 * at once but advances from the next tick.
 *
 * Machine sleep: a lab that ends a tick in any state but `Working` or
 * `NoPower` leaves the active list. Changes to its slots put it back, and so
 * does every change to the research (a new current research, a technology
 * completed, a unit freed by a removed lab): `wakeAll` puts every lab back,
 * which is rare enough to cost nothing. It needs no subscriptions. Starting
 * a unit notifies its subscribers (inserters waiting to drop packs).
 */

import { SAT_ONE, EntityTypeId, ENTITIES, type EntityPrototype } from '../../data/entities';
import { itemPrototype, type ItemStack } from '../../data/items';
import {
  SCIENCE_PACKS,
  TECH_SLOTS,
  technologyPrototype,
  type Technology,
} from '../../data/technologies';
import type { Entities } from '../entities/entities';
import { MachineState } from '../entities/machine';
import { SparseSet, growTo } from '../entities/sparseSet';
import type { EntityDetail, EntityTypeTable, Slot } from '../entities/table';
import { fnv1a32 } from '../hash';
import type { SaveReader, SaveWriter } from '../save/codec';
import { NOT_GRANTED, PowerBudget } from '../power/consumer';
import type { ResearchState } from './research';
import { DEFAULT_FORCE } from './unlocks';

/** Slots per lab: one per science pack type. */
export const LAB_SLOTS = SCIENCE_PACKS.length;

/** The lab slot that holds science pack `item`, or -1 for anything else. */
export function labSlotOf(item: number): number {
  return SCIENCE_PACKS.indexOf(item as (typeof SCIENCE_PACKS)[number]);
}

/** Most units of science pack `item` a lab slot holds: one stack. */
function slotLimit(item: number): number {
  return itemPrototype(item)?.stackSize ?? 0;
}

export class LabTable implements EntityTypeTable {
  readonly type = EntityTypeId.Lab;
  readonly proto: EntityPrototype = ENTITIES[EntityTypeId.Lab];
  private readonly set = new SparseSet();
  /** Labs stepped by `update`: every one whose state may change on its own. */
  private readonly active = new SparseSet();
  /** Technology of the unit in progress (0: none). */
  private tech = new Uint16Array(0);
  /** Progress on the unit in progress, in 1/`SAT_ONE` working ticks at full power. */
  private progress = new Uint32Array(0);
  private state = new Uint8Array(0);
  /** Packs per slot, `LAB_SLOTS` per row (slot `i` holds `SCIENCE_PACKS[i]`). */
  private packs = new Uint16Array(0);
  /**
   * Units in progress per technology id: how many labs have `tech` set to
   * it. Follows from `tech`, so it isn't hashed.
   */
  private readonly inProgress = new Uint32Array(TECH_SLOTS);
  private readonly budget = new PowerBudget();
  private readonly energyPerTick = this.proto.energyPerTick ?? 0;
  /** The research the labs work for (set by `createSimState`; none: labs have nothing to do). */
  private research: ResearchState | null = null;

  /** Connects the labs to the research state of their simulation. */
  attach(research: ResearchState): void {
    this.research = research;
  }

  /** Number of labs. */
  get count(): number {
    return this.set.size;
  }

  /** Number of labs on the active list. */
  get activeCount(): number {
    return this.active.size;
  }

  /** Units of technology `tech` labs are researching right now. */
  unitsInProgress(tech: number): number {
    return technologyPrototype(tech) ? this.inProgress[tech]! : 0;
  }

  /**
   * Whole working ticks done on the units of technology `tech` in progress,
   * summed over the labs (for the research progress bar).
   */
  ticksInProgress(tech: number): number {
    let ticks = 0;
    for (let row = 0; row < this.set.size; row++) {
      if (this.tech[row] === tech) ticks += Math.floor(this.progress[row]! / SAT_ONE);
    }
    return ticks;
  }

  /** A new lab: `NoResearch` until its first step, on the active list. */
  add(id: number): void {
    const row = this.set.add(id);
    const min = row + 1;
    this.tech = growTo(this.tech, min);
    this.progress = growTo(this.progress, min);
    this.state = growTo(this.state, min);
    this.packs = growTo(this.packs, min * LAB_SLOTS);
    this.budget.grow(min);
    this.state[row] = MachineState.NoResearch;
    this.active.add(id);
  }

  remove(id: number): void {
    const row = this.set.remove(id);
    if (row < 0) return;
    this.active.remove(id);
    const freed = this.tech[row]!;
    if (freed !== 0) this.inProgress[freed] = this.inProgress[freed]! - 1;
    const last = this.set.size;
    const columns = [this.tech, this.progress, this.state];
    if (row !== last) {
      for (const c of columns) c[row] = c[last]!;
      this.packs.copyWithin(row * LAB_SLOTS, last * LAB_SLOTS, (last + 1) * LAB_SLOTS);
      this.budget.moveRow(last, row);
    }
    for (const c of columns) c[last] = 0;
    this.packs.fill(0, last * LAB_SLOTS, (last + 1) * LAB_SLOTS);
    this.budget.clearRow(last);
    // Its unit can be researched by another lab now.
    if (freed !== 0) this.wakeAll();
  }

  /** The packs in the slots, plus those of the unit in progress. */
  contents(id: number): readonly ItemStack[] {
    const row = this.row(id);
    const out: ItemStack[] = [];
    const t = technologyPrototype(this.tech[row]!);
    for (const item of t?.packs ?? []) out.push({ item, count: 1 });
    SCIENCE_PACKS.forEach((item, i) => {
      const count = this.packs[row * LAB_SLOTS + i]!;
      if (count > 0) out.push({ item, count });
    });
    return out;
  }

  status(id: number): MachineState {
    return this.state[this.row(id)]! as MachineState;
  }

  /** `technology` is the unit in progress (0: none); `progress` its whole working ticks. */
  detail(id: number): EntityDetail {
    const row = this.row(id);
    return {
      status: this.state[row]! as MachineState,
      recipe: 0,
      progress: Math.floor(this.progress[row]! / SAT_ONE),
      energy: 0,
      burning: 0,
      technology: this.tech[row]!,
    };
  }

  /** Progress on the unit in progress in 1/`SAT_ONE` ticks (for tests and tools). */
  rawProgress(id: number): number {
    return this.progress[this.row(id)]!;
  }

  /** The technology of lab `id`'s unit in progress, or 0. */
  unitTech(id: number): number {
    return this.tech[this.row(id)]!;
  }

  slots(id: number): Slot[] {
    const row = this.row(id);
    return SCIENCE_PACKS.map((item, i) => {
      const count = this.packs[row * LAB_SLOTS + i]!;
      return { item: count > 0 ? item : 0, count };
    });
  }

  insertable(id: number, item: number): number {
    const i = labSlotOf(item);
    return i < 0 ? 0 : this.room(this.row(id), i);
  }

  /** Every science pack. */
  accepts(_id: number, item: number): boolean {
    return labSlotOf(item) >= 0;
  }

  /** Whether some pack slot is below a stack. */
  hasRoom(id: number): boolean {
    const row = this.row(id);
    return SCIENCE_PACKS.some((_, i) => this.room(row, i) > 0);
  }

  /** Packs go into their slot, up to a stack. */
  insert(id: number, item: number, count: number, entities: Entities): number {
    const i = labSlotOf(item);
    if (i < 0) return 0;
    const row = this.row(id);
    const n = Math.min(count, this.room(row, i));
    if (n <= 0) return 0;
    this.packs[row * LAB_SLOTS + i]! += n;
    this.changed(id, entities);
    return n;
  }

  take(id: number, slot: number, count: number, entities: Entities): number {
    if (!Number.isInteger(slot) || slot < 0 || slot >= LAB_SLOTS) return 0;
    const k = this.row(id) * LAB_SLOTS + slot;
    const n = Math.min(count, this.packs[k]!);
    if (n <= 0) return 0;
    this.packs[k]! -= n;
    this.changed(id, entities);
    return n;
  }

  /** Nothing: inserters don't take packs back out of a lab. */
  outputSlot(): number {
    return -1;
  }

  /** Its working energy while it may research this tick, else nothing (see the file comment). */
  powerDemand(id: number): number {
    const row = this.row(id);
    return this.mayWork(row, id) ? this.budget.grant(row, this.energyPerTick) : 0;
  }

  /**
   * Puts every lab back on the active list: the research changed (a new
   * current research, a technology completed, a unit freed), which can let
   * any of them work again or change what it waits for.
   */
  wakeAll(): void {
    for (let row = 0; row < this.set.size; row++) {
      const id = this.set.idAt(row);
      if (!this.active.has(id)) this.active.add(id);
    }
  }

  /** The lab system: steps every active lab by one tick. */
  update(entities: Entities): void {
    // Backwards, so a lab leaving the list only moves one already stepped.
    for (let i = this.active.size - 1; i >= 0; i--) {
      const id = this.active.idAt(i);
      const row = this.set.indexOf(id);
      const state = this.step(row, id, entities);
      this.state[row] = state;
      if (state !== MachineState.Working && state !== MachineState.NoPower) {
        this.active.remove(id);
      }
    }
  }

  hashInto(h: number): number {
    const n = this.set.size;
    h = fnv1a32(Uint32Array.of(n, this.active.size), h);
    h = fnv1a32(this.set.dense, h);
    h = fnv1a32(this.active.dense, h);
    for (const c of [this.tech, this.progress, this.state]) {
      h = fnv1a32(c.subarray(0, n), h);
    }
    return fnv1a32(this.packs.subarray(0, n * LAB_SLOTS), h);
  }

  save(w: SaveWriter): void {
    const n = this.set.size;
    w.sparseSet(this.set);
    w.sparseSet(this.active);
    for (const c of [this.tech, this.progress, this.state]) w.column(c, n);
    w.column(this.packs, n * LAB_SLOTS);
  }

  load(r: SaveReader): void {
    r.sparseSet(this.set);
    r.sparseSet(this.active);
    const n = this.set.size;
    this.tech = r.column(this.tech, n);
    this.progress = r.column(this.progress, n);
    this.state = r.column(this.state, n);
    this.packs = r.column(this.packs, n * LAB_SLOTS);
    // Power grants only live within a tick (consumer.ts): not saved.
    this.budget.grow(n);
    // Units in progress per technology follow from the rows.
    this.inProgress.fill(0);
    for (let row = 0; row < n; row++) {
      const tech = this.tech[row]!;
      if (tech !== 0) this.inProgress[tech] = this.inProgress[tech]! + 1;
    }
  }

  /** One tick of the lab in row `row`; returns its new state. */
  private step(row: number, id: number, entities: Entities): MachineState {
    const granted = this.budget.take(row);
    const speed = (): number => this.budget.speed(id, granted, entities);
    let advance: number;
    if (this.tech[row] === 0) {
      const t = this.startable();
      if (!t) return MachineState.NoResearch;
      if (!this.hasPacks(row, t)) return MachineState.NoInput;
      advance = speed();
      if (advance === 0) return MachineState.NoPower;
      for (const item of t.packs) this.packs[row * LAB_SLOTS + labSlotOf(item)]! -= 1;
      this.tech[row] = t.id;
      this.inProgress[t.id] = this.inProgress[t.id]! + 1;
      // Its slots have room again: inserters waiting to drop can go on.
      entities.notify(id);
    } else {
      advance = speed();
      if (advance === 0) return MachineState.NoPower;
    }
    if (advance === NOT_GRANTED) return MachineState.Working;
    const tech = this.tech[row]!;
    const t = technologyPrototype(tech)!;
    const progress = this.progress[row]! + advance;
    if (progress < t.ticksPerUnit * SAT_ONE) {
      this.progress[row] = progress;
      return MachineState.Working;
    }
    this.tech[row] = 0;
    this.progress[row] = 0;
    this.inProgress[tech] = this.inProgress[tech]! - 1;
    if (this.research?.completeUnit(DEFAULT_FORCE, tech)) {
      // Researched: the current research may have ended, and labs waiting
      // for something to research should say so.
      this.wakeAll();
    }
    return MachineState.Working;
  }

  /**
   * The technology a lab without a unit in progress would start one of: the
   * current research, if it has units left that no lab is researching yet.
   */
  private startable(): Technology | undefined {
    const research = this.research;
    if (!research) return undefined;
    const tech = research.currentOf(DEFAULT_FORCE);
    const t = technologyPrototype(tech);
    if (!t) return undefined;
    return research.unitsDone(DEFAULT_FORCE, tech) + this.inProgress[tech]! < t.units
      ? t
      : undefined;
  }

  /**
   * Whether lab `id` in row `row` may research this tick, as far as can be
   * told before the labs run: on the active list, with a unit in progress or
   * the packs to start one of the technology it would start.
   */
  private mayWork(row: number, id: number): boolean {
    if (!this.active.has(id)) return false;
    if (this.tech[row] !== 0) return true;
    const t = this.startable();
    return t !== undefined && this.hasPacks(row, t);
  }

  private hasPacks(row: number, t: Technology): boolean {
    return t.packs.every((item) => this.packs[row * LAB_SLOTS + labSlotOf(item)]! >= 1);
  }

  /** Room left in slot `i`. */
  private room(row: number, i: number): number {
    return Math.max(0, slotLimit(SCIENCE_PACKS[i]!) - this.packs[row * LAB_SLOTS + i]!);
  }

  /** The lab's slots changed: put it on the active list and tell its subscribers. */
  private changed(id: number, entities: Entities): void {
    if (!this.active.has(id)) this.active.add(id);
    entities.notify(id);
  }

  private row(id: number): number {
    const row = this.set.indexOf(id);
    if (row < 0) {
      throw new RangeError(`no lab ${String(id)}`);
    }
    return row;
  }
}

/** The lab table in `entities`, if one is registered. */
export function labTable(entities: Entities): LabTable | undefined {
  const table = entities.table(EntityTypeId.Lab);
  return table instanceof LabTable ? table : undefined;
}

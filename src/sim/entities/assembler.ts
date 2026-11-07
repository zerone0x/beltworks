/**
 * Assembling machines (1 and 2): 3×3 electric consumers that make the
 * recipe the player sets (`SetRecipe`, src/sim/entities/transfer.ts; any
 * recipe but smelting, `isAssemblerRecipe`). One `AssemblerTable` per
 * machine type; they differ only in their prototype's crafting speed and
 * energy use (src/data/entities.ts).
 *
 * Slots are sized from the recipe: one input slot per ingredient, in the
 * recipe's order, then one output slot per product. Each slot only ever
 * holds its own item, so the table stores counts alone. An input slot takes
 * up to `ASSEMBLER_INPUT_MULTIPLIER` (2) times the recipe's amount (from
 * inserters and by hand alike), an output slot up to a stack. Without a
 * recipe there are no slots. Changing the recipe empties the slots and drops
 * a craft in progress; the command refunds all of it to the player first.
 *
 * Each tick a machine on the active list:
 * 1. Without a recipe is `NoRecipe`.
 * 2. With no craft in progress needs every ingredient in its input slots
 *    (`NoInput`) and room for every product in its output slots
 *    (`OutputFull`), and power (`NoPower` at satisfaction 0 or without a
 *    pole); then it takes the ingredients out of the input slots, which
 *    starts the craft.
 * 3. Advances the craft by its network's satisfaction `s` (in 1/`SAT_ONE`
 *    ticks); after `craftingTicks(recipe ticks, crafting speed)` working
 *    ticks at full power (twice the recipe's ticks for machine 1, 4/3 of
 *    them rounded up for machine 2) the products go into the output slots.
 *    Progress past the end of a craft is not carried over, and the next
 *    craft starts on the next tick, so at full power a craft takes exactly
 *    that many ticks, at half power twice as many.
 *
 * Power (D26): `powerDemand` asks for the machine's `energyPerTick` while it
 * is on the active list with a craft in progress or one it can start, else
 * 0 (no drain). It only advances on a tick its demand was granted: one woken
 * after the power step (an inserter filled its last missing ingredient)
 * starts its craft at once but advances from the next tick.
 *
 * Machine sleep: a machine that ends a tick in any state but `Working` or
 * `NoPower` leaves the active list, and goes back on it when its slots
 * change (`insert`, `take`) or its recipe is set, the only things that can
 * make it work again. It needs no subscriptions. Taking ingredients and
 * finishing a craft notify its subscribers (inserters waiting to drop into
 * it or to pick up from it).
 */

import {
  ASSEMBLER_INPUT_MULTIPLIER,
  EntityTypeId,
  SAT_ONE,
  craftingTicks,
  type EntityPrototype,
  type RealEntityTypeId,
} from '../../data/entities';
import { itemPrototype, type ItemStack } from '../../data/items';
import {
  ASSEMBLER_MAX_INPUTS,
  ASSEMBLER_MAX_OUTPUTS,
  isAssemblerRecipe,
  recipePrototype,
  type Recipe,
} from '../../data/recipes';
import { fnv1a32 } from '../hash';
import type { SaveReader, SaveWriter } from '../save/codec';
import { NOT_GRANTED, PowerBudget } from '../power/consumer';
import type { Entities } from './entities';
import { MachineState } from './machine';
import { SparseSet, growTo } from './sparseSet';
import type { EntityDetail, EntityTypeTable, Slot } from './table';

/** Most units an input slot takes for an ingredient the recipe needs `count` of. */
export function assemblerInputLimit(item: number, count: number): number {
  const stack = itemPrototype(item)?.stackSize ?? 0;
  return Math.min(ASSEMBLER_INPUT_MULTIPLIER * count, Math.max(stack, count));
}

/** Most units an output slot holds for a product the recipe makes `count` of. */
export function assemblerOutputLimit(item: number, count: number): number {
  return Math.max(itemPrototype(item)?.stackSize ?? 0, count);
}

export class AssemblerTable implements EntityTypeTable {
  readonly type: RealEntityTypeId;
  readonly proto: EntityPrototype;
  private readonly set = new SparseSet();
  /** Machines stepped by `update`: every one whose state may change on its own. */
  private readonly active = new SparseSet();
  /** The recipe set (0: none). */
  private recipeId = new Uint16Array(0);
  /** 1 while a craft is in progress (its ingredients are taken). */
  private busy = new Uint8Array(0);
  /** Progress on the craft in progress, in 1/`SAT_ONE` working ticks at full power. */
  private progress = new Uint32Array(0);
  private state = new Uint8Array(0);
  /** Units per input slot, `ASSEMBLER_MAX_INPUTS` per row (the items follow from the recipe). */
  private inputs = new Uint16Array(0);
  /** Units per output slot, `ASSEMBLER_MAX_OUTPUTS` per row. */
  private outputs = new Uint16Array(0);
  private readonly budget = new PowerBudget();
  private readonly energyPerTick: number;

  constructor(proto: EntityPrototype) {
    this.type = proto.id;
    this.proto = proto;
    this.energyPerTick = proto.energyPerTick ?? 0;
  }

  /** Number of machines. */
  get count(): number {
    return this.set.size;
  }

  /** Number of machines on the active list. */
  get activeCount(): number {
    return this.active.size;
  }

  /** Working ticks at full power one craft of recipe `recipe` takes in this machine type. */
  craftTicks(recipe: Recipe): number {
    return craftingTicks(recipe.ticks, this.proto.craftingSpeed);
  }

  /** A new machine has no recipe: `NoRecipe`, off the active list. */
  add(id: number): void {
    const row = this.set.add(id);
    const min = row + 1;
    this.recipeId = growTo(this.recipeId, min);
    this.busy = growTo(this.busy, min);
    this.progress = growTo(this.progress, min);
    this.state = growTo(this.state, min);
    this.inputs = growTo(this.inputs, min * ASSEMBLER_MAX_INPUTS);
    this.outputs = growTo(this.outputs, min * ASSEMBLER_MAX_OUTPUTS);
    this.budget.grow(min);
    this.state[row] = MachineState.NoRecipe;
  }

  remove(id: number): void {
    const row = this.set.remove(id);
    if (row < 0) return;
    this.active.remove(id);
    const last = this.set.size;
    const columns = [this.recipeId, this.busy, this.progress, this.state];
    if (row !== last) {
      for (const c of columns) c[row] = c[last]!;
      this.inputs.copyWithin(
        row * ASSEMBLER_MAX_INPUTS,
        last * ASSEMBLER_MAX_INPUTS,
        (last + 1) * ASSEMBLER_MAX_INPUTS,
      );
      this.outputs.copyWithin(
        row * ASSEMBLER_MAX_OUTPUTS,
        last * ASSEMBLER_MAX_OUTPUTS,
        (last + 1) * ASSEMBLER_MAX_OUTPUTS,
      );
      this.budget.moveRow(last, row);
    }
    for (const c of columns) c[last] = 0;
    this.inputs.fill(0, last * ASSEMBLER_MAX_INPUTS, (last + 1) * ASSEMBLER_MAX_INPUTS);
    this.outputs.fill(0, last * ASSEMBLER_MAX_OUTPUTS, (last + 1) * ASSEMBLER_MAX_OUTPUTS);
    this.budget.clearRow(last);
  }

  /** The input and output slots, plus the ingredients of a craft in progress. */
  contents(id: number): readonly ItemStack[] {
    const row = this.row(id);
    const r = recipePrototype(this.recipeId[row]!);
    const out: ItemStack[] = [];
    if (!r) return out;
    if (this.busy[row] === 1) {
      for (const [item, count] of r.inputs) out.push({ item, count });
    }
    r.inputs.forEach(([item], i) => {
      const count = this.inputs[row * ASSEMBLER_MAX_INPUTS + i]!;
      if (count > 0) out.push({ item, count });
    });
    r.outputs.forEach(([item], j) => {
      const count = this.outputs[row * ASSEMBLER_MAX_OUTPUTS + j]!;
      if (count > 0) out.push({ item, count });
    });
    return out;
  }

  status(id: number): MachineState {
    return this.state[this.row(id)]! as MachineState;
  }

  /** `recipe` is the recipe set; `progress` the craft's whole working ticks at full power. */
  detail(id: number): EntityDetail {
    const row = this.row(id);
    return {
      status: this.state[row]! as MachineState,
      recipe: this.recipeId[row]!,
      progress: Math.floor(this.progress[row]! / SAT_ONE),
      energy: 0,
      burning: 0,
    };
  }

  /** Craft progress in 1/`SAT_ONE` ticks (for tests and tools). */
  rawProgress(id: number): number {
    return this.progress[this.row(id)]!;
  }

  /** Whether a craft is in progress (its ingredients are taken). */
  crafting(id: number): boolean {
    return this.busy[this.row(id)] === 1;
  }

  selectedRecipe(id: number): number {
    return this.recipeId[this.row(id)]!;
  }

  /** Any recipe but smelting (that fits the slots). */
  allowsRecipe(_id: number, recipe: number): boolean {
    const r = recipePrototype(recipe);
    return (
      r !== undefined &&
      isAssemblerRecipe(r) &&
      r.inputs.length <= ASSEMBLER_MAX_INPUTS &&
      r.outputs.length <= ASSEMBLER_MAX_OUTPUTS
    );
  }

  setRecipe(id: number, recipe: number, entities: Entities): void {
    const row = this.row(id);
    this.recipeId[row] = recipe;
    this.busy[row] = 0;
    this.progress[row] = 0;
    this.inputs.fill(0, row * ASSEMBLER_MAX_INPUTS, (row + 1) * ASSEMBLER_MAX_INPUTS);
    this.outputs.fill(0, row * ASSEMBLER_MAX_OUTPUTS, (row + 1) * ASSEMBLER_MAX_OUTPUTS);
    if (recipe === 0) {
      this.state[row] = MachineState.NoRecipe;
      this.active.remove(id);
      entities.notify(id);
    } else {
      this.state[row] = MachineState.NoInput;
      this.changed(id, entities);
    }
  }

  /** The input slots, then the output slots, of the recipe set (none without one). */
  slots(id: number): Slot[] {
    const row = this.row(id);
    const r = recipePrototype(this.recipeId[row]!);
    if (!r) return [];
    const slot = (item: number, count: number): Slot => ({ item: count > 0 ? item : 0, count });
    return [
      ...r.inputs.map(([item], i) => slot(item, this.inputs[row * ASSEMBLER_MAX_INPUTS + i]!)),
      ...r.outputs.map(([item], j) => slot(item, this.outputs[row * ASSEMBLER_MAX_OUTPUTS + j]!)),
    ];
  }

  insertable(id: number, item: number): number {
    const row = this.row(id);
    const i = this.inputIndex(row, item);
    return i < 0 ? 0 : this.inputRoom(row, i);
  }

  /** The recipe's ingredients. */
  accepts(id: number, item: number): boolean {
    return this.inputIndex(this.row(id), item) >= 0;
  }

  /** Ingredients go into their input slot, up to its limit. */
  insert(id: number, item: number, count: number, entities: Entities): number {
    const row = this.row(id);
    const i = this.inputIndex(row, item);
    if (i < 0) return 0;
    const n = Math.min(count, this.inputRoom(row, i));
    if (n <= 0) return 0;
    this.inputs[row * ASSEMBLER_MAX_INPUTS + i]! += n;
    this.changed(id, entities);
    return n;
  }

  take(id: number, slot: number, count: number, entities: Entities): number {
    const row = this.row(id);
    const r = recipePrototype(this.recipeId[row]!);
    if (!r || slot < 0) return 0;
    let column: Uint16Array;
    let k: number;
    if (slot < r.inputs.length) {
      column = this.inputs;
      k = row * ASSEMBLER_MAX_INPUTS + slot;
    } else if (slot < r.inputs.length + r.outputs.length) {
      column = this.outputs;
      k = row * ASSEMBLER_MAX_OUTPUTS + slot - r.inputs.length;
    } else {
      return 0;
    }
    const n = Math.min(count, column[k]!);
    if (n <= 0) return 0;
    column[k]! -= n;
    this.changed(id, entities);
    return n;
  }

  /** The first output slot holding something (`accept` accepts). Inserters never take ingredients. */
  outputSlot(id: number, accept?: (item: number) => boolean): number {
    const row = this.row(id);
    const r = recipePrototype(this.recipeId[row]!);
    if (!r) return -1;
    for (let j = 0; j < r.outputs.length; j++) {
      const item = r.outputs[j]![0];
      if (this.outputs[row * ASSEMBLER_MAX_OUTPUTS + j]! > 0 && (!accept || accept(item))) {
        return r.inputs.length + j;
      }
    }
    return -1;
  }

  /** Its working energy while it may craft this tick, else nothing (see the file comment). */
  powerDemand(id: number): number {
    const row = this.row(id);
    return this.mayWork(row, id) ? this.budget.grant(row, this.energyPerTick) : 0;
  }

  /** The assembler system for this machine type: steps every active machine by one tick. */
  update(entities: Entities): void {
    // Backwards, so a machine leaving the list only moves one already stepped.
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
    for (const c of [this.recipeId, this.busy, this.progress, this.state]) {
      h = fnv1a32(c.subarray(0, n), h);
    }
    h = fnv1a32(this.inputs.subarray(0, n * ASSEMBLER_MAX_INPUTS), h);
    return fnv1a32(this.outputs.subarray(0, n * ASSEMBLER_MAX_OUTPUTS), h);
  }

  save(w: SaveWriter): void {
    const n = this.set.size;
    w.sparseSet(this.set);
    w.sparseSet(this.active);
    for (const c of [this.recipeId, this.busy, this.progress, this.state]) w.column(c, n);
    w.column(this.inputs, n * ASSEMBLER_MAX_INPUTS);
    w.column(this.outputs, n * ASSEMBLER_MAX_OUTPUTS);
  }

  load(r: SaveReader): void {
    r.sparseSet(this.set);
    r.sparseSet(this.active);
    const n = this.set.size;
    this.recipeId = r.column(this.recipeId, n);
    this.busy = r.column(this.busy, n);
    this.progress = r.column(this.progress, n);
    this.state = r.column(this.state, n);
    this.inputs = r.column(this.inputs, n * ASSEMBLER_MAX_INPUTS);
    this.outputs = r.column(this.outputs, n * ASSEMBLER_MAX_OUTPUTS);
    // Power grants only live within a tick (consumer.ts): not saved.
    this.budget.grow(n);
  }

  /** One tick of the machine in row `row`; returns its new state. */
  private step(row: number, id: number, entities: Entities): MachineState {
    const granted = this.budget.take(row);
    const r = recipePrototype(this.recipeId[row]!);
    if (!r) return MachineState.NoRecipe;
    const speed = (): number => this.budget.speed(id, granted, entities);
    let advance: number;
    if (this.busy[row] === 0) {
      if (!this.hasInputs(row, r)) return MachineState.NoInput;
      if (!this.outputRoom(row, r)) return MachineState.OutputFull;
      advance = speed();
      if (advance === 0) return MachineState.NoPower;
      r.inputs.forEach(([, count], i) => {
        this.inputs[row * ASSEMBLER_MAX_INPUTS + i]! -= count;
      });
      this.busy[row] = 1;
      // Input slots have room again: inserters waiting to drop can go on.
      entities.notify(id);
    } else {
      advance = speed();
      if (advance === 0) return MachineState.NoPower;
    }
    if (advance === NOT_GRANTED) return MachineState.Working;
    const progress = this.progress[row]! + advance;
    if (progress < this.craftTicks(r) * SAT_ONE) {
      this.progress[row] = progress;
      return MachineState.Working;
    }
    r.outputs.forEach(([, count], j) => {
      this.outputs[row * ASSEMBLER_MAX_OUTPUTS + j]! += count;
    });
    this.busy[row] = 0;
    this.progress[row] = 0;
    entities.notify(id);
    return MachineState.Working;
  }

  /**
   * Whether machine `id` in row `row` may craft this tick, as far as can be
   * told before the machines run: on the active list, with a craft in
   * progress or the ingredients and output room to start one.
   */
  private mayWork(row: number, id: number): boolean {
    if (!this.active.has(id)) return false;
    const r = recipePrototype(this.recipeId[row]!);
    if (!r) return false;
    return this.busy[row] === 1 || (this.hasInputs(row, r) && this.outputRoom(row, r));
  }

  private hasInputs(row: number, r: Recipe): boolean {
    return r.inputs.every(([, count], i) => this.inputs[row * ASSEMBLER_MAX_INPUTS + i]! >= count);
  }

  private outputRoom(row: number, r: Recipe): boolean {
    return r.outputs.every(
      ([item, count], j) =>
        this.outputs[row * ASSEMBLER_MAX_OUTPUTS + j]! + count <= assemblerOutputLimit(item, count),
    );
  }

  /** Index of `item` among the ingredients of the recipe set, or -1. */
  private inputIndex(row: number, item: number): number {
    const r = recipePrototype(this.recipeId[row]!);
    if (!r || item === 0) return -1;
    return r.inputs.findIndex(([it]) => it === item);
  }

  /** Room left in input slot `i` (an ingredient of the recipe set). */
  private inputRoom(row: number, i: number): number {
    const [item, count] = recipePrototype(this.recipeId[row]!)!.inputs[i]!;
    return Math.max(
      0,
      assemblerInputLimit(item, count) - this.inputs[row * ASSEMBLER_MAX_INPUTS + i]!,
    );
  }

  /** The machine's slots or recipe changed: put it on the active list and tell its subscribers. */
  private changed(id: number, entities: Entities): void {
    if (!this.active.has(id)) this.active.add(id);
    entities.notify(id);
  }

  private row(id: number): number {
    const row = this.set.indexOf(id);
    if (row < 0) {
      throw new RangeError(`no ${this.proto.name} ${String(id)}`);
    }
    return row;
  }
}

/** Entity types of the assembling machines, in the order the assembler system steps them. */
export const ASSEMBLER_TYPES = [
  EntityTypeId.AssemblingMachine1,
  EntityTypeId.AssemblingMachine2,
] as const;

/** Whether entity type `type` is an assembling machine. */
export function isAssemblerType(type: number): boolean {
  return (ASSEMBLER_TYPES as readonly number[]).includes(type);
}

/** The assembler table of machine type `type` in `entities`, if one is registered. */
export function assemblerTable(entities: Entities, type: number): AssemblerTable | undefined {
  const table = entities.table(type);
  return table instanceof AssemblerTable ? table : undefined;
}

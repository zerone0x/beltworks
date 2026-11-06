/**
 * Stone furnaces: an input slot, a burner (fuel slot and energy buffer, see
 * burner.ts) and an output slot per furnace, plus the recipe being smelted,
 * its progress in ticks, and the machine state.
 *
 * The recipe follows from the input item (the smelting recipe whose
 * ingredient it is, src/data/recipes.ts). On each tick a furnace works it:
 * 1. With no recipe in progress it needs a full set of ingredients in the
 *    input slot (`NoInput` otherwise) and room for the result in the output
 *    slot (`OutputFull`; at most `FURNACE_OUTPUT_LIMIT` units, one item).
 * 2. It burns `energyPerTick` joules (`NoFuel` if the burner has none left).
 *    A new recipe takes its ingredients out of the input slot only now, once
 *    it is certain to start.
 * 3. Progress goes up by one; after `ticks` ticks the result goes into the
 *    output slot and the furnace is ready for the next recipe.
 * So with ingredients and fuel at hand a furnace makes one result every
 * `ticks` ticks exactly, and every joule of fuel is used.
 *
 * Machine sleep: only furnaces on the active list are stepped. One that ends
 * a tick in any state but `Working` leaves the list, and goes back on it when
 * its slots change (`insert`/`take`), which is the only thing that can make
 * it work again.
 */

import { ENTITIES, EntityTypeId, FURNACE_OUTPUT_LIMIT } from '../../data/entities';
import { fuelValue, itemPrototype, type ItemStack, type RealItemId } from '../../data/items';
import { recipePrototype, smeltingRecipeFor, type Recipe } from '../../data/recipes';
import { fnv1a32 } from '../hash';
import { BurnerColumns } from './burner';
import type { Entities } from './entities';
import { MachineState } from './machine';
import { SparseSet, growTo } from './sparseSet';
import type { EntityDetail, EntityTypeTable, Slot } from './table';

/** Slot indices of a furnace, in the order `slots` lists them. */
export const FurnaceSlot = {
  Input: 0,
  Fuel: 1,
  Output: 2,
} as const;

/** Joules a furnace burns per working tick. */
export const FURNACE_ENERGY_PER_TICK = ENTITIES[EntityTypeId.StoneFurnace].energyPerTick ?? 0;

export class FurnaceTable implements EntityTypeTable {
  readonly type = EntityTypeId.StoneFurnace;
  private readonly set = new SparseSet();
  /** Furnaces stepped by `update`: every one whose state may change on its own. */
  private readonly active = new SparseSet();
  private inputItem = new Uint16Array(0);
  private inputCount = new Uint16Array(0);
  private outputItem = new Uint16Array(0);
  private outputCount = new Uint16Array(0);
  /** Recipe in progress (its ingredients are already taken), or 0. */
  private recipe = new Uint8Array(0);
  /** Ticks done on the recipe in progress. */
  private progress = new Uint16Array(0);
  private state = new Uint8Array(0);
  private readonly burner = new BurnerColumns();

  /** Number of furnaces. */
  get count(): number {
    return this.set.size;
  }

  /** Number of furnaces on the active list. */
  get activeCount(): number {
    return this.active.size;
  }

  add(id: number): void {
    const row = this.set.add(id);
    const min = row + 1;
    this.inputItem = growTo(this.inputItem, min);
    this.inputCount = growTo(this.inputCount, min);
    this.outputItem = growTo(this.outputItem, min);
    this.outputCount = growTo(this.outputCount, min);
    this.recipe = growTo(this.recipe, min);
    this.progress = growTo(this.progress, min);
    this.state = growTo(this.state, min);
    this.burner.grow(min);
    this.state[row] = MachineState.NoInput;
  }

  remove(id: number): void {
    const row = this.set.remove(id);
    if (row < 0) return;
    this.active.remove(id);
    const last = this.set.size;
    const columns = [
      this.inputItem,
      this.inputCount,
      this.outputItem,
      this.outputCount,
      this.recipe,
      this.progress,
      this.state,
    ];
    if (row !== last) {
      for (const c of columns) c[row] = c[last]!;
      this.burner.moveRow(last, row);
    }
    for (const c of columns) c[last] = 0;
    this.burner.clearRow(last);
  }

  /** The input, fuel and output slots, plus the ingredients of a recipe in progress. */
  contents(id: number): readonly ItemStack[] {
    const row = this.row(id);
    const out: ItemStack[] = [];
    const r = recipePrototype(this.recipe[row]!);
    if (r) {
      for (const [item, count] of r.inputs) out.push({ item, count });
    }
    for (const slot of this.slotsAt(row)) {
      if (slot.count > 0) out.push({ item: slot.item as RealItemId, count: slot.count });
    }
    return out;
  }

  status(id: number): MachineState {
    return this.state[this.row(id)]! as MachineState;
  }

  detail(id: number): EntityDetail {
    const row = this.row(id);
    return {
      status: this.state[row]! as MachineState,
      recipe: this.recipe[row]!,
      progress: this.progress[row]!,
      energy: this.burner.energy[row]!,
      burning: this.burner.burning[row]!,
    };
  }

  slots(id: number): Slot[] {
    return this.slotsAt(this.row(id));
  }

  insertable(id: number, item: number): number {
    const row = this.row(id);
    return this.inputRoom(row, item) + this.burner.insertable(row, item);
  }

  /** Ores (anything with a smelting recipe) and fuel. */
  accepts(_id: number, item: number): boolean {
    return smeltingRecipeFor(item) !== undefined || fuelValue(item) > 0;
  }

  /** Ingredients go into the input slot; fuel into the fuel slot (also when the input has no room). */
  insert(id: number, item: number, count: number, entities: Entities): number {
    const row = this.row(id);
    let n = Math.min(count, this.inputRoom(row, item));
    if (n > 0) {
      this.inputItem[row] = item;
      this.inputCount[row] = this.inputCount[row]! + n;
    }
    n += this.burner.insert(row, item, count - n);
    if (n > 0) this.changed(id, entities);
    return n;
  }

  take(id: number, slot: number, count: number, entities: Entities): number {
    const row = this.row(id);
    let n = 0;
    if (slot === FurnaceSlot.Fuel) {
      n = this.burner.take(row, count);
    } else if (slot === FurnaceSlot.Input || slot === FurnaceSlot.Output) {
      const items = slot === FurnaceSlot.Input ? this.inputItem : this.outputItem;
      const counts = slot === FurnaceSlot.Input ? this.inputCount : this.outputCount;
      n = Math.min(count, counts[row]!);
      counts[row] = counts[row]! - n;
      if (counts[row] === 0) items[row] = 0;
    }
    if (n > 0) this.changed(id, entities);
    return n;
  }

  outputSlot(id: number, accept?: (item: number) => boolean): number {
    const row = this.row(id);
    const ok = this.outputCount[row]! > 0 && (!accept || accept(this.outputItem[row]!));
    return ok ? FurnaceSlot.Output : -1;
  }

  /** The furnace system: steps every active furnace by one tick. */
  update(entities: Entities): void {
    // Backwards, so a furnace leaving the list only moves one already stepped.
    for (let i = this.active.size - 1; i >= 0; i--) {
      const id = this.active.idAt(i);
      const row = this.set.indexOf(id);
      const state = this.step(row, id, entities);
      this.state[row] = state;
      if (state !== MachineState.Working) {
        this.active.remove(id);
      }
    }
  }

  hashInto(h: number): number {
    const n = this.set.size;
    h = fnv1a32(Uint32Array.of(n, this.active.size), h);
    h = fnv1a32(this.set.dense, h);
    h = fnv1a32(this.active.dense, h);
    for (const c of [
      this.inputItem,
      this.inputCount,
      this.outputItem,
      this.outputCount,
      this.recipe,
      this.progress,
      this.state,
    ]) {
      h = fnv1a32(c.subarray(0, n), h);
    }
    return this.burner.hashInto(h, n);
  }

  /** One tick of the furnace in row `row`; returns its new state. */
  private step(row: number, id: number, entities: Entities): MachineState {
    let r = recipePrototype(this.recipe[row]!);
    let changed = false;
    if (!r) {
      r = smeltingRecipeFor(this.inputItem[row]!);
      const [, need] = r?.inputs[0] ?? [0, 0];
      if (!r || this.inputCount[row]! < need) {
        return MachineState.NoInput;
      }
      if (!this.outputRoom(row, r)) {
        return MachineState.OutputFull;
      }
      if (!this.burn(row, id, entities)) {
        return MachineState.NoFuel;
      }
      this.inputCount[row] = this.inputCount[row]! - need;
      if (this.inputCount[row] === 0) this.inputItem[row] = 0;
      this.recipe[row] = r.id;
      changed = true;
    } else if (!this.burn(row, id, entities)) {
      return MachineState.NoFuel;
    }
    const progress = this.progress[row]! + 1;
    if (progress >= r.ticks) {
      const [item, count] = r.outputs[0]!;
      this.outputItem[row] = item;
      this.outputCount[row] = this.outputCount[row]! + count;
      this.recipe[row] = 0;
      this.progress[row] = 0;
      changed = true;
    } else {
      this.progress[row] = progress;
    }
    if (changed) entities.notify(id);
    return MachineState.Working;
  }

  /** Burns a tick's worth of energy; a fuel unit taken from the slot notifies like any change. */
  private burn(row: number, id: number, entities: Entities): boolean {
    const fuel = this.burner.fuelCount[row]!;
    const ok = this.burner.consume(row, FURNACE_ENERGY_PER_TICK);
    if (this.burner.fuelCount[row] !== fuel) entities.notify(id);
    return ok;
  }

  /** How many units of `item` the input slot can take (0 if `item` isn't smeltable). */
  private inputRoom(row: number, item: number): number {
    if (!smeltingRecipeFor(item)) return 0;
    const slotItem = this.inputItem[row]!;
    if (slotItem !== 0 && slotItem !== item) return 0;
    return itemPrototype(item)!.stackSize - this.inputCount[row]!;
  }

  /** Whether the output slot has room for one result of `r`. */
  private outputRoom(row: number, r: Recipe): boolean {
    const [item, count] = r.outputs[0]!;
    const slotItem = this.outputItem[row]!;
    if (slotItem !== 0 && slotItem !== item) return false;
    const limit = Math.min(FURNACE_OUTPUT_LIMIT, itemPrototype(item)!.stackSize);
    return this.outputCount[row]! + count <= limit;
  }

  private slotsAt(row: number): Slot[] {
    return [
      { item: this.inputItem[row]!, count: this.inputCount[row]! },
      { item: this.burner.fuelItem[row]!, count: this.burner.fuelCount[row]! },
      { item: this.outputItem[row]!, count: this.outputCount[row]! },
    ];
  }

  /** The furnace's slots changed: put it on the active list and tell its subscribers. */
  private changed(id: number, entities: Entities): void {
    if (!this.active.has(id)) this.active.add(id);
    entities.notify(id);
  }

  private row(id: number): number {
    const row = this.set.indexOf(id);
    if (row < 0) {
      throw new RangeError(`no furnace ${String(id)}`);
    }
    return row;
  }
}

/** The furnace table of `entities`, if one is registered. */
export function furnaceTable(entities: Entities): FurnaceTable | undefined {
  const table = entities.table(EntityTypeId.StoneFurnace);
  return table instanceof FurnaceTable ? table : undefined;
}

/**
 * Boilers: a burner (fuel slot and energy buffer, see
 * src/sim/entities/burner.ts), the most it can deliver this tick, what its
 * steam engines drew from it this tick, and its state.
 *
 * A boiler is not electric itself: it feeds the steam engines in front of its
 * output side (steamEngine.ts), which are the producers on the electric
 * network. Each tick, at the start of the power system (`powerPrepare` of the
 * steam engine table):
 * 1. `beginTick` sets every boiler's supply for the tick: the most it can
 *    deliver, `min(maxOutputPerTick, buffer + one unit of the fuel in its
 *    slot)`, and resets what was drawn. With no energy at all it is `NoFuel`,
 *    otherwise `NoDemand` until something is drawn.
 * 2. The engines share the supply out among themselves, and the solver tells
 *    each engine what it delivers; the engine burns exactly that in its
 *    boiler (`burn`), which turns the boiler `Working`.
 * So a boiler burns fuel for exactly the energy its engines deliver (100%
 * efficiency), nothing when nothing is drawn, and never more than its
 * supply: its supply counts at most one fuel unit beyond the buffer, so a
 * tick's draws burn at most that unit.
 *
 * Inserters fuel boilers through the generic item hooks; nothing comes out
 * of a boiler but what the player takes from its fuel slot.
 */

import { ENTITIES, EntityTypeId } from '../../data/entities';
import { fuelValue, type ItemStack } from '../../data/items';
import { BurnerColumns } from '../entities/burner';
import type { Entities } from '../entities/entities';
import { MachineState } from '../entities/machine';
import { SparseSet, growTo } from '../entities/sparseSet';
import type { EntityDetail, EntityTypeTable, Slot } from '../entities/table';
import { fnv1a32 } from '../hash';

/** Slot indices of a boiler, in the order `slots` lists them. */
export const BoilerSlot = {
  Fuel: 0,
} as const;

/** Most joules per tick a boiler delivers to its steam engines. */
export const BOILER_MAX_OUTPUT = ENTITIES[EntityTypeId.Boiler].maxOutputPerTick ?? 0;

export class BoilerTable implements EntityTypeTable {
  readonly type = EntityTypeId.Boiler;
  private readonly set = new SparseSet();
  private readonly burner = new BurnerColumns();
  /** Joules the boiler can deliver this tick (set by `beginTick`). */
  private supplyCol = new Uint32Array(0);
  /** Joules its engines drew from it this tick. */
  private outputCol = new Uint32Array(0);
  private state = new Uint8Array(0);

  /** Number of boilers. */
  get count(): number {
    return this.set.size;
  }

  /** Whether entity `id` is a boiler. */
  has(id: number): boolean {
    return this.set.has(id);
  }

  /** Boiler ids, in row order (a copy). */
  ids(): number[] {
    return Array.from(this.set.dense);
  }

  add(id: number): void {
    const row = this.set.add(id);
    const min = row + 1;
    this.burner.grow(min);
    this.supplyCol = growTo(this.supplyCol, min);
    this.outputCol = growTo(this.outputCol, min);
    this.state = growTo(this.state, min);
    this.state[row] = MachineState.NoFuel;
  }

  remove(id: number): void {
    const row = this.set.remove(id);
    if (row < 0) return;
    const last = this.set.size;
    const columns = [this.supplyCol, this.outputCol, this.state];
    if (row !== last) {
      for (const c of columns) c[row] = c[last]!;
      this.burner.moveRow(last, row);
    }
    for (const c of columns) c[last] = 0;
    this.burner.clearRow(last);
  }

  /** The fuel slot. */
  contents(id: number): readonly ItemStack[] {
    const stack = this.burner.fuelStack(this.row(id));
    return stack ? [stack] : [];
  }

  status(id: number): MachineState {
    return this.state[this.row(id)]! as MachineState;
  }

  detail(id: number): EntityDetail {
    const row = this.row(id);
    return {
      status: this.state[row]! as MachineState,
      recipe: 0,
      progress: 0,
      energy: this.burner.energy[row]!,
      burning: this.burner.burning[row]!,
      power: this.outputCol[row]!,
    };
  }

  slots(id: number): Slot[] {
    const row = this.row(id);
    return [{ item: this.burner.fuelItem[row]!, count: this.burner.fuelCount[row]! }];
  }

  /** Only fuel goes in. */
  accepts(_id: number, item: number): boolean {
    return fuelValue(item) > 0;
  }

  insertable(id: number, item: number): number {
    return this.burner.insertable(this.row(id), item);
  }

  insert(id: number, item: number, count: number, entities: Entities): number {
    const n = this.burner.insert(this.row(id), item, count);
    if (n > 0) entities.notify(id);
    return n;
  }

  take(id: number, slot: number, count: number, entities: Entities): number {
    const n = slot === BoilerSlot.Fuel ? this.burner.take(this.row(id), count) : 0;
    if (n > 0) entities.notify(id);
    return n;
  }

  /** Joules boiler `id` can deliver this tick (0 if it isn't a boiler). */
  supply(id: number): number {
    const row = this.set.indexOf(id);
    return row < 0 ? 0 : this.supplyCol[row]!;
  }

  /** Joules boiler `id`'s engines drew from it this tick (0 if it isn't a boiler). */
  output(id: number): number {
    const row = this.set.indexOf(id);
    return row < 0 ? 0 : this.outputCol[row]!;
  }

  /** Start of the power system: every boiler's supply for this tick, nothing drawn yet. */
  beginTick(): void {
    for (let row = 0; row < this.set.size; row++) {
      const count = this.burner.fuelCount[row]!;
      const next = count > 0 ? fuelValue(this.burner.fuelItem[row]!) : 0;
      const supply = Math.min(BOILER_MAX_OUTPUT, this.burner.energy[row]! + next);
      this.supplyCol[row] = supply;
      this.outputCol[row] = 0;
      this.state[row] = supply > 0 ? MachineState.NoDemand : MachineState.NoFuel;
    }
  }

  /**
   * An engine of boiler `id` delivers `joules` this tick: burn them. The
   * engines never draw more than the boiler's supply in total, so the
   * burner always has the energy.
   */
  burn(id: number, joules: number, entities: Entities): void {
    if (joules <= 0) return;
    const row = this.row(id);
    const output = this.outputCol[row]! + joules;
    if (output > this.supplyCol[row]!) {
      throw new RangeError(`boiler ${String(id)} asked for more than its supply`);
    }
    const fuel = this.burner.fuelCount[row]!;
    this.burner.consume(row, joules);
    this.outputCol[row] = output;
    this.state[row] = MachineState.Working;
    // A unit taken from the fuel slot makes room: wake inserters waiting to refuel it.
    if (this.burner.fuelCount[row] !== fuel) entities.notify(id);
  }

  hashInto(h: number): number {
    const n = this.set.size;
    h = fnv1a32(Uint32Array.of(n), h);
    h = fnv1a32(this.set.dense, h);
    for (const c of [this.supplyCol, this.outputCol, this.state]) {
      h = fnv1a32(c.subarray(0, n), h);
    }
    return this.burner.hashInto(h, n);
  }

  private row(id: number): number {
    const row = this.set.indexOf(id);
    if (row < 0) {
      throw new RangeError(`no boiler ${String(id)}`);
    }
    return row;
  }
}

/** The boiler table of `entities`, if one is registered. */
export function boilerTable(entities: Entities): BoilerTable | undefined {
  const table = entities.table(EntityTypeId.Boiler);
  return table instanceof BoilerTable ? table : undefined;
}

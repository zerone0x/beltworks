/**
 * The burner energy source, a component shared by every fuel-burning entity
 * type (stone furnaces, burner mining drills and burner inserters).
 *
 * A burner has one fuel slot (a stack of a single fuel item) and an energy
 * buffer: the joules left of the fuel unit currently burning. `consume` takes
 * a tick's worth of energy out of the buffer, burning the next unit from the
 * fuel slot when the buffer runs short. Energy is never lost: when there is no
 * fuel left, the remainder stays in the buffer and is used together with the
 * next unit. Everything is integer joules; fuel values come from
 * src/data/items.ts.
 *
 * `BurnerColumns` stores this as struct-of-arrays columns that its owning
 * table keeps row-aligned with its own sparse set (grow on add, `moveRow` and
 * `clearRow` on swap-remove).
 */

import { fuelValue, itemPrototype, type ItemStack, type RealItemId } from '../../data/items';
import { fnv1a32 } from '../hash';
import type { SaveReader, SaveWriter } from '../save/codec';
import { growTo } from './sparseSet';

export class BurnerColumns {
  /** Fuel slot: item id (0 when empty) and units per row. */
  fuelItem = new Uint16Array(0);
  fuelCount = new Uint16Array(0);
  /** Joules left in the buffer per row. */
  energy = new Int32Array(0);
  /** The fuel item whose energy is in the buffer (for showing how much is left), or 0. */
  burning = new Uint16Array(0);

  /** Makes room for at least `rows` rows. New rows are empty. */
  grow(rows: number): void {
    this.fuelItem = growTo(this.fuelItem, rows);
    this.fuelCount = growTo(this.fuelCount, rows);
    this.energy = growTo(this.energy, rows);
    this.burning = growTo(this.burning, rows);
  }

  /** Copies row `from` into row `to` (swap-remove). */
  moveRow(from: number, to: number): void {
    this.fuelItem[to] = this.fuelItem[from]!;
    this.fuelCount[to] = this.fuelCount[from]!;
    this.energy[to] = this.energy[from]!;
    this.burning[to] = this.burning[from]!;
  }

  /** Empties row `row`. */
  clearRow(row: number): void {
    this.fuelItem[row] = 0;
    this.fuelCount[row] = 0;
    this.energy[row] = 0;
    this.burning[row] = 0;
  }

  /**
   * Takes `joules` out of row `row`'s buffer, burning one unit from the fuel
   * slot first if the buffer holds less than that. Returns whether there was
   * enough energy; if not, nothing changes.
   */
  consume(row: number, joules: number): boolean {
    let energy = this.energy[row]!;
    if (energy < joules) {
      const count = this.fuelCount[row]!;
      if (count === 0) {
        return false;
      }
      const item = this.fuelItem[row]!;
      energy += fuelValue(item);
      this.burning[row] = item;
      this.fuelCount[row] = count - 1;
      if (count === 1) this.fuelItem[row] = 0;
      if (energy < joules) {
        // A fuel unit smaller than one tick's demand: not an M1 case, but
        // keep the energy rather than burning it for nothing.
        this.energy[row] = energy;
        return false;
      }
    }
    this.energy[row] = energy - joules;
    return true;
  }

  /** How many units of `item` the fuel slot of row `row` can take now (0 if it isn't fuel). */
  insertable(row: number, item: number): number {
    if (fuelValue(item) === 0) {
      return 0;
    }
    const slotItem = this.fuelItem[row]!;
    if (slotItem !== 0 && slotItem !== item) {
      return 0;
    }
    return itemPrototype(item)!.stackSize - this.fuelCount[row]!;
  }

  /** Adds up to `count` units of `item` to the fuel slot; returns how many went in. */
  insert(row: number, item: number, count: number): number {
    const n = Math.min(count, this.insertable(row, item));
    if (n > 0) {
      this.fuelItem[row] = item;
      this.fuelCount[row] = this.fuelCount[row]! + n;
    }
    return n;
  }

  /** Takes up to `count` units out of the fuel slot; returns how many came out. */
  take(row: number, count: number): number {
    const n = Math.min(count, this.fuelCount[row]!);
    if (n > 0) {
      this.fuelCount[row] = this.fuelCount[row]! - n;
      if (this.fuelCount[row] === 0) this.fuelItem[row] = 0;
    }
    return n;
  }

  /** The fuel slot of row `row` as a stack, or `null` when it is empty. */
  fuelStack(row: number): ItemStack | null {
    const count = this.fuelCount[row]!;
    return count > 0 ? { item: this.fuelItem[row]! as RealItemId, count } : null;
  }

  /** Folds rows `[0, rows)` into a running FNV-1a hash. */
  hashInto(h: number, rows: number): number {
    h = fnv1a32(this.fuelItem.subarray(0, rows), h);
    h = fnv1a32(this.fuelCount.subarray(0, rows), h);
    h = fnv1a32(this.energy.subarray(0, rows), h);
    return fnv1a32(this.burning.subarray(0, rows), h);
  }

  /** Writes rows `[0, rows)` to a save. */
  save(w: SaveWriter, rows: number): void {
    w.column(this.fuelItem, rows);
    w.column(this.fuelCount, rows);
    w.column(this.energy, rows);
    w.column(this.burning, rows);
  }

  /** Reads `rows` rows written by `save`. */
  load(r: SaveReader, rows: number): void {
    this.fuelItem = r.column(this.fuelItem, rows);
    this.fuelCount = r.column(this.fuelCount, rows);
    this.energy = r.column(this.energy, rows);
    this.burning = r.column(this.burning, rows);
  }
}

/**
 * Chests: a fixed number of item slots per chest (16 for the wooden chest, 32
 * for the iron chest, from src/data/entities.ts; one `ChestTable` per chest
 * type, built from its prototype), stored as two flat uint16 columns (item id and count
 * per slot), `slotsPerChest` consecutive slots per row in sparse-set order.
 *
 * Chests have no per-tick behavior. Items go in and out through the item
 * hooks (any slot, like an inventory: existing stacks are topped up first),
 * and every change notifies the chest's subscribers. Removing a chest refunds
 * its contents (removal is refused if they don't fit; see build.ts).
 */

import {
  ENTITIES,
  EntityTypeId,
  type EntityPrototype,
  type RealEntityTypeId,
} from '../../data/entities';
import { itemPrototype, type ItemStack, type RealItemId } from '../../data/items';
import { fnv1a32 } from '../hash';
import { Inventory } from '../inventory';
import { SaveError, type SaveReader, type SaveWriter } from '../save/codec';
import type { Entities } from './entities';
import { SparseSet, growTo } from './sparseSet';
import type { EntityTypeTable, Slot } from './table';

export class ChestTable implements EntityTypeTable {
  readonly type: RealEntityTypeId;
  readonly slotsPerChest: number;
  private readonly proto: EntityPrototype;
  private readonly set = new SparseSet();
  private items = new Uint16Array(0);
  private counts = new Uint16Array(0);

  constructor(proto: EntityPrototype = ENTITIES[EntityTypeId.WoodenChest]) {
    this.proto = proto;
    this.type = proto.id;
    this.slotsPerChest = proto.slots ?? 1;
  }

  /** Number of chests. */
  get count(): number {
    return this.set.size;
  }

  add(id: number): void {
    const row = this.set.add(id);
    const end = (row + 1) * this.slotsPerChest;
    this.items = growTo(this.items, end);
    this.counts = growTo(this.counts, end);
  }

  remove(id: number): void {
    const row = this.set.remove(id);
    if (row < 0) return;
    const S = this.slotsPerChest;
    const last = this.set.size;
    if (row !== last) {
      this.items.copyWithin(row * S, last * S, (last + 1) * S);
      this.counts.copyWithin(row * S, last * S, (last + 1) * S);
    }
    this.items.fill(0, last * S, (last + 1) * S);
    this.counts.fill(0, last * S, (last + 1) * S);
  }

  /**
   * Chest `id`'s slots as an `Inventory` view (valid until the next chest is
   * added or removed).
   */
  inventory(id: number): Inventory {
    const from = this.row(id) * this.slotsPerChest;
    const to = from + this.slotsPerChest;
    return new Inventory(this.items.subarray(from, to), this.counts.subarray(from, to));
  }

  contents(id: number): readonly ItemStack[] {
    const out: ItemStack[] = [];
    for (const slot of this.slots(id)) {
      if (slot.count > 0) out.push({ item: slot.item as RealItemId, count: slot.count });
    }
    return out;
  }

  slots(id: number): Slot[] {
    const inv = this.inventory(id);
    const out: Slot[] = [];
    for (let i = 0; i < inv.slots; i++) {
      out.push({ item: inv.items[i]!, count: inv.counts[i]! });
    }
    return out;
  }

  insertable(id: number, item: number): number {
    return itemPrototype(item) ? this.inventory(id).spaceFor(item) : 0;
  }

  /** Anything goes into a chest. */
  accepts(_id: number, item: number): boolean {
    return itemPrototype(item) !== undefined;
  }

  insert(id: number, item: number, count: number, entities: Entities): number {
    if (!itemPrototype(item)) return 0;
    const n = this.inventory(id).add(item, count);
    if (n > 0) entities.notify(id);
    return n;
  }

  take(id: number, slot: number, count: number, entities: Entities): number {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.slotsPerChest) return 0;
    const i = this.row(id) * this.slotsPerChest + slot;
    const n = Math.min(count, this.counts[i]!);
    if (n > 0) {
      this.counts[i] = this.counts[i]! - n;
      if (this.counts[i] === 0) this.items[i] = 0;
      entities.notify(id);
    }
    return n;
  }

  outputSlot(id: number, accept?: (item: number) => boolean): number {
    const from = this.row(id) * this.slotsPerChest;
    for (let slot = 0; slot < this.slotsPerChest; slot++) {
      const i = from + slot;
      if (this.counts[i]! > 0 && (!accept || accept(this.items[i]!))) return slot;
    }
    return -1;
  }

  hashInto(h: number): number {
    const n = this.set.size * this.slotsPerChest;
    h = fnv1a32(Uint32Array.of(this.set.size, this.slotsPerChest), h);
    h = fnv1a32(this.set.dense, h);
    h = fnv1a32(this.items.subarray(0, n), h);
    return fnv1a32(this.counts.subarray(0, n), h);
  }

  save(w: SaveWriter): void {
    const n = this.set.size * this.slotsPerChest;
    w.u32(this.slotsPerChest);
    w.sparseSet(this.set);
    w.column(this.items, n);
    w.column(this.counts, n);
  }

  load(r: SaveReader): void {
    const slots = r.u32();
    if (slots !== this.slotsPerChest) {
      throw new SaveError(`${this.proto.name}: ${String(slots)} slots per chest in the save`);
    }
    r.sparseSet(this.set);
    const n = this.set.size * this.slotsPerChest;
    this.items = r.column(this.items, n);
    this.counts = r.column(this.counts, n);
  }

  private row(id: number): number {
    const row = this.set.indexOf(id);
    if (row < 0) {
      throw new RangeError(`no ${this.proto.name} ${String(id)}`);
    }
    return row;
  }
}

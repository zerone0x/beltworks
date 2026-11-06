/**
 * All placed entities: the generic store, the occupancy index, the per-type
 * tables, and the wake subscriptions, kept consistent with each other.
 *
 * This class only does bookkeeping; whether a placement is allowed (terrain,
 * reach, collisions, inventory) is decided by the build commands in build.ts
 * before calling `add`.
 */

import { entityPrototype, type EntityPrototype } from '../../data/entities';
import type { ItemStack } from '../../data/items';
import { fnv1a32 } from '../hash';
import type { Direction } from './direction';
import { MachineState } from './machine';
import { Occupancy } from './occupancy';
import { EntityStore, footprintSize } from './store';
import type { EntityDetail, EntityTypeTable, Slot } from './table';
import { WakeSubscriptions } from './wake';

/** The tiles an entity covers: top-left tile and size. */
export interface Footprint {
  x: number;
  y: number;
  w: number;
  h: number;
}

const NO_CONTENTS: readonly ItemStack[] = [];

export class Entities {
  readonly store = new EntityStore();
  readonly occupancy = new Occupancy();
  readonly wake = new WakeSubscriptions();
  /** Registered tables, sorted by type id. */
  private readonly tableList: readonly EntityTypeTable[];
  private readonly byType = new Map<number, EntityTypeTable>();

  constructor(tables: readonly EntityTypeTable[] = []) {
    for (const table of tables) {
      if (this.byType.has(table.type)) {
        throw new RangeError(`two tables registered for entity type ${String(table.type)}`);
      }
      this.byType.set(table.type, table);
    }
    this.tableList = tables.slice().sort((a, b) => a.type - b.type);
    this.wake.onWatch = (target) => {
      this.tableOf(target)?.watched?.(target, this);
    };
  }

  /** Number of entities. */
  get count(): number {
    return this.store.count;
  }

  /** Every registered table, in type id order. */
  get tables(): readonly EntityTypeTable[] {
    return this.tableList;
  }

  /** The table registered for entity type `type`, if any. */
  table(type: number): EntityTypeTable | undefined {
    return this.byType.get(type);
  }

  /** The entity covering tile `(x, y)`, or 0. */
  at(x: number, y: number): number {
    return this.occupancy.at(x, y);
  }

  /** The prototype of entity `id`, or `undefined` if there is no such entity. */
  prototypeOf(id: number): EntityPrototype | undefined {
    return entityPrototype(this.store.type(id));
  }

  /** The tiles entity `id` covers. The entity must exist. */
  footprint(id: number): Footprint {
    const proto = this.prototypeOf(id);
    if (!proto) {
      throw new RangeError(`no entity ${String(id)}`);
    }
    return {
      x: this.store.x(id),
      y: this.store.y(id),
      ...footprintSize(proto, this.store.dir(id)),
    };
  }

  /**
   * Adds an entity of prototype `proto` with its top-left tile at `(x, y)`
   * and returns its id. Its footprint must be free and inside the map.
   */
  add(proto: EntityPrototype, x: number, y: number, dir: Direction): number {
    const { w, h } = footprintSize(proto, dir);
    const id = this.store.add(proto.id, x, y, dir);
    this.occupancy.fill(id, x, y, w, h);
    this.byType.get(proto.id)?.add(id, this);
    for (const table of this.tableList) {
      table.entityPlaced?.(id, this);
    }
    return id;
  }

  /** Items entity `id` holds (refunded on removal), besides its own item. */
  contents(id: number): readonly ItemStack[] {
    return this.byType.get(this.store.type(id))?.contents(id) ?? NO_CONTENTS;
  }

  /**
   * Removes entity `id`, waking whatever waited on it. Returns false if there
   * is no such entity. Refunds are the caller's job (see `contents`).
   */
  remove(id: number): boolean {
    const type = this.store.type(id);
    if (type === 0) {
      return false;
    }
    for (const table of this.tableList) {
      table.entityRemoved?.(id, this);
    }
    this.byType.get(type)?.remove(id, this);
    const { x, y, w, h } = this.footprint(id);
    this.occupancy.clear(id, x, y, w, h);
    this.store.remove(id);
    this.wake.unwatchAll(id);
    for (const watcher of this.wake.forgetTarget(id)) {
      this.wakeOne(watcher);
    }
    return true;
  }

  /**
   * Turns entity `id` to face `dir`. Its footprint must stay valid (it does
   * for square footprints; the caller checks other shapes).
   */
  setDirection(id: number, dir: Direction): void {
    const before = this.footprint(id);
    this.store.setDir(id, dir);
    const after = this.footprint(id);
    if (before.w !== after.w) {
      this.occupancy.clear(id, before.x, before.y, before.w, before.h);
      this.occupancy.fill(id, after.x, after.y, after.w, after.h);
    }
    this.byType.get(this.store.type(id))?.rotated?.(id, this);
    for (const table of this.tableList) {
      table.entityRotated?.(id, this);
    }
  }

  /** The recipe entity `id` is set to, or 0 (types without a recipe hook, missing entities). */
  selectedRecipe(id: number): number {
    return this.tableOf(id)?.selectedRecipe?.(id) ?? 0;
  }

  /** Whether entity `id` can be set to recipe `recipe` (false for types without a recipe hook). */
  allowsRecipe(id: number, recipe: number): boolean {
    return this.tableOf(id)?.allowsRecipe?.(id, recipe) ?? false;
  }

  /**
   * Sets entity `id` to recipe `recipe` (one `allowsRecipe` accepts, or 0)
   * and tells every table (`entityReconfigured`). Its contents are dropped:
   * refunding them is the caller's job (see `contents`).
   */
  setRecipe(id: number, recipe: number): void {
    const table = this.tableOf(id);
    if (!table?.setRecipe) return;
    table.setRecipe(id, recipe, this);
    for (const t of this.tableList) {
      t.entityReconfigured?.(id, this);
    }
  }

  /** Machine state of entity `id` (Idle for types without one and for missing entities). */
  status(id: number): MachineState {
    return this.tableOf(id)?.status?.(id) ?? MachineState.Idle;
  }

  /** GUI details of entity `id`, or `undefined` if its type has none. */
  detail(id: number): EntityDetail | undefined {
    return this.tableOf(id)?.detail?.(id);
  }

  /** Item slots of entity `id`, in slot order; empty for types without slots and missing entities. */
  slots(id: number): Slot[] {
    return this.tableOf(id)?.slots?.(id) ?? [];
  }

  /** How many units of `item` entity `id` would accept right now (see `EntityTypeTable.insertable`). */
  insertable(id: number, item: number): number {
    return this.tableOf(id)?.insertable?.(id, item) ?? 0;
  }

  /** Whether entity `id` takes `item` at all, however full it is (see `EntityTypeTable.accepts`). */
  accepts(id: number, item: number): boolean {
    return this.tableOf(id)?.accepts?.(id, item) ?? false;
  }

  /** Inserts up to `count` units of `item` into entity `id`; returns how many went in. */
  insert(id: number, item: number, count: number): number {
    const table = this.tableOf(id);
    return count > 0 ? (table?.insert?.(id, item, count, this) ?? 0) : 0;
  }

  /** Takes up to `count` units out of slot `slot` of entity `id`; returns how many came out. */
  take(id: number, slot: number, count: number): number {
    const table = this.tableOf(id);
    return count > 0 ? (table?.take?.(id, slot, count, this) ?? 0) : 0;
  }

  /** The slot an inserter would pick up from, or -1 (see `EntityTypeTable.outputSlot`). */
  outputSlot(id: number, accept?: (item: number) => boolean): number {
    return this.tableOf(id)?.outputSlot?.(id, accept) ?? -1;
  }

  /** Entity `target` changed: wakes every entity subscribed to it (see wake.ts). */
  notify(target: number): void {
    for (const watcher of this.wake.watchersOf(target)) {
      this.wakeOne(watcher);
    }
  }

  /** Folds every entity, the occupancy index, the tables and the subscriptions into a hash. */
  hashInto(h: number): number {
    h = this.store.hashInto(h);
    h = this.occupancy.hashInto(h);
    h = fnv1a32(Uint32Array.of(this.tableList.length), h);
    for (const table of this.tableList) {
      h = fnv1a32(Uint32Array.of(table.type), h);
      h = table.hashInto(h);
    }
    return this.wake.hashInto(h);
  }

  private tableOf(id: number): EntityTypeTable | undefined {
    return this.byType.get(this.store.type(id));
  }

  private wakeOne(watcher: number): void {
    this.byType.get(this.store.type(watcher))?.wake?.(watcher, this);
  }
}

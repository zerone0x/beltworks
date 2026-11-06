/**
 * The registration hook for per-type entity tables.
 *
 * Each entity type with state of its own (chest slots, furnace progress, belt
 * lanes, ...) gets a struct-of-arrays table keyed by entity id through a
 * `SparseSet` (src/sim/entities/sparseSet.ts), and registers it in
 * `createEntityTables` (src/sim/entities/registry.ts). `Entities` then calls
 * the hooks below as entities of that type are placed, rotated and removed,
 * and folds the table into the state hash.
 *
 * Systems (drills, belts, inserters, machines in src/sim/tick.ts) walk their
 * table directly; nothing here runs per tick.
 *
 * Types that hold items (chests, furnaces, later drills and inserters) also
 * implement the item hooks, which everything that moves items goes through:
 * the player's GUI commands (`Insert`/`Take`, src/sim/entities/transfer.ts),
 * and later drills dropping their output and inserters picking up and
 * dropping. `Entities` forwards to them (`entities.insert(id, ...)` and so
 * on). A table whose contents change through these hooks (or through its own
 * system) calls `entities.notify(id)`, so subscribers waiting on it wake up.
 */

import type { ItemStack } from '../../data/items';
import type { RealEntityTypeId } from '../../data/entities';
import type { Entities } from './entities';
import type { MachineState } from './machine';

/** One item slot: item id (0 for an empty slot) and units. */
export interface Slot {
  item: number;
  count: number;
}

/** What the entity GUI shows about an entity besides its slots. */
export interface EntityDetail {
  status: MachineState;
  /** Recipe being made (src/data/recipes.ts), or 0. */
  recipe: number;
  /** Ticks done on the current recipe. */
  progress: number;
  /** Joules left in the burner's buffer, and the fuel item they came from (0 for none). */
  energy: number;
  burning: number;
}

export interface EntityTypeTable {
  /** The entity type whose rows this table holds. One table per type. */
  readonly type: RealEntityTypeId;

  /**
   * A new entity of this type was placed: add its row. The entity is already
   * in the generic store and the occupancy index.
   */
  add(id: number, entities: Entities): void;

  /**
   * Items the entity holds. Removing it refunds them together with the
   * entity's own item, and is refused if they don't all fit.
   */
  contents(id: number): readonly ItemStack[];

  /**
   * The entity is about to be removed (it is still in the store and the
   * occupancy index): drop its row. Its contents have already been refunded.
   */
  remove(id: number, entities: Entities): void;

  /** The entity's direction changed (only for rotatable types). */
  rotated?(id: number, entities: Entities): void;

  /**
   * Called on every table, in type id order, after any entity was placed or
   * before any entity is removed, so tables can relink neighbours (belts
   * merging into lines, inserters finding their source and target).
   */
  entityPlaced?(id: number, entities: Entities): void;
  entityRemoved?(id: number, entities: Entities): void;

  /**
   * Entity `id` of this type subscribed to an entity that changed (see
   * src/sim/entities/wake.ts): put it back on the system's active list.
   */
  wake?(id: number, entities: Entities): void;

  /** Folds the table into a running FNV-1a hash, in row order. */
  hashInto(h: number): number;

  /** The entity's machine state (for the renderer and GUI). Idle when absent. */
  status?(id: number): MachineState;

  /** GUI details beyond the slots (status, progress, fuel). */
  detail?(id: number): EntityDetail;

  // Item hooks. Slot indices are fixed per type (e.g. furnace input, fuel,
  // output); `slots` lists them in that order.

  /** The entity's item slots, in slot order (a copy). */
  slots?(id: number): Slot[];

  /**
   * How many units of `item` `insert` would accept right now, routed the way
   * `insert` routes them (a furnace puts ores into its input and fuel into its
   * fuel slot). 0 for items the entity doesn't take, unknown ids included.
   */
  insertable?(id: number, item: number): number;

  /** Inserts up to `count` units of `item`; returns how many went in. */
  insert?(id: number, item: number, count: number, entities: Entities): number;

  /** Takes up to `count` units out of slot `slot`; returns how many came out (item: `slots`). */
  take?(id: number, slot: number, count: number, entities: Entities): number;

  /**
   * The slot an inserter picking up from the entity takes from (a chest's
   * first non-empty slot, a furnace's output), or -1 when there is nothing to
   * pick up.
   */
  outputSlot?(id: number): number;
}

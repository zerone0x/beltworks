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
 */

import type { ItemStack } from '../../data/items';
import type { RealEntityTypeId } from '../../data/entities';
import type { Entities } from './entities';

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
}

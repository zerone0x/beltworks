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
 * Types that hold items (chests, furnaces, drills, belts, inserters) also
 * implement the item hooks, which everything that moves items goes through:
 * the player's GUI commands (`Insert`/`Take`, src/sim/entities/transfer.ts),
 * drills dropping their output, and inserters picking up and dropping.
 * `Entities` forwards to them (`entities.insert(id, ...)` and so on). A table whose contents change through these hooks (or through its own
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
  /** Joules per tick of electric power it delivered on the latest tick (generators, boilers). */
  power?: number;
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
   * rotated or before any entity is removed, so tables can relink neighbours
   * (inserters finding their source and target). The entity's own table gets
   * `add`, `rotated` and `remove` first; belts relink their lines there.
   */
  entityPlaced?(id: number, entities: Entities): void;
  entityRotated?(id: number, entities: Entities): void;
  entityRemoved?(id: number, entities: Entities): void;

  /**
   * Something subscribed to entity `id` of this type (see wake.ts). Belts
   * keep a list of watched belts per line, so a moving lane can notify them.
   */
  watched?(id: number, entities: Entities): void;

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

  /**
   * Whether the entity takes `item` at all, however full it is right now (a
   * chest takes anything, a furnace ores and fuel, a drill fuel). Inserters
   * only pick up items their target accepts, so they never get stuck holding
   * something it will never take.
   */
  accepts?(id: number, item: number): boolean;

  /** Inserts up to `count` units of `item`; returns how many went in. */
  insert?(id: number, item: number, count: number, entities: Entities): number;

  /** Takes up to `count` units out of slot `slot`; returns how many came out (item: `slots`). */
  take?(id: number, slot: number, count: number, entities: Entities): number;

  /**
   * The slot an inserter picking up from the entity takes from (a chest's
   * first non-empty slot, a furnace's output), or -1 when there is nothing to
   * pick up. With `accept`, only slots holding an item it accepts count.
   */
  outputSlot?(id: number, accept?: (item: number) => boolean): number;

  // Power hooks (src/sim/power/). A type implementing `powerDemand` is an
  // electric consumer, one implementing `powerMaxOutput` an electric
  // producer; either way its entities join the network of a pole whose
  // supply area covers them. The power system calls these once per tick per
  // connected entity, before the drills, belts, inserters and machines run.

  /**
   * Called once per tick on every table that has it, in type id order, at
   * the start of the power system: before any `powerDemand`,
   * `powerMaxOutput` or `powerDraw` of the tick. For per-tick setup that
   * spans entities (steam engines sharing out their boilers' supply). The
   * type doesn't have to be electric.
   */
  powerPrepare?(entities: Entities): void;

  /**
   * Joules entity `id` wants this tick at full speed (a non-negative
   * integer; 0 while it sleeps or idles). It then reads its network's
   * satisfaction back (`PowerGrid.satisfaction`) when its own system runs.
   */
  powerDemand?(id: number, entities: Entities): number;

  /** Most joules producer `id` can deliver this tick (a non-negative integer). */
  powerMaxOutput?(id: number, entities: Entities): number;

  /**
   * Producer `id` delivers `joules` this tick (at most its `powerMaxOutput`;
   * 0 when nothing is drawn or it isn't connected): burn fuel for it.
   */
  powerDraw?(id: number, joules: number, entities: Entities): void;
}

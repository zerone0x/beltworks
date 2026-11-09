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
import type { Direction } from './direction';
import type { Entities } from './entities';
import type { MachineState } from './machine';
import type { SaveReader, SaveWriter } from '../save/codec';
import type { SparseSet } from './sparseSet';

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
  /**
   * Joules per tick of power on the latest tick: delivered (generators,
   * boilers) or drawn (electric consumers; filled in by the snapshot from
   * the grid when the table leaves it out).
   */
  power?: number;
  /** Technology of a lab's unit in progress (src/data/technologies.ts), or 0 / absent. */
  technology?: number;
}

export interface EntityTypeTable {
  /**
   * The entity type whose rows this table holds. One table per type, except
   * that a table can hold several types (`types`): it is then registered for
   * each of them and hashed once, at this one (the belt table holds every
   * belt tier, since transport lines run across them).
   */
  readonly type: RealEntityTypeId;
  /** Every type the table holds, `type` among them; just `type` when absent. */
  readonly types?: readonly RealEntityTypeId[];

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
   * The direction a `Rotate` command turns the entity to; a quarter turn
   * clockwise when absent. (Underground belts reverse instead.)
   */
  rotation?(id: number, entities: Entities): Direction;

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
   * Called on every table, in type id order, after entity `id` changed its
   * settings in a way that can change what it accepts (an assembling
   * machine's recipe), so tables can wake entities that feed it (inserters
   * waiting for something their target accepts).
   */
  entityReconfigured?(id: number, entities: Entities): void;

  /**
   * Something subscribed to entity `id` of this type (see wake.ts). Belts
   * keep a list of watched belts per line, so a moving lane can notify them.
   */
  watched?(id: number, entities: Entities): void;

  /**
   * Entity `id` of this type subscribed to an entity that changed (see
   * src/sim/entities/wake.ts): put it back on the system's active list.
   * Nothing more: it must not change subscriptions (`notify` walks the
   * subscriber list without copying it) or step the entity (the belt step
   * relies on waking twice being the same as waking once).
   */
  wake?(id: number, entities: Entities): void;

  /** Folds the table into a running FNV-1a hash, in row order. */
  hashInto(h: number): number;

  /**
   * Writes the table's complete state to a save (its own section, see
   * src/sim/save/save.ts): rows, active list, and anything else that can
   * change what the table does later, hashed or not. Every new piece of
   * state goes here, or is rebuilt from what is saved in `load`; the
   * round-trip tests (tests/sim/save.test.ts) fail otherwise.
   */
  save(w: SaveWriter): void;

  /**
   * Restores what `save` wrote, into this freshly created, empty table. The
   * generic store, the occupancy index and the subscriptions are already
   * loaded; other tables may not be yet.
   */
  load(r: SaveReader, entities: Entities): void;

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
   * When it grows, the table must `notify` (a machine consuming ingredients
   * or fuel), since inserters waiting for room subscribe to the entity.
   */
  insertable?(id: number, item: number): number;

  /**
   * Whether the entity takes `item` at all, however full it is right now (a
   * chest takes anything, a furnace ores and fuel, a drill fuel). Inserters
   * pick up only what their target can take now (`insertable` > 0; a belt
   * target what it `accepts`), and wait on the target too when it uses an
   * item at the source but has no room for it yet.
   */
  accepts?(id: number, item: number): boolean;

  /**
   * Whether `insertable` is above 0 for some item the entity accepts; true
   * when absent. An inserter whose target has no room for anything waits on
   * the target alone (nothing its source offers could help until the target
   * makes room), instead of also being woken by every change at its source.
   */
  hasRoom?(id: number): boolean;

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

  // Recipe hooks, for types whose recipe the player picks (assembling
  // machines; furnaces pick theirs from their input).

  /** The recipe the entity is set to (src/data/recipes.ts), or 0 for none. */
  selectedRecipe?(id: number): number;

  /** Whether the entity can be set to recipe `recipe` (an existing recipe id). */
  allowsRecipe?(id: number, recipe: number): boolean;

  /**
   * Sets the entity to recipe `recipe` (0 for none; one `allowsRecipe`
   * accepts): its slots are resized from the new recipe and start empty, and
   * a craft in progress is dropped. The caller first refunds `contents`.
   */
  setRecipe?(id: number, recipe: number, entities: Entities): void;

  // Power hooks (src/sim/power/). A type implementing `powerDemand` is an
  // electric consumer, one implementing `powerMaxOutput` an electric
  // producer; either way its entities join the network of a pole whose
  // supply area covers them. The power system calls these once per tick per
  // connected entity (consumers with `powerAwake`: per awake entity), before
  // the drills, belts, inserters and machines run.

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

  /**
   * Consumers: the entities whose `powerDemand` may change from one tick to
   * the next (the system's active list). An entity outside it must report
   * the same demand on every tick it stays outside, with no effect, so the
   * power system asks it once after it leaves and then not again until it
   * is back (D62). Without this hook every connected entity is asked every
   * tick.
   */
  powerAwake?(): SparseSet;

  /** Most joules producer `id` can deliver this tick (a non-negative integer). */
  powerMaxOutput?(id: number, entities: Entities): number;

  /**
   * Producer `id` delivers `joules` this tick (at most its `powerMaxOutput`;
   * 0 when nothing is drawn or it isn't connected): burn fuel for it.
   */
  powerDraw?(id: number, joules: number, entities: Entities): void;
}

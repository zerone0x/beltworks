/**
 * Burner mining drills: a burner (fuel slot and energy buffer, see
 * burner.ts), mining progress in ticks, a round-robin cursor over the tiles
 * the drill covers, one held output unit, and the machine state.
 *
 * A drill covers 2×2 tiles and mines the resources under them, one unit
 * every `DRILL_MINING_TICKS` working ticks, from the covered tiles in turn
 * (row-major in world coordinates, starting after the tile mined last and
 * skipping empty ones). Each tick a drill:
 * 1. Holding a unit it couldn't drop yet, tries to drop it again
 *    (`OutputFull` while that fails).
 * 2. Before starting a unit, needs a resource left under it (`Depleted`
 *    otherwise, for good: resources never grow back).
 * 3. Burns `DRILL_ENERGY_PER_TICK` joules (`NoFuel` if the burner has none).
 * 4. Advances; on the last tick of a unit it takes one unit out of the world
 *    (`World.mine`) and drops it.
 * So with fuel and room in front a drill mines exactly one unit every
 * `DRILL_MINING_TICKS` ticks.
 *
 * Output: the unit goes to the drop tile, the tile just in front of the drill
 * (see `drillDropTile`), through the item hooks of whatever entity covers it
 * (`entities.insert`: a chest stores it, a furnace smelts ores and burns
 * coal, another drill burns coal). This is the drill's one output hook: a
 * type that implements `insert` (transport belts, once they exist) takes
 * drill output with no change here. With nothing there, or no room, the drill
 * holds the unit and stops (`OutputFull`). Mined coal never goes into the
 * drill's own fuel slot: drills are fuelled through the GUI or by inserters.
 *
 * Machine sleep: only drills on the active list are stepped. One that ends a
 * tick in any state but `Working` leaves the list. It goes back on it when
 * - its own slots change (fuel inserted, the held unit taken),
 * - the entity on its drop tile changes or goes away (an `OutputFull` drill
 *   subscribes to it, see wake.ts; the subscription ends once a unit drops),
 * - an entity is placed on its drop tile (`entityPlaced`),
 * - it is rotated (its drop tile moves).
 */

import { ENTITIES, EntityTypeId } from '../../data/entities';
import { minedItem, type ItemStack, type RealItemId } from '../../data/items';
import { fnv1a32 } from '../hash';
import type { World } from '../world/world';
import { BurnerColumns } from './burner';
import { DIRECTION_DX, DIRECTION_DY, Direction } from './direction';
import type { Entities } from './entities';
import { MachineState } from './machine';
import { SparseSet, growTo } from './sparseSet';
import type { EntityDetail, EntityTypeTable, Slot } from './table';

/** Slot indices of a drill, in the order `slots` lists them. */
export const DrillSlot = {
  Fuel: 0,
  /** The mined unit waiting to be dropped (at most one). */
  Output: 1,
} as const;

const DRILL = ENTITIES[EntityTypeId.BurnerMiningDrill];
/** Joules a drill burns per working tick. */
export const DRILL_ENERGY_PER_TICK = DRILL.energyPerTick ?? 0;
/** Working ticks per mined unit. */
export const DRILL_MINING_TICKS = DRILL.miningTicks ?? 1;
/** Tiles a drill covers (its footprint is square, so rotation doesn't change it). */
const DRILL_TILES = DRILL.width * DRILL.height;

/**
 * The tile a drill with its top-left tile at `(x, y)` facing `dir` drops its
 * output onto: just outside the front edge, on the left half as seen from the
 * drill (north: `(x, y - 1)`, east: `(x + 2, y)`, south: `(x + 1, y + 2)`,
 * west: `(x - 1, y + 1)`), so it is the same tile relative to the drill
 * whichever way it faces.
 */
export function drillDropTile(x: number, y: number, dir: Direction): { x: number; y: number } {
  const w = DRILL.width;
  const h = DRILL.height;
  switch (dir) {
    case Direction.East:
      return { x: x + w, y };
    case Direction.South:
      return { x: x + w - 1, y: y + h };
    case Direction.West:
      return { x: x - 1, y: y + h - 1 };
    default:
      return { x, y: y - 1 };
  }
}

export class DrillTable implements EntityTypeTable {
  readonly type = EntityTypeId.BurnerMiningDrill;
  private readonly set = new SparseSet();
  /** Drills stepped by `update`: every one whose state may change on its own. */
  private readonly active = new SparseSet();
  /** Working ticks done on the unit being mined. */
  private progress = new Uint16Array(0);
  /** Index (row-major in the footprint) of the covered tile to try first for the next unit. */
  private cursor = new Uint8Array(0);
  /** The mined unit waiting to be dropped, or 0. */
  private held = new Uint16Array(0);
  private state = new Uint8Array(0);
  private readonly burner = new BurnerColumns();

  /** Number of drills. */
  get count(): number {
    return this.set.size;
  }

  /** Number of drills on the active list. */
  get activeCount(): number {
    return this.active.size;
  }

  /** New drills start on the active list; their first step finds their state. */
  add(id: number): void {
    const row = this.set.add(id);
    const min = row + 1;
    this.progress = growTo(this.progress, min);
    this.cursor = growTo(this.cursor, min);
    this.held = growTo(this.held, min);
    this.state = growTo(this.state, min);
    this.burner.grow(min);
    this.state[row] = MachineState.NoFuel;
    this.active.add(id);
  }

  remove(id: number): void {
    const row = this.set.remove(id);
    if (row < 0) return;
    this.active.remove(id);
    const last = this.set.size;
    const columns = [this.progress, this.cursor, this.held, this.state];
    if (row !== last) {
      for (const c of columns) c[row] = c[last]!;
      this.burner.moveRow(last, row);
    }
    for (const c of columns) c[last] = 0;
    this.burner.clearRow(last);
  }

  /** The fuel slot and the held unit. */
  contents(id: number): readonly ItemStack[] {
    const out: ItemStack[] = [];
    for (const slot of this.slots(id)) {
      if (slot.count > 0) out.push({ item: slot.item as RealItemId, count: slot.count });
    }
    return out;
  }

  /** The drop tile moved: try again from there. */
  rotated(id: number, entities: Entities): void {
    entities.wake.unwatchAll(id);
    this.activate(id);
  }

  /** Wakes the drills whose drop tile the new entity covers. */
  entityPlaced(placed: number, entities: Entities): void {
    if (this.set.size === 0) return;
    const { x, y, w, h } = entities.footprint(placed);
    for (let ty = y; ty < y + h; ty++) {
      for (let tx = x; tx < x + w; tx++) {
        // A drill dropping onto (tx, ty) covers one of its four neighbours.
        for (let d = 0; d < 4; d++) {
          const drill = entities.at(tx + DIRECTION_DX[d]!, ty + DIRECTION_DY[d]!);
          if (drill === placed || !this.set.has(drill)) continue;
          const drop = this.dropTile(drill, entities);
          if (drop.x === tx && drop.y === ty) this.activate(drill);
        }
      }
    }
  }

  /** The entity on the drop tile changed (or went away): try to drop again. */
  wake(id: number): void {
    this.activate(id);
  }

  status(id: number): MachineState {
    return this.state[this.row(id)]! as MachineState;
  }

  detail(id: number): EntityDetail {
    const row = this.row(id);
    return {
      status: this.state[row]! as MachineState,
      recipe: 0,
      progress: this.progress[row]!,
      energy: this.burner.energy[row]!,
      burning: this.burner.burning[row]!,
    };
  }

  slots(id: number): Slot[] {
    const row = this.row(id);
    const held = this.held[row]!;
    return [
      { item: this.burner.fuelItem[row]!, count: this.burner.fuelCount[row]! },
      { item: held, count: held !== 0 ? 1 : 0 },
    ];
  }

  /** Only fuel goes in. */
  insertable(id: number, item: number): number {
    return this.burner.insertable(this.row(id), item);
  }

  insert(id: number, item: number, count: number, entities: Entities): number {
    const n = this.burner.insert(this.row(id), item, count);
    if (n > 0) this.changed(id, entities);
    return n;
  }

  take(id: number, slot: number, count: number, entities: Entities): number {
    const row = this.row(id);
    let n = 0;
    if (slot === DrillSlot.Fuel) {
      n = this.burner.take(row, count);
    } else if (slot === DrillSlot.Output && this.held[row] !== 0) {
      this.held[row] = 0;
      n = 1;
    }
    if (n > 0) this.changed(id, entities);
    return n;
  }

  outputSlot(id: number): number {
    return this.held[this.row(id)] !== 0 ? DrillSlot.Output : -1;
  }

  /** The drill system: steps every active drill by one tick. */
  update(entities: Entities, world: World): void {
    // Backwards, so a drill leaving the list only moves one already stepped
    // (drills woken during the loop join at the end and wait for the next tick).
    for (let i = this.active.size - 1; i >= 0; i--) {
      const id = this.active.idAt(i);
      const row = this.set.indexOf(id);
      const state = this.step(row, id, entities, world);
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
    for (const c of [this.progress, this.cursor, this.held, this.state]) {
      h = fnv1a32(c.subarray(0, n), h);
    }
    return this.burner.hashInto(h, n);
  }

  /** The drop tile of drill `id` (see {@link drillDropTile}). */
  dropTile(id: number, entities: Entities): { x: number; y: number } {
    const { store } = entities;
    return drillDropTile(store.x(id), store.y(id), store.dir(id));
  }

  /** One tick of the drill in row `row`; returns its new state. */
  private step(row: number, id: number, entities: Entities, world: World): MachineState {
    if (this.held[row] !== 0) {
      if (!this.dropHeld(row, id, entities)) {
        return MachineState.OutputFull;
      }
      entities.notify(id);
    }
    if (this.progress[row] === 0 && this.nextTile(row, id, entities, world) < 0) {
      return MachineState.Depleted;
    }
    const fuel = this.burner.fuelCount[row]!;
    const burnt = this.burner.consume(row, DRILL_ENERGY_PER_TICK);
    // A fuel unit taken from the slot is a change like any other.
    if (this.burner.fuelCount[row] !== fuel) entities.notify(id);
    if (!burnt) {
      return MachineState.NoFuel;
    }
    const progress = this.progress[row]! + 1;
    if (progress < DRILL_MINING_TICKS) {
      this.progress[row] = progress;
      return MachineState.Working;
    }
    this.progress[row] = 0;
    // Someone (a player, hand-mining) may have emptied the tiles meanwhile.
    const tile = this.nextTile(row, id, entities, world);
    if (tile < 0) {
      return MachineState.Depleted;
    }
    const { x, y } = this.tileAt(id, entities, tile);
    const item = minedItem(world.resourceAt(x, y));
    world.mine(x, y, 1);
    this.cursor[row] = (tile + 1) % DRILL_TILES;
    this.held[row] = item ?? 0;
    if (this.dropHeld(row, id, entities)) {
      return MachineState.Working;
    }
    // The unit stays in the output slot, where an inserter could pick it up.
    entities.notify(id);
    return MachineState.OutputFull;
  }

  /**
   * The drill's output hook: drops the held unit into the entity on the drop
   * tile through its `insert` hook. On failure, subscribes to that entity so
   * the drill wakes when it changes. Returns whether the unit went in.
   */
  private dropHeld(row: number, id: number, entities: Entities): boolean {
    const { x, y } = this.dropTile(id, entities);
    const target = entities.at(x, y);
    if (target !== 0 && entities.insert(target, this.held[row]!, 1) === 1) {
      this.held[row] = 0;
      entities.wake.unwatchAll(id);
      return true;
    }
    if (target !== 0) entities.wake.watch(id, target);
    return false;
  }

  /**
   * Index of the covered tile the next unit comes from: the first one from
   * the cursor on, in row-major order, that still has a resource the drill
   * can mine; -1 if there is none.
   */
  private nextTile(row: number, id: number, entities: Entities, world: World): number {
    const start = this.cursor[row]!;
    for (let k = 0; k < DRILL_TILES; k++) {
      const tile = (start + k) % DRILL_TILES;
      const { x, y } = this.tileAt(id, entities, tile);
      if (world.amountAt(x, y) > 0 && minedItem(world.resourceAt(x, y)) !== undefined) {
        return tile;
      }
    }
    return -1;
  }

  /** World coordinates of covered tile `tile` (row-major index in the footprint). */
  private tileAt(id: number, entities: Entities, tile: number): { x: number; y: number } {
    const { store } = entities;
    return {
      x: store.x(id) + (tile % DRILL.width),
      y: store.y(id) + Math.floor(tile / DRILL.width),
    };
  }

  /** The drill's slots changed: put it on the active list and tell its subscribers. */
  private changed(id: number, entities: Entities): void {
    this.activate(id);
    entities.notify(id);
  }

  private activate(id: number): void {
    if (!this.active.has(id)) this.active.add(id);
  }

  private row(id: number): number {
    const row = this.set.indexOf(id);
    if (row < 0) {
      throw new RangeError(`no drill ${String(id)}`);
    }
    return row;
  }
}

/** The drill table of `entities`, if one is registered. */
export function drillTable(entities: Entities): DrillTable | undefined {
  const table = entities.table(EntityTypeId.BurnerMiningDrill);
  return table instanceof DrillTable ? table : undefined;
}

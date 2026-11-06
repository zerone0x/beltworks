/**
 * Burner inserters: a burner (fuel slot and energy buffer, see burner.ts), the
 * item in the hand, the arm position in ticks, and the state. The state
 * machine is drawn in docs/ARCHITECTURE.md ("Burner inserter").
 *
 * An inserter is 1×1. It faces the way it drops: it picks up from the tile
 * behind it (`inserterPickupTile`) and drops onto the tile in front of it
 * (`inserterDropTile`), through whatever entity covers those tiles, looked
 * up again on every pickup and drop, so no link can go stale when
 * neighbours are placed, rotated or removed:
 * - picking up: a chest's first slot holding something the target accepts,
 *   a furnace's output, a drill's held unit (the `outputSlot` hook), or the
 *   item closest to the end of the belt's left lane, else its right lane,
 *   within the belt's own tile (`BeltTable.takeAt` from `beltOffset` to
 *   `beltEnd`, which for the belt at a line's start includes items at or
 *   past its start edge);
 * - dropping: the target's `insert` hook (a chest stores it, a furnace puts
 *   ores into its input and fuel into its fuel slot when the input doesn't
 *   take it, a drill or inserter only takes fuel), or the middle of the
 *   belt's far lane (`BeltTable.insertAt`, see `farLane`).
 * Only items the target accepts at all (`accepts` hook) are picked up, so an
 * inserter never holds something its target will never take.
 *
 * Timing: the arm swings `INSERTER_SWING_TICKS` (36) ticks from the pickup
 * tile to the drop tile and as many back, so with a source and a target that
 * are always ready an inserter moves one item every `INSERTER_CYCLE_TICKS`
 * (72) ticks: it picks up on the tick it is back at the pickup end (tick
 * 0), drops 36 ticks later, and picks up again on tick 72. Each tick:
 * 1. At the pickup end with an empty hand: refuel (below), then without
 *    energy for a swing `NoFuel`; with no entity on the drop tile
 *    `WaitingForTarget`; with nothing to pick up `WaitingForSource`;
 *    otherwise it takes one unit into its hand.
 * 2. At the drop end holding an item: drops it, or `WaitingForTarget`.
 * 3. It burns `INSERTER_ENERGY_PER_TICK` joules (`NoFuel` if the burner has
 *    none left) and moves the arm one tick towards the drop end while it
 *    holds something, back towards the pickup end otherwise (`Swinging`).
 * Energy is only used while the arm moves: 72 × 1 667 J per item.
 *
 * Refuelling: at the pickup end, an inserter whose fuel slot is empty takes
 * one unit of fuel from its source into its own fuel slot first (whatever
 * its target is), then picks up for its target as usual. This needs no
 * energy (the hand is already at the source), so an inserter taking from a
 * source with coal starts on its own. An inserter that runs dry mid-swing
 * stops where it is until it gets fuel.
 *
 * Machine sleep: only inserters on the active list are stepped. One that
 * ends a tick in any state but `Swinging` leaves the list, subscribed to the
 * one entity it waits on (wake.ts): its source while `WaitingForSource` (and
 * while `NoFuel` at the pickup end, to refuel from it), its target while it
 * holds an item the target won't take yet. It goes back on the list when
 * - its own slots change (fuel inserted, the hand emptied),
 * - the entity it waits on changes or goes away (for a belt: when items
 *   change near its tile, see "Notifications" in src/sim/belts/belts.ts),
 * - an entity is placed or rotated on its pickup or drop tile
 *   (`entityPlaced`, `entityRotated`; a belt's far lane depends on its
 *   direction),
 * - it is rotated itself.
 * Waiting costs nothing per tick.
 */

import { ENTITIES, EntityTypeId } from '../../data/entities';
import { fuelValue, type ItemStack, type RealItemId } from '../../data/items';
import { beltTable } from '../belts/belts';
import { BELT_LENGTH, BeltLane } from '../belts/line';
import { fnv1a32 } from '../hash';
import { BurnerColumns } from './burner';
import { DIRECTION_DX, DIRECTION_DY, type Direction } from './direction';
import type { Entities } from './entities';
import { MachineState } from './machine';
import { SparseSet, growTo } from './sparseSet';
import type { EntityDetail, EntityTypeTable, Slot } from './table';

/** Slot indices of an inserter, in the order `slots` lists them. */
export const InserterSlot = {
  Fuel: 0,
  /** The item in the hand (at most one). */
  Hand: 1,
} as const;

/**
 * The inserter states of the state machine, as stored (they are
 * `MachineState` values, so the renderer and GUI need nothing special).
 */
export const InserterState = {
  WaitingForSource: MachineState.WaitingForSource,
  WaitingForTarget: MachineState.WaitingForTarget,
  Swinging: MachineState.Working,
  NoFuel: MachineState.NoFuel,
} as const;

export type InserterState = (typeof InserterState)[keyof typeof InserterState];

const INSERTER = ENTITIES[EntityTypeId.BurnerInserter];
/** Joules an inserter burns per tick its arm moves. */
export const INSERTER_ENERGY_PER_TICK = INSERTER.energyPerTick ?? 0;
/** Ticks from the pickup end to the drop end (and back). */
export const INSERTER_SWING_TICKS = INSERTER.swingTicks ?? 1;
/** Ticks of one pickup → drop → return cycle. */
export const INSERTER_CYCLE_TICKS = 2 * INSERTER_SWING_TICKS;

/** The tile an inserter on `(x, y)` facing `dir` picks up from: the one behind it. */
export function inserterPickupTile(x: number, y: number, dir: Direction): { x: number; y: number } {
  return { x: x - DIRECTION_DX[dir]!, y: y - DIRECTION_DY[dir]! };
}

/** The tile an inserter on `(x, y)` facing `dir` drops onto: the one in front of it. */
export function inserterDropTile(x: number, y: number, dir: Direction): { x: number; y: number } {
  return { x: x + DIRECTION_DX[dir]!, y: y + DIRECTION_DY[dir]! };
}

/**
 * The lane an inserter facing `dir` drops onto a belt facing `beltDir`: the
 * far one, as seen from the inserter. An inserter in line with the belt
 * (behind or in front of it) uses the right lane.
 */
export function farLane(dir: Direction, beltDir: Direction): BeltLane {
  // Dropping towards the belt's left side means reaching across to its left lane.
  return dir === ((beltDir + 3) & 3) ? BeltLane.Left : BeltLane.Right;
}

const isFuel = (item: number): boolean => fuelValue(item) > 0;

export class InserterTable implements EntityTypeTable {
  readonly type = EntityTypeId.BurnerInserter;
  private readonly set = new SparseSet();
  /** Inserters stepped by `update`: every one whose state may change on its own. */
  private readonly active = new SparseSet();
  /** The item in the hand, or 0. */
  private held = new Uint16Array(0);
  /** Arm position: ticks from the pickup end (0) towards the drop end (`INSERTER_SWING_TICKS`). */
  private arm = new Uint8Array(0);
  private state = new Uint8Array(0);
  private readonly burner = new BurnerColumns();

  /** Number of inserters. */
  get count(): number {
    return this.set.size;
  }

  /** Number of inserters on the active list. */
  get activeCount(): number {
    return this.active.size;
  }

  /** New inserters start at the pickup end, on the active list; their first step finds their state. */
  add(id: number): void {
    const row = this.set.add(id);
    const min = row + 1;
    this.held = growTo(this.held, min);
    this.arm = growTo(this.arm, min);
    this.state = growTo(this.state, min);
    this.burner.grow(min);
    this.state[row] = InserterState.NoFuel;
    this.active.add(id);
  }

  remove(id: number): void {
    const row = this.set.remove(id);
    if (row < 0) return;
    this.active.remove(id);
    const last = this.set.size;
    const columns = [this.held, this.arm, this.state];
    if (row !== last) {
      for (const c of columns) c[row] = c[last]!;
      this.burner.moveRow(last, row);
    }
    for (const c of columns) c[last] = 0;
    this.burner.clearRow(last);
  }

  /** The fuel slot and the item in the hand. */
  contents(id: number): readonly ItemStack[] {
    const out: ItemStack[] = [];
    for (const slot of this.slots(id)) {
      if (slot.count > 0) out.push({ item: slot.item as RealItemId, count: slot.count });
    }
    return out;
  }

  /** Pickup and drop tiles moved: look again from there. The arm and the hand stay as they are. */
  rotated(id: number, entities: Entities): void {
    entities.wake.unwatchAll(id);
    this.activate(id);
  }

  /** Wakes the inserters picking up from or dropping onto a tile the new entity covers. */
  entityPlaced(placed: number, entities: Entities): void {
    this.wakeAround(placed, entities);
  }

  /** A rotated belt has its lanes the other way round, and may be on another line. */
  entityRotated(rotated: number, entities: Entities): void {
    this.wakeAround(rotated, entities);
  }

  /** The entity waited on changed (or went away): look again. */
  wake(id: number): void {
    this.activate(id);
  }

  status(id: number): MachineState {
    return this.state[this.row(id)]! as MachineState;
  }

  /** `progress` is the arm position, in ticks from the pickup end. */
  detail(id: number): EntityDetail {
    const row = this.row(id);
    return {
      status: this.state[row]! as MachineState,
      recipe: 0,
      progress: this.arm[row]!,
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

  /** The item in the hand (0 for none) and the arm position, for snapshots. */
  hand(id: number): { held: number; arm: number } {
    const row = this.row(id);
    return { held: this.held[row]!, arm: this.arm[row]! };
  }

  /** Only fuel goes in (into the fuel slot; the hand is filled by picking up). */
  accepts(_id: number, item: number): boolean {
    return isFuel(item);
  }

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
    if (slot === InserterSlot.Fuel) {
      n = this.burner.take(row, count);
    } else if (slot === InserterSlot.Hand && this.held[row] !== 0) {
      this.held[row] = 0;
      n = 1;
      // No longer waiting on a target: the arm goes back for another item.
      entities.wake.unwatchAll(id);
    }
    if (n > 0) this.changed(id, entities);
    return n;
  }

  /** The inserter system: steps every active inserter by one tick. */
  update(entities: Entities): void {
    // Backwards, so an inserter leaving the list only moves one already stepped
    // (inserters woken during the loop join at the end and wait for the next tick).
    for (let i = this.active.size - 1; i >= 0; i--) {
      const id = this.active.idAt(i);
      const row = this.set.indexOf(id);
      const state = this.step(row, id, entities);
      this.state[row] = state;
      if (state !== InserterState.Swinging) {
        this.active.remove(id);
      }
    }
  }

  hashInto(h: number): number {
    const n = this.set.size;
    h = fnv1a32(Uint32Array.of(n, this.active.size), h);
    h = fnv1a32(this.set.dense, h);
    h = fnv1a32(this.active.dense, h);
    for (const c of [this.held, this.arm, this.state]) {
      h = fnv1a32(c.subarray(0, n), h);
    }
    return this.burner.hashInto(h, n);
  }

  /** One tick of the inserter in row `row`; returns its new state. */
  private step(row: number, id: number, entities: Entities): InserterState {
    const arm = this.arm[row]!;
    if (this.held[row] === 0 && arm === 0) {
      const state = this.pickUp(row, id, entities);
      if (state !== InserterState.Swinging) return state;
    } else if (this.held[row] !== 0 && arm === INSERTER_SWING_TICKS) {
      if (!this.drop(row, id, entities)) return InserterState.WaitingForTarget;
    }
    const fuel = this.burner.fuelCount[row]!;
    const burnt = this.burner.consume(row, INSERTER_ENERGY_PER_TICK);
    // A fuel unit taken from the slot is a change like any other.
    if (this.burner.fuelCount[row] !== fuel) entities.notify(id);
    if (!burnt) return InserterState.NoFuel;
    this.arm[row] = this.held[row] !== 0 ? arm + 1 : arm - 1;
    return InserterState.Swinging;
  }

  /**
   * At the pickup end with an empty hand: refuels, then takes one unit for
   * the target. Returns `Swinging` once the hand holds it, else the state
   * to wait in (subscribed to what it waits on).
   */
  private pickUp(row: number, id: number, entities: Entities): InserterState {
    const { store } = entities;
    const dir = store.dir(id);
    const from = inserterPickupTile(store.x(id), store.y(id), dir);
    const to = inserterDropTile(store.x(id), store.y(id), dir);
    const source = entities.at(from.x, from.y);
    const target = entities.at(to.x, to.y);
    if (source !== 0 && this.burner.fuelCount[row] === 0) {
      const fuel = this.takeFrom(source, isFuel, entities);
      if (fuel !== 0) {
        this.burner.insert(row, fuel, 1);
        entities.notify(id);
      }
    }
    const canMove =
      this.burner.energy[row]! >= INSERTER_ENERGY_PER_TICK || this.burner.fuelCount[row]! > 0;
    if (!canMove) {
      this.waitOn(id, source, entities);
      return InserterState.NoFuel;
    }
    if (target === 0) {
      this.waitOn(id, 0, entities);
      return InserterState.WaitingForTarget;
    }
    const item =
      source !== 0 ? this.takeFrom(source, (it) => entities.accepts(target, it), entities) : 0;
    if (item === 0) {
      this.waitOn(id, source, entities);
      return InserterState.WaitingForSource;
    }
    this.held[row] = item;
    entities.wake.unwatchAll(id);
    entities.notify(id);
    return InserterState.Swinging;
  }

  /**
   * At the drop end: puts the held item into the entity on the drop tile.
   * On failure, subscribes to that entity. Returns whether it went in.
   */
  private drop(row: number, id: number, entities: Entities): boolean {
    const { store } = entities;
    const dir = store.dir(id);
    const to = inserterDropTile(store.x(id), store.y(id), dir);
    const target = entities.at(to.x, to.y);
    const item = this.held[row]!;
    let ok = false;
    const belts = beltTable(entities);
    if (target !== 0 && belts && store.type(target) === EntityTypeId.TransportBelt) {
      const lane = farLane(dir, store.dir(target));
      const pos = belts.beltOffset(target) + BELT_LENGTH / 2;
      ok = belts.insertAt(belts.beltLine(target), lane, pos, item);
    } else if (target !== 0) {
      ok = entities.insert(target, item, 1) === 1;
    }
    if (!ok) {
      this.waitOn(id, target, entities);
      return false;
    }
    this.held[row] = 0;
    entities.wake.unwatchAll(id);
    entities.notify(id);
    return true;
  }

  /**
   * Takes one unit `accept` accepts out of entity `source`; returns its item
   * id, or 0 if there is none. Belts: the item closest to the end of the
   * left lane, else of the right lane, on the belt's own tile (see
   * `BeltTable.beltEnd`).
   */
  private takeFrom(source: number, accept: (item: number) => boolean, entities: Entities): number {
    const belts = beltTable(entities);
    if (belts && entities.store.type(source) === EntityTypeId.TransportBelt) {
      const line = belts.beltLine(source);
      const from = belts.beltOffset(source);
      const to = belts.beltEnd(source);
      for (let lane = 0; lane < 2; lane++) {
        const item = belts.peekAt(line, lane, from, to);
        if (item !== 0 && accept(item)) return belts.takeAt(line, lane, from, to);
      }
      return 0;
    }
    const slot = entities.outputSlot(source, accept);
    if (slot < 0) return 0;
    const item = entities.slots(source)[slot]!.item;
    return entities.take(source, slot, 1) === 1 ? item : 0;
  }

  /** Subscribes inserter `id` to `target` alone (none for 0), unless it already is. */
  private waitOn(id: number, target: number, entities: Entities): void {
    const { wake } = entities;
    if (target !== 0 && wake.watchesOnly(id, target)) return;
    wake.unwatchAll(id);
    if (target !== 0) wake.watch(id, target);
  }

  /** Wakes the inserters whose pickup or drop tile entity `id` covers. */
  private wakeAround(id: number, entities: Entities): void {
    if (this.set.size === 0) return;
    const { store } = entities;
    const { x, y, w, h } = entities.footprint(id);
    for (let ty = y; ty < y + h; ty++) {
      for (let tx = x; tx < x + w; tx++) {
        // An inserter reaching (tx, ty) stands on one of its four neighbours.
        for (let d = 0; d < 4; d++) {
          const nx = tx + DIRECTION_DX[d]!;
          const ny = ty + DIRECTION_DY[d]!;
          const ins = entities.at(nx, ny);
          if (ins === id || !this.set.has(ins)) continue;
          const dir = store.dir(ins);
          const from = inserterPickupTile(nx, ny, dir);
          const to = inserterDropTile(nx, ny, dir);
          if ((from.x === tx && from.y === ty) || (to.x === tx && to.y === ty)) this.activate(ins);
        }
      }
    }
  }

  /** The inserter's slots changed: put it on the active list and tell its subscribers. */
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
      throw new RangeError(`no inserter ${String(id)}`);
    }
    return row;
  }
}

/** The inserter table of `entities`, if one is registered. */
export function inserterTable(entities: Entities): InserterTable | undefined {
  const table = entities.table(EntityTypeId.BurnerInserter);
  return table instanceof InserterTable ? table : undefined;
}

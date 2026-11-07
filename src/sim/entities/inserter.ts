/**
 * Inserters. `InserterTableBase` holds everything every inserter type
 * shares: the item in the hand, the arm position, the state, the active
 * list, and the pickup, drop and wake logic, with the timing (`swingTicks`)
 * and reach (`reach`) taken from the type's prototype. Each kind adds its
 * energy source: the burner inserter (`InserterTable`, below) a burner (fuel
 * slot and energy buffer, see burner.ts), the electric, fast and long-handed
 * inserters (`ElectricInserterTable`, electricInserter.ts) their electric
 * network. The
 * state machine is drawn in docs/ARCHITECTURE.md ("Burner inserter"); the
 * rest of this comment describes the burner inserter, and the electric one
 * differs only where electricInserter.ts says so.
 *
 * An inserter is 1×1. It faces the way it drops: it picks up from the tile
 * behind it (`inserterPickupTile`) and drops onto the tile in front of it
 * (`inserterDropTile`); a long-handed inserter (reach 2) skips the
 * neighbouring tiles and uses the ones 2 tiles behind and in front of it,
 * whatever stands in between. It reaches them through whatever entity
 * covers those tiles, looked
 * up again on every pickup and drop, so no link can go stale when
 * neighbours are placed, rotated or removed:
 * - picking up: a chest's first slot holding something the target accepts,
 *   a furnace's output, a drill's held unit (the `outputSlot` hook), or the
 *   item closest to the end of the belt's left lane, else its right lane,
 *   within the belt's own tile (`BeltTable.takeAt` from `beltOffset` to
 *   `beltEnd`, which for the belt at a line's start includes items at or
 *   past its start edge; on a splitter, the half on that tile);
 * - dropping: the target's `insert` hook (a chest stores it, a furnace puts
 *   ores into its input and fuel into its fuel slot when the input doesn't
 *   take it, a drill or inserter only takes fuel), or the middle of the
 *   belt's far lane (`BeltTable.insertAt`, see `farLane`; on a splitter, of
 *   the half on that tile).
 * Only items the target accepts at all (`accepts` hook) are picked up, so an
 * inserter never holds something its target will never take; for an
 * assembling machine or a lab only those it has room for right now (`wants`
 * hook, D45), so one fed several ingredients from one source doesn't hold
 * one it can't take while another runs out.
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
 * holds an item the target won't take yet. While `WaitingForSource` on a
 * source holding something its target takes but has no room for yet, it
 * subscribes to the target as well (D45). It goes back on the list when
 * - its own slots change (fuel inserted, the hand emptied),
 * - the entity it waits on changes or goes away (for a belt: when items
 *   change near its tile, see "Notifications" in src/sim/belts/belts.ts),
 * - an entity is placed or rotated on its pickup or drop tile
 *   (`entityPlaced`, `entityRotated`; a belt's far lane depends on its
 *   direction), or one there changes its recipe (`entityReconfigured`: an
 *   assembling machine then accepts other items),
 * - it is rotated itself.
 * Waiting costs nothing per tick.
 */

import {
  ENTITIES,
  EntityTypeId,
  inserterReach,
  isBeltType,
  type EntityPrototype,
  type RealEntityTypeId,
} from '../../data/entities';
import { fuelValue, type ItemStack, type RealItemId } from '../../data/items';
import { beltTable } from '../belts/belts';
import { BELT_LENGTH, BeltLane } from '../belts/line';
import { fnv1a32 } from '../hash';
import { NOT_GRANTED } from '../power/consumer';
import { BurnerColumns } from './burner';
import { DIRECTION_DX, DIRECTION_DY, type Direction } from './direction';
import type { Entities } from './entities';
import { MachineState } from './machine';
import { SparseSet, growTo } from './sparseSet';
import type { EntityDetail, EntityTypeTable, Slot } from './table';

/** Slot indices of a burner inserter, in the order `slots` lists them. */
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
  /** Electric inserters only: no power to move the arm (stays on the active list). */
  NoPower: MachineState.NoPower,
} as const;

export type InserterState = (typeof InserterState)[keyof typeof InserterState];

const INSERTER = ENTITIES[EntityTypeId.BurnerInserter];
/** Joules a burner inserter burns per tick its arm moves. */
export const INSERTER_ENERGY_PER_TICK = INSERTER.energyPerTick ?? 0;
/** Ticks from the pickup end to the drop end (and back) of a burner inserter. */
export const INSERTER_SWING_TICKS = INSERTER.swingTicks ?? 1;
/** Ticks of one pickup → drop → return cycle. */
export const INSERTER_CYCLE_TICKS = 2 * INSERTER_SWING_TICKS;

/**
 * The tile an inserter on `(x, y)` facing `dir` with reach `reach` picks up
 * from: `reach` tiles behind it.
 */
export function inserterPickupTile(
  x: number,
  y: number,
  dir: Direction,
  reach: number = 1,
): { x: number; y: number } {
  return { x: x - reach * DIRECTION_DX[dir]!, y: y - reach * DIRECTION_DY[dir]! };
}

/**
 * The tile an inserter on `(x, y)` facing `dir` with reach `reach` drops
 * onto: `reach` tiles in front of it.
 */
export function inserterDropTile(
  x: number,
  y: number,
  dir: Direction,
  reach: number = 1,
): { x: number; y: number } {
  return { x: x + reach * DIRECTION_DX[dir]!, y: y + reach * DIRECTION_DY[dir]! };
}

/**
 * The lane an inserter facing `dir` drops onto a belt facing `beltDir`: the
 * far one, as seen from the inserter (whatever its reach). An inserter in
 * line with the belt (behind or in front of it) uses the right lane.
 */
export function farLane(dir: Direction, beltDir: Direction): BeltLane {
  // Dropping towards the belt's left side means reaching across to its left lane.
  return dir === ((beltDir + 3) & 3) ? BeltLane.Left : BeltLane.Right;
}

const isFuel = (item: number): boolean => fuelValue(item) > 0;

/**
 * The rows, active list, state machine, pickup and drop logic shared by
 * every inserter type. Subclasses add the energy source: whether the arm can
 * leave the pickup end (`canSwing`), what a tick of movement costs
 * (`energize`), and the slots that come with it.
 */
export abstract class InserterTableBase implements EntityTypeTable {
  readonly type: RealEntityTypeId;
  protected readonly proto: EntityPrototype;
  protected readonly set = new SparseSet();
  /** Inserters stepped by `update`: every one whose state may change on its own. */
  protected readonly active = new SparseSet();
  /** The item in the hand, or 0. */
  protected held = new Uint16Array(0);
  /** Arm position: from the pickup end (0) towards the drop end (`armEnd`), in 1/`armScale` ticks. */
  protected arm = new Uint32Array(0);
  protected state = new Uint8Array(0);
  /** Arm units per tick at full speed (1 for burner inserters, `SAT_ONE` for electric). */
  readonly armScale: number;
  /** Arm position at the drop end: `swingTicks × armScale`. */
  readonly armEnd: number;
  /** How many tiles behind and in front of it the inserter picks up and drops (1 or 2). */
  readonly reach: number;
  /** The state an inserter without energy is in (`NoFuel`, `NoPower`). */
  protected abstract readonly noEnergyState: InserterState;

  constructor(proto: EntityPrototype, armScale: number) {
    this.type = proto.id;
    this.proto = proto;
    this.armScale = armScale;
    this.armEnd = (proto.swingTicks ?? 1) * armScale;
    this.reach = inserterReach(proto);
  }

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
    this.growRows?.(min);
    this.state[row] = this.noEnergyState;
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
      this.moveRow?.(last, row);
    }
    for (const c of columns) c[last] = 0;
    this.clearRow?.(last);
  }

  /** The inserter's slots that hold something. */
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

  /** What a target accepts may have changed (an assembling machine's recipe). */
  entityReconfigured(changed: number, entities: Entities): void {
    this.wakeAround(changed, entities);
  }

  /** The entity waited on changed (or went away): look again. */
  wake(id: number): void {
    this.activate(id);
  }

  status(id: number): MachineState {
    return this.state[this.row(id)]! as MachineState;
  }

  /** The inserter's item slots, in slot order. */
  abstract slots(id: number): Slot[];

  /**
   * The item in the hand (0 for none) and the arm position (in 1/`armScale`
   * ticks from the pickup end, so in ticks for burner inserters), for
   * snapshots.
   */
  hand(id: number): { held: number; arm: number } {
    const row = this.row(id);
    return { held: this.held[row]!, arm: this.arm[row]! };
  }

  /**
   * How far the arm of inserter `id` moved on the latest tick, in arm units:
   * positive towards the drop end, negative back, 0 when it isn't swinging
   * (for drawing it between ticks).
   */
  lastSwing(id: number, entities: Entities): number {
    const row = this.row(id);
    if (this.state[row] !== InserterState.Swinging) return 0;
    const step = this.swingStep(id, entities);
    return this.held[row] !== 0 ? step : -step;
  }

  /** The inserter system: steps every active inserter of this type by one tick. */
  update(entities: Entities): void {
    // Backwards, so an inserter leaving the list only moves one already stepped
    // (inserters woken during the loop join at the end and wait for the next tick).
    for (let i = this.active.size - 1; i >= 0; i--) {
      const id = this.active.idAt(i);
      const row = this.set.indexOf(id);
      const state = this.step(row, id, entities);
      this.state[row] = state;
      if (state !== InserterState.Swinging && state !== InserterState.NoPower) {
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
    return this.hashRows?.(h, n) ?? h;
  }

  // Hooks for the energy source.

  /**
   * At the pickup end with an empty hand, before looking for something to
   * pick up (`source` is the entity on the pickup tile, or 0). Burner
   * inserters refuel here.
   */
  protected beforePickUp?(row: number, id: number, source: number, entities: Entities): void;

  /** Whether the arm has the energy to start a swing from the pickup end. */
  protected abstract canSwing(row: number, id: number, entities: Entities): boolean;

  /**
   * The entity an inserter that can't start a swing waits on (`source` is
   * the entity on its pickup tile), or 0 for none.
   */
  protected abstract noEnergyWatch(source: number): number;

  /**
   * Energy for one tick of arm movement of the inserter in row `row`:
   * returns how far the arm moves (> 0, in arm units), 0 when it has no
   * energy (`noEnergyState`), or `NOT_GRANTED` when it has to wait a tick
   * without moving (staying `Swinging`).
   */
  protected abstract energize(row: number, id: number, entities: Entities): number;

  /** How far the arm moves on a tick it swings, in arm units (for `lastSwing`). */
  protected abstract swingStep(id: number, entities: Entities): number;

  /** Called at the start of every step of row `row`, before anything else. */
  protected beginStep?(row: number): void;

  /** Columns of the subclass: grow, move on swap-remove, clear, hash. */
  protected growRows?(rows: number): void;
  protected moveRow?(from: number, to: number): void;
  protected clearRow?(row: number): void;
  protected hashRows?(h: number, rows: number): number;

  /** Arm position in whole ticks from the pickup end, for the GUI. */
  protected armTicks(row: number): number {
    return Math.floor(this.arm[row]! / this.armScale);
  }

  /**
   * Empties the hand (the GUI's `take` on the hand slot); returns 1 if it
   * held something.
   */
  protected takeHand(row: number, id: number, entities: Entities): number {
    if (this.held[row] === 0) return 0;
    this.held[row] = 0;
    // No longer waiting on a target: the arm goes back for another item.
    entities.wake.unwatchAll(id);
    return 1;
  }

  /** The inserter's slots changed: put it on the active list and tell its subscribers. */
  protected changed(id: number, entities: Entities): void {
    this.activate(id);
    entities.notify(id);
  }

  protected isActive(id: number): boolean {
    return this.active.has(id);
  }

  protected row(id: number): number {
    const row = this.set.indexOf(id);
    if (row < 0) {
      throw new RangeError(`no ${this.proto.name} ${String(id)}`);
    }
    return row;
  }

  /** One tick of the inserter in row `row`; returns its new state. */
  private step(row: number, id: number, entities: Entities): InserterState {
    this.beginStep?.(row);
    const arm = this.arm[row]!;
    if (this.held[row] === 0 && arm === 0) {
      const state = this.pickUp(row, id, entities);
      if (state !== InserterState.Swinging) return state;
    } else if (this.held[row] !== 0 && arm === this.armEnd) {
      if (!this.drop(row, id, entities)) return InserterState.WaitingForTarget;
    }
    const advance = this.energize(row, id, entities);
    if (advance === 0) return this.noEnergyState;
    if (advance === NOT_GRANTED) return InserterState.Swinging;
    this.arm[row] =
      this.held[row] !== 0 ? Math.min(this.armEnd, arm + advance) : Math.max(0, arm - advance);
    return InserterState.Swinging;
  }

  /**
   * At the pickup end with an empty hand: lets the energy source prepare
   * (refuel), then takes one unit for the target. Returns `Swinging` once the
   * hand holds it, else the state to wait in (subscribed to what it waits
   * on).
   */
  private pickUp(row: number, id: number, entities: Entities): InserterState {
    const { store } = entities;
    const dir = store.dir(id);
    const from = inserterPickupTile(store.x(id), store.y(id), dir, this.reach);
    const to = inserterDropTile(store.x(id), store.y(id), dir, this.reach);
    const source = entities.at(from.x, from.y);
    const target = entities.at(to.x, to.y);
    this.beforePickUp?.(row, id, source, entities);
    if (!this.canSwing(row, id, entities)) {
      this.waitOn(id, this.noEnergyWatch(source), entities);
      return this.noEnergyState;
    }
    if (target === 0) {
      this.waitOn(id, 0, entities);
      return InserterState.WaitingForTarget;
    }
    const item =
      source !== 0 ? takeFrom(source, from, (it) => entities.wants(target, it), entities) : 0;
    if (item === 0) {
      // Something the target takes but has no room for yet: it may want it
      // once it uses some up, so wait on the target too (D45).
      if (
        source !== 0 &&
        entities.wantsByRoom(target) &&
        hasItem(source, from, (it) => entities.accepts(target, it), entities)
      ) {
        this.waitOnBoth(id, source, target, entities);
      } else {
        this.waitOn(id, source, entities);
      }
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
    const to = inserterDropTile(store.x(id), store.y(id), dir, this.reach);
    const target = entities.at(to.x, to.y);
    const item = this.held[row]!;
    let ok = false;
    const belts = beltTable(entities);
    if (target !== 0 && belts && isBeltType(store.type(target))) {
      const lane = farLane(dir, store.dir(target));
      const pos = belts.beltOffset(target) + BELT_LENGTH / 2;
      ok = belts.insertAt(belts.beltLineAt(target, to.x, to.y), lane, pos, item);
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

  /** Subscribes inserter `id` to `target` alone (none for 0), unless it already is. */
  private waitOn(id: number, target: number, entities: Entities): void {
    const { wake } = entities;
    if (target !== 0 && wake.watchesOnly(id, target)) return;
    wake.unwatchAll(id);
    if (target !== 0) wake.watch(id, target);
  }

  /** Subscribes inserter `id` to `source` and `target` (both non-zero), in that order. */
  private waitOnBoth(id: number, source: number, target: number, entities: Entities): void {
    const { wake } = entities;
    wake.unwatchAll(id);
    wake.watch(id, source);
    wake.watch(id, target);
  }

  /** Wakes the inserters whose pickup or drop tile entity `id` covers. */
  private wakeAround(id: number, entities: Entities): void {
    if (this.set.size === 0) return;
    const { store } = entities;
    const { x, y, w, h } = entities.footprint(id);
    for (let ty = y; ty < y + h; ty++) {
      for (let tx = x; tx < x + w; tx++) {
        // An inserter of this type reaching (tx, ty) stands `reach` tiles away from it.
        for (let d = 0; d < 4; d++) {
          const nx = tx + this.reach * DIRECTION_DX[d]!;
          const ny = ty + this.reach * DIRECTION_DY[d]!;
          const ins = entities.at(nx, ny);
          if (ins === id || !this.set.has(ins)) continue;
          const dir = store.dir(ins);
          const from = inserterPickupTile(nx, ny, dir, this.reach);
          const to = inserterDropTile(nx, ny, dir, this.reach);
          if ((from.x === tx && from.y === ty) || (to.x === tx && to.y === ty)) this.activate(ins);
        }
      }
    }
  }

  private activate(id: number): void {
    if (!this.active.has(id)) this.active.add(id);
  }
}

/**
 * Takes one unit `accept` accepts out of entity `source`; returns its item
 * id, or 0 if there is none. Belts: the item closest to the end of the left
 * lane, else of the right lane, on the belt's own tile (see
 * `BeltTable.beltEnd`).
 */
function takeFrom(
  source: number,
  tile: { x: number; y: number },
  accept: (item: number) => boolean,
  entities: Entities,
): number {
  const belts = beltTable(entities);
  if (belts && isBeltType(entities.store.type(source))) {
    // A splitter: the half on the pickup tile.
    const line = belts.beltLineAt(source, tile.x, tile.y);
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

/** Whether entity `source` holds a unit `accept` accepts where {@link takeFrom} would look. */
function hasItem(
  source: number,
  tile: { x: number; y: number },
  accept: (item: number) => boolean,
  entities: Entities,
): boolean {
  const belts = beltTable(entities);
  if (belts && isBeltType(entities.store.type(source))) {
    const line = belts.beltLineAt(source, tile.x, tile.y);
    const from = belts.beltOffset(source);
    const to = belts.beltEnd(source);
    for (let lane = 0; lane < 2; lane++) {
      const item = belts.peekAt(line, lane, from, to);
      if (item !== 0 && accept(item)) return true;
    }
    return false;
  }
  return entities.outputSlot(source, accept) >= 0;
}

/**
 * Burner inserters: a 1×1 inserter with a burner (fuel slot and energy
 * buffer) that burns `INSERTER_ENERGY_PER_TICK` joules on every tick its arm
 * moves, and refuels itself from its source.
 */
export class InserterTable extends InserterTableBase {
  protected readonly noEnergyState = InserterState.NoFuel;
  private readonly burner = new BurnerColumns();

  constructor() {
    super(INSERTER, 1);
  }

  /** `progress` is the arm position, in ticks from the pickup end. */
  detail(id: number): EntityDetail {
    const row = this.row(id);
    return {
      status: this.state[row]! as MachineState,
      recipe: 0,
      progress: this.armTicks(row),
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
    } else if (slot === InserterSlot.Hand) {
      n = this.takeHand(row, id, entities);
    }
    if (n > 0) this.changed(id, entities);
    return n;
  }

  /** Refuelling: with an empty fuel slot, it takes one unit of fuel from its source first. */
  protected override beforePickUp(row: number, id: number, source: number, entities: Entities) {
    if (source !== 0 && this.burner.fuelCount[row] === 0) {
      const { store } = entities;
      const tile = inserterPickupTile(store.x(id), store.y(id), store.dir(id), 1);
      const fuel = takeFrom(source, tile, isFuel, entities);
      if (fuel !== 0) {
        this.burner.insert(row, fuel, 1);
        entities.notify(id);
      }
    }
  }

  protected canSwing(row: number): boolean {
    return this.burner.energy[row]! >= INSERTER_ENERGY_PER_TICK || this.burner.fuelCount[row]! > 0;
  }

  /** Without fuel at the pickup end it waits on its source, to refuel from it. */
  protected noEnergyWatch(source: number): number {
    return source;
  }

  protected energize(row: number, id: number, entities: Entities): number {
    const fuel = this.burner.fuelCount[row]!;
    const burnt = this.burner.consume(row, INSERTER_ENERGY_PER_TICK);
    // A fuel unit taken from the slot is a change like any other.
    if (this.burner.fuelCount[row] !== fuel) entities.notify(id);
    return burnt ? 1 : 0;
  }

  protected swingStep(): number {
    return 1;
  }

  protected override growRows(rows: number): void {
    this.burner.grow(rows);
  }

  protected override moveRow(from: number, to: number): void {
    this.burner.moveRow(from, to);
  }

  protected override clearRow(row: number): void {
    this.burner.clearRow(row);
  }

  protected override hashRows(h: number, rows: number): number {
    return this.burner.hashInto(h, rows);
  }
}

/**
 * Steps every inserter table of `entities` (burner, electric, fast,
 * long-handed), in type id order: the inserter system.
 */
export function updateInserters(entities: Entities): void {
  for (const table of entities.tables) {
    if (table instanceof InserterTableBase) table.update(entities);
  }
}

/** The inserter table of entity type `type`, if it is an inserter type with a table. */
export function inserterTableOf(entities: Entities, type: number): InserterTableBase | undefined {
  const table = entities.table(type);
  return table instanceof InserterTableBase ? table : undefined;
}

/** The burner inserter table of `entities`, if one is registered. */
export function inserterTable(entities: Entities): InserterTable | undefined {
  const table = entities.table(EntityTypeId.BurnerInserter);
  return table instanceof InserterTable ? table : undefined;
}

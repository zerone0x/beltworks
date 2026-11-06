/**
 * Mining drills. `MiningDrillTable` holds everything burner and electric
 * drills share: mining progress, a round-robin cursor over the tiles the
 * drill mines, one held output unit, the machine state, the active list, and
 * the drop/insert/wake logic. Each kind adds its energy source: the burner
 * mining drill (`DrillTable`, below) a burner (fuel slot and energy buffer,
 * see burner.ts), the electric mining drill (`ElectricDrillTable`,
 * electricDrill.ts) its electric network.
 *
 * A drill mines the square of tiles centered on it given by its prototype's
 * `miningArea` (its own footprint when absent: the burner drill's 2×2; the
 * electric drill's 5×5 around its 3×3), one unit every `miningTicks`
 * working ticks at full speed, from the mined tiles in turn (row-major in
 * world coordinates, starting after the tile mined last and skipping empty
 * ones). Each tick a drill:
 * 1. Holding a unit it couldn't drop yet, tries to drop it again
 *    (`OutputFull` while that fails).
 * 2. Before starting a unit, needs a resource left in its area (`Depleted`
 *    otherwise, for good: resources never grow back).
 * 3. Gets its energy for the tick (`energize`): a burner drill burns
 *    `energyPerTick` joules (`NoFuel` if the burner has none) and advances
 *    by one tick; an electric drill advances by its network's satisfaction
 *    `s` in 1/`SAT_ONE` ticks (`NoPower` when `s` is 0).
 * 4. Advances; on the last tick of a unit it takes one unit out of the world
 *    (`World.mine`) and drops it. Progress past the end of a unit is not
 *    carried over: every unit starts from 0.
 * So with energy and room in front a drill mines exactly one unit every
 * `miningTicks` ticks at full speed (`ceil(miningTicks × SAT_ONE / s)` ticks
 * at satisfaction `s`).
 *
 * Output: the unit goes to the drop tile, the tile just in front of the
 * middle of the drill's front edge, on its left half for even widths (see
 * `drillDropTileFor`), through the item hooks of whatever entity covers it
 * (`entities.insert`: a chest stores it, a furnace smelts ores and burns
 * coal, another burner drill or a burner inserter burns coal, a transport
 * belt puts it on the middle of its tile). This is the drill's one output
 * hook: any type that implements `insert` takes drill output with no change
 * here. With nothing there, or no room, the drill holds the unit and stops
 * (`OutputFull`). Mined coal never goes into the drill's own fuel slot:
 * burner drills are fuelled through the GUI or by inserters.
 *
 * Machine sleep: only drills on the active list are stepped. One that ends a
 * tick in any state but `Working` or `NoPower` leaves the list (`NoPower`
 * waits for its network, which can change on any tick). It goes back on it
 * when
 * - its own slots change (fuel inserted, the held unit taken),
 * - the entity on its drop tile changes or goes away (an `OutputFull` drill
 *   subscribes to it, see wake.ts; the subscription ends once a unit drops),
 * - an entity is placed on its drop tile (`entityPlaced`),
 * - it is rotated (its drop tile moves).
 */

import {
  ENTITIES,
  EntityTypeId,
  type EntityPrototype,
  type RealEntityTypeId,
} from '../../data/entities';
import { fuelValue, minedItem, type ItemStack, type RealItemId } from '../../data/items';
import { fnv1a32 } from '../hash';
import { NOT_GRANTED } from '../power/consumer';
import type { World } from '../world/world';
import { BurnerColumns } from './burner';
import { DIRECTION_DX, DIRECTION_DY, Direction } from './direction';
import type { Entities } from './entities';
import { MachineState } from './machine';
import { SparseSet, growTo } from './sparseSet';
import type { EntityDetail, EntityTypeTable, Slot } from './table';

/** Slot indices of a burner mining drill, in the order `slots` lists them. */
export const DrillSlot = {
  Fuel: 0,
  /** The mined unit waiting to be dropped (at most one). */
  Output: 1,
} as const;

const DRILL = ENTITIES[EntityTypeId.BurnerMiningDrill];
/** Joules a burner drill burns per working tick. */
export const DRILL_ENERGY_PER_TICK = DRILL.energyPerTick ?? 0;
/** Working ticks per mined unit of a burner drill. */
export const DRILL_MINING_TICKS = DRILL.miningTicks ?? 1;

/**
 * The tile a drill of prototype `proto` with its top-left tile at `(x, y)`
 * facing `dir` drops its output onto: just outside the front edge, at its
 * middle (the left one of the two middle tiles, as seen from the drill, for
 * an even width). It is the same tile relative to the drill whichever way it
 * faces. For a 2×2 drill: north `(x, y - 1)`, east `(x + 2, y)`, south
 * `(x + 1, y + 2)`, west `(x - 1, y + 1)`; for a 3×3 one: north
 * `(x + 1, y - 1)`, east `(x + 3, y + 1)`, south `(x + 1, y + 3)`, west
 * `(x - 1, y + 1)`. Drill footprints are square.
 */
export function drillDropTileFor(
  proto: EntityPrototype,
  x: number,
  y: number,
  dir: Direction,
): { x: number; y: number } {
  const w = proto.width;
  const h = proto.height;
  const k = (w - 1) >> 1;
  switch (dir) {
    case Direction.East:
      return { x: x + w, y: y + k };
    case Direction.South:
      return { x: x + w - 1 - k, y: y + h };
    case Direction.West:
      return { x: x - 1, y: y + h - 1 - k };
    default:
      return { x: x + k, y: y - 1 };
  }
}

/** The drop tile of a burner mining drill (see {@link drillDropTileFor}). */
export function drillDropTile(x: number, y: number, dir: Direction): { x: number; y: number } {
  return drillDropTileFor(DRILL, x, y, dir);
}

/**
 * The rows, active list, mining and output logic shared by every mining
 * drill type. Subclasses add the energy source (`energize`) and the slots
 * that come with it.
 */
export abstract class MiningDrillTable implements EntityTypeTable {
  readonly type: RealEntityTypeId;
  protected readonly proto: EntityPrototype;
  protected readonly set = new SparseSet();
  /** Drills stepped by `update`: every one whose state may change on its own. */
  protected readonly active = new SparseSet();
  /** Progress on the unit being mined, in 1/`progressScale` working ticks. */
  protected progress = new Uint32Array(0);
  /** Index (row-major in the mining area) of the tile to try first for the next unit. */
  protected cursor = new Uint8Array(0);
  /** The mined unit waiting to be dropped, or 0. */
  protected held = new Uint16Array(0);
  protected state = new Uint8Array(0);
  /** Progress units per working tick at full speed (1 for burner drills, `SAT_ONE` for electric). */
  protected readonly progressScale: number;
  /** Progress per mined unit. */
  private readonly unitProgress: number;
  /** Edge of the mined square, and its offset from the drill's top-left tile. */
  private readonly areaSize: number;
  private readonly areaOffset: number;
  private readonly areaTiles: number;
  /** The state a drill with no energy for a tick is in (`NoFuel`, `NoPower`). */
  protected abstract readonly noEnergyState: MachineState;

  constructor(proto: EntityPrototype, progressScale: number) {
    this.type = proto.id;
    this.proto = proto;
    this.progressScale = progressScale;
    this.unitProgress = (proto.miningTicks ?? 1) * progressScale;
    this.areaSize = proto.miningArea ?? proto.width;
    this.areaOffset = (proto.width - this.areaSize) >> 1;
    this.areaTiles = this.areaSize * this.areaSize;
  }

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
    this.growRows?.(min);
    this.state[row] = this.noEnergyState;
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
      this.moveRow?.(last, row);
    }
    for (const c of columns) c[last] = 0;
    this.clearRow?.(last);
  }

  /** The drill's slots that hold something. */
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

  /** The drill's item slots, in slot order. */
  abstract slots(id: number): Slot[];

  outputSlot(id: number, accept?: (item: number) => boolean): number {
    const held = this.held[this.row(id)]!;
    return held !== 0 && (!accept || accept(held)) ? this.heldSlot : -1;
  }

  /** The drill system: steps every active drill of this type by one tick. */
  update(entities: Entities, world: World): void {
    // Backwards, so a drill leaving the list only moves one already stepped
    // (drills woken during the loop join at the end and wait for the next tick).
    for (let i = this.active.size - 1; i >= 0; i--) {
      const id = this.active.idAt(i);
      const row = this.set.indexOf(id);
      const state = this.step(row, id, entities, world);
      this.state[row] = state;
      if (state !== MachineState.Working && state !== MachineState.NoPower) {
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
    return this.hashRows?.(h, n) ?? h;
  }

  /** The drop tile of drill `id` (see {@link drillDropTileFor}). */
  dropTile(id: number, entities: Entities): { x: number; y: number } {
    const { store } = entities;
    return drillDropTileFor(this.proto, store.x(id), store.y(id), store.dir(id));
  }

  // Hooks for the energy source.

  /** Index of the held-unit slot in `slots`. */
  protected abstract readonly heldSlot: number;

  /**
   * Energy for one working tick of the drill in row `row`: returns the
   * progress it makes (> 0), 0 when it has no energy (`noEnergyState`), or
   * `NOT_GRANTED` when it has to wait a tick without progress (staying
   * `Working`).
   */
  protected abstract energize(row: number, id: number, entities: Entities): number;

  /** Called at the start of every step of row `row`, before anything else. */
  protected beginStep?(row: number): void;

  /** Columns of the subclass: grow, move on swap-remove, clear, hash. */
  protected growRows?(rows: number): void;
  protected moveRow?(from: number, to: number): void;
  protected clearRow?(row: number): void;
  protected hashRows?(h: number, rows: number): number;

  /** Working ticks done on the current unit (whole ticks at full speed), for the GUI. */
  protected progressTicks(row: number): number {
    return Math.floor(this.progress[row]! / this.progressScale);
  }

  /**
   * Takes the held unit out (the GUI's or an inserter's `take` on the held
   * slot); returns 1 if there was one.
   */
  protected takeHeld(row: number): number {
    if (this.held[row] === 0) return 0;
    this.held[row] = 0;
    return 1;
  }

  /**
   * Whether drill `id` in row `row` may work this tick, as far as can be told
   * before the drills run: it is on the active list, and a unit it holds has
   * somewhere to go (the entity on its drop tile has room for it).
   */
  protected mayWork(row: number, id: number, entities: Entities): boolean {
    if (!this.active.has(id)) return false;
    const held = this.held[row]!;
    if (held === 0) return true;
    const { x, y } = this.dropTile(id, entities);
    const target = entities.at(x, y);
    return target !== 0 && entities.insertable(target, held) > 0;
  }

  /** The drill's slots changed: put it on the active list and tell its subscribers. */
  protected changed(id: number, entities: Entities): void {
    this.activate(id);
    entities.notify(id);
  }

  protected row(id: number): number {
    const row = this.set.indexOf(id);
    if (row < 0) {
      throw new RangeError(`no ${this.proto.name} ${String(id)}`);
    }
    return row;
  }

  /** One tick of the drill in row `row`; returns its new state. */
  private step(row: number, id: number, entities: Entities, world: World): MachineState {
    this.beginStep?.(row);
    if (this.held[row] !== 0) {
      if (!this.dropHeld(row, id, entities)) {
        return MachineState.OutputFull;
      }
      entities.notify(id);
    }
    if (this.progress[row] === 0 && this.nextTile(row, id, entities, world) < 0) {
      return MachineState.Depleted;
    }
    const advance = this.energize(row, id, entities);
    if (advance === 0) {
      return this.noEnergyState;
    }
    if (advance === NOT_GRANTED) {
      return MachineState.Working;
    }
    const progress = this.progress[row]! + advance;
    if (progress < this.unitProgress) {
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
    this.cursor[row] = (tile + 1) % this.areaTiles;
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
   * Index of the mined tile the next unit comes from: the first one from the
   * cursor on, in row-major order, that still has a resource the drill can
   * mine; -1 if there is none.
   */
  private nextTile(row: number, id: number, entities: Entities, world: World): number {
    const start = this.cursor[row]!;
    for (let k = 0; k < this.areaTiles; k++) {
      const tile = (start + k) % this.areaTiles;
      const { x, y } = this.tileAt(id, entities, tile);
      if (world.amountAt(x, y) > 0 && minedItem(world.resourceAt(x, y)) !== undefined) {
        return tile;
      }
    }
    return -1;
  }

  /** World coordinates of mined tile `tile` (row-major index in the mining area). */
  private tileAt(id: number, entities: Entities, tile: number): { x: number; y: number } {
    const { store } = entities;
    const a = this.areaSize;
    return {
      x: store.x(id) + this.areaOffset + (tile % a),
      y: store.y(id) + this.areaOffset + Math.floor(tile / a),
    };
  }

  private activate(id: number): void {
    if (!this.active.has(id)) this.active.add(id);
  }
}

/**
 * Burner mining drills: a 2×2 drill with a burner (fuel slot and energy
 * buffer) that burns `DRILL_ENERGY_PER_TICK` joules on every working tick.
 */
export class DrillTable extends MiningDrillTable {
  protected readonly noEnergyState = MachineState.NoFuel;
  protected readonly heldSlot = DrillSlot.Output;
  private readonly burner = new BurnerColumns();

  constructor() {
    super(DRILL, 1);
  }

  detail(id: number): EntityDetail {
    const row = this.row(id);
    return {
      status: this.state[row]! as MachineState,
      recipe: 0,
      progress: this.progressTicks(row),
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
  accepts(_id: number, item: number): boolean {
    return fuelValue(item) > 0;
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
    if (slot === DrillSlot.Fuel) {
      n = this.burner.take(row, count);
    } else if (slot === DrillSlot.Output) {
      n = this.takeHeld(row);
    }
    if (n > 0) this.changed(id, entities);
    return n;
  }

  protected energize(row: number, id: number, entities: Entities): number {
    const fuel = this.burner.fuelCount[row]!;
    const burnt = this.burner.consume(row, DRILL_ENERGY_PER_TICK);
    // A fuel unit taken from the slot is a change like any other.
    if (this.burner.fuelCount[row] !== fuel) entities.notify(id);
    return burnt ? 1 : 0;
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

/** The burner drill table of `entities`, if one is registered. */
export function drillTable(entities: Entities): DrillTable | undefined {
  const table = entities.table(EntityTypeId.BurnerMiningDrill);
  return table instanceof DrillTable ? table : undefined;
}

/**
 * Steam engines: the electric producers of M2, fed by boilers (boiler.ts).
 * There are no real fluids in v1 (see docs/GDD.md): an engine is fed when it
 * is connected to a boiler by steam, and steam connections are a pure
 * function of positions and directions:
 * - a boiler's output side is the edge it faces; an engine's two ends are
 *   its short edges (north and south when it faces north or south, east and
 *   west otherwise);
 * - a boiler feeds an engine that has a tile right in front of the boiler's
 *   output side and has the boiler right off one of its ends;
 * - an engine passes steam on to an engine lined up end to end with it (each
 *   has a tile right off one of the other's ends).
 * So a boiler feeds a row of engines in front of it (two side by side fit in
 * front of its 2-tile output side, and rows continue end to end), never one
 * merely touching its sides. Each engine is fed by one boiler at most: the
 * lowest-id boiler that reaches it. A boiler's engines are listed in the
 * order steam reaches them, breadth first from the boiler with neighbours by
 * ascending id. Links are rebuilt whenever a boiler or engine is placed,
 * rotated or removed.
 *
 * Per tick, the solver collects every producer's `powerMaxOutput` before it
 * calls any `powerDraw`, so engines can't just report 15 000 J each against
 * a boiler that has 30 000. Instead, in `powerPrepare` (the start of the
 * power system) each boiler's supply is shared out among its engines in
 * their order, each taking up to its own maximum: `available = min(15 000,
 * what the boiler has left)`. Engines that aren't connected to a network
 * take nothing (they couldn't deliver it), so the next ones can. Then
 * `powerMaxOutput` reports the engine's allocation, and `powerDraw` burns
 * what the engine delivers in its boiler. So one boiler with two engines
 * supplies up to 30 000 J/tick, and with three engines still 30 000 (the
 * third gets nothing while the first two can take it all).
 *
 * States: `Working` while it delivers energy, `NoDemand` while it has steam
 * but nothing is drawn (or it isn't connected to a network), `NoInput` (no
 * steam) when no boiler feeds it or its boiler has no fuel.
 */

import { ENTITIES, EntityTypeId } from '../../data/entities';
import type { ItemStack } from '../../data/items';
import { Direction } from '../entities/direction';
import type { Entities, Footprint } from '../entities/entities';
import { MachineState } from '../entities/machine';
import { SparseSet, growTo } from '../entities/sparseSet';
import type { EntityDetail, EntityTypeTable } from '../entities/table';
import { fnv1a32 } from '../hash';
import { boilerTable } from './boiler';
import type { TileRect } from './geometry';
import { powerGrid } from './grid';

/** Most joules per tick a steam engine delivers. */
export const STEAM_ENGINE_MAX_OUTPUT = ENTITIES[EntityTypeId.SteamEngine].maxOutputPerTick ?? 0;

const NO_CONTENTS: readonly ItemStack[] = [];

/**
 * The row of tiles right in front of the output side of a boiler with
 * footprint `f` facing `dir`.
 */
export function boilerOutputRect(f: Footprint, dir: Direction): TileRect {
  switch (dir) {
    case Direction.North:
      return { x0: f.x, y0: f.y - 1, x1: f.x + f.w - 1, y1: f.y - 1 };
    case Direction.East:
      return { x0: f.x + f.w, y0: f.y, x1: f.x + f.w, y1: f.y + f.h - 1 };
    case Direction.South:
      return { x0: f.x, y0: f.y + f.h, x1: f.x + f.w - 1, y1: f.y + f.h };
    default:
      return { x0: f.x - 1, y0: f.y, x1: f.x - 1, y1: f.y + f.h - 1 };
  }
}

/** The two rows of tiles right off the ends of a steam engine with footprint `f` facing `dir`. */
export function engineEndRects(f: Footprint, dir: Direction): [TileRect, TileRect] {
  if ((dir & 1) === 0) {
    return [
      { x0: f.x, y0: f.y - 1, x1: f.x + f.w - 1, y1: f.y - 1 },
      { x0: f.x, y0: f.y + f.h, x1: f.x + f.w - 1, y1: f.y + f.h },
    ];
  }
  return [
    { x0: f.x - 1, y0: f.y, x1: f.x - 1, y1: f.y + f.h - 1 },
    { x0: f.x + f.w, y0: f.y, x1: f.x + f.w, y1: f.y + f.h - 1 },
  ];
}

export class SteamEngineTable implements EntityTypeTable {
  readonly type = EntityTypeId.SteamEngine;
  private readonly set = new SparseSet();
  /** The boiler feeding the engine, or 0. */
  private boilerCol = new Uint32Array(0);
  /** Its place in its boiler's list (0 first), or 0 without a boiler. */
  private rankCol = new Uint32Array(0);
  /** Joules it may deliver this tick (its share of the boiler's supply). */
  private availableCol = new Uint32Array(0);
  /** Joules it delivered this tick. */
  private outputCol = new Uint32Array(0);
  private state = new Uint8Array(0);
  /** Engines fed by each boiler, in the order steam reaches them; boilers by ascending id. */
  private feeds = new Map<number, number[]>();

  /** Number of steam engines. */
  get count(): number {
    return this.set.size;
  }

  add(id: number): void {
    const row = this.set.add(id);
    const min = row + 1;
    this.boilerCol = growTo(this.boilerCol, min);
    this.rankCol = growTo(this.rankCol, min);
    this.availableCol = growTo(this.availableCol, min);
    this.outputCol = growTo(this.outputCol, min);
    this.state = growTo(this.state, min);
    this.state[row] = MachineState.NoInput;
  }

  remove(id: number): void {
    const row = this.set.remove(id);
    if (row < 0) return;
    const last = this.set.size;
    const columns = [this.boilerCol, this.rankCol, this.availableCol, this.outputCol, this.state];
    if (row !== last) {
      for (const c of columns) c[row] = c[last]!;
    }
    for (const c of columns) c[last] = 0;
  }

  contents(): readonly ItemStack[] {
    return NO_CONTENTS;
  }

  // Links: rebuilt whenever a boiler or an engine comes, turns or goes.

  entityPlaced(id: number, entities: Entities): void {
    if (this.isSteam(entities.store.type(id))) this.relink(entities, 0);
  }

  entityRotated(id: number, entities: Entities): void {
    if (this.isSteam(entities.store.type(id))) this.relink(entities, 0);
  }

  /** Called before the entity goes: relink without it. */
  entityRemoved(id: number, entities: Entities): void {
    if (this.isSteam(entities.store.type(id))) this.relink(entities, id);
  }

  // Reads.

  /** The boiler feeding engine `id`, or 0 (none, or not an engine). */
  boilerOf(id: number): number {
    const row = this.set.indexOf(id);
    return row < 0 ? 0 : this.boilerCol[row]!;
  }

  /** The engines boiler `id` feeds, in the order steam reaches them (a copy). */
  enginesOf(id: number): number[] {
    return (this.feeds.get(id) ?? []).slice();
  }

  /** Joules engine `id` may deliver this tick, and delivered (0 if it isn't an engine). */
  available(id: number): number {
    const row = this.set.indexOf(id);
    return row < 0 ? 0 : this.availableCol[row]!;
  }

  output(id: number): number {
    const row = this.set.indexOf(id);
    return row < 0 ? 0 : this.outputCol[row]!;
  }

  status(id: number): MachineState {
    return this.state[this.row(id)]! as MachineState;
  }

  detail(id: number): EntityDetail {
    const row = this.row(id);
    return {
      status: this.state[row]! as MachineState,
      recipe: 0,
      progress: 0,
      energy: 0,
      burning: 0,
      power: this.outputCol[row]!,
    };
  }

  // Power hooks.

  /** Start of the power system: the boilers' supply for the tick, shared out among their engines. */
  powerPrepare(entities: Entities): void {
    const boilers = boilerTable(entities);
    boilers?.beginTick();
    const n = this.set.size;
    this.availableCol.fill(0, 0, n);
    if (!boilers) return;
    const grid = powerGrid(entities);
    for (const [boiler, engines] of this.feeds) {
      let left = boilers.supply(boiler);
      for (const engine of engines) {
        if (left === 0) break;
        if ((grid?.networkOf(engine) ?? 0) === 0) continue;
        const take = Math.min(STEAM_ENGINE_MAX_OUTPUT, left);
        this.availableCol[this.set.indexOf(engine)] = take;
        left -= take;
      }
    }
  }

  powerMaxOutput(id: number): number {
    return this.availableCol[this.row(id)]!;
  }

  /** Engine `id` delivers `joules`: its boiler burns them. */
  powerDraw(id: number, joules: number, entities: Entities): void {
    const row = this.row(id);
    const boilers = boilerTable(entities);
    const boiler = this.boilerCol[row]!;
    this.outputCol[row] = joules;
    if (joules > 0) boilers!.burn(boiler, joules, entities);
    const steam = boiler !== 0 && (boilers?.supply(boiler) ?? 0) > 0;
    this.state[row] = !steam
      ? MachineState.NoInput
      : joules > 0
        ? MachineState.Working
        : MachineState.NoDemand;
  }

  hashInto(h: number): number {
    const n = this.set.size;
    h = fnv1a32(Uint32Array.of(n), h);
    h = fnv1a32(this.set.dense, h);
    for (const c of [this.boilerCol, this.rankCol, this.availableCol, this.outputCol, this.state]) {
      h = fnv1a32(c.subarray(0, n), h);
    }
    return h;
  }

  // Internals.

  private isSteam(type: number): boolean {
    return type === EntityTypeId.Boiler || type === EntityTypeId.SteamEngine;
  }

  /**
   * Rebuilds every steam link, leaving out entity `gone` (one about to be
   * removed, or 0). Boilers claim engines in ascending id order, each
   * breadth first from its output side.
   */
  private relink(entities: Entities, gone: number): void {
    const boilers = boilerTable(entities);
    const n = this.set.size;
    this.boilerCol.fill(0, 0, n);
    this.rankCol.fill(0, 0, n);
    this.feeds = new Map();
    if (!boilers) return;
    const ids = boilers.ids().filter((id) => id !== gone);
    ids.sort((a, b) => a - b);
    const isEngine = (id: number): boolean => id !== gone && this.set.has(id);
    for (const boiler of ids) {
      const front = boilerOutputRect(entities.footprint(boiler), entities.store.dir(boiler));
      const list: number[] = [];
      const claim = (candidates: number[]): void => {
        for (const e of candidates.sort((a, b) => a - b)) {
          const row = this.set.indexOf(e);
          if (this.boilerCol[row] !== 0) continue;
          this.boilerCol[row] = boiler;
          this.rankCol[row] = list.length;
          list.push(e);
        }
      };
      claim(
        this.entitiesIn(entities, [front], isEngine).filter((e) =>
          this.entitiesIn(entities, this.ends(entities, e), (q) => q === boiler).includes(boiler),
        ),
      );
      for (let k = 0; k < list.length; k++) {
        const e = list[k]!;
        claim(
          this.entitiesIn(entities, this.ends(entities, e), isEngine).filter((q) =>
            this.entitiesIn(entities, this.ends(entities, q), (r) => r === e).includes(e),
          ),
        );
      }
      if (list.length > 0) this.feeds.set(boiler, list);
    }
  }

  private ends(entities: Entities, engine: number): TileRect[] {
    return engineEndRects(entities.footprint(engine), entities.store.dir(engine));
  }

  /** Distinct entities covering tiles of `rects` that pass `keep`, in first-seen order. */
  private entitiesIn(
    entities: Entities,
    rects: readonly TileRect[],
    keep: (id: number) => boolean,
  ): number[] {
    const out: number[] = [];
    for (const r of rects) {
      for (let ty = r.y0; ty <= r.y1; ty++) {
        for (let tx = r.x0; tx <= r.x1; tx++) {
          const e = entities.at(tx, ty);
          if (e !== 0 && keep(e) && !out.includes(e)) out.push(e);
        }
      }
    }
    return out;
  }

  private row(id: number): number {
    const row = this.set.indexOf(id);
    if (row < 0) {
      throw new RangeError(`no steam engine ${String(id)}`);
    }
    return row;
  }
}

/** The steam engine table of `entities`, if one is registered. */
export function steamEngineTable(entities: Entities): SteamEngineTable | undefined {
  const table = entities.table(EntityTypeId.SteamEngine);
  return table instanceof SteamEngineTable ? table : undefined;
}

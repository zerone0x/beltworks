/**
 * A crew of builders working in parallel, for scenes too big for one player
 * (the 10k and 50k scenes). Like `Builder` (builder.ts), every change goes
 * through `Sim.enqueue` as a command (`Move`, `Place`, `Insert`, `SetRecipe`,
 * `SetResearch`) and the crew only *reads* state to steer and to check that
 * each command applied, so a scene can never reach a state normal play
 * couldn't. Every helper throws when a command doesn't apply.
 *
 * Each player runs a task: a generator that sends the commands for the
 * current tick and then yields; `runCrew` steps the simulation once every
 * task has yielded, so all players act in the same ticks (in player id
 * order). A player that wants to place where another one is standing waits
 * until that one has moved on; players only ever stop on tiles nothing is
 * built on, so nobody waits forever.
 *
 * Walking follows axis-aligned segments (see `route`), so a player never
 * cuts a corner into water.
 */

import { beltTable } from '../../src/sim/belts/belts';
import type { Axis, CommandInput } from '../../src/sim/commands';
import { Direction } from '../../src/sim/entities/direction';
import { playerOverlaps } from '../../src/sim/entities/placement';
import { footprintSize } from '../../src/sim/entities/store';
import { entityForItem } from '../../src/data/entities';
import { tileCenter } from '../../src/sim/fixed';
import { PLAYER_SPEED } from '../../src/sim/player';
import type { Sim } from '../../src/sim/tick';
import type { World } from '../../src/sim/world/world';
import type { Insertion, Placement } from './builder';

/** One tick of a task: the task has sent its commands for this tick. */
export type Task = Generator<void, void, void>;

/** Ticks a walk segment may take before the crew gives up (the player is stuck). */
const MAX_WALK_TICKS = 20_000;
/** Ticks a player may wait for another one to get out of the way. */
const MAX_WAIT_TICKS = 2_000;

const axisToward = (d: number): Axis => (d >= PLAYER_SPEED ? 1 : d <= -PLAYER_SPEED ? -1 : 0);

/** A tile. */
export interface Tile {
  readonly x: number;
  readonly y: number;
}

/**
 * Runs every task to completion, stepping the simulation once per round in
 * which every unfinished task has yielded.
 */
export function runCrew(sim: Sim, tasks: readonly Task[]): void {
  let active = tasks.slice();
  while (active.length > 0) {
    active = active.filter((task) => !task.next().done);
    if (active.length > 0) sim.step();
  }
}

export class CrewMember {
  private moveX: Axis = 0;
  private moveY: Axis = 0;
  /** Units this player has put onto belts so far. */
  beltItems = 0;

  constructor(
    readonly sim: Sim,
    readonly playerId: number,
  ) {}

  private send(cmd: CommandInput): void {
    this.sim.enqueue({ ...cmd, tick: this.sim.tick });
  }

  /** The player's position in subtiles. */
  get position(): { x: number; y: number } {
    const { players } = this.sim.state;
    return { x: players.x[this.playerId]!, y: players.y[this.playerId]! };
  }

  /** Walks to the center of tile `(tileX, tileY)` and stops there (see `Builder.walkTo`). */
  *walkTo(tileX: number, tileY: number): Task {
    const tx = tileCenter(tileX);
    const ty = tileCenter(tileY);
    for (let ticks = 0; ; ticks++) {
      const { x, y } = this.position;
      const ax = axisToward(tx - x);
      const ay = axisToward(ty - y);
      if (ax !== this.moveX || ay !== this.moveY) {
        this.send({ type: 'Move', playerId: this.playerId, dx: ax, dy: ay });
        this.moveX = ax;
        this.moveY = ay;
      }
      if (ax === 0 && ay === 0) {
        yield;
        return;
      }
      if (ticks >= MAX_WALK_TICKS) {
        throw new Error(
          `player ${String(this.playerId)} got stuck walking to tile (${String(tileX)}, ${String(tileY)})`,
        );
      }
      yield;
    }
  }

  /** Walks through `waypoints` in order (each leg along one axis). */
  *walk(waypoints: readonly Tile[]): Task {
    for (const { x, y } of waypoints) yield* this.walkTo(x, y);
  }

  /** Whether another player's collision box overlaps the `w`×`h` footprint at `(x, y)`. */
  private blockedByOther(x: number, y: number, w: number, h: number): boolean {
    const { players } = this.sim.state;
    for (let i = 0; i < players.count; i++) {
      if (i === this.playerId) continue;
      if (playerOverlaps(players.x[i]!, players.y[i]!, x, y, x + w - 1, y + h - 1)) return true;
    }
    return false;
  }

  /**
   * Places every entity of `placements` in one tick, in order, once no other
   * player stands on any of their footprints, and returns their ids.
   */
  *place(placements: readonly Placement[]): Generator<void, number[], void> {
    for (let waited = 0; ; waited++) {
      const blocked = placements.some(({ item, x, y, dir }) => {
        const proto = entityForItem(item);
        if (!proto) return false;
        const { w, h } = footprintSize(proto, proto.rotatable ? dir : Direction.North);
        return this.blockedByOther(x, y, w, h);
      });
      if (!blocked) break;
      if (waited >= MAX_WAIT_TICKS) {
        throw new Error(`player ${String(this.playerId)} waited too long for room to build`);
      }
      yield;
    }
    for (const { item, x, y, dir } of placements) {
      this.send({ type: 'Place', playerId: this.playerId, item, x, y, dir });
    }
    yield;
    const { entities } = this.sim.state;
    return placements.map(({ x, y }) => {
      const id = entities.at(x, y);
      const placed = id !== 0 && entities.footprint(id).x === x && entities.footprint(id).y === y;
      if (!placed) {
        throw new Error(
          `player ${String(this.playerId)}: Place at (${String(x)}, ${String(y)}) was ignored`,
        );
      }
      return id;
    });
  }

  /** Runs every insertion in one tick; throws unless all the items left the inventory. */
  *insert(insertions: readonly Insertion[]): Task {
    if (insertions.length === 0) return;
    const inventory = this.sim.state.players.inventory(this.playerId);
    const expected = new Map<number, number>();
    for (const { entity, item, count } of insertions) {
      this.send({ type: 'Insert', playerId: this.playerId, entity, item, count });
      expected.set(item, (expected.get(item) ?? inventory.count(item)) - count);
    }
    yield;
    for (const [item, left] of expected) {
      const actual = inventory.count(item);
      if (actual !== left) {
        throw new Error(
          `player ${String(this.playerId)}: Insert of item ${String(item)} moved ${String(actual - left)} too few units`,
        );
      }
    }
  }

  /** Sets the recipe of every assembling machine in `entities` in one tick. */
  *setRecipes(entities: readonly number[], recipe: number): Task {
    for (const entity of entities) {
      this.send({ type: 'SetRecipe', playerId: this.playerId, entity, recipe });
    }
    yield;
    for (const entity of entities) {
      if (this.sim.state.entities.selectedRecipe(entity) !== recipe) {
        throw new Error(`player ${String(this.playerId)}: SetRecipe on ${String(entity)} ignored`);
      }
    }
  }

  /** Makes `tech` the current research. */
  *setResearch(tech: number): Task {
    this.send({ type: 'SetResearch', playerId: this.playerId, tech });
    yield;
    if (this.sim.state.research.currentOf(0) !== tech) {
      throw new Error(`SetResearch ${String(tech)} was ignored`);
    }
  }

  /**
   * Puts two items (one per lane) on the middle of each of `belts` (all
   * within reach) every `interval` ticks, `rounds` times: `items[0]` on the
   * right lane and the last of `items` on the left. On belts that move
   * evenly by at least the item spacing in `interval` ticks every insert
   * finds room, so they end up with `2 * rounds` items each; where items
   * bunch up (behind a splitter), a belt without room at its middle gets
   * fewer (the player looks first, so every `Insert` sent applies in full).
   */
  *fillRounds(
    belts: readonly number[],
    items: readonly number[],
    rounds: number,
    interval: number,
  ): Task {
    const table = beltTable(this.sim.state.entities)!;
    const right = items[0]!;
    const left = items[items.length - 1]!;
    for (let r = 0; r < rounds; r++) {
      const insertions: Insertion[] = [];
      for (const entity of belts) {
        const room = table.insertable(entity, right);
        if (room === 2 && right !== left) {
          insertions.push({ entity, item: right, count: 1 }, { entity, item: left, count: 1 });
        } else if (room > 0) {
          insertions.push({ entity, item: r % 2 === 0 ? right : left, count: room });
        }
      }
      yield* this.insert(insertions);
      this.beltItems += insertions.reduce((n, i) => n + i.count, 0);
      if (r < rounds - 1) for (let t = 1; t < interval; t++) yield;
    }
  }
}

/** Whether a player can walk the straight row or column of tiles from `a` to `b` (inclusive). */
function lineWalkable(world: World, a: Tile, b: Tile): boolean {
  const dx = Math.sign(b.x - a.x);
  const dy = Math.sign(b.y - a.y);
  for (let x = a.x, y = a.y; ; x += dx, y += dy) {
    if (!world.isWalkable(x, y)) return false;
    if (x === b.x && y === b.y) return true;
  }
}

/**
 * Shortest 4-neighbour paths over walkable tiles from one tile, within a
 * rectangle: `route(to)` returns the axis-aligned waypoints to `to` (an
 * L-shaped walk where that is clear, else the breadth-first path), or `null`
 * when `to` can't be reached.
 */
export class Router {
  private readonly parent: Int32Array;
  private readonly w: number;
  private readonly h: number;

  constructor(
    private readonly world: World,
    private readonly from: Tile,
    private readonly x0: number,
    private readonly y0: number,
    x1: number,
    y1: number,
  ) {
    this.w = x1 - x0 + 1;
    this.h = y1 - y0 + 1;
    this.parent = new Int32Array(this.w * this.h).fill(-1);
    const start = this.index(from.x, from.y);
    const queue = new Int32Array(this.w * this.h);
    let head = 0;
    let tail = 0;
    this.parent[start] = start;
    queue[tail++] = start;
    const steps = [1, -1, this.w, -this.w];
    while (head < tail) {
      const i = queue[head++]!;
      const x = i % this.w;
      for (const s of steps) {
        const j = i + s;
        if (j < 0 || j >= this.parent.length || this.parent[j] !== -1) continue;
        if ((s === 1 && x === this.w - 1) || (s === -1 && x === 0)) continue;
        if (!world.isWalkable(x0 + (j % this.w), y0 + Math.floor(j / this.w))) continue;
        this.parent[j] = i;
        queue[tail++] = j;
      }
    }
  }

  private index(x: number, y: number): number {
    return (y - this.y0) * this.w + (x - this.x0);
  }

  /** Whether `to` can be reached from the start. */
  reaches(to: Tile): boolean {
    const { x, y } = to;
    if (x < this.x0 || y < this.y0 || x >= this.x0 + this.w || y >= this.y0 + this.h) return false;
    return this.parent[this.index(x, y)] !== -1;
  }

  /** Waypoints from the start to `to` (see the class comment). */
  route(to: Tile): Tile[] | null {
    const { from, world } = this;
    for (const corner of [
      { x: to.x, y: from.y },
      { x: from.x, y: to.y },
    ]) {
      if (lineWalkable(world, from, corner) && lineWalkable(world, corner, to)) return [corner, to];
    }
    if (!this.reaches(to)) return null;
    const path: Tile[] = [];
    for (let i = this.index(to.x, to.y); ; i = this.parent[i]!) {
      path.push({ x: this.x0 + (i % this.w), y: this.y0 + Math.floor(i / this.w) });
      if (this.parent[i] === i) break;
    }
    path.reverse();
    // Keep the corners only.
    const out: Tile[] = [];
    for (let k = 1; k < path.length; k++) {
      const prev = path[k - 1]!;
      const next = path[k + 1];
      const cur = path[k]!;
      const turn = next && (next.x - cur.x !== cur.x - prev.x || next.y - cur.y !== cur.y - prev.y);
      if (!next || turn) out.push(cur);
    }
    return out;
  }
}

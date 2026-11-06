/**
 * Builds benchmark scenes the way a player would: every change goes through
 * `Sim.enqueue` as a command (`Move`, `Place`, `Insert`), and the simulation
 * steps while the player walks and builds. The builder only *reads* state
 * (player position, entity ids, inventory counts) to steer the player and to
 * check that each command did what it should, so a scene can never reach a
 * state that normal play couldn't.
 *
 * Every helper throws when a command doesn't apply (out of reach, blocked,
 * missing items), so a scene that drifts out of sync with the simulation
 * (e.g. after a world-generation change) fails loudly instead of silently
 * benchmarking fewer entities.
 */

import type { Axis, CommandInput } from '../../src/sim/commands';
import type { Direction } from '../../src/sim/entities/direction';
import { tileCenter } from '../../src/sim/fixed';
import { PLAYER_SPEED } from '../../src/sim/player';
import type { Sim } from '../../src/sim/tick';

/** One `Place` command: an item, the top-left tile of the footprint and a direction. */
export interface Placement {
  readonly item: number;
  readonly x: number;
  readonly y: number;
  readonly dir: Direction;
}

/** One `Insert` command: items from the player's inventory into an entity. */
export interface Insertion {
  readonly entity: number;
  readonly item: number;
  readonly count: number;
}

/** Ticks a walk may take before the builder gives up (the player is stuck). */
const MAX_WALK_TICKS = 20_000;

const axisToward = (d: number): Axis => (d >= PLAYER_SPEED ? 1 : d <= -PLAYER_SPEED ? -1 : 0);

export class Builder {
  private moveX: Axis = 0;
  private moveY: Axis = 0;

  constructor(
    readonly sim: Sim,
    readonly playerId: number = 0,
  ) {}

  /** Queues `cmd` for the tick the next `step()` runs. */
  private send(cmd: CommandInput): void {
    this.sim.enqueue({ ...cmd, tick: this.sim.tick });
  }

  /** The player's position in subtiles. */
  get position(): { x: number; y: number } {
    const { players } = this.sim.state;
    return { x: players.x[this.playerId]!, y: players.y[this.playerId]! };
  }

  /**
   * Walks the player to the center of tile `(tileX, tileY)` with `Move`
   * commands, stepping the simulation as it goes, and stops it there (within
   * one tick of movement, so its collision box stays inside that tile).
   */
  walkTo(tileX: number, tileY: number): void {
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
        // The stop command still needs a tick to apply.
        this.sim.step();
        return;
      }
      if (ticks >= MAX_WALK_TICKS) {
        throw new Error(`builder got stuck walking to tile (${String(tileX)}, ${String(tileY)})`);
      }
      this.sim.step();
    }
  }

  /**
   * Places every entity of `placements` in one tick, in order, and returns
   * their ids. Throws if any of them wasn't placed.
   */
  place(placements: readonly Placement[]): number[] {
    for (const { item, x, y, dir } of placements) {
      this.send({ type: 'Place', playerId: this.playerId, item, x, y, dir });
    }
    this.sim.step();
    const { entities } = this.sim.state;
    return placements.map(({ x, y }) => {
      const id = entities.at(x, y);
      const placed = id !== 0 && entities.footprint(id).x === x && entities.footprint(id).y === y;
      if (!placed) {
        const { x: px, y: py } = this.position;
        throw new Error(
          `Place at (${String(x)}, ${String(y)}) was ignored (player at subtile ${String(px)}, ${String(py)})`,
        );
      }
      return id;
    });
  }

  /**
   * Runs every insertion of `insertions` in one tick. Throws unless all the
   * items left the player's inventory (so they all landed in the entities).
   */
  insert(insertions: readonly Insertion[]): void {
    const inventory = this.sim.state.players.inventory(this.playerId);
    const expected = new Map<number, number>();
    for (const { entity, item, count } of insertions) {
      this.send({ type: 'Insert', playerId: this.playerId, entity, item, count });
      expected.set(item, (expected.get(item) ?? inventory.count(item)) - count);
    }
    this.sim.step();
    for (const [item, left] of expected) {
      const actual = inventory.count(item);
      if (actual !== left) {
        throw new Error(
          `Insert of item ${String(item)} moved ${String(actual - left)} too few units`,
        );
      }
    }
  }
}

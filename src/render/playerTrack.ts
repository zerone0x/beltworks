/**
 * Smooth player positions between simulation ticks.
 *
 * Snapshots arrive about once per tick (60 Hz), but frames don't line up with
 * them. Each new snapshot starts a glide from where the player is drawn right
 * now to the snapshot's position, lasting as long as the ticks the snapshot
 * covers. Rendering is therefore up to one tick behind the simulation, which
 * is invisible, and the motion has no jumps when snapshots come early or late.
 *
 * Positions here are floats in subtiles; nothing flows back into the sim.
 */

import { SUBTILES_PER_TILE } from '../sim/fixed';
import { PLAYER_STRIDE, PlayerField } from '../sim/snapshot';
import { TICKS_PER_SECOND } from '../worker/protocol';

const TICK_MS = 1000 / TICKS_PER_SECOND;
/** Moves longer than this (in subtiles, per axis) snap instead of gliding, e.g. after a restart. */
export const SNAP_DISTANCE = 4 * SUBTILES_PER_TILE;

export interface TrackedPoint {
  x: number;
  y: number;
}

export class PlayerTrack {
  /** The latest snapshot's player records (see `PLAYER_STRIDE`). */
  private records: Int32Array = new Int32Array(0);
  /** Where each player was drawn when the latest snapshot arrived: x, y pairs in subtiles. */
  private from = new Float64Array(0);
  private startMs = 0;
  private durationMs = 0;

  /** Number of players in the latest snapshot. */
  get count(): number {
    return this.records.length / PLAYER_STRIDE;
  }

  /** The latest player records, as received (integers). */
  get latest(): Int32Array {
    return this.records;
  }

  /** Starts gliding towards the players in a new snapshot that covers `ticksRun` ticks. */
  push(records: Int32Array, ticksRun: number, nowMs: number): void {
    const count = records.length / PLAYER_STRIDE;
    const from = new Float64Array(count * 2);
    for (let i = 0; i < count; i++) {
      const tx = records[i * PLAYER_STRIDE + PlayerField.x]!;
      const ty = records[i * PLAYER_STRIDE + PlayerField.y]!;
      const drawn = i < this.count ? this.sample(i, nowMs) : null;
      const far =
        !drawn || Math.abs(drawn.x - tx) > SNAP_DISTANCE || Math.abs(drawn.y - ty) > SNAP_DISTANCE;
      from[2 * i] = far ? tx : drawn.x;
      from[2 * i + 1] = far ? ty : drawn.y;
    }
    this.records = records;
    this.from = from;
    this.startMs = nowMs;
    this.durationMs = Math.max(0, ticksRun) * TICK_MS;
  }

  /** Position of player `i` to draw at time `nowMs`, in subtiles, or `null` if unknown. */
  sample(i: number, nowMs: number): TrackedPoint | null {
    if (i < 0 || i >= this.count) {
      return null;
    }
    const tx = this.records[i * PLAYER_STRIDE + PlayerField.x]!;
    const ty = this.records[i * PLAYER_STRIDE + PlayerField.y]!;
    const t =
      this.durationMs > 0 ? Math.min(1, Math.max(0, (nowMs - this.startMs) / this.durationMs)) : 1;
    if (t >= 1) {
      return { x: tx, y: ty };
    }
    const fx = this.from[2 * i]!;
    const fy = this.from[2 * i + 1]!;
    return { x: fx + (tx - fx) * t, y: fy + (ty - fy) * t };
  }
}

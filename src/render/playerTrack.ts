/**
 * Smooth player positions between simulation ticks.
 *
 * Snapshots arrive about once per tick (60 Hz), but frames don't line up with
 * them. Each new snapshot starts a glide from where the player is drawn right
 * now to the snapshot's position, lasting as long as the ticks the snapshot
 * covers. Rendering is therefore up to one tick behind the simulation, which
 * is invisible, and the motion has no jumps when snapshots come early or late.
 *
 * Each player also has a walk clock (the renderer's walk cycle, D67): the
 * simulation ticks it has spent walking under its own power (a non-zero
 * walking intent in its record), glided the same way, so the cycle is timed
 * off the simulation and not the wall clock, stops dead when the player
 * stops, and doesn't run while something else (a belt) carries it.
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
  /** Walk clocks (ticks) per player: where each was when the latest snapshot arrived, and where it glides to. */
  private walkFrom = new Float64Array(0);
  private walkTo = new Float64Array(0);
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
    const walkFrom = new Float64Array(count);
    const walkTo = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const tx = records[i * PLAYER_STRIDE + PlayerField.x]!;
      const ty = records[i * PLAYER_STRIDE + PlayerField.y]!;
      const drawn = i < this.count ? this.sample(i, nowMs) : null;
      const far =
        !drawn || Math.abs(drawn.x - tx) > SNAP_DISTANCE || Math.abs(drawn.y - ty) > SNAP_DISTANCE;
      from[2 * i] = far ? tx : drawn.x;
      from[2 * i + 1] = far ? ty : drawn.y;
      const o = i * PLAYER_STRIDE;
      const walking = records[o + PlayerField.moveX] !== 0 || records[o + PlayerField.moveY] !== 0;
      // The clock glides on from where it is drawn and never loses ticks to an early snapshot.
      const known = i < this.count;
      walkFrom[i] = known ? this.walkTicks(i, nowMs) : 0;
      walkTo[i] = (known ? this.walkTo[i]! : 0) + (walking ? Math.max(0, ticksRun) : 0);
    }
    this.records = records;
    this.from = from;
    this.walkFrom = walkFrom;
    this.walkTo = walkTo;
    this.startMs = nowMs;
    this.durationMs = Math.max(0, ticksRun) * TICK_MS;
  }

  /** Whether player `i` walks under its own power in the latest snapshot. */
  walking(i: number): boolean {
    if (i < 0 || i >= this.count) return false;
    const o = i * PLAYER_STRIDE;
    return this.records[o + PlayerField.moveX] !== 0 || this.records[o + PlayerField.moveY] !== 0;
  }

  /**
   * Player `i`'s walk clock at time `nowMs`: simulation ticks spent walking,
   * interpolated between snapshots (0 if unknown).
   */
  walkTicks(i: number, nowMs: number): number {
    if (i < 0 || i >= this.count) return 0;
    const t = this.progress(nowMs);
    const from = this.walkFrom[i]!;
    return from + (this.walkTo[i]! - from) * t;
  }

  /** How far the glide towards the latest snapshot has come at `nowMs` (0..1). */
  private progress(nowMs: number): number {
    return this.durationMs > 0
      ? Math.min(1, Math.max(0, (nowMs - this.startMs) / this.durationMs))
      : 1;
  }

  /** Position of player `i` to draw at time `nowMs`, in subtiles, or `null` if unknown. */
  sample(i: number, nowMs: number): TrackedPoint | null {
    if (i < 0 || i >= this.count) {
      return null;
    }
    const tx = this.records[i * PLAYER_STRIDE + PlayerField.x]!;
    const ty = this.records[i * PLAYER_STRIDE + PlayerField.y]!;
    const t = this.progress(nowMs);
    if (t >= 1) {
      return { x: tx, y: ty };
    }
    const fx = this.from[2 * i]!;
    const fy = this.from[2 * i + 1]!;
    return { x: fx + (tx - fx) * t, y: fy + (ty - fy) * t };
  }
}

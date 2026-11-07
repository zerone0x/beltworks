/**
 * What snapshots cost, as the main thread sees them: the worker's time to
 * encode each one and its size (both carried in the snapshot), the time from
 * the worker's `postMessage` to the main thread's handler (`latency`), and
 * the main thread's time to turn the message into a snapshot and apply it to
 * the view and panels (`apply`). The render profile reads it per stage
 * (docs/TOOLING.md, "Render profile"); nothing in the game depends on it.
 */

import { percentiles, type Percentiles } from '../profile/percentiles';

/** One stage's worth of snapshots, summarized. */
export interface SnapshotCost {
  /** Snapshots received, per second of wall time. */
  rate: number;
  /** Ticks the snapshots covered, per second (UPS as the main thread saw it). */
  ups: number;
  /** Snapshots that covered more than one tick (the worker fell behind a wake-up). */
  catchUps: number;
  /** Worker time to encode one snapshot, ms. */
  encode: Percentiles;
  /** Bytes transferred per snapshot. */
  bytes: Percentiles;
  /** `postMessage` in the worker to the main thread's handler, ms. */
  latency: Percentiles;
  /** Main thread: decoding the message and applying the snapshot, ms. */
  apply: Percentiles;
}

/** Collects per-snapshot costs between `reset` and `summary`. */
export class SnapshotMeter {
  private encode: number[] = [];
  private bytes: number[] = [];
  private latency: number[] = [];
  private apply: number[] = [];
  private ticks = 0;
  private catchUps = 0;
  private since = performance.now();

  /** Records one snapshot. */
  record(encodeMs: number, bytes: number, latencyMs: number, applyMs: number, ticksRun: number) {
    this.encode.push(encodeMs);
    this.bytes.push(bytes);
    this.latency.push(latencyMs);
    this.apply.push(applyMs);
    this.ticks += ticksRun;
    if (ticksRun > 1) this.catchUps++;
    // A meter nobody reads keeps the last few minutes only.
    if (this.encode.length > 20_000) this.reset();
  }

  /** Forgets everything recorded so far. */
  reset(): void {
    this.encode = [];
    this.bytes = [];
    this.latency = [];
    this.apply = [];
    this.ticks = 0;
    this.catchUps = 0;
    this.since = performance.now();
  }

  /** The snapshots recorded since the last `reset`. */
  summary(): SnapshotCost {
    const seconds = Math.max(1e-3, (performance.now() - this.since) / 1000);
    return {
      rate: this.encode.length / seconds,
      ups: this.ticks / seconds,
      catchUps: this.catchUps,
      encode: percentiles(this.encode),
      bytes: percentiles(this.bytes),
      latency: percentiles(this.latency),
      apply: percentiles(this.apply),
    };
  }
}

/** A clock both threads share: wall time in ms, at `performance.now()` resolution. */
export function sharedNow(): number {
  return performance.timeOrigin + performance.now();
}

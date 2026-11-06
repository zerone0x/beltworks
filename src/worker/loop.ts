/**
 * Fixed-step accumulator for the worker loop. Wall time is a float here; it
 * only decides how many ticks to run and never reaches simulation state.
 */

export interface Advance {
  /** Ticks to run now. */
  ticks: number;
  /** Ticks that were due but are dropped because the backlog exceeded the cap. */
  dropped: number;
}

export class FixedStepClock {
  private last: number | null = null;
  private accumulator = 0;

  constructor(
    readonly stepMs: number,
    readonly maxTicksPerAdvance: number,
  ) {
    if (!(stepMs > 0) || !Number.isInteger(maxTicksPerAdvance) || maxTicksPerAdvance < 1) {
      throw new RangeError('stepMs must be > 0 and maxTicksPerAdvance an integer >= 1');
    }
  }

  /** Accounts for the time elapsed up to `nowMs` and returns how many ticks to run. */
  advance(nowMs: number): Advance {
    if (this.last === null) {
      this.last = nowMs;
      return { ticks: 0, dropped: 0 };
    }
    // Clamp negative deltas (a clock that went backwards) to zero.
    this.accumulator += Math.max(0, nowMs - this.last);
    this.last = nowMs;
    // The epsilon absorbs float error, e.g. 1000 / (1000 / 60) = 59.99999999999999.
    const due = Math.floor(this.accumulator / this.stepMs + 1e-9);
    this.accumulator = Math.max(0, this.accumulator - due * this.stepMs);
    // If too far behind, run the cap and forget the rest (keeping the partial tick).
    const ticks = Math.min(due, this.maxTicksPerAdvance);
    return { ticks, dropped: due - ticks };
  }

  /** Milliseconds until the next tick is due (0 if it already is). */
  msUntilNextTick(): number {
    return Math.max(0, this.stepMs - this.accumulator);
  }

  reset(): void {
    this.last = null;
    this.accumulator = 0;
  }
}

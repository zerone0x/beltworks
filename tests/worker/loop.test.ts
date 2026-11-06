import { describe, expect, it } from 'vitest';
import { FixedStepClock } from '../../src/worker/loop';
import { MAX_CATCH_UP_TICKS, TICKS_PER_SECOND } from '../../src/worker/protocol';

const STEP = 1000 / TICKS_PER_SECOND;

describe('FixedStepClock', () => {
  it('runs nothing on the first call', () => {
    const clock = new FixedStepClock(STEP, MAX_CATCH_UP_TICKS);
    expect(clock.advance(1234)).toEqual({ ticks: 0, dropped: 0 });
  });

  it('runs 60 ticks per second regardless of wake-up jitter', () => {
    const clock = new FixedStepClock(STEP, MAX_CATCH_UP_TICKS);
    clock.advance(0);
    let ticks = 0;
    // Uneven wake-ups between 5 and 30 ms, all within the catch-up cap.
    const deltas = [5, 30, 12, 17, 16, 25, 9, 21];
    let now = 0;
    for (let i = 0; now < 10_000; i++) {
      now += deltas[i % deltas.length]!;
      ticks += clock.advance(now).ticks;
    }
    expect(Math.abs(ticks - (now / 1000) * TICKS_PER_SECOND)).toBeLessThanOrEqual(1);
  });

  it('catches up at most the cap and drops the rest', () => {
    const clock = new FixedStepClock(STEP, MAX_CATCH_UP_TICKS);
    clock.advance(0);
    // One second stalled: 60 ticks due, 5 run, 55 dropped.
    expect(clock.advance(1000)).toEqual({ ticks: MAX_CATCH_UP_TICKS, dropped: 55 });
    // The backlog is gone: the next wake-up only owes the time since then.
    expect(clock.advance(1000 + STEP).ticks).toBe(1);
  });

  it('reports the time until the next tick', () => {
    const clock = new FixedStepClock(STEP, MAX_CATCH_UP_TICKS);
    clock.advance(0);
    expect(clock.msUntilNextTick()).toBeCloseTo(STEP);
    clock.advance(10);
    expect(clock.msUntilNextTick()).toBeCloseTo(STEP - 10);
    clock.advance(20);
    expect(clock.msUntilNextTick()).toBeCloseTo(2 * STEP - 20);
  });

  it('ignores a clock going backwards', () => {
    const clock = new FixedStepClock(STEP, MAX_CATCH_UP_TICKS);
    clock.advance(100);
    expect(clock.advance(50)).toEqual({ ticks: 0, dropped: 0 });
  });
});

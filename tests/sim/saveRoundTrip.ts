/**
 * The round-trip check shared by the save tests (tests/sim/save.test.ts,
 * tests/bench/save.test.ts): `loadSim(saveSim(sim))` hashes like `sim`, saves
 * to the same bytes, and then behaves identically, tick for tick.
 */

import { expect } from 'vitest';
import { loadSim, saveSim } from '../../src/sim/save/save';
import type { Sim } from '../../src/sim/tick';

const hex = (h: number): string => `0x${h.toString(16).padStart(8, '0')}`;

/**
 * Saves and loads `sim` and returns the copy, after checking that it hashes
 * the same and saves to the same bytes (so nothing was lost or reordered).
 */
export function reload(sim: Sim): Sim {
  const bytes = saveSim(sim);
  const copy = loadSim(bytes);
  expect(copy.tick, 'tick after loading').toBe(sim.tick);
  expect(hex(copy.hash()), `hash after loading at tick ${String(sim.tick)}`).toBe(hex(sim.hash()));
  const again = saveSim(copy);
  expect(again.length, 'size of the loaded copy saved again').toBe(bytes.length);
  expect(
    Buffer.from(again).equals(Buffer.from(bytes)),
    'the loaded copy saves the same bytes',
  ).toBe(true);
  return copy;
}

/**
 * Steps `a` and `b` together for `ticks` ticks, comparing their hashes after
 * every tick; fails at the first tick they differ.
 */
export function stepTogether(a: Sim, b: Sim, ticks: number): void {
  for (let i = 0; i < ticks; i++) {
    a.step();
    b.step();
    const ha = a.hash();
    const hb = b.hash();
    if (ha !== hb) {
      expect(hex(hb), `hash of the loaded copy after tick ${String(a.tick - 1)}`).toBe(hex(ha));
    }
  }
}

/** Saves and loads `sim`, then runs both for `ticks` ticks comparing hashes every tick. */
export function expectRoundTrip(sim: Sim, ticks: number): void {
  stepTogether(sim, reload(sim), ticks);
}

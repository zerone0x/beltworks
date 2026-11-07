/**
 * Simulation speed-up for e2e tests that wait on long processes (research,
 * mining, measuring a production rate): the test hook's `setTimeScale` runs
 * the simulation several times faster than real time (dev and test builds
 * only; docs/DECISIONS.md, D42). The simulation's ticks are the same, so
 * everything measured in ticks or game state stays exact.
 *
 * The player walks faster too, so tests walk and build at normal speed and
 * only speed up while the player stands still and waits.
 */

import type { Page } from '@playwright/test';

/** Sets the simulation speed: `scale` ticks per 1/60 s of wall time (1 is normal speed). */
export const setTimeScale = (page: Page, scale: number) =>
  page.evaluate((s) => {
    window.__beltworks!.setTimeScale(s);
  }, scale);

/** Runs `wait` with the simulation `scale` times faster, then goes back to normal speed. */
export async function fastForward<T>(page: Page, scale: number, wait: () => Promise<T>) {
  await setTimeScale(page, scale);
  try {
    return await wait();
  } finally {
    await setTimeScale(page, 1);
  }
}

/**
 * Turning the build ghost in e2e tests. `R` asks for a turn that the build
 * input applies on the next rendered frame, one turn per frame however many
 * presses came in. Pressing on a timer until the ghost faces the right way
 * (as specs used to, every 50 ms) races that frame on a slow software
 * renderer: presses that land in the same frame are lost, and a press sent
 * just after the frame that reached the direction turns it past it, for
 * another round of up to three turns. Each press here waits for its turn.
 */

import { expect, type Page } from '@playwright/test';

const ghostDir = (page: Page) => page.evaluate(() => window.__beltworks!.ghost()?.dir);

/** Presses `R` until the ghost faces `dir`, waiting for each turn before the next press. */
export async function turnGhost(page: Page, dir: number): Promise<void> {
  const deadline = Date.now() + 15_000;
  let now = await ghostDir(page);
  for (let turns = 0; turns < 4 && now !== dir; turns++) {
    const before = now;
    await page.keyboard.press('r');
    // A read is a round trip, about a frame on a slow page: no extra wait needed.
    while ((now = await ghostDir(page)) === before) {
      if (Date.now() > deadline) throw new Error(`the ghost didn't turn from ${String(before)}`);
      await page.waitForTimeout(10);
    }
  }
  expect(now, 'the ghost never faced the requested direction').toBe(dir);
}

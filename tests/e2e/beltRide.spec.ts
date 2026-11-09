/**
 * Belts carry the player (docs/DECISIONS.md, D66): with a test kit (D29) the
 * player lays a row of transport belts with the mouse, walks onto it with
 * the keyboard and lets go; the belt carries the player to its end, where
 * the player stops just past the last belt.
 */

import { expect, test, type Page } from '@playwright/test';
import { ENTITIES, EntityTypeId } from '../../src/data/entities';
import { Direction } from '../../src/sim/entities/direction';
import { SUBTILES_PER_TILE } from '../../src/sim/fixed';
import { player, waitUntilStill } from './walk';

const KIT = 'transport-belt:10';
/** The belts run east along row 0 from `FIRST` to `LAST` (all within build reach of the spawn). */
const FIRST = 2;
const LAST = 9;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

const belts = (page: Page) => page.evaluate(() => window.__beltworks!.belts());
const beltAt = async (page: Page, x: number, y: number) =>
  (await belts(page)).find((b) => b.x === x && b.y === y);
const ghost = (page: Page) => page.evaluate(() => window.__beltworks!.ghost());

/** Places a transport belt at tile `(x, y)` facing `dir` (pressing R until the ghost does). */
async function placeBelt(page: Page, x: number, y: number, dir: number) {
  const at = await page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
  await page.mouse.move(at.x, at.y);
  for (let i = 0; i < 4; i++) {
    const g = await ghost(page);
    if (g?.dir === dir) break;
    await page.keyboard.press('r');
    await expect.poll(async () => (await ghost(page))?.dir).not.toBe(g?.dir);
  }
  await expect
    .poll(() => ghost(page))
    .toMatchObject({ name: 'transport-belt', x, y, dir, valid: true });
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => beltAt(page, x, y)).toMatchObject({ dir });
}

test('a belt carries the player standing on it to its end', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await page.goto(`./?kit=${KIT}`);
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, -460);
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.camera())).zoom)
    .toBeGreaterThan(1.9);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });

  // The player stands at (0, 0); belts east along row 0.
  expect(await player(page)).toMatchObject({ x: 0, y: 0 });
  await page.keyboard.press('1');
  for (let x = FIRST; x <= LAST; x++) await placeBelt(page, x, 0, Direction.East);
  await page.keyboard.press('q');

  // Walk east onto the first belt, then let go of the key at once. On a
  // slow page the release takes effect a few frames later; the long run of
  // belts leaves room for that.
  await page.keyboard.down('d');
  await page.waitForFunction((x) => window.__beltworks!.player()!.x >= x, FIRST + 0.05, {
    timeout: 30_000,
  });
  await page.keyboard.up('d');
  await page.waitForTimeout(100);
  const released = await player(page);
  expect(released.x, 'the walk overshot the belts (a very slow page?)').toBeLessThan(LAST - 0.5);

  // Without any input the belt keeps carrying the player east, along row 0...
  await expect
    .poll(async () => (await player(page)).x, { timeout: 30_000 })
    .toBeGreaterThan(released.x + 1);
  expect((await player(page)).y).toBe(0);

  // ...to just past the end of the last belt, where it stops.
  const still = await waitUntilStill(page);
  const speed = ENTITIES[EntityTypeId.TransportBelt].beltSpeed! / SUBTILES_PER_TILE;
  expect(still.x).toBeGreaterThanOrEqual(LAST + 1);
  expect(still.x).toBeLessThan(LAST + 1 + speed);
  expect(still.y).toBe(0);
  expect(errors).toEqual([]);
});

/**
 * Belt tiers and underground belts end to end: with a test kit (`?kit=`,
 * dev and test builds only; docs/DECISIONS.md, D29) the player lays a
 * transport belt, an underground pair (the ghost shows the exit's reach and
 * partner before it is placed) and two fast belts with real mouse and
 * keyboard input, drops coal at the start and waits until it comes out of
 * the exit onto the fast belts.
 */

import { expect, test, type Page } from '@playwright/test';
import { EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { UndergroundMode } from '../../src/sim/belts/underground';
import { Direction } from '../../src/sim/entities/direction';

/** The test kit, in hotbar order. */
const KIT = 'transport-belt:4,underground-belt:2,fast-transport-belt:2,coal:10';
const KEY = { belt: '1', underground: '2', fast: '3' } as const;

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

/** Points the ghost at tile `(x, y)` facing `dir` (pressing R until it does). */
async function aim(page: Page, name: string, x: number, y: number, dir: number) {
  const at = await page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
  await page.mouse.move(at.x, at.y);
  for (let i = 0; i < 4; i++) {
    const g = await ghost(page);
    if (g?.dir === dir) break;
    await page.keyboard.press('r');
    await expect.poll(async () => (await ghost(page))?.dir).not.toBe(g?.dir);
  }
  await expect.poll(() => ghost(page)).toMatchObject({ name, x, y, dir, valid: true });
  return at;
}

async function place(page: Page, name: string, x: number, y: number, dir: number) {
  const at = await aim(page, name, x, y, dir);
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => beltAt(page, x, y)).toMatchObject({ dir });
}

test('items run under the ground through an underground pair onto fast belts', async ({
  page,
}, testInfo) => {
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

  const { East } = Direction;
  const y = -2;
  await page.keyboard.press(KEY.belt);
  await place(page, 'transport-belt', 1, y, East);
  await page.keyboard.press(KEY.underground);
  await aim(page, 'underground-belt', 2, y, East);
  expect((await ghost(page))?.underground).toEqual({
    mode: UndergroundMode.Entrance,
    partner: null,
  });
  await place(page, 'underground-belt', 2, y, East);
  // Three tiles on: the ghost would be the exit, paired with the entrance.
  const exitAt = await aim(page, 'underground-belt', 6, y, East);
  await expect
    .poll(async () => (await ghost(page))?.underground)
    .toEqual({ mode: UndergroundMode.Exit, partner: { x: 2, y } });
  const reach = testInfo.outputPath('underground-ghost.png');
  await page.screenshot({ path: reach });
  await testInfo.attach('underground ghost with reach and partner', {
    path: reach,
    contentType: 'image/png',
  });
  await page.mouse.click(exitAt.x, exitAt.y);
  await expect.poll(() => beltAt(page, 6, y)).toMatchObject({ mode: UndergroundMode.Exit });
  expect(await beltAt(page, 2, y)).toMatchObject({
    type: EntityTypeId.UndergroundBelt,
    mode: UndergroundMode.Entrance,
  });
  await page.keyboard.press(KEY.fast);
  await place(page, 'fast-transport-belt', 7, y, East);
  await place(page, 'fast-transport-belt', 8, y, East);
  await page.keyboard.press('q');

  // Two coal at the start (one per lane) end up at the end of the fast belts.
  expect(
    await page.evaluate(([tx, ty]) => window.__beltworks!.dropOnBelt(tx!, ty!, 3, 2), [1, y]),
  ).toBe(true);
  await expect
    .poll(async () => (await beltAt(page, 8, y))?.items.length, { timeout: 30_000 })
    .toBe(2);
  expect((await beltAt(page, 8, y))?.items.every((i) => i.item === ItemId.Coal)).toBe(true);
  expect((await beltAt(page, 8, y))?.type).toBe(EntityTypeId.FastTransportBelt);
  const shot = testInfo.outputPath('undergrounds.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('underground pair and fast belts', {
    path: shot,
    contentType: 'image/png',
  });
  expect(errors).toEqual([]);
});

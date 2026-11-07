/**
 * Splitters end to end: with a test kit (`?kit=`, dev and test builds only;
 * docs/DECISIONS.md, D29) the player lays a transport belt into the left
 * half of a splitter and a belt in front of each half with real mouse and
 * keyboard input, drops coal twice at the start and waits until each output
 * has two: each lane's items alternate between the outputs.
 */

import { expect, test, type Page } from '@playwright/test';
import { EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { SPLITTER_HALF_MODE } from '../../src/sim/belts/splitter';
import { Direction } from '../../src/sim/entities/direction';

/** The test kit, in hotbar order. */
const KIT = 'transport-belt:3,splitter:1,coal:10';
const KEY = { belt: '1', splitter: '2' } as const;

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

/** Places the selected item at tile `(x, y)` facing `dir` (pressing R until the ghost does). */
async function place(page: Page, name: string, x: number, y: number, dir: number) {
  const at = await page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
  await page.mouse.move(at.x, at.y);
  for (let i = 0; i < 4; i++) {
    const g = await ghost(page);
    if (g?.dir === dir) break;
    await page.keyboard.press('r');
    await expect.poll(async () => (await ghost(page))?.dir).not.toBe(g?.dir);
  }
  await expect.poll(() => ghost(page)).toMatchObject({ name, x, y, dir, valid: true });
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => beltAt(page, x, y)).toMatchObject({ dir });
}

test('a splitter shares the items of each lane out between its two outputs', async ({
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
  const y = -3;
  await page.keyboard.press(KEY.belt);
  await place(page, 'transport-belt', 1, y, East);
  await place(page, 'transport-belt', 3, y, East);
  await place(page, 'transport-belt', 3, y + 1, East);
  // Facing east, the splitter covers (2, y) (its left half) and (2, y + 1).
  await page.keyboard.press(KEY.splitter);
  await place(page, 'splitter', 2, y, East);
  await page.keyboard.press('q');
  expect(await beltAt(page, 2, y)).toMatchObject({
    type: EntityTypeId.Splitter,
    mode: SPLITTER_HALF_MODE,
  });
  expect(await beltAt(page, 2, y + 1)).toMatchObject({
    type: EntityTypeId.Splitter,
    mode: SPLITTER_HALF_MODE + 1,
  });

  // Two coal (one per lane) go to the left output, the next two to the right one.
  const drop = () =>
    page.evaluate(([tx, ty]) => window.__beltworks!.dropOnBelt(tx!, ty!, 3, 2), [1, y]);
  expect(await drop()).toBe(true);
  await expect.poll(async () => (await beltAt(page, 1, y))?.items.length).toBe(0);
  expect(await drop()).toBe(true);
  const coal = async (ty: number) =>
    (await beltAt(page, 3, ty))?.items.filter((i) => i.item === ItemId.Coal).length;
  await expect.poll(() => coal(y), { timeout: 30_000 }).toBe(2);
  await expect.poll(() => coal(y + 1), { timeout: 30_000 }).toBe(2);
  const shot = testInfo.outputPath('splitter.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('a splitter sharing coal out', { path: shot, contentType: 'image/png' });
  expect(errors).toEqual([]);
});

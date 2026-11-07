/**
 * An assembling machine, end to end: placed on steam power next to the
 * spawn, set to gears in its recipe picker, fed plates by hand, and its
 * gears taken out, all with real keyboard and mouse input (the test hook only
 * reads state). The page starts with a test kit (`?kit=`, dev and test builds
 * only; docs/DECISIONS.md, D29), so nothing has to be crafted first.
 */

import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { Direction } from '../../src/sim/entities/direction';
import { MachineState } from '../../src/sim/entities/machine';
import { closeWindows } from './windows';

/** The test kit, in hotbar order. */
const KIT =
  'assembling-machine-1:1,boiler:1,steam-engine:1,small-electric-pole:1,coal:5,iron-plate:20';
const KEY = { assembler: '1', boiler: '2', engine: '3', pole: '4' } as const;

/**
 * Footprints west of the spawn (the player starts on the corner of tiles
 * (-1..0, -1..0); the entity window opens on the right): the machine, a
 * steam engine facing north with its boiler below it, and a pole whose
 * supply area covers the machine and the engine.
 */
const RIG = {
  assembler: { x: -9, y: -3, w: 3, h: 3 },
  engine: { x: -5, y: -5, w: 3, h: 5 },
  boiler: { x: -5, y: 0, w: 2, h: 3 },
  pole: { x: -6, y: 0, w: 1, h: 1 },
} as const;
type Rect = (typeof RIG)[keyof typeof RIG];

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

const tileScreen = (page: Page, x: number, y: number) =>
  page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
const entityAt = async (page: Page, x: number, y: number) =>
  (await page.evaluate(() => window.__beltworks!.entities())).find(
    (e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h,
  );
const ghost = (page: Page) => page.evaluate(() => window.__beltworks!.ghost());
const count = async (page: Page, item: number) =>
  (await page.evaluate(() => window.__beltworks!.inventory()))
    .filter((s) => s.item === item)
    .reduce((n, s) => n + s.count, 0);

test('an assembling machine makes gears from plates fed by hand', async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.goto(`./?kit=${KIT}`);
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, -200);
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.camera())).zoom)
    .toBeGreaterThan(1.3);
  const panel = page.locator('#entity-panel');

  /** Selects hotbar `key` and places its item over `r` facing north. */
  const place = async (key: string, r: Rect, name: string) => {
    await page.keyboard.press(key);
    const at = await tileScreen(page, r.x + (r.w - 1) / 2, r.y + (r.h - 1) / 2);
    await page.mouse.move(at.x, at.y);
    await expect.poll(async () => (await ghost(page))?.name).toBe(name);
    expect((await ghost(page))?.dir).toBe(Direction.North);
    await expect.poll(() => ghost(page)).toMatchObject({ x: r.x, y: r.y, valid: true });
    await page.mouse.click(at.x, at.y);
    await expect.poll(async () => (await entityAt(page, r.x, r.y))?.name).toBe(name);
  };
  /** Opens the window of the entity covering `r`, with nothing in hand. */
  const openAt = async (r: Rect, name: string) => {
    await closeWindows(page);
    if ((await page.evaluate(() => window.__beltworks!.selectedSlot())) !== null) {
      await page.keyboard.press('q');
      await expect.poll(() => page.evaluate(() => window.__beltworks!.selectedSlot())).toBeNull();
    }
    const at = await tileScreen(page, r.x + 1, r.y + 1);
    await page.mouse.click(at.x, at.y);
    await expect(panel).toHaveAttribute('data-type', name);
  };

  await place(KEY.assembler, RIG.assembler, 'assembling-machine-1');
  await place(KEY.engine, RIG.engine, 'steam-engine');
  await place(KEY.boiler, RIG.boiler, 'boiler');
  await place(KEY.pole, RIG.pole, 'small-electric-pole');
  await openAt(RIG.boiler, 'boiler');
  await panel.locator('.player-inventory .slot[data-item="coal"]').click();
  await expect(panel.locator('[data-role="fuel"] .slot')).toHaveAttribute('data-item', 'coal');

  // A new machine has no recipe; its picker offers every unlocked non-smelting recipe.
  await openAt(RIG.assembler, 'assembling-machine-1');
  await expect(panel).toHaveAttribute('data-status', 'no-recipe');
  const gear = panel.locator('button.recipe[data-recipe="iron-gear-wheel"]');
  await expect(gear).toHaveAttribute('data-selected', 'false');
  await expect(panel.locator('button.recipe[data-recipe="iron-plate"]')).toHaveCount(0);
  await gear.click();
  await expect(gear).toHaveAttribute('data-selected', 'true');
  await expect(panel).toHaveAttribute('data-status', 'no-input');
  await expect(panel.locator('[data-role="recipe"]')).toHaveText(
    '2 × Iron plate → Iron gear wheel (1 s)',
  );
  await expect
    .poll(async () => (await entityAt(page, RIG.assembler.x, RIG.assembler.y))?.recipe)
    .toBeGreaterThan(0);

  // A click on the plates puts in what the input slot takes: twice the recipe, 4.
  await panel.locator('.player-inventory .slot[data-item="iron-plate"]').click();
  await expect.poll(() => count(page, ItemId.IronPlate)).toBe(16);
  const output = panel.locator('[data-role="output"] .slot');
  await expect(panel).toHaveAttribute('data-status', 'working');
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.assemblers()))[0])
    .toMatchObject({ item: ItemId.IronGearWheel, speed: 1 });
  await expect(panel.locator('[data-role="power"]')).toHaveText('Power: 75 kW / 75 kW');
  await expect(output).toHaveAttribute('data-item', 'iron-gear-wheel', { timeout: 20_000 });
  const shot = testInfo.outputPath('m3-assembler.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('an assembling machine making gears, with its recipe picker', {
    path: shot,
    contentType: 'image/png',
  });

  // Both gears done (one per second at speed 1/2), then it waits for plates.
  await expect(output).toHaveAttribute('data-count', '2', { timeout: 20_000 });
  await expect(panel).toHaveAttribute('data-status', 'no-input');
  expect((await entityAt(page, RIG.assembler.x, RIG.assembler.y))?.status).toBe(
    MachineState.NoInput,
  );
  await output.click();
  await expect.poll(() => count(page, ItemId.IronGearWheel)).toBe(2);
  await expect(output).toHaveAttribute('data-count', '0');
  expect(errors).toEqual([]);
});

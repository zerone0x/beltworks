/**
 * Blueprints (D59), end to end with real input: a small factory (an
 * assembling machine making gears, the inserter and chest feeding it, a
 * belt) is copied with the copy key and a dragged box, pasted elsewhere
 * (recipe included), saved to the library, exported as a string,
 * re-imported, and pasted again turned a quarter turn. Kept short: the
 * factory is placed right next to the spawn from a test kit (`?kit=`, D29).
 */

import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { Direction } from '../../src/sim/entities/direction';
import { turnGhost } from './ghost';
import { frames } from './walk';
import { closeWindows } from './windows';

const KIT = 'assembling-machine-1:3,burner-inserter:3,wooden-chest:3,transport-belt:3';

const tileScreen = (page: Page, x: number, y: number) =>
  page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
const blueprint = (page: Page) => page.evaluate(() => window.__beltworks!.blueprint());
/** The entities as name, top-left tile, direction and recipe (> 0 when set). */
const layout = (page: Page) =>
  page.evaluate(() =>
    window
      .__beltworks!.entities()
      .map((e) => `${e.name}@${String(e.x)},${String(e.y)}:${String(e.dir)}${e.recipe ? '+r' : ''}`)
      .sort(),
  );
/** Where a blueprint's ghosts start (the top-left corner of the blueprint), and whether all are green. */
const ghostOrigin = async (page: Page) => {
  const { ghosts } = await blueprint(page);
  if (ghosts.length === 0) return null;
  return {
    x: Math.min(...ghosts.map((g) => g.x)),
    y: Math.min(...ghosts.map((g) => g.y)),
    valid: ghosts.every((g) => g.valid),
  };
};

test('copy a small factory, paste it, export and re-import its string', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto(`./?kit=${KIT}`);
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });

  /** Selects hotbar `key`, turns its ghost to `dir`, and places it with its top-left tile at `(x, y)`. */
  const place = async (key: string, x: number, y: number, size: number, dir: number) => {
    await page.keyboard.press(key);
    const at = await tileScreen(page, x + (size - 1) / 2, y + (size - 1) / 2);
    await page.mouse.move(at.x, at.y);
    await expect.poll(() => page.evaluate(() => window.__beltworks!.ghost()?.valid)).toBe(true);
    await turnGhost(page, dir);
    await page.mouse.click(at.x, at.y);
    await expect
      .poll(async () => (await layout(page)).some((e) => e.includes(`@${String(x)},${String(y)}:`)))
      .toBe(true);
  };
  // West of the spawn: the machine (3 × 3), the inserter feeding it from the chest, a belt.
  await place('1', -9, -3, 3, Direction.North);
  await place('2', -6, -2, 1, Direction.West);
  await place('3', -5, -2, 1, Direction.North);
  await place('4', -6, 0, 1, Direction.East);
  await page.keyboard.press('q');
  await expect.poll(() => page.evaluate(() => window.__beltworks!.selectedSlot())).toBeNull();
  // Gears, in the machine's window.
  const machine = await tileScreen(page, -8, -2);
  await page.mouse.click(machine.x, machine.y);
  const panel = page.locator('#entity-panel');
  await panel.locator('button.recipe[data-recipe="iron-gear-wheel"]').click();
  await closeWindows(page);
  const original = [
    'assembling-machine-1@-9,-3:0+r',
    'burner-inserter@-6,-2:3',
    'transport-belt@-6,0:1',
    'wooden-chest@-5,-2:0',
  ];
  await expect.poll(() => layout(page)).toEqual(original);

  // Copy: the key, then a box dragged over the factory.
  await page.keyboard.press('c');
  await expect.poll(async () => (await blueprint(page)).mode).toBe('select');
  const from = await tileScreen(page, -9, -3);
  const to = await tileScreen(page, -5, 0);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await expect
    .poll(async () => (await blueprint(page)).box)
    .toEqual({ x0: -9, y0: -3, x1: -5, y1: 0 });
  await page.mouse.up();
  await expect
    .poll(() => blueprint(page))
    .toMatchObject({ mode: 'paste', clipboard: 4, width: 5, height: 4 });

  // Paste east of the spawn: the ghosts follow the cursor, all green, then a click.
  const target = await tileScreen(page, 4, -2);
  await page.mouse.move(target.x, target.y);
  await expect.poll(() => ghostOrigin(page)).toEqual({ x: 2, y: -3, valid: true });
  await frames(page);
  const ghostShot = testInfo.outputPath('m5-blueprint-ghost.png');
  await page.screenshot({ path: ghostShot });
  await testInfo.attach('the copied factory and its blueprint ghost', {
    path: ghostShot,
    contentType: 'image/png',
  });
  await page.mouse.click(target.x, target.y);
  // The copy, recipe included (set once the machine showed up in a snapshot).
  const moved = (dx: number, dy: number) =>
    original.map((e) =>
      e.replace(
        /@(-?\d+),(-?\d+)/,
        (_, x: string, y: string) => `@${String(Number(x) + dx)},${String(Number(y) + dy)}`,
      ),
    );
  await expect.poll(() => layout(page)).toEqual([...original, ...moved(11, 0)].sort());

  // The library: save the clipboard, export its string, import it back.
  await page.keyboard.press('q');
  await expect.poll(async () => (await blueprint(page)).mode).toBe('idle');
  await page.keyboard.press('b');
  const library = page.locator('#blueprint-panel');
  await expect(library).toBeVisible();
  await expect(library.locator('[data-role="clipboard"]')).toHaveText('Copied: 4 entities');
  await library.locator('[data-role="name"]').fill('Gear cell');
  await library.locator('[data-role="save"]').click();
  const rows = library.locator('.blueprint');
  await expect(rows).toHaveCount(1);
  await rows.first().locator('[data-action="export"]').click();
  const field = library.locator('[data-role="string"]');
  await expect(field).toHaveValue(/^BW1\.[A-Za-z0-9_-]+$/);
  const text = await field.inputValue();
  await field.fill('BW1.not-a-blueprint');
  await library.locator('[data-role="import"]').click();
  await expect(library.locator('[data-role="status"]')).toContainText('damaged');
  await field.fill(text);
  await library.locator('[data-role="import"]').click();
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(1)).toHaveAttribute('data-name', 'Gear cell');
  await expect(library.locator('[data-role="status"]')).toHaveText(
    'Imported “Gear cell” (4 entities).',
  );
  const panelShot = testInfo.outputPath('m5-blueprint-library.png');
  await page.screenshot({ path: panelShot });
  await testInfo.attach('the blueprint library after exporting and re-importing', {
    path: panelShot,
    contentType: 'image/png',
  });
  // Saved in the browser, not in the game.
  expect(
    await page.evaluate(
      () =>
        (JSON.parse(localStorage.getItem('beltworks.blueprints')!) as { entries: unknown[] })
          .entries.length,
    ),
  ).toBe(2);

  // Paste the imported one turned a quarter turn, south of the spawn.
  await rows.nth(1).locator('[data-action="paste"]').click();
  await expect(library).toBeHidden();
  await expect.poll(async () => (await blueprint(page)).mode).toBe('paste');
  const south = await tileScreen(page, -4, 4);
  await page.mouse.move(south.x, south.y);
  await page.keyboard.press('r');
  await expect.poll(async () => (await blueprint(page)).width).toBe(4);
  await expect.poll(() => ghostOrigin(page)).toEqual({ x: -5, y: 2, valid: true });
  await page.mouse.click(south.x, south.y);
  const turned = [
    'assembling-machine-1@-4,2:0+r',
    'burner-inserter@-3,5:0',
    'transport-belt@-5,5:2',
    'wooden-chest@-3,6:0',
  ];
  await expect.poll(() => layout(page)).toEqual([...original, ...moved(11, 0), ...turned].sort());
  // Out of items: the kit had three of each, so a fourth copy is skipped with a message.
  await page.mouse.move(target.x, target.y + 300);
  await page.mouse.click(target.x, target.y + 300);
  await expect(page.locator('#save-toast')).toContainText('Pasted');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await blueprint(page)).mode).toBe('idle');
  await expect(page.locator('#game-menu')).toBeHidden();
  // All three machines show their product.
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.__beltworks!.assemblers())).map((m) => m.item),
    )
    .toEqual([ItemId.IronGearWheel, ItemId.IronGearWheel, ItemId.IronGearWheel]);
  await frames(page);
  const pastedShot = testInfo.outputPath('m5-blueprint-pasted.png');
  await page.screenshot({ path: pastedShot });
  await testInfo.attach('the factory, its copy, and the imported copy turned a quarter turn', {
    path: pastedShot,
    contentType: 'image/png',
  });
  expect(errors).toEqual([]);
});

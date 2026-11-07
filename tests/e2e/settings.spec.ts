/**
 * Settings, hotbar management and the cursor stack (#88): rebinding a key,
 * the UI scale, pinning items to hotbar slots, and moving stacks with the
 * cursor between inventory slots and into a chest.
 */

import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { STARTING_KIT } from '../../src/data/start';
import { closeWindows } from './windows';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

async function open(page: Page): Promise<void> {
  await page.goto('./');
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });
}

/** Opens the settings from the game menu. */
async function openSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.locator('#menu-settings').click();
  await expect(page.locator('#settings-panel')).toBeVisible();
}

const kitSlot = (item: number): number => STARTING_KIT.findIndex((s) => s.item === item);
const inventory = (page: Page) => page.evaluate(() => window.__beltworks!.inventory());
const selected = (page: Page) => page.evaluate(() => window.__beltworks!.selectedSlot());
const ghostName = async (page: Page) =>
  (await page.evaluate(() => window.__beltworks!.ghost()))?.name;

test('a rebound key works at once, shows in the help, and is remembered', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  await openSettings(page);
  const key = page.locator('#key-inventory');
  await expect(key).toHaveText('E');
  await key.click();
  await expect(key).toHaveText('Press a key…');
  // Escape cancels; a key another action has swaps with it.
  await page.keyboard.press('Escape');
  await expect(key).toHaveText('E');
  await expect(page.locator('#settings-panel')).toBeVisible();
  await key.click();
  await page.keyboard.press('r');
  await expect(key).toHaveText('R');
  await expect(page.locator('#key-rotate')).toHaveText('E');
  await key.click();
  await page.keyboard.press('i');
  await expect(key).toHaveText('I');
  await expect(page.locator('#key-rotate')).toHaveText('E');
  await page.locator('#keys-reset').click();
  await expect(key).toHaveText('E');
  await expect(page.locator('#key-rotate')).toHaveText('R');
  await key.click();
  await page.keyboard.press('i');
  await expect(key).toHaveText('I');
  await closeWindows(page);
  await expect(page.locator('#game-menu')).toBeHidden();

  const panel = page.locator('#inventory-panel');
  await page.keyboard.press('i');
  await expect(panel).toBeVisible();
  await page.keyboard.press('i');
  await expect(panel).toBeHidden();
  await page.keyboard.press('e');
  await page.waitForTimeout(200);
  await expect(panel).toBeHidden();
  await page.keyboard.press('h');
  const help = page.locator('#help-panel');
  await expect(help.getByRole('cell', { name: 'I', exact: true })).toBeVisible();
  await page.keyboard.press('h');

  await page.reload();
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.keyboard.press('i');
  await expect(panel).toBeVisible();
  expect(errors).toEqual([]);
});

test('the UI scale grows the hotbar and panels around where they sit; graphics options apply', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await open(page);
  const hotbar = page.locator('#hotbar');
  const before = (await hotbar.boundingBox())!;
  await openSettings(page);
  await page.locator('#setting-ui-scale').selectOption('1.5');
  // The graphics options apply on the spot, too (here: without errors).
  await page.locator('#setting-shadows').uncheck();
  await page.locator('#setting-animation').uncheck();
  await page.locator('#setting-terrain-detail').selectOption('low');
  await closeWindows(page);
  await expect
    .poll(async () => (await hotbar.boundingBox())!.width)
    .toBeCloseTo(before.width * 1.5, 0);
  const after = (await hotbar.boundingBox())!;
  // Still centered, still on the bottom edge.
  expect(after.x + after.width / 2).toBeCloseTo(before.x + before.width / 2, 0);
  expect(after.y + after.height).toBeCloseTo(before.y + before.height, 0);
  // The hotbar still takes clicks where it is drawn now.
  const slot = hotbar.locator('.slot[data-slot="0"]');
  await slot.click();
  await expect.poll(() => selected(page)).toBe(0);
  await page.keyboard.press('e');
  const panel = (await page.locator('#inventory-panel').boundingBox())!;
  expect(panel.x).toBeCloseTo(8, 0);
  expect(panel.y).toBeCloseTo(64, 0);
  expect(errors).toEqual([]);
});

test('items are pinned to hotbar slots with Alt and a key or a drag, and unpinned with a middle click', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await open(page);
  const hotbarSlot = (i: number) => page.locator(`#hotbar .slot[data-slot="${String(i)}"]`);
  const invSlot = (i: number) => page.locator(`#inventory-panel .slot[data-slot="${String(i)}"]`);
  const inserters = kitSlot(ItemId.ElectricInserter);
  expect(inserters).toBeGreaterThanOrEqual(10);
  await expect(hotbarSlot(2)).toHaveAttribute('data-item', 'burner-mining-drill');

  // Alt+3 with the mouse over the electric inserters in the inventory window.
  await page.keyboard.press('e');
  await invSlot(inserters).hover();
  await page.keyboard.press('Alt+Digit3');
  await expect(hotbarSlot(2)).toHaveAttribute('data-item', 'electric-inserter');
  await expect(hotbarSlot(2)).toHaveAttribute('data-pinned', 'true');
  await expect(hotbarSlot(2)).toHaveAttribute('data-count', '4');
  expect((await page.evaluate(() => window.__beltworks!.hotbarPins()))[2]).toBe(
    'electric-inserter',
  );
  await page.keyboard.press('e');
  // Its key takes the inserters from wherever they are in the inventory.
  await page.keyboard.press('3');
  await expect.poll(() => selected(page)).toBe(inserters);
  await expect(page.locator('#hotbar')).toHaveAttribute('data-selected', '2');
  await page.mouse.move(400, 300);
  await expect.poll(() => ghostName(page)).toBe('electric-inserter');
  await page.keyboard.press('q');

  // A drag from the inventory pins too.
  await page.keyboard.press('e');
  const coal = kitSlot(ItemId.Coal);
  await invSlot(coal).hover();
  await page.mouse.down();
  await hotbarSlot(7).hover();
  await page.mouse.up();
  await expect(hotbarSlot(7)).toHaveAttribute('data-item', 'coal');
  await expect(hotbarSlot(7)).toHaveAttribute('data-pinned', 'true');
  // Nothing was picked up or moved by the drag.
  expect(await selected(page)).toBeNull();
  expect((await inventory(page))[coal]).toEqual({ item: ItemId.Coal, count: 10 });

  // A middle click unpins: the slot shows its inventory slot again.
  await hotbarSlot(2).click({ button: 'middle' });
  await expect(hotbarSlot(2)).toHaveAttribute('data-pinned', 'false');
  await expect(hotbarSlot(2)).toHaveAttribute('data-item', 'burner-mining-drill');
  expect(errors).toEqual([]);
});

test('the cursor picks up stacks and puts them into other slots and a chest', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  const invSlot = (i: number) => page.locator(`#inventory-panel .slot[data-slot="${String(i)}"]`);
  const coal = kitSlot(ItemId.Coal);
  const cursor = page.locator('#cursor-stack');

  await page.keyboard.press('e');
  // Pick up the coal and put it in slot 30.
  await invSlot(coal).click();
  await expect.poll(() => selected(page)).toBe(coal);
  await expect(cursor).toBeVisible();
  await expect(cursor).toHaveAttribute('data-count', '10');
  await invSlot(30).click();
  await expect
    .poll(async () => (await inventory(page))[30])
    .toEqual({ item: ItemId.Coal, count: 10 });
  expect((await inventory(page))[coal]!.count).toBe(0);
  expect(await selected(page)).toBeNull();
  await expect(cursor).toBeHidden();
  // Half of it (a right click) into slot 31.
  await invSlot(30).click({ button: 'right' });
  await expect(cursor).toHaveAttribute('data-count', '5');
  await invSlot(31).click();
  await expect
    .poll(async () => (await inventory(page))[31])
    .toEqual({ item: ItemId.Coal, count: 5 });
  expect((await inventory(page))[30]).toEqual({ item: ItemId.Coal, count: 5 });
  // A whole stack onto another item swaps the two.
  const belts = kitSlot(ItemId.TransportBelt);
  await invSlot(31).click();
  await invSlot(belts).click();
  await expect.poll(async () => (await inventory(page))[belts]!.item).toBe(ItemId.Coal);
  expect((await inventory(page))[31]).toEqual({ item: ItemId.TransportBelt, count: 10 });
  await page.keyboard.press('e');

  // A wooden chest next to the player, then the coal from slot 30 into it.
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, -460);
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.camera())).zoom)
    .toBeGreaterThan(1.9);
  const at = await page.evaluate(() => window.__beltworks!.tileToScreen(2, 0));
  await page.keyboard.press(String(kitSlot(ItemId.WoodenChest) + 1));
  await page.mouse.move(at.x, at.y);
  await expect.poll(() => ghostName(page)).toBe('wooden-chest');
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.ghost()))?.valid)
    .toBe(true);
  await page.mouse.click(at.x, at.y);
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.entities())).length)
    .toBe(1);
  await page.keyboard.press('q');
  await page.mouse.click(at.x, at.y);
  const panel = page.locator('#entity-panel');
  await expect(panel).toHaveAttribute('data-type', 'wooden-chest');
  // The hotbar key of the coal (now in the belts' slot) puts it on the cursor,
  // and a click on the chest's slots puts it in (without the cursor, that
  // click would take from the chest, D11).
  await page.keyboard.press(String(belts + 1));
  await expect.poll(() => page.evaluate(() => window.__beltworks!.cursorCount())).toBe(5);
  await expect(cursor).toHaveAttribute('data-count', '5');
  await panel.locator('.entity-slots .slot').first().click();
  await expect(panel.locator('.entity-slots .slot[data-item="coal"]')).toHaveAttribute(
    'data-count',
    '5',
  );
  const coalLeft = async () =>
    (await inventory(page)).reduce((n, s) => n + (s.item === ItemId.Coal ? s.count : 0), 0);
  await expect.poll(coalLeft).toBe(5);
  expect(await selected(page)).toBeNull();
  await closeWindows(page);
  expect(errors).toEqual([]);
});

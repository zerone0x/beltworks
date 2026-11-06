/**
 * UX follow-ups from playing the M1 build (#36): splitting stacks in entity
 * windows, clickable hotbar slots, and item icons readable on belts at 1×;
 * and from M2 (#42): selecting items in the inventory window, and the pipette.
 */

import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { STARTING_KIT } from '../../src/data/start';
import { TILE_PX } from '../../src/render/camera';
import { Direction } from '../../src/sim/entities/direction';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

async function open(page: Page, zoomIn = true): Promise<void> {
  await page.goto('./');
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });
  if (!zoomIn) return;
  // Zoom in around the player (the camera follows it), so tiles are easy to hit.
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, -460);
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.camera())).zoom)
    .toBeGreaterThan(1.9);
  await page.waitForFunction(() => window.__beltworks!.terrainReady());
}

/** Screen position of the center of tile `(x, y)`, or of its top-left corner. */
async function tileScreen(page: Page, x: number, y: number, corner = false) {
  const at = await page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
  const zoom = (await page.evaluate(() => window.__beltworks!.camera())).zoom;
  const shift = corner ? (TILE_PX / 2) * zoom : 0;
  return { x: at.x - shift, y: at.y - shift };
}

const countOf = async (page: Page, item: number) =>
  (await page.evaluate(() => window.__beltworks!.inventory())).reduce(
    (n, s) => n + (s.item === item ? s.count : 0),
    0,
  );
const entities = (page: Page) => page.evaluate(() => window.__beltworks!.entities());
const entityAt = async (page: Page, x: number, y: number) =>
  (await entities(page)).find((e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h);
const ghost = (page: Page) => page.evaluate(() => window.__beltworks!.ghost());
const selected = (page: Page) => page.evaluate(() => window.__beltworks!.selectedSlot());
/** Hotbar key (`1`–`0`) of the starting-kit slot holding `item`. */
const keyFor = (item: number): string => String(STARTING_KIT.findIndex((s) => s.item === item) + 1);

/**
 * Places the item of hotbar key `key` with the cursor at `at`, the ghost
 * facing `dir`, and waits for the entity to show up on tile `(x, y)`.
 */
async function place(
  page: Page,
  key: string,
  at: { x: number; y: number },
  tile: { x: number; y: number },
  dir: number = Direction.North,
): Promise<void> {
  if ((await selected(page)) !== Number(key) - 1) await page.keyboard.press(key);
  await page.mouse.move(at.x, at.y);
  for (let i = 0; i < 4 && (await ghost(page))?.dir !== dir; i++) {
    const before = (await ghost(page))?.dir;
    await page.keyboard.press('r');
    await expect.poll(async () => (await ghost(page))?.dir).not.toBe(before);
  }
  await expect.poll(async () => (await ghost(page))?.valid).toBe(true);
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => entityAt(page, tile.x, tile.y)).toBeTruthy();
}

test('entity windows move one item, half or the whole stack, both ways', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  // A furnace on tiles (2..3, -1..0): the cursor on the corner between them.
  await place(page, keyFor(ItemId.StoneFurnace), await tileScreen(page, 3, 0, true), {
    x: 2,
    y: -1,
  });
  await page.keyboard.press('q');
  const center = await tileScreen(page, 3, 0, true);
  await page.mouse.click(center.x, center.y);
  const panel = page.locator('#entity-panel');
  await expect(panel).toHaveAttribute('data-type', 'stone-furnace');

  const coal = panel.locator('.player-inventory .slot[data-item="coal"]');
  const fuel = panel.locator('[data-role="fuel"] .slot');
  const expectCounts = async (inFurnace: number, inInventory: number) => {
    await expect(fuel).toHaveAttribute('data-count', String(inFurnace));
    await expect.poll(() => countOf(page, ItemId.Coal)).toBe(inInventory);
  };
  await expectCounts(0, 10);

  // In: ctrl-click and middle click move one item each, right click half
  // (rounded up), shift-click the rest of the stack.
  await coal.click({ modifiers: ['Control'] });
  await expectCounts(1, 9);
  await coal.click({ button: 'middle' });
  await expectCounts(2, 8);
  await coal.click({ button: 'right' });
  await expectCounts(6, 4);
  await coal.click({ modifiers: ['Shift'] });
  await expectCounts(10, 0);
  await expect(coal).toHaveCount(0);

  // Out of the fuel slot, the same way.
  await fuel.click({ modifiers: ['Control'] });
  await expectCounts(9, 1);
  await fuel.click({ button: 'middle' });
  await expectCounts(8, 2);
  await fuel.click({ button: 'right' });
  await expectCounts(4, 6);
  await fuel.click();
  await expectCounts(0, 10);

  // One coal each for every machine of the starting kit is now possible.
  for (let i = 0; i < 3; i++) await coal.click({ modifiers: ['Control'] });
  await expectCounts(3, 7);
  expect(errors).toEqual([]);
});

test('hotbar slots select on click, and a right click or Q deselects', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  const hotbar = page.locator('#hotbar');
  const slot = (i: number) => hotbar.locator(`.slot[data-slot="${String(i)}"]`);
  const beltSlot = STARTING_KIT.findIndex((s) => s.item === ItemId.TransportBelt);
  const chestSlot = STARTING_KIT.findIndex((s) => s.item === ItemId.WoodenChest);

  await slot(beltSlot).click();
  await expect.poll(() => selected(page)).toBe(beltSlot);
  await expect(hotbar).toHaveAttribute('data-selected', String(beltSlot));
  await expect(slot(beltSlot)).toHaveAttribute('data-selected', 'true');
  // The ghost follows the cursor once it is back over the game.
  const at = await tileScreen(page, 2, 2);
  await page.mouse.move(at.x, at.y);
  await expect.poll(async () => (await ghost(page))?.name).toBe('transport-belt');

  // Clicking the selected slot again deselects; the click never reaches the game below.
  await slot(beltSlot).click();
  await expect.poll(() => selected(page)).toBeNull();
  await expect(hotbar).toHaveAttribute('data-selected', '');
  await slot(chestSlot).click();
  await expect.poll(() => selected(page)).toBe(chestSlot);
  await slot(beltSlot).click({ button: 'right' });
  await expect.poll(() => selected(page)).toBeNull();
  await slot(chestSlot).click();
  await expect.poll(() => selected(page)).toBe(chestSlot);
  await page.keyboard.press('q');
  await expect.poll(() => selected(page)).toBeNull();
  // A click on an empty slot selects it too, like its number key.
  await slot(9).click();
  await expect.poll(() => selected(page)).toBe(9);

  expect(await entities(page)).toEqual([]);
  expect(await countOf(page, ItemId.TransportBelt)).toBe(STARTING_KIT[beltSlot]!.count);
  expect(errors).toEqual([]);
});

test('an item past the hotbar is selected in the inventory and placed with the mouse', async ({
  page,
}, testInfo) => {
  const errors = collectErrors(page);
  await open(page);
  const inventory = page.locator('#inventory-panel');
  const hotbar = page.locator('#hotbar');
  const invSlot = (item: string) => inventory.locator(`.slot[data-item="${item}"]`);
  const kitSlot = STARTING_KIT.findIndex((s) => s.item === ItemId.ElectricInserter);
  expect(kitSlot).toBeGreaterThanOrEqual(10);

  await page.keyboard.press('e');
  await expect(inventory).toBeVisible();
  // Coal places nothing: a click on it selects nothing.
  await invSlot('coal').click();
  await page.waitForTimeout(200);
  expect(await selected(page)).toBeNull();
  // An electric inserter, past the hotbar: selected, highlighted in the
  // inventory and not in the hotbar.
  await invSlot('electric-inserter').click();
  await expect.poll(() => selected(page)).toBe(kitSlot);
  await expect(inventory).toHaveAttribute('data-selected', String(kitSlot));
  await expect(invSlot('electric-inserter')).toHaveAttribute('data-selected', 'true');
  await expect(hotbar).toHaveAttribute('data-selected', '');
  // Again deselects, a right click too.
  await invSlot('electric-inserter').click();
  await expect.poll(() => selected(page)).toBeNull();
  await invSlot('electric-inserter').click();
  await expect.poll(() => selected(page)).toBe(kitSlot);
  await invSlot('coal').click({ button: 'right' });
  await expect.poll(() => selected(page)).toBeNull();
  // A hotbar item clicked in the inventory selects its hotbar slot.
  await invSlot('wooden-chest').click();
  const chestSlot = STARTING_KIT.findIndex((s) => s.item === ItemId.WoodenChest);
  await expect.poll(() => selected(page)).toBe(chestSlot);
  await expect(hotbar).toHaveAttribute('data-selected', String(chestSlot));

  await invSlot('electric-inserter').click();
  await expect.poll(() => selected(page)).toBe(kitSlot);
  // Its ghost follows the cursor over the game next to the window.
  const first = await tileScreen(page, 2, 2);
  await page.mouse.move(first.x, first.y);
  await expect.poll(async () => (await ghost(page))?.name).toBe('electric-inserter');
  const shot = testInfo.outputPath('ux-inventory-select.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('an electric inserter selected in the inventory', {
    path: shot,
    contentType: 'image/png',
  });
  // The selection stays when the window closes.
  await page.keyboard.press('e');
  await expect(inventory).toBeHidden();
  expect(await selected(page)).toBe(kitSlot);

  // All four, east along y = 2: the selection is dropped with the last one.
  const kitCount = STARTING_KIT[kitSlot]!.count;
  for (let i = 0; i < kitCount; i++) {
    const x = 2 + i;
    const at = await tileScreen(page, x, 2);
    await page.mouse.move(at.x, at.y);
    await expect.poll(async () => (await ghost(page))?.name).toBe('electric-inserter');
    for (let r = 0; r < 4 && (await ghost(page))?.dir !== Direction.East; r++) {
      const before = (await ghost(page))?.dir;
      await page.keyboard.press('r');
      await expect.poll(async () => (await ghost(page))?.dir).not.toBe(before);
    }
    await expect.poll(() => ghost(page)).toMatchObject({ x, y: 2, valid: true });
    await page.mouse.click(at.x, at.y);
    await expect.poll(async () => (await entityAt(page, x, 2))?.name).toBe('electric-inserter');
    await expect.poll(() => countOf(page, ItemId.ElectricInserter)).toBe(kitCount - i - 1);
  }
  await expect.poll(() => selected(page)).toBeNull();
  await expect.poll(() => ghost(page)).toBeNull();
  expect((await entityAt(page, 2, 2))?.dir).toBe(Direction.East);
  expect(errors).toEqual([]);
});

test('Q with nothing selected picks the item of the entity under the cursor', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  const beltSlot = STARTING_KIT.findIndex((s) => s.item === ItemId.TransportBelt);
  const kitSlot = STARTING_KIT.findIndex((s) => s.item === ItemId.ElectricInserter);
  // A belt facing east at (2, 2), and an electric inserter (from the inventory) at (3, 2).
  const belt = await tileScreen(page, 2, 2);
  await place(page, keyFor(ItemId.TransportBelt), belt, { x: 2, y: 2 }, Direction.East);
  await page.keyboard.press('q');
  await page.keyboard.press('e');
  await page.locator('#inventory-panel .slot[data-item="electric-inserter"]').click();
  await page.keyboard.press('e');
  const ins = await tileScreen(page, 3, 2);
  await page.mouse.move(ins.x, ins.y);
  await expect.poll(() => ghost(page)).toMatchObject({ name: 'electric-inserter', valid: true });
  await page.mouse.click(ins.x, ins.y);
  await expect.poll(async () => (await entityAt(page, 3, 2))?.name).toBe('electric-inserter');
  await page.keyboard.press('q');
  await expect.poll(() => selected(page)).toBeNull();

  // Over the belt: the belt's hotbar slot is selected, the ghost facing east.
  await page.mouse.move(belt.x, belt.y);
  await page.keyboard.press('q');
  await expect.poll(() => selected(page)).toBe(beltSlot);
  await expect
    .poll(() => ghost(page))
    .toMatchObject({ name: 'transport-belt', dir: Direction.East });
  await page.keyboard.press('r');
  await expect.poll(async () => (await ghost(page))?.dir).toBe(Direction.South);
  // Q deselects; Q again picks it up again, facing the belt's way.
  await page.keyboard.press('q');
  await expect.poll(() => selected(page)).toBeNull();
  await page.keyboard.press('q');
  await expect
    .poll(() => ghost(page))
    .toMatchObject({ name: 'transport-belt', dir: Direction.East });
  await page.keyboard.press('q');
  await expect.poll(() => selected(page)).toBeNull();

  // Over the inserter: the remaining ones, past the hotbar.
  await page.mouse.move(ins.x, ins.y);
  await page.keyboard.press('q');
  await expect.poll(() => selected(page)).toBe(kitSlot);
  await page.keyboard.press('q');
  await expect.poll(() => selected(page)).toBeNull();
  // Over empty ground: nothing.
  const ground = await tileScreen(page, 2, 4);
  await page.mouse.move(ground.x, ground.y);
  await page.keyboard.press('q');
  await page.waitForTimeout(200);
  expect(await selected(page)).toBeNull();
  // Over a chest with none left in the inventory: nothing either.
  const chestKey = keyFor(ItemId.WoodenChest);
  const chests = STARTING_KIT.find((s) => s.item === ItemId.WoodenChest)!.count;
  for (let i = 0; i < chests; i++) {
    await place(page, chestKey, await tileScreen(page, 2 + i, 4), { x: 2 + i, y: 4 });
  }
  await page.keyboard.press('q');
  await expect.poll(() => selected(page)).toBeNull();
  await page.keyboard.press('q');
  await page.waitForTimeout(200);
  expect(await selected(page)).toBeNull();
  expect(errors).toEqual([]);
});

test('items on belts and in inserter hands are readable icons at 1×', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await open(page, false);
  expect((await page.evaluate(() => window.__beltworks!.camera())).zoom).toBe(1);

  // Belts east along y = 2 from x = -4 to 3, an inserter at (4, 2) and a chest at (5, 2).
  const beltKey = keyFor(ItemId.TransportBelt);
  for (let x = -4; x <= 3; x++) {
    await place(page, beltKey, await tileScreen(page, x, 2), { x, y: 2 }, Direction.East);
  }
  const inserterKey = keyFor(ItemId.BurnerInserter);
  await place(page, inserterKey, await tileScreen(page, 4, 2), { x: 4, y: 2 }, Direction.East);
  await place(page, keyFor(ItemId.WoodenChest), await tileScreen(page, 5, 2), { x: 5, y: 2 });
  await page.keyboard.press('q');
  await page.mouse.move(1, 1);

  // What's left of the kit at the start of the line, two at a time (one per
  // lane): the inserter fuels itself with the first coal and moves the rest
  // into the chest.
  const drops: [number, number][] = [
    [ItemId.Coal, 2],
    [ItemId.TransportBelt, 2],
    [ItemId.BurnerInserter, 2],
    [ItemId.WoodenChest, 1],
    [ItemId.StoneFurnace, 2],
    [ItemId.Coal, 2],
    [ItemId.BurnerMiningDrill, 2],
    [ItemId.Coal, 2],
  ];
  for (const [item, count] of drops) {
    await page.waitForFunction(
      () => window.__beltworks!.belts().find((b) => b.x === -4 && b.y === 2)?.items.length === 0,
    );
    expect(
      await page.evaluate(([i, n]) => window.__beltworks!.dropOnBelt(-4, 2, i!, n), [item, count]),
    ).toBe(true);
  }

  // Shot while the inserter holds an item and the line is still spread out.
  await page.waitForFunction(
    () =>
      window.__beltworks!.inserters().some((i) => i.held !== 0 && i.arm > 6 && i.arm < 30) &&
      window.__beltworks!.belts().some((b) => b.x <= 0 && b.items.length > 0),
    undefined,
    { timeout: 30_000, polling: 'raf' },
  );
  const shot = testInfo.outputPath('ux-items.png');
  // At 1×, cropped to the line, the player and the hotbar.
  const size = page.viewportSize()!;
  await page.screenshot({
    path: shot,
    clip: {
      x: size.width / 2 - 240,
      y: size.height / 2 - 40,
      width: 480,
      height: size.height / 2 + 40,
    },
  });
  await testInfo.attach('readable items', { path: shot, contentType: 'image/png' });

  // The line carries a mix of the dropped kinds.
  const onBelts = (await page.evaluate(() => window.__beltworks!.belts())).flatMap((b) =>
    b.items.map((i) => i.item),
  );
  const dropped = new Set(drops.map(([item]) => item));
  expect(onBelts.every((item) => dropped.has(item))).toBe(true);
  expect(new Set(onBelts).size).toBeGreaterThan(1);
  expect(errors).toEqual([]);
});

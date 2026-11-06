import { expect, test, type Page } from '@playwright/test';
import { ITEMS, ItemId } from '../../src/data/items';
import { STARTING_KIT } from '../../src/data/start';
import { HOTBAR_SLOTS } from '../../src/ui/inventory';
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

async function open(page: Page): Promise<void> {
  await page.goto('./');
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });
}

/** Screen position of the center of tile `(x, y)`, or of its top-left corner. */
async function tileScreen(page: Page, x: number, y: number, corner = false) {
  const at = await page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
  const zoom = (await page.evaluate(() => window.__beltworks!.camera())).zoom;
  const shift = corner ? (TILE_PX / 2) * zoom : 0;
  return { x: at.x - shift, y: at.y - shift };
}

const entities = (page: Page) => page.evaluate(() => window.__beltworks!.entities());
const ghost = (page: Page) => page.evaluate(() => window.__beltworks!.ghost());
const countOf = async (page: Page, item: number) =>
  (await page.evaluate(() => window.__beltworks!.inventory())).reduce(
    (n, s) => n + (s.item === item ? s.count : 0),
    0,
  );
const entityAt = async (page: Page, x: number, y: number) =>
  (await entities(page)).find((e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h);

/** Hotbar key (`1`–`0`) of the starting-kit slot holding `item`. */
const keyFor = (item: number): string => String(STARTING_KIT.findIndex((s) => s.item === item) + 1);

test('place a chest and a furnace from the hotbar, rotate a belt, remove the chest', async ({
  page,
}, testInfo) => {
  const errors = collectErrors(page);
  await open(page);
  const hotbar = page.locator('#hotbar');
  // Zoom in around the player (the camera follows it), so the screenshot shows the shapes well.
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, -460);
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.camera())).zoom)
    .toBeGreaterThan(1.9);
  await page.waitForFunction(() => window.__beltworks!.terrainReady());

  // The starting kit is in the hotbar (as far as it reaches; the rest follows in the inventory).
  for (const [slot, stack] of STARTING_KIT.slice(0, HOTBAR_SLOTS).entries()) {
    const cell = hotbar.locator(`.slot[data-slot="${String(slot)}"]`);
    await expect(cell).toHaveAttribute('data-item', ITEMS[stack.item].name);
    await expect(cell).toHaveAttribute('data-count', String(stack.count));
  }

  // Select the chest: its slot lights up and a ghost follows the cursor.
  const chestKey = keyFor(ItemId.WoodenChest);
  await page.keyboard.press(chestKey);
  expect(await page.evaluate(() => window.__beltworks!.selectedSlot())).toBe(Number(chestKey) - 1);
  await expect(
    hotbar.locator(`.slot[data-slot="${String(Number(chestKey) - 1)}"]`),
  ).toHaveAttribute('data-selected', 'true');
  // On the player's own tile the ghost is red.
  let at = await tileScreen(page, 0, 0);
  await page.mouse.move(at.x, at.y);
  await expect.poll(() => ghost(page)).toMatchObject({ name: 'wooden-chest', x: 0, y: 0 });
  expect((await ghost(page))!.valid).toBe(false);
  // Two tiles to the right it is green; a click places the chest.
  at = await tileScreen(page, 2, 0);
  await page.mouse.move(at.x, at.y);
  await expect
    .poll(() => ghost(page))
    .toEqual({
      name: 'wooden-chest',
      x: 2,
      y: 0,
      dir: Direction.North,
      valid: true,
    });
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => entityAt(page, 2, 0)).toMatchObject({ name: 'wooden-chest', w: 1, h: 1 });
  await expect.poll(() => countOf(page, ItemId.WoodenChest)).toBe(1);
  // The ghost turns red now that the tile is taken.
  await expect.poll(async () => (await ghost(page))?.valid).toBe(false);

  // A 2×2 furnace snaps to the tile corner nearest to the cursor.
  await page.keyboard.press(keyFor(ItemId.StoneFurnace));
  at = await tileScreen(page, 4, -2, true);
  await page.mouse.move(at.x, at.y);
  await expect.poll(() => ghost(page)).toMatchObject({ name: 'stone-furnace', x: 3, y: -3 });
  await page.mouse.click(at.x, at.y);
  await expect
    .poll(() => entityAt(page, 4, -2))
    .toMatchObject({ name: 'stone-furnace', x: 3, y: -3, w: 2, h: 2 });
  await expect.poll(() => countOf(page, ItemId.StoneFurnace)).toBe(1);

  // Belts: R turns the ghost, the click places it facing that way.
  await page.keyboard.press(keyFor(ItemId.TransportBelt));
  at = await tileScreen(page, 2, 2);
  await page.mouse.move(at.x, at.y);
  await expect.poll(async () => (await ghost(page))?.name).toBe('transport-belt');
  await page.keyboard.press('r');
  await expect.poll(async () => (await ghost(page))?.dir).toBe(Direction.East);
  await page.mouse.click(at.x, at.y);
  await expect
    .poll(() => entityAt(page, 2, 2))
    .toMatchObject({ name: 'transport-belt', dir: Direction.East });

  // An inserter (still facing east) and a drill, so the screenshot shows every placeholder.
  await page.keyboard.press(keyFor(ItemId.BurnerInserter));
  at = await tileScreen(page, 3, 0);
  await page.mouse.move(at.x, at.y);
  await expect.poll(async () => (await ghost(page))?.valid).toBe(true);
  await page.mouse.click(at.x, at.y);
  await expect
    .poll(() => entityAt(page, 3, 0))
    .toMatchObject({ name: 'burner-inserter', dir: Direction.East });
  await page.keyboard.press(keyFor(ItemId.BurnerMiningDrill));
  at = await tileScreen(page, -2, 2, true);
  await page.mouse.move(at.x, at.y);
  await expect.poll(() => ghost(page)).toMatchObject({ x: -3, y: 1, valid: true });
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => entityAt(page, -2, 2)).toMatchObject({ name: 'burner-mining-drill' });

  // The ghost preview next to what was built, for the docs.
  await page.keyboard.press(keyFor(ItemId.TransportBelt));
  at = await tileScreen(page, 3, 2);
  await page.mouse.move(at.x, at.y);
  await expect.poll(async () => (await ghost(page))?.x).toBe(3);
  await expect.poll(async () => (await ghost(page))?.valid).toBe(true);
  const shot = testInfo.outputPath('m1-placement.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('ghost preview next to placed entities', {
    path: shot,
    contentType: 'image/png',
  });

  // With nothing selected, R rotates the entity under the cursor.
  await page.keyboard.press('q');
  expect(await page.evaluate(() => window.__beltworks!.selectedSlot())).toBeNull();
  expect(await ghost(page)).toBeNull();
  at = await tileScreen(page, 2, 2);
  await page.mouse.move(at.x, at.y);
  await page.keyboard.press('r');
  await expect.poll(async () => (await entityAt(page, 2, 2))?.dir).toBe(Direction.South);

  // Right click removes the chest and refunds it.
  at = await tileScreen(page, 2, 0);
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expect.poll(() => entityAt(page, 2, 0)).toBeUndefined();
  await expect.poll(() => countOf(page, ItemId.WoodenChest)).toBe(2);
  // Removing never started mining.
  expect((await page.evaluate(() => window.__beltworks!.player()))!.mining).toBe(false);
  expect((await entities(page)).map((e) => e.name).sort()).toEqual([
    'burner-inserter',
    'burner-mining-drill',
    'stone-furnace',
    'transport-belt',
  ]);
  expect(errors).toEqual([]);
});

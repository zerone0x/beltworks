import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { ResourceId } from '../../src/data/resources';
import { STARTING_KIT } from '../../src/data/start';
import { TILE_PX } from '../../src/render/camera';
import { MachineState } from '../../src/sim/entities/machine';
import { SUBTILES_PER_TILE } from '../../src/sim/fixed';
import { inMiningReach } from '../../src/sim/player';
import { startingPatches } from '../../src/sim/world/generate';
import { player, walkNear } from './walk';
import { closeWindows } from './windows';

/** Seed used by src/main.ts. */
const WORLD_SEED = 1;

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
  // Zoom in around the player (the camera follows it), so slots and shapes are easy to hit.
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
const entityAt = async (page: Page, x: number, y: number) =>
  (await page.evaluate(() => window.__beltworks!.entities())).find(
    (e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h,
  );
const ghost = (page: Page) => page.evaluate(() => window.__beltworks!.ghost());

/** Hotbar key (`1`–`0`) of the starting-kit slot holding `item`. */
const keyFor = (item: number): string => String(STARTING_KIT.findIndex((s) => s.item === item) + 1);

test('a chest takes and gives back items through its GUI, and refunds them on removal', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await open(page);
  const panel = page.locator('#entity-panel');
  await page.keyboard.press(keyFor(ItemId.WoodenChest));
  let at = await tileScreen(page, 2, 0);
  await page.mouse.move(at.x, at.y);
  await expect.poll(async () => (await ghost(page))?.valid).toBe(true);
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => entityAt(page, 2, 0)).toMatchObject({ name: 'wooden-chest' });

  // With nothing in hand, a left click opens the chest.
  await page.keyboard.press('q');
  await page.mouse.click(at.x, at.y);
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-type', 'wooden-chest');
  const chestSlots = panel.locator('.entity-slots .slot');
  await expect(chestSlots).toHaveCount(16);

  // Clicking the coal in the inventory moves the whole stack into the chest.
  await panel.locator('.player-inventory .slot[data-item="coal"]').click();
  await expect(chestSlots.first()).toHaveAttribute('data-item', 'coal');
  await expect(chestSlots.first()).toHaveAttribute('data-count', '10');
  await expect.poll(() => countOf(page, ItemId.Coal)).toBe(0);
  // Clicking it in the chest brings it back.
  await chestSlots.first().click();
  await expect.poll(() => countOf(page, ItemId.Coal)).toBe(10);
  await expect(chestSlots.first()).toHaveAttribute('data-count', '0');

  // Coal back in, then remove the chest: the panel closes and the coal is refunded.
  await panel.locator('.player-inventory .slot[data-item="coal"]').click();
  await expect.poll(() => countOf(page, ItemId.Coal)).toBe(0);
  at = await tileScreen(page, 2, 0);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expect.poll(() => entityAt(page, 2, 0)).toBeUndefined();
  await expect(panel).toBeHidden();
  await expect.poll(() => countOf(page, ItemId.Coal)).toBe(10);
  await expect.poll(() => countOf(page, ItemId.WoodenChest)).toBe(2);
  expect(errors).toEqual([]);
});

test('place a furnace, fuel and load it from the GUI, and take the iron plates', async ({
  page,
}, testInfo) => {
  // Walking with the keyboard is slow on CI's software-rendered Chromium.
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await open(page);
  const patch = startingPatches(WORLD_SEED).find((p) => p.ore === ResourceId.IronOre)!;
  const generatedAt = (x: number, y: number) =>
    page.evaluate(([gx, gy]) => window.__beltworks!.generatedTile(gx!, gy!), [x, y]);

  // Walk onto the iron patch and mine a few ores from a tile in reach.
  const stand = await walkNear(page, patch.x + 0.5, patch.y + 0.5, 1.5);
  const [px, py] = [Math.floor(stand.x), Math.floor(stand.y)];
  let ore: { x: number; y: number } | null = null;
  for (const [ox, oy] of [
    [-1, 0],
    [-1, -1],
    [-1, 1],
    [0, -1],
    [0, 1],
  ] as const) {
    const [x, y] = [px + ox, py + oy];
    const inReach = inMiningReach(stand.x * SUBTILES_PER_TILE, stand.y * SUBTILES_PER_TILE, x, y);
    if (inReach && (await generatedAt(x, y)).resource === ResourceId.IronOre) {
      ore = { x, y };
      break;
    }
  }
  expect(ore, `no iron ore west of (${stand.x}, ${stand.y})`).not.toBeNull();
  let at = await tileScreen(page, ore!.x, ore!.y);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: 'right' });
  await expect.poll(() => countOf(page, ItemId.IronOre), { timeout: 10_000 }).toBeGreaterThan(2);
  await page.mouse.up({ button: 'right' });
  await expect.poll(async () => (await player(page)).mining).toBe(false);

  // A furnace two tiles east of the player: a 2×2 ghost snaps to the corner under the cursor.
  await page.keyboard.press(keyFor(ItemId.StoneFurnace));
  const [fx, fy] = [px + 2, py - 1];
  at = await tileScreen(page, fx + 1, fy + 1, true);
  await page.mouse.move(at.x, at.y);
  await expect.poll(() => ghost(page)).toMatchObject({ x: fx, y: fy, valid: true });
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => entityAt(page, fx, fy)).toMatchObject({ name: 'stone-furnace' });
  const furnace = (await entityAt(page, fx, fy))!;
  expect(furnace.status).toBe(MachineState.NoInput);

  // Open it.
  await page.keyboard.press('q');
  at = await tileScreen(page, fx, fy);
  await page.mouse.click(at.x, at.y);
  const panel = page.locator('#entity-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-type', 'stone-furnace');
  expect(await page.evaluate(() => window.__beltworks!.openEntity())).toBe(furnace.id);
  await expect(panel).toHaveAttribute('data-status', 'no-input');
  const slot = (role: string) => panel.locator(`[data-role="${role}"] .slot`);

  // Coal goes to the fuel slot, the ore to the input; the furnace starts working.
  const ores = await countOf(page, ItemId.IronOre);
  await panel.locator('.player-inventory .slot[data-item="coal"]').click();
  await expect(slot('fuel')).toHaveAttribute('data-item', 'coal');
  await panel.locator('.player-inventory .slot[data-item="iron-ore"]').click();
  await expect(panel).toHaveAttribute('data-status', 'working');
  await expect.poll(() => countOf(page, ItemId.IronOre)).toBe(0);
  // One ore is already being smelted, the rest wait in the input.
  await expect(slot('input')).toHaveAttribute('data-count', String(ores - 1));
  // The renderer knows it works (the firebox glows).
  await expect.poll(async () => (await entityAt(page, fx, fy))?.status).toBe(MachineState.Working);

  // 192 ticks (3.2 s) per plate.
  await expect(slot('output')).toHaveAttribute('data-item', 'iron-plate', { timeout: 10_000 });
  await expect(slot('output')).toHaveAttribute('data-count', '2', { timeout: 10_000 });
  const shot = testInfo.outputPath('m1-furnace.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('a working furnace and its GUI', { path: shot, contentType: 'image/png' });

  // Clicking the output takes the plates.
  await slot('output').click();
  await expect.poll(() => countOf(page, ItemId.IronPlate)).toBeGreaterThanOrEqual(2);
  // Once the ore runs out it waits for input again, with every ore turned into a plate.
  await expect(panel).toHaveAttribute('data-status', 'no-input', { timeout: 20_000 });
  await slot('output').click();
  await expect.poll(() => countOf(page, ItemId.IronPlate)).toBe(ores);
  await expect.poll(async () => (await entityAt(page, fx, fy))?.status).toBe(MachineState.NoInput);

  // Escape closes the panel.
  await closeWindows(page);
  await expect(panel).toBeHidden();
  expect(await page.evaluate(() => window.__beltworks!.openEntity())).toBe(0);
  expect(errors).toEqual([]);
});

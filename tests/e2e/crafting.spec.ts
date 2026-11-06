import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { RecipeId } from '../../src/data/recipes';
import { ResourceId } from '../../src/data/resources';
import { STARTING_KIT } from '../../src/data/start';
import { SUBTILES_PER_TILE } from '../../src/sim/fixed';
import { inMiningReach } from '../../src/sim/player';
import { startingPatches } from '../../src/sim/world/generate';
import { player, walkNear } from './walk';

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
}

const countOf = async (page: Page, item: number) =>
  (await page.evaluate(() => window.__beltworks!.inventory())).reduce(
    (n, s) => n + (s.item === item ? s.count : 0),
    0,
  );
const craftQueue = (page: Page) => page.evaluate(() => window.__beltworks!.craftQueue());

test('mine stone, craft stone furnaces from it, and cancel one from the queue', async ({
  page,
}, testInfo) => {
  // Walking with the keyboard is slow on CI's software-rendered Chromium.
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await open(page);
  const kitFurnaces = STARTING_KIT.find((s) => s.item === ItemId.StoneFurnace)?.count ?? 0;
  const patch = startingPatches(WORLD_SEED).find((p) => p.ore === ResourceId.Stone)!;

  // Walk onto the stone patch and pick a stone tile in reach (not under the player).
  const stand = await walkNear(page, patch.x + 0.5, patch.y + 0.5, 1.5);
  const [px, py] = [Math.floor(stand.x), Math.floor(stand.y)];
  let tile: { x: number; y: number } | null = null;
  for (const [ox, oy] of [
    [1, -1],
    [1, 0],
    [0, -1],
    [-1, -1],
    [1, 1],
    [-1, 0],
    [0, 1],
    [-1, 1],
  ] as const) {
    const [x, y] = [px + ox, py + oy];
    const inReach = inMiningReach(stand.x * SUBTILES_PER_TILE, stand.y * SUBTILES_PER_TILE, x, y);
    const generated = await page.evaluate(
      ([gx, gy]) => window.__beltworks!.generatedTile(gx!, gy!),
      [x, y],
    );
    if (inReach && generated.resource === ResourceId.Stone) {
      tile = { x, y };
      break;
    }
  }
  expect(tile, `no stone tile in reach of (${stand.x}, ${stand.y})`).not.toBeNull();

  // Mine stone for seven furnaces (5 each), at one unit per 0.5 s.
  const at = await page.evaluate(
    ([x, y]) => window.__beltworks!.tileToScreen(x!, y!),
    [tile!.x, tile!.y],
  );
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: 'right' });
  await expect.poll(async () => (await player(page)).mining).toBe(true);
  await expect
    .poll(() => countOf(page, ItemId.Stone), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(35);
  await page.mouse.up({ button: 'right' });
  await expect.poll(async () => (await player(page)).mining).toBe(false);
  const stone = await countOf(page, ItemId.Stone);

  // The crafting panel sits in the inventory window and counts what the stone allows.
  await page.keyboard.press('e');
  const panel = page.locator('#crafting-panel');
  await expect(panel).toBeVisible();
  const furnace = panel.locator('.recipe[data-recipe="stone-furnace"]');
  await expect(furnace).toHaveAttribute('data-craftable', String(Math.floor(stone / 5)));
  await expect(panel.locator('.recipe[data-recipe="wooden-chest"]')).toHaveAttribute(
    'data-craftable',
    '0',
  );
  const strip = page.locator('#craft-queue');
  await expect(strip).toBeHidden();

  // Shift-click queues five furnaces (2.5 s), and their stone is reserved at once.
  await furnace.click({ modifiers: ['Shift'] });
  await expect.poll(() => countOf(page, ItemId.Stone)).toBe(stone - 25);
  // A click queues one more behind them.
  await furnace.click();
  await expect.poll(() => countOf(page, ItemId.Stone)).toBe(stone - 30);
  await expect(strip).toBeVisible();
  const entries = strip.locator('.craft[data-recipe]');
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(1)).toHaveAttribute('data-recipe', 'stone-furnace');
  await expect(entries.nth(1)).toHaveAttribute('data-count', '1');
  await expect(furnace).toHaveAttribute('data-craftable', String(Math.floor((stone - 30) / 5)));

  const shot = testInfo.outputPath('m1-crafting.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('crafting panel and queue', { path: shot, contentType: 'image/png' });

  // Clicking the second entry cancels it and refunds its stone.
  await entries.nth(1).click();
  await expect.poll(() => countOf(page, ItemId.Stone)).toBe(stone - 25);
  await expect(entries).toHaveCount(1);
  const queue = await craftQueue(page);
  expect(queue.entries).toHaveLength(1);
  expect(queue.entries[0]).toMatchObject({ recipe: RecipeId.StoneFurnace, flags: 0 });

  // The five furnaces land in the inventory and the strip empties.
  await expect.poll(() => countOf(page, ItemId.StoneFurnace)).toBe(kitFurnaces + 5);
  await expect(strip).toBeHidden();
  expect(errors).toEqual([]);
});

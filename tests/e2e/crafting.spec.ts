import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { ResourceId } from '../../src/data/resources';
import { STARTING_KIT } from '../../src/data/start';
import { SUBTILES_PER_TILE } from '../../src/sim/fixed';
import { inMiningReach } from '../../src/sim/player';
import { startingPatches } from '../../src/sim/world/generate';
import { fastForward } from './timeScale';
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

test('mine stone, craft stone furnaces from it, and cancel the rest from the queue', async ({
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

  // Mine stone for ten furnaces (5 each), at one unit per 0.5 s, so the queue below
  // holds 5 s of crafting: plenty for the test steps that need it non-empty.
  const at = await page.evaluate(
    ([x, y]) => window.__beltworks!.tileToScreen(x!, y!),
    [tile!.x, tile!.y],
  );
  // The player stands still while mining, so the simulation runs at 8× speed
  // meanwhile (`setTimeScale`, docs/DECISIONS.md, D42); the crafting below
  // runs at normal speed again.
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: 'right' });
  await expect.poll(async () => (await player(page)).mining).toBe(true);
  await fastForward(page, 8, () =>
    expect.poll(() => countOf(page, ItemId.Stone), { timeout: 20_000 }).toBeGreaterThanOrEqual(50),
  );
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
  await expect(page.locator('#craft-queue')).toBeHidden();

  // Shift-click queues five furnaces (0.5 s each), and their stone is reserved at once.
  await furnace.click({ modifiers: ['Shift'] });
  await expect.poll(() => countOf(page, ItemId.Stone)).toBe(stone - 25);
  // Another shift-click queues five more.
  const more = Math.min(5, Math.floor((stone - 25) / 5));
  await furnace.click({ modifiers: ['Shift'] });
  await expect.poll(() => countOf(page, ItemId.Stone)).toBe(stone - 25 - 5 * more);
  const queued = 5 + more;
  // Crafts finish while the test runs (slowly on CI), so from here on only
  // check what doesn't depend on timing.
  const strip = page.locator('#craft-queue');
  const entries = strip.locator('.craft[data-recipe]');
  await expect(entries.first()).toHaveAttribute('data-recipe', 'stone-furnace');

  const shot = testInfo.outputPath('m1-crafting.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('crafting panel and queue', { path: shot, contentType: 'image/png' });

  // Clicking the front entry cancels the furnaces it has left and refunds their stone.
  await entries.first().click();
  await expect(strip).toBeHidden({ timeout: 10_000 });
  expect((await craftQueue(page)).entries).toEqual([]);
  const crafted = (await countOf(page, ItemId.StoneFurnace)) - kitFurnaces;
  const left = await countOf(page, ItemId.Stone);
  // Every unit of stone is either back in the inventory or in a furnace...
  expect(left + 5 * crafted).toBe(stone);
  // ...at least one furnace was made, and the cancel took some back.
  expect(crafted).toBeGreaterThanOrEqual(1);
  expect(crafted).toBeLessThan(queued);
  await expect(furnace).toHaveAttribute('data-craftable', String(Math.floor(left / 5)));
  expect(errors).toEqual([]);
});

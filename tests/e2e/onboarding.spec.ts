/**
 * #91 acceptance: a new player starts from the title screen (New game on a
 * typed seed) and follows the onboarding's objectives, mine → craft → drill
 * → belt → furnace → inserter → chest → power, to an automated iron plate
 * line in under 5 minutes of game time. Every objective advances on the
 * game's state as the player builds with real input; the spec checks the
 * tracker's step after each, the slot it points out, a tooltip, and the
 * seed in the game menu. (Test builds skip the title screen and the
 * objectives unless the URL asks for them: `?title=1&onboarding=1`.)
 */

import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { ResourceId } from '../../src/data/resources';
import { Direction } from '../../src/sim/entities/direction';
import { SUBTILES_PER_TILE } from '../../src/sim/fixed';
import { inMiningReach } from '../../src/sim/player';
import { startingPatches } from '../../src/sim/world/generate';
import { World } from '../../src/sim/world/world';
import { FURNACE_STONE } from '../../src/ui/onboarding';
import {
  countOf,
  entityAt,
  findLayout,
  ghost,
  keyFor,
  place,
  tileScreen,
  zoomIn,
  type Tile,
} from './ironLine';
import { fastForward } from './timeScale';
import { player, walkNear } from './walk';
import { closeMenu, closeWindows } from './windows';

const SEED = 1;
/** Game time the GDD gives a new player for the first automated line. */
const FIVE_MINUTES = 5 * 60 * 60;

const step = (page: Page) => page.locator('#onboarding').getAttribute('data-step');

test('a new player follows the objectives to an automated iron plate line in 5 minutes', async ({
  page,
  context,
}, testInfo) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  const attach = async (name: string, title: string) => {
    const path = testInfo.outputPath(name);
    await page.screenshot({ path });
    await testInfo.attach(title, { path, contentType: 'image/png' });
  };
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);

  // The title screen: no saves yet, so New game (on a typed seed), Load disabled, Settings.
  await page.goto('./?title=1&onboarding=1');
  await expect(page.locator('#start-screen')).toBeVisible();
  await expect(page.locator('#start-continue')).toHaveCount(0);
  await expect(page.locator('#title-load')).toBeDisabled();
  await page.locator('#title-settings').click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-panel')).toBeHidden();
  await page.locator('#title-seed').fill(String(SEED));
  await page.locator('#title-seed-copy').click();
  await expect(page.locator('#title-status')).toHaveText(`Copied seed ${String(SEED)}.`);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(String(SEED));
  await attach('m5-title.png', 'the title screen');
  await page.locator('#start-new-game').click();
  await expect(page.locator('#start-screen')).toHaveCount(0);
  await page.waitForFunction(() => window.__beltworks?.player() != null, undefined, {
    timeout: 30_000,
  });
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 30_000,
  });
  // The game menu shows the seed.
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu-seed')).toHaveText(String(SEED));
  await closeMenu(page);

  // 1. Mine stone: the tracker points the way to the stone patch.
  await expect.poll(() => step(page)).toBe('mine');
  await expect(page.locator('#onboarding-where')).toContainText('tiles');
  const patches = startingPatches(SEED);
  const stonePatch = patches.find((p) => p.ore === ResourceId.Stone)!;
  const stand = await walkNear(page, stonePatch.x + 0.5, stonePatch.y + 0.5, 1.5);
  const world = new World(SEED);
  const [px, py] = [Math.floor(stand.x), Math.floor(stand.y)];
  const near: Tile[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) if (dx || dy) near.push({ x: px + dx, y: py + dy });
  }
  const stone = near.find(
    (t) =>
      world.resourceAt(t.x, t.y) === ResourceId.Stone &&
      inMiningReach(stand.x * SUBTILES_PER_TILE, stand.y * SUBTILES_PER_TILE, t.x, t.y),
  )!;
  expect(stone, 'a stone tile in reach').toBeDefined();
  const rock = await tileScreen(page, stone.x, stone.y);
  await page.mouse.move(rock.x, rock.y);
  await page.mouse.down({ button: 'right' });
  await expect.poll(async () => (await player(page)).mining).toBe(true);
  await fastForward(page, 4, () =>
    expect.poll(() => countOf(page, ItemId.Stone)).toBeGreaterThanOrEqual(FURNACE_STONE),
  );
  await page.mouse.up({ button: 'right' });
  await expect.poll(async () => (await player(page)).mining).toBe(false);

  // 2. Craft a furnace: the recipe is pointed out in the crafting panel, with its tooltip.
  await expect.poll(() => step(page)).toBe('craft');
  await page.keyboard.press('e');
  const recipe = page.locator('#crafting-panel .recipe[data-recipe="stone-furnace"]');
  await expect(recipe).toHaveAttribute('data-marked', 'true');
  await recipe.hover();
  const tooltip = page.locator('#tooltip');
  await expect(tooltip).toBeVisible();
  await expect(tooltip.locator('.tooltip-title')).toHaveText('Stone furnace');
  await expect(tooltip).toContainText('Crafting time 0.5 s');
  await expect(tooltip).toContainText('Power 90 kW, burns fuel');
  await attach('m5-onboarding-craft.png', 'the craft objective and a recipe tooltip');
  await recipe.click();
  await expect.poll(() => step(page)).toBe('drill');
  await page.keyboard.press('e');
  await expect(tooltip).toBeHidden();

  // 3–7. Walk to the iron patch and build the line in the objectives' order.
  const iron = patches.find((p) => p.ore === ResourceId.IronOre)!;
  await zoomIn(page);
  const at = await walkNear(page, iron.x + 0.5, iron.y + 0.5, 1.5);
  const l = findLayout(world, at.x, at.y)!;
  expect(l, `room for the line around (${at.x}, ${at.y})`).toBeDefined();
  const E = Direction.East;
  const drillKey = keyFor(ItemId.BurnerMiningDrill);
  await expect(
    page.locator(`#hotbar .slot[data-slot="${String(Number(drillKey) - 1)}"]`),
  ).toHaveAttribute('data-marked', 'true');
  await page.keyboard.press(drillKey);
  await place(page, 'burner-mining-drill', l.drill, 2, E);
  await expect.poll(() => step(page)).toBe('belt');
  await page.keyboard.press(keyFor(ItemId.TransportBelt));
  const [first, ...rest] = l.belts;
  await place(page, 'transport-belt', first!, 1, E, { hold: true });
  for (const t of rest) {
    const c = await tileScreen(page, t.x, t.y);
    await page.mouse.move(c.x, c.y, { steps: 4 });
    await expect.poll(() => entityAt(page, t.x, t.y)).toMatchObject({ name: 'transport-belt' });
  }
  await page.mouse.up();
  await expect.poll(() => step(page)).toBe('furnace');
  await page.keyboard.press(keyFor(ItemId.StoneFurnace));
  await place(page, 'stone-furnace', l.furnace, 2);
  await expect.poll(() => step(page)).toBe('inserter');
  await page.keyboard.press(keyFor(ItemId.BurnerInserter));
  await place(page, 'burner-inserter', l.pick, 1, E);
  await expect.poll(() => step(page)).toBe('chest');
  await place(page, 'burner-inserter', l.put, 1, E);
  await page.keyboard.press(keyFor(ItemId.WoodenChest));
  await place(page, 'wooden-chest', l.chest, 1);
  await page.keyboard.press('q');
  await expect.poll(() => ghost(page)).toBeNull();

  // 8. Power it: coal into the drill, the furnace and both inserters through their windows.
  await expect.poll(() => step(page)).toBe('power');
  await expect(page.locator('#onboarding-where')).toHaveText(/^\d machines? waiting for fuel$/);
  const panel = page.locator('#entity-panel');
  const coal = panel.locator('.player-inventory .slot[data-item="coal"]');
  for (const [t, button] of [
    [l.drill, 'right'],
    [l.furnace, 'right'],
    [l.pick, 'right'],
    [l.put, 'left'],
  ] as const) {
    const left = await countOf(page, ItemId.Coal);
    const c = await tileScreen(page, t.x, t.y);
    await page.mouse.click(c.x, c.y);
    await expect(panel).toBeVisible();
    await coal.click({ button });
    await expect.poll(() => countOf(page, ItemId.Coal)).toBeLessThan(left);
    await closeWindows(page);
    await expect(panel).toBeHidden();
  }

  // The line runs on its own: the objectives finish once plates leave the furnace for the chest.
  await page.mouse.move(8, 8);
  await fastForward(page, 4, () => expect.poll(() => step(page), { timeout: 60_000 }).toBe('done'));
  const tick = await page.evaluate(() => window.__beltworks!.latestTick());
  expect(tick, 'game ticks to an automated line').toBeLessThan(FIVE_MINUTES);
  await expect(page.locator('#onboarding-objective')).toHaveText(
    'Your iron plate line runs on its own!',
  );
  await attach('m5-onboarding-done.png', 'the objectives done, the line running');
  // Close puts it away for good (a new game keeps it closed; the menu's Tutorial brings it back).
  await page.locator('#onboarding-skip').click();
  await expect(page.locator('#onboarding')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('beltworks.onboarding'))).toContain(
    '"dismissed":true',
  );
  // And the plates really are in the chest (its window shows its contents).
  const box = await tileScreen(page, l.chest.x, l.chest.y);
  await page.mouse.click(box.x, box.y);
  await expect(panel).toHaveAttribute('data-type', 'wooden-chest');
  const plates = panel.locator('.entity-slots .slot').first();
  await expect(plates).toHaveAttribute('data-item', 'iron-plate');
  expect(Number(await plates.getAttribute('data-count'))).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { STARTING_KIT } from '../../src/data/start';
import { TREE_WOOD } from '../../src/data/trees';
import { SUBTILES_PER_TILE } from '../../src/sim/fixed';
import { playerOverlaps } from '../../src/sim/entities/placement';
import { inMiningReach } from '../../src/sim/player';
import { player, walkNear } from './walk';

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

const generatedAt = (page: Page, x: number, y: number) =>
  page.evaluate(([gx, gy]) => window.__beltworks!.generatedTile(gx!, gy!), [x, y]);
const renderedAt = (page: Page, x: number, y: number) =>
  page.evaluate(([gx, gy]) => window.__beltworks!.renderedTile(gx!, gy!), [x, y]);
const ghost = (page: Page) => page.evaluate(() => window.__beltworks!.ghost());
const countOf = async (page: Page, item: number) =>
  (await page.evaluate(() => window.__beltworks!.inventory())).reduce(
    (n, s) => n + (s.item === item ? s.count : 0),
    0,
  );
const tileScreen = (page: Page, x: number, y: number) =>
  page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);

/** Hotbar key (`1`–`0`) of the starting-kit slot holding `item`. */
const keyFor = (item: number): string => String(STARTING_KIT.findIndex((s) => s.item === item) + 1);

/**
 * The tree closest to the spawn on the generated map that is at least `min`
 * tiles away from it (ties: smallest y, then x).
 */
async function nearestTree(page: Page, min = 0): Promise<{ x: number; y: number }> {
  return page.evaluate((min2) => {
    const hook = window.__beltworks!;
    let best: { x: number; y: number; d2: number } | null = null;
    for (let y = -112; y <= 112; y++) {
      for (let x = -112; x <= 112; x++) {
        const d2 = x * x + y * y;
        if (d2 < min2 || (best !== null && d2 >= best.d2)) continue;
        if (hook.generatedTile(x, y).tree === 1) best = { x, y, d2 };
      }
    }
    if (!best) throw new Error('no tree near the spawn');
    return { x: best.x, y: best.y };
  }, min * min);
}

test('trees grow outside the starting area, block building, and give wood when mined', async ({
  page,
}, testInfo) => {
  // Walking with the keyboard is slow on CI's software-rendered Chromium.
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await open(page);

  // The spawn is clear; the first trees stand beyond the starting area.
  const first = await nearestTree(page);
  expect(first.x * first.x + first.y * first.y).toBeGreaterThanOrEqual(48 * 48);

  // Walk up to a tree past the fade-in ring, where forests are dense (from
  // the west), then mine whichever tree is in reach of where the player
  // stopped, closest first.
  const goal = await nearestTree(page, 80);
  const stand = await walkNear(page, goal.x - 1 + 0.5, goal.y + 0.5, 1);
  const [px, py] = [Math.floor(stand.x), Math.floor(stand.y)];
  let tree: { x: number; y: number } | null = null;
  let bestD2 = Infinity;
  for (let oy = -2; oy <= 2; oy++) {
    for (let ox = -2; ox <= 2; ox++) {
      const [x, y] = [px + ox, py + oy];
      const inReach = inMiningReach(stand.x * SUBTILES_PER_TILE, stand.y * SUBTILES_PER_TILE, x, y);
      // Not a tile the player overlaps: a chest couldn't go there even without the tree.
      const [sx, sy] = [stand.x * SUBTILES_PER_TILE, stand.y * SUBTILES_PER_TILE];
      if (!inReach || playerOverlaps(sx, sy, x, y, x, y) || ox * ox + oy * oy >= bestD2) continue;
      if ((await generatedAt(page, x, y)).tree === 1) {
        tree = { x, y };
        bestD2 = ox * ox + oy * oy;
      }
    }
  }
  expect(tree, `no tree in reach of (${stand.x}, ${stand.y})`).not.toBeNull();
  const { x: tx, y: ty } = tree!;

  // Zoom in around the player (the camera follows it) so the trees show well.
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, -460);
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.camera())).zoom)
    .toBeGreaterThan(1.9);
  await page.waitForFunction(() => window.__beltworks!.terrainReady());
  await expect.poll(async () => (await renderedAt(page, tx, ty))?.tree).toBe(1);

  // A chest can't go on the tree: the ghost is red.
  await page.keyboard.press(keyFor(ItemId.WoodenChest));
  let at = await tileScreen(page, tx, ty);
  await page.mouse.move(at.x, at.y);
  await expect.poll(() => ghost(page)).toMatchObject({ name: 'wooden-chest', x: tx, y: ty });
  expect((await ghost(page))!.valid).toBe(false);
  await page.mouse.click(at.x, at.y);
  await page.waitForTimeout(300);
  expect(await countOf(page, ItemId.WoodenChest)).toBe(2);

  const shot = testInfo.outputPath('m2-trees.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('trees outside the starting area, with a blocked ghost on one', {
    path: shot,
    contentType: 'image/png',
  });

  // Put the chest away and hold the right button on the tree: it falls and
  // gives its wood.
  await page.keyboard.press('q');
  expect(await ghost(page)).toBeNull();
  const wood = await countOf(page, ItemId.Wood);
  at = await tileScreen(page, tx, ty);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: 'right' });
  await expect.poll(async () => (await player(page)).mining).toBe(true);
  const target = await player(page);
  expect([target.mineX, target.mineY]).toEqual([tx, ty]);
  await expect.poll(() => countOf(page, ItemId.Wood), { timeout: 10_000 }).toBe(wood + TREE_WOOD);
  await expect.poll(async () => (await renderedAt(page, tx, ty))?.tree).toBe(0);
  // Nothing left to mine there: mining ends on its own.
  await expect.poll(async () => (await player(page)).mining).toBe(false);
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(200);
  expect(await countOf(page, ItemId.Wood)).toBe(wood + TREE_WOOD);

  // Now the chest fits where the tree stood.
  await page.keyboard.press(keyFor(ItemId.WoodenChest));
  await page.mouse.move(at.x + 1, at.y);
  await page.mouse.move(at.x, at.y);
  await expect.poll(async () => (await ghost(page))?.valid).toBe(true);
  await page.mouse.click(at.x, at.y);
  await expect
    .poll(async () =>
      (await page.evaluate(() => window.__beltworks!.entities())).find(
        (e) => e.x === tx && e.y === ty,
      ),
    )
    .toMatchObject({ name: 'wooden-chest' });
  expect(await countOf(page, ItemId.WoodenChest)).toBe(1);
  expect(errors).toEqual([]);
});

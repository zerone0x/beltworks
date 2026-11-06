import { expect, test, type Page } from '@playwright/test';
import { ITEMS, MINED_ITEM } from '../../src/data/items';
import { ResourceId } from '../../src/data/resources';
import { TILE_PX } from '../../src/render/camera';
import { startingPatches } from '../../src/sim/world/generate';

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

const player = async (page: Page) => (await page.evaluate(() => window.__beltworks!.player()))!;
const camera = (page: Page) => page.evaluate(() => window.__beltworks!.camera());

/** Waits until the player stopped moving (two snapshots apart show the same position). */
async function waitUntilStill(page: Page): Promise<{ x: number; y: number }> {
  let last = await player(page);
  for (;;) {
    await page.waitForTimeout(100);
    const now = await player(page);
    if (now.x === last.x && now.y === last.y) return now;
    last = now;
  }
}

/**
 * Walks the player with WASD until it stands within `tolerance` tiles of the
 * center of tile `(tx, ty)` on both axes, steering every 40 ms.
 */
async function walkTo(page: Page, tx: number, ty: number, tolerance = 0.6): Promise<void> {
  const held = new Set<string>();
  const set = async (key: string, on: boolean): Promise<void> => {
    if (on && !held.has(key)) {
      held.add(key);
      await page.keyboard.down(key);
    } else if (!on && held.has(key)) {
      held.delete(key);
      await page.keyboard.up(key);
    }
  };
  const deadline = Date.now() + 15_000;
  for (;;) {
    const p = await player(page);
    const dx = tx + 0.5 - p.x;
    const dy = ty + 0.5 - p.y;
    if (Math.abs(dx) <= tolerance && Math.abs(dy) <= tolerance) break;
    if (Date.now() > deadline)
      throw new Error(`walk to (${tx}, ${ty}) timed out at (${p.x}, ${p.y})`);
    await set('d', dx > tolerance);
    await set('a', dx < -tolerance);
    await set('s', dy > tolerance);
    await set('w', dy < -tolerance);
    await page.waitForTimeout(40);
  }
  for (const key of [...held]) await set(key, false);
}

test('WASD moves the player, the camera follows, panning frees it and F re-follows', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await open(page);
  expect(await page.evaluate(() => window.__beltworks!.following())).toBe(true);
  const start = await player(page);
  expect(start).toMatchObject({ x: 0, y: 0, mining: false });

  // Walk right and down for a moment.
  await page.keyboard.down('d');
  await page.keyboard.down('s');
  await page.waitForTimeout(400);
  await page.keyboard.up('d');
  await page.keyboard.up('s');
  const moved = await waitUntilStill(page);
  expect(moved.x).toBeGreaterThan(1);
  expect(moved.y).toBeGreaterThan(1);

  // The camera is centered on the player.
  await expect
    .poll(async () => {
      const c = await camera(page);
      return Math.hypot(c.x - moved.x * TILE_PX, c.y - moved.y * TILE_PX);
    })
    .toBeLessThan(0.01);

  // Zooming while following keeps the player centered.
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(1);
  const zoomed = await camera(page);
  expect(zoomed.x).toBeCloseTo(moved.x * TILE_PX, 2);
  expect(zoomed.y).toBeCloseTo(moved.y * TILE_PX, 2);

  // Arrow keys pan the camera away and stop following.
  await page.keyboard.down('ArrowLeft');
  await page.waitForTimeout(250);
  await page.keyboard.up('ArrowLeft');
  expect(await page.evaluate(() => window.__beltworks!.following())).toBe(false);
  const panned = await camera(page);
  expect(panned.x).toBeLessThan(moved.x * TILE_PX - 10);
  // Walking now doesn't move the free camera.
  await page.keyboard.down('w');
  await page.waitForTimeout(200);
  await page.keyboard.up('w');
  const walked = await waitUntilStill(page);
  expect(walked.y).toBeLessThan(moved.y);
  expect(await camera(page)).toEqual(panned);

  // F snaps back onto the player.
  await page.keyboard.press('f');
  expect(await page.evaluate(() => window.__beltworks!.following())).toBe(true);
  await expect
    .poll(async () => {
      const c = await camera(page);
      return Math.hypot(c.x - walked.x * TILE_PX, c.y - walked.y * TILE_PX);
    })
    .toBeLessThan(0.01);
  expect(errors).toEqual([]);
});

test('walk to an ore tile, mine it for 2 s, and find the ore in the inventory', async ({
  page,
}, testInfo) => {
  const errors = collectErrors(page);
  await open(page);
  // The copper patch: its color stands out best in the screenshot.
  const patch = startingPatches(WORLD_SEED).find((p) => p.ore === ResourceId.CopperOre)!;
  const item = ITEMS[MINED_ITEM[patch.ore]];
  const generated = await page.evaluate(
    ([x, y]) => window.__beltworks!.generatedTile(x!, y!),
    [patch.x, patch.y],
  );
  expect(generated.resource).toBe(patch.ore);

  // Stand next to the patch center (within the 2.5-tile reach), not on it,
  // so the player doesn't hide the mining indicator.
  await walkTo(page, patch.x - 1, patch.y + 1);
  await waitUntilStill(page);
  const hotbar = page.locator('#hotbar');
  const panel = page.locator('#inventory-panel');
  await expect(panel).toBeHidden();
  await expect(hotbar.locator(`[data-item="${item.name}"]`)).toHaveCount(0);

  // Hold the right mouse button on the ore tile for 2 s.
  const at = await page.evaluate(
    ([x, y]) => window.__beltworks!.tileToScreen(x!, y!),
    [patch.x, patch.y],
  );
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: 'right' });
  await expect.poll(async () => (await player(page)).mining).toBe(true);
  const target = await player(page);
  expect([target.mineX, target.mineY]).toEqual([patch.x, patch.y]);
  await page.waitForTimeout(2_000);

  // Open the inventory while still mining.
  await page.keyboard.press('e');
  await expect(panel).toBeVisible();
  const slots = panel.locator(`.slot[data-item="${item.name}"]`);
  await expect(slots).toHaveCount(1);
  const mined = Number(await slots.first().getAttribute('data-count'));
  // 2 s at one unit per 0.5 s is 4 units; allow for input latency and slow test steps.
  expect(mined).toBeGreaterThanOrEqual(3);
  expect(mined).toBeLessThanOrEqual(10);
  await expect(slots.first()).toHaveAttribute('title', new RegExp(`^${item.label} × \\d+$`));
  await expect(hotbar.locator(`[data-item="${item.name}"]`)).toHaveCount(1);

  const shot = testInfo.outputPath('m0-player.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('player mining with the inventory open', {
    path: shot,
    contentType: 'image/png',
  });

  await page.mouse.up({ button: 'right' });
  await expect.poll(async () => (await player(page)).mining).toBe(false);
  // Every unit in the inventory came out of the tile, as streamed back to the renderer.
  const inventory = await page.evaluate(() => window.__beltworks!.inventory());
  const total = inventory.reduce((n, s) => n + (s.item === item.id ? s.count : 0), 0);
  expect(total).toBeGreaterThanOrEqual(mined);
  await expect
    .poll(() =>
      page.evaluate(
        ([x, y]) => window.__beltworks!.renderedTile(x!, y!)?.amount,
        [patch.x, patch.y],
      ),
    )
    .toBe(generated.amount - total);

  // E closes the panel again.
  await page.keyboard.press('e');
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
});

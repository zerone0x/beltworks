import { expect, test, type Page } from '@playwright/test';
import { ITEMS, MINED_ITEM } from '../../src/data/items';
import { ResourceId } from '../../src/data/resources';
import { TILE_PX } from '../../src/render/camera';
import { SUBTILES_PER_TILE } from '../../src/sim/fixed';
import { inMiningReach } from '../../src/sim/player';
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

/** Animation frames per second over half a second, for failure diagnostics. */
const fps = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const start = performance.now();
        const tick = (now: number): void => {
          frames++;
          if (now - start < 500) requestAnimationFrame(tick);
          else resolve(Math.round((frames * 1000) / (now - start)));
        };
        requestAnimationFrame(tick);
      }),
  );

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
 * Walks the player with WASD until it stands still within `tolerance` tiles
 * of `(tx, ty)` (tile coordinates) on both axes.
 *
 * Input only becomes commands on the next rendered frame, and software-
 * rendered Chromium on CI can run at a low frame rate, so a key release takes
 * effect late and the player overshoots. Each pass therefore holds the keys
 * until the player is within the tolerance (or past the target) on each axis,
 * waits for it to stop, and measures again.
 */
async function walkNear(
  page: Page,
  tx: number,
  ty: number,
  tolerance: number,
): Promise<{ x: number; y: number }> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const p = await waitUntilStill(page);
    const dx = tx - p.x;
    const dy = ty - p.y;
    if (Math.abs(dx) <= tolerance && Math.abs(dy) <= tolerance) return p;
    if (Date.now() > deadline) {
      throw new Error(
        `walk to (${tx}, ${ty}) timed out at (${p.x}, ${p.y}); page at ${await fps(page)} fps`,
      );
    }
    // For each held key: the remaining distance along its axis, positive while short of the target.
    const remaining: Record<string, (q: { x: number; y: number }) => number> = {};
    if (dx > tolerance) remaining.d = (q) => tx - q.x;
    if (dx < -tolerance) remaining.a = (q) => q.x - tx;
    if (dy > tolerance) remaining.s = (q) => ty - q.y;
    if (dy < -tolerance) remaining.w = (q) => q.y - ty;
    for (const key of Object.keys(remaining)) await page.keyboard.down(key);
    while (Object.keys(remaining).length > 0) {
      await page.waitForTimeout(20);
      const q = await player(page);
      for (const [key, left] of Object.entries(remaining)) {
        if (left(q) <= tolerance || Date.now() > deadline) {
          delete remaining[key];
          await page.keyboard.up(key);
        }
      }
    }
  }
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
  // Walking with the keyboard is slow on CI's software-rendered Chromium.
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await open(page);
  // The copper patch: its color stands out best in the screenshot.
  const patch = startingPatches(WORLD_SEED).find((p) => p.ore === ResourceId.CopperOre)!;
  const item = ITEMS[MINED_ITEM[patch.ore]];
  const generatedAt = (x: number, y: number) =>
    page.evaluate(([gx, gy]) => window.__beltworks!.generatedTile(gx!, gy!), [x, y]);

  // Walk onto the patch, then mine an ore tile next to wherever the player
  // stopped: diagonally up-right first, so the player doesn't hide the
  // mining indicator. Any neighbouring tile is within the 2.5-tile reach.
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
    if (inReach && (await generatedAt(x, y)).resource === patch.ore) {
      tile = { x, y };
      break;
    }
  }
  expect(tile, `no ore tile in reach of (${stand.x}, ${stand.y})`).not.toBeNull();
  const { x: tx, y: ty } = tile!;
  const generated = await generatedAt(tx, ty);
  const hotbar = page.locator('#hotbar');
  const panel = page.locator('#inventory-panel');
  await expect(panel).toBeHidden();
  await expect(hotbar.locator(`[data-item="${item.name}"]`)).toHaveCount(0);

  // Hold the right mouse button on the ore tile for 2 s.
  const at = await page.evaluate(([x, y]) => window.__beltworks!.tileToScreen(x!, y!), [tx, ty]);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: 'right' });
  await expect.poll(async () => (await player(page)).mining).toBe(true);
  const target = await player(page);
  expect([target.mineX, target.mineY]).toEqual([tx, ty]);
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
      page.evaluate(([x, y]) => window.__beltworks!.renderedTile(x!, y!)?.amount, [tx, ty]),
    )
    .toBe(generated.amount - total);

  // E closes the panel again.
  await page.keyboard.press('e');
  await expect(panel).toBeHidden();
  expect(errors).toEqual([]);
});

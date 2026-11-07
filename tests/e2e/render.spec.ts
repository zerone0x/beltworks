import { expect, test, type Page } from '@playwright/test';
import { TILE_PX } from '../../src/render/camera';
import { FREE_MARGIN } from '../../src/render/terrainLayer';
import { startingPatches } from '../../src/sim/world/generate';
import { formatTile } from '../../src/ui/debugOverlay';

/** Seed used by src/main.ts. */
const WORLD_SEED = 1;

/** Collects console errors, page errors and failed requests. */
function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => errors.push(`requestfailed: ${req.url()}`));
  return errors;
}

async function open(page: Page): Promise<void> {
  await page.goto('./');
  await page.waitForFunction(() => window.__beltworks !== undefined);
  await waitForTerrain(page);
}

/** Waits until the worker caught up with the camera and every chunk around it is baked. */
async function waitForTerrain(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });
}

const camera = (page: Page) => page.evaluate(() => window.__beltworks!.camera());

test('initial view renders the terrain around the spawn', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  expect(await camera(page)).toEqual({ x: 0, y: 0, zoom: 1 });
  const stats = await page.evaluate(() => window.__beltworks!.terrainStats());
  expect(stats.sprites).toBe(stats.bakeChunks);

  // The overlay shows changing tick counts; mask it (and the help hint's
  // text, whose font differs between machines) so the image is stable.
  const options = {
    mask: [page.locator('#debug-overlay'), page.locator('#help-hint')],
    maxDiffPixelRatio: 0.01,
    // A full-HD screenshot takes a while in software rendering.
    timeout: 15_000,
  };
  await expect(page).toHaveScreenshot('initial-view.png', options);

  // The spawn area is flattened to grass, so also pin down a zoomed-out view
  // large enough for lakes, sand, rock, and all four starting ore patches.
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.evaluate((y) => window.__beltworks!.setCamera(0, y, 0.25), -12 * TILE_PX);
  await waitForTerrain(page);
  await expect(page).toHaveScreenshot('zoomed-out.png', options);
  expect(errors).toEqual([]);
});

test('wheel zooms towards the cursor, arrows and middle-drag pan, without errors', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await open(page);
  // Free the camera from the player: only a free camera zooms towards the cursor.
  await page.evaluate(() => window.__beltworks!.setCamera(0, 0, 1));
  const size = page.viewportSize()!;
  const worldAt = (cam: { x: number; y: number; zoom: number }, sx: number, sy: number) => ({
    x: cam.x + (sx - size.width / 2) / cam.zoom,
    y: cam.y + (sy - size.height / 2) / cam.zoom,
  });

  // Zoom in towards a point away from the center: that world point stays under the cursor.
  const [sx, sy] = [size.width * 0.8, size.height * 0.25];
  await page.mouse.move(sx, sy);
  const before = await camera(page);
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(1);
  const zoomed = await camera(page);
  const pinned = worldAt(zoomed, sx, sy);
  const original = worldAt(before, sx, sy);
  expect(pinned.x).toBeCloseTo(original.x, 3);
  expect(pinned.y).toBeCloseTo(original.y, 3);

  // The zoom is clamped to [0.25, 4].
  for (let i = 0; i < 10; i++) await page.mouse.wheel(0, -500);
  await expect.poll(async () => (await camera(page)).zoom).toBe(4);
  for (let i = 0; i < 20; i++) await page.mouse.wheel(0, 500);
  await expect.poll(async () => (await camera(page)).zoom).toBe(0.25);
  await waitForTerrain(page);

  // Arrow keys pan.
  const beforeKeys = await camera(page);
  await page.keyboard.down('ArrowRight');
  await page.keyboard.down('ArrowUp');
  await page.waitForTimeout(300);
  await page.keyboard.up('ArrowRight');
  await page.keyboard.up('ArrowUp');
  const afterKeys = await camera(page);
  expect(afterKeys.x).toBeGreaterThan(beforeKeys.x);
  expect(afterKeys.y).toBeLessThan(beforeKeys.y);

  // Middle-drag moves the world with the cursor.
  await page.mouse.move(600, 400);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(400, 300, { steps: 5 });
  await page.mouse.up({ button: 'middle' });
  const afterDrag = await camera(page);
  expect(afterDrag.x - afterKeys.x).toBeCloseTo(200 / afterDrag.zoom, 3);
  expect(afterDrag.y - afterKeys.y).toBeCloseTo(100 / afterDrag.zoom, 3);

  await waitForTerrain(page);
  expect(errors).toEqual([]);
});

test('panning across many chunks keeps only the window around the view', async ({ page }) => {
  // Each jump bakes a few chunks of rendered terrain, which is slow in software (CI).
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await open(page);
  const size = page.viewportSize()!;
  const chunkPx = 32 * TILE_PX;
  // At zoom 1 the screen spans at most this many chunks per axis, plus the margin on both sides.
  const maxWindow =
    (Math.ceil(size.width / chunkPx) + 1 + 2) * (Math.ceil(size.height / chunkPx) + 1 + 2);
  // Rendered terrain keeps textures (4 MiB each at 1×) for the chunks within FREE_MARGIN of the view.
  const reach = 2 * FREE_MARGIN * TILE_PX;
  const maxTextures =
    (Math.ceil((size.width + reach) / chunkPx) + 1) *
    (Math.ceil((size.height + reach) / chunkPx) + 1);

  // Jump the camera 3 chunks at a time across ~120 chunks, waiting for each view to load.
  for (let i = 1; i <= 40; i++) {
    await page.evaluate((x) => window.__beltworks!.setCamera(x, x / 2, 1), i * 3 * 32 * TILE_PX);
    await waitForTerrain(page);
    const stats = await page.evaluate(() => window.__beltworks!.terrainStats());
    // Nothing outside the viewport + margin survives.
    expect(stats.chunks).toBe(stats.windowChunks);
    expect(stats.windowChunks).toBeLessThanOrEqual(maxWindow);
    // Chunk textures near the view are baked, and those further away freed:
    // at most the chunks within FREE_MARGIN tiles of the view stay.
    expect(stats.sprites).toBeGreaterThanOrEqual(stats.bakeChunks);
    expect(stats.sprites).toBeLessThanOrEqual(maxTextures);
    expect(stats.textureBytes).toBeLessThanOrEqual(maxTextures * 4 * 1024 * 1024);
  }
  expect(errors).toEqual([]);
});

test('the debug overlay shows the tile under the mouse', async ({ page }) => {
  const errors = collectErrors(page);
  await open(page);
  const size = page.viewportSize()!;
  const readout = page.locator('#debug-overlay .tile-readout');

  // Center the view on the first starting ore patch (always an ore tile), then point at it.
  const patch = startingPatches(WORLD_SEED)[0]!;
  await page.evaluate(
    ([x, y]) => window.__beltworks!.setCamera(x!, y!, 1),
    [(patch.x + 0.5) * TILE_PX, (patch.y + 0.5) * TILE_PX],
  );
  await waitForTerrain(page);
  const [sx, sy] = [size.width / 2, size.height / 2];
  await page.mouse.move(sx, sy);
  const tile = await page.evaluate(([x, y]) => window.__beltworks!.tileAtScreen(x!, y!), [sx, sy]);
  expect(tile).toEqual({ x: patch.x, y: patch.y });

  // The readout comes from the chunks streamed by the worker; cross-check it
  // against a world generated on the main thread.
  const info = await page.evaluate(
    ([x, y]) => window.__beltworks!.generatedTile(x!, y!),
    [tile.x, tile.y],
  );
  expect(info.resource).toBe(patch.ore);
  await expect(readout).toHaveText(formatTile({ ...tile, info }));
  await expect(readout).toContainText(/ · [a-z ]+ \d{1,3}( \d{3})*$/);

  // A tree shows after the terrain too: point at the first one east of the spawn area.
  const treeTile = await page.evaluate(() => {
    for (let x = 48; x < 200; x++) {
      for (let y = -20; y <= 20; y++) {
        if (window.__beltworks!.generatedTile(x, y).tree) return { x, y };
      }
    }
    return null;
  });
  expect(treeTile).not.toBeNull();
  await page.evaluate(
    ([x, y]) => window.__beltworks!.setCamera(x!, y!, 1),
    [(treeTile!.x + 0.5) * TILE_PX, (treeTile!.y + 0.5) * TILE_PX],
  );
  await waitForTerrain(page);
  await page.mouse.move(sx + 1, sy);
  await page.mouse.move(sx, sy);
  await expect(readout).toContainText(
    `tile (${String(treeTile!.x)}, ${String(treeTile!.y)}) grass · tree`,
  );

  // Leaving the canvas clears it.
  await page.dispatchEvent('#app > canvas', 'pointerleave');
  await expect(readout).toHaveText('tile -');
  expect(errors).toEqual([]);
});

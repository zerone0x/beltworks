/**
 * The minimap and map mode (#87): `M` toggles the minimap, a click on it
 * moves the camera there and a drag pans it, and zooming out with the wheel
 * past 0.25× fades into map mode and back (`m5-minimap` and `m5-map-mode`
 * screenshots). Runs on the 1k benchmark factory (`?scene=1k`) so the map
 * has buildings and belts on it, with the rendered terrain (`?art=1`).
 * Then its key is rebound in the settings (D50) and the UI scale magnifies
 * it in its corner (D53).
 */

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { TILE_PX } from '../../src/render/camera';
import { MINIMAP_TILES } from '../../src/ui/minimap';
import { closeWindows } from './windows';

const hook = <T>(page: Page, fn: () => T) => page.evaluate(fn);
const camera = (page: Page) => hook(page, () => window.__beltworks!.camera());
const minimap = (page: Page) => hook(page, () => window.__beltworks!.minimap());
const mapView = (page: Page) => hook(page, () => window.__beltworks!.mapView());

async function shoot(page: Page, testInfo: TestInfo, file: string, title: string): Promise<void> {
  const shot = testInfo.outputPath(file);
  await page.screenshot({ path: shot });
  await testInfo.attach(title, { path: shot, contentType: 'image/png' });
}

test('minimap: toggle, click and drag to move the camera; map mode zoomed out', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  // The rendered terrain, as deployed (test builds default to the flat placeholder).
  await page.goto('./?scene=1k&art=1');
  await page.waitForFunction(() => window.__beltworks !== undefined);
  await page.waitForFunction(() => window.__beltworks!.entities().length > 500, undefined, {
    timeout: 30_000,
  });
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 30_000,
  });
  await page.mouse.move(5, 5);

  // M shows it, drawn from the chunks seen so far; M again hides it.
  await expect(page.locator('#minimap')).toBeHidden();
  await page.keyboard.press('m');
  await expect(page.locator('#minimap')).toBeVisible();
  await expect.poll(async () => (await minimap(page)).chunkDraws).toBeGreaterThan(4);
  await page.waitForTimeout(300);
  await shoot(page, testInfo, 'm5-minimap.png', 'the minimap over the 1k factory');

  // A click 40 pixels right of its center moves the camera 40 tiles east.
  const before = await camera(page);
  const { box } = await minimap(page);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.click(cx + 40, cy - 20);
  await expect.poll(() => hook(page, () => window.__beltworks!.following())).toBe(false);
  let after = await camera(page);
  expect(after.x / TILE_PX).toBeCloseTo(Math.round(before.x / TILE_PX) + 40, 0);
  expect(after.y / TILE_PX).toBeCloseTo(Math.round(before.y / TILE_PX) - 20, 0);
  // The minimap recenters on the camera.
  await expect.poll(async () => (await minimap(page)).center?.x).toBeCloseTo(after.x / TILE_PX, 0);

  // Dragging: the map stays put under the pointer and the camera follows it.
  const start = await camera(page);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 30, cy, { steps: 3 });
  after = await camera(page);
  expect(after.x / TILE_PX).toBeCloseTo(Math.round(start.x / TILE_PX) - 30, 0);
  expect((await minimap(page)).center?.x).toBeCloseTo(start.x / TILE_PX, 0);
  await page.mouse.up();

  await page.keyboard.press('m');
  await expect(page.locator('#minimap')).toBeHidden();

  // Zoom out with the wheel past 0.25×: the view fades into map mode, which
  // hides (and stops drawing) the terrain and entity layers.
  await page.keyboard.press('f');
  const center = page.viewportSize()!;
  await page.mouse.move(center.width / 2, center.height / 2);
  for (let i = 0; i < 5; i++) await page.mouse.wheel(0, 300);
  await expect.poll(async () => (await camera(page)).zoom).toBeLessThan(0.25);
  await expect
    .poll(
      async () => {
        const m = await mapView(page);
        return m.complete && !m.spritesVisible;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  const map = await mapView(page);
  expect(map.blend).toBe(1);
  expect(map.mapSprites).toBeGreaterThan(0);
  await page.mouse.move(5, 5);
  await page.keyboard.press('m');
  await expect.poll(async () => (await minimap(page)).chunkDraws).toBeGreaterThan(4);
  await page.waitForTimeout(300);
  await shoot(page, testInfo, 'm5-map-mode.png', 'map mode at 0.125× with the minimap');

  // And back: zooming in fades the sprite view back in and frees the map's textures.
  await page.mouse.move(center.width / 2, center.height / 2);
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -300);
  await expect.poll(async () => (await camera(page)).zoom).toBeGreaterThan(0.25);
  await expect
    .poll(async () => {
      const m = await mapView(page);
      return m.blend === 0 && m.spritesVisible && m.mapSprites === 0;
    })
    .toBe(true);
  expect(errors).toEqual([]);
});

test('minimap: its key is rebindable in the settings, and it follows the UI scale', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto('./');
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });
  const element = page.locator('#minimap');

  // Rebind it to N in the settings and scale the UI by 1.5.
  await page.keyboard.press('Escape');
  await page.locator('#menu-settings').click();
  const key = page.locator('#key-minimap');
  await expect(key).toHaveText('M');
  await key.click();
  await page.keyboard.press('n');
  await expect(key).toHaveText('N');
  await page.locator('#setting-ui-scale').selectOption('1.5');
  await closeWindows(page);
  await expect(page.locator('#game-menu')).toBeHidden();

  // M does nothing now; N toggles it, and the help lists N for it.
  await page.mouse.move(5, 5);
  await page.keyboard.press('m');
  await page.waitForTimeout(200);
  await expect(element).toBeHidden();
  await page.keyboard.press('n');
  await expect(element).toBeVisible();
  await page.keyboard.press('h');
  await expect(page.locator('#help-panel').getByRole('row', { name: /^N Minimap/ })).toBeVisible();
  await page.keyboard.press('h');

  // 1.5 times the size, still in the bottom-right corner, drawn at twice the pixels.
  const { box } = await minimap(page);
  const viewport = page.viewportSize()!;
  expect(box.width).toBeCloseTo(MINIMAP_TILES * 1.5, 0);
  const outer = (await element.boundingBox())!;
  expect(outer.x + outer.width).toBeCloseTo(viewport.width - 8, 0);
  expect(outer.y + outer.height).toBeCloseTo(viewport.height - 8, 0);
  await expect.poll(async () => (await minimap(page)).canvasWidth).toBe(MINIMAP_TILES * 2);

  // A click still lands on the tile drawn there: 60 pixels right of the center is 40 tiles east.
  await expect.poll(async () => (await minimap(page)).center).not.toBeNull();
  const before = await camera(page);
  await page.mouse.click(box.x + box.width / 2 + 60, box.y + box.height / 2);
  await expect.poll(() => hook(page, () => window.__beltworks!.following())).toBe(false);
  const after = await camera(page);
  expect(after.x / TILE_PX).toBeCloseTo(Math.round(before.x / TILE_PX) + 40, 0);

  await page.keyboard.press('n');
  await expect(element).toBeHidden();
  expect(errors).toEqual([]);
});

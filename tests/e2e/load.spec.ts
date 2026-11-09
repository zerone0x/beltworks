/**
 * Loading (#112, D64): the title screen shows without waiting for the
 * renderer's code (PixiJS, the game view), which loads in the background;
 * the game waits for it, with a note while it takes long; and a renderer
 * that can't be downloaded (offline) gets a clear message with Reload.
 */

import { expect, test, type Page, type Route } from '@playwright/test';

/** The renderer's chunk (src/render/renderer.ts, imported dynamically by main.ts). */
const RENDERER = '**/assets/renderer-*.js';

const ready = (page: Page) =>
  page.waitForFunction(
    () => window.__beltworks?.player() != null && window.__beltworks.latestTick() > 0,
  );

test('the title screen shows before the renderer loads, and the game waits for it', async ({
  page,
}) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let requested = false;
  await page.route(RENDERER, async (route: Route) => {
    requested = true;
    await held;
    await route.continue();
  });
  await page.goto('./?title=1');
  // The title screen is up while the renderer's code is still on its way.
  await expect(page.locator('#start-new-game')).toBeVisible();
  await expect(page.locator('#title-version')).toBeVisible();
  await expect.poll(() => requested).toBe(true);
  await page.locator('#start-new-game').click();
  await expect(page.locator('#loading-game')).toBeVisible();
  await expect(page.locator('#app canvas')).toHaveCount(0);
  release();
  await ready(page);
  await expect(page.locator('#app canvas')).toHaveCount(1);
  await expect(page.locator('#loading-game')).toHaveCount(0);
});

test('a renderer that fails to download says so and offers Reload', async ({ page }) => {
  await page.route(RENDERER, (route) => route.abort('internetdisconnected'));
  await page.goto('./');
  const dialog = page.locator('#start-failed');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("The game's files couldn't be downloaded");
  await expect(page.locator('#app canvas')).toHaveCount(0);
  await expect(page.locator('#loading-game')).toHaveCount(0);
  // Back online: Reload starts the game.
  await page.unroute(RENDERER);
  await page.locator('#start-failed-reload').click();
  await ready(page);
  await expect(page.locator('#start-failed')).toHaveCount(0);
});

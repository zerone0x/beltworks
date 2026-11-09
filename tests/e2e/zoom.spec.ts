/**
 * Zooming the map (#119): the mouse wheel over the canvas zooms towards the
 * cursor (and over a UI panel not at all); a macOS mouse-wheel notch
 * (4.000244140625 px) and a trackpad pinch (ctrl+wheel, or Safari's gesture
 * events) zoom as much as a wheel notch elsewhere or the fingers do, where
 * they used to barely move the view; and the zoom keys (`=` and `-` by
 * default, `+` with shift, the numpad's `+` and `-`), rebindable in the
 * settings and listed in the help and About, zoom in steps and while held,
 * out into map mode and back, within the zoom limits.
 */

import { expect, test, type Page } from '@playwright/test';
import { MAX_ZOOM, MIN_ZOOM } from '../../src/render/camera';
import { KEY_ZOOM_STEP, MAC_NOTCH_PX } from '../../src/render/cameraInput';
import { closeMenu, closeWindows } from './windows';

const zoom = (page: Page) => page.evaluate(() => window.__beltworks!.camera().zoom);

/** The world position (in world pixels) under screen point `(sx, sy)`. */
async function underCursor(page: Page, sx: number, sy: number): Promise<{ x: number; y: number }> {
  const c = await page.evaluate(() => window.__beltworks!.camera());
  const { width, height } = page.viewportSize()!;
  return { x: c.x + (sx - width / 2) / c.zoom, y: c.y + (sy - height / 2) / c.zoom };
}

/** Frees the camera (it stops following the player) where it is, at zoom `z`. */
const setZoom = (page: Page, z: number) =>
  page.evaluate((zz) => {
    const c = window.__beltworks!.camera();
    window.__beltworks!.setCamera(c.x, c.y, zz);
  }, z);

/** Dispatches wheel events on the canvas at `(x, y)` the way a platform reports them. */
const wheelEvents = (
  page: Page,
  events: { x: number; y: number; deltaY: number; ctrl?: boolean }[],
) =>
  page.evaluate((list) => {
    const canvas = document.querySelector('canvas')!;
    for (const { x, y, deltaY, ctrl } of list) {
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          clientX: x,
          clientY: y,
          deltaY,
          deltaMode: 0,
          ctrlKey: !!ctrl,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
  }, events);

test('zoom: wheel over the canvas, macOS notches, pinch, and the zoom keys', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('./');
  await page.waitForFunction(() => window.__beltworks?.player() != null);

  // The mouse wheel zooms towards the cursor: the tile under it stays put.
  await setZoom(page, 1);
  await page.mouse.move(300, 200);
  const tile = await underCursor(page, 300, 200);
  await page.mouse.wheel(0, -200);
  await expect.poll(() => zoom(page)).toBeCloseTo(Math.exp(0.3), 2);
  const after = await underCursor(page, 300, 200);
  expect(after.x).toBeCloseTo(tile.x, 0);
  expect(after.y).toBeCloseTo(tile.y, 0);

  // Over a UI panel (the hotbar) the wheel doesn't zoom.
  await setZoom(page, 1);
  const hotbar = (await page.locator('#hotbar').boundingBox())!;
  await page.mouse.move(hotbar.x + hotbar.width / 2, hotbar.y + hotbar.height / 2);
  await page.mouse.wheel(0, -200);
  await page.waitForTimeout(200);
  expect(await zoom(page)).toBe(1);

  // macOS: one notch of a mouse wheel is 4.000244140625 px; three notches zoom
  // as far as three 100 px notches elsewhere (they used to zoom by 1.8 %).
  await setZoom(page, 1);
  await wheelEvents(
    page,
    [1, 2, 3].map(() => ({ x: 640, y: 360, deltaY: -MAC_NOTCH_PX })),
  );
  expect(await zoom(page)).toBeCloseTo(Math.exp(0.45), 2);

  // A trackpad pinch to twice the size (ctrl+wheel, -100 × ln 2 px in all) zooms in twice.
  await setZoom(page, 1);
  const pinch = (-100 * Math.LN2) / 10;
  await wheelEvents(
    page,
    Array.from({ length: 10 }, () => ({ x: 640, y: 360, deltaY: pinch, ctrl: true })),
  );
  expect(await zoom(page)).toBeCloseTo(2, 2);

  // Safari's pinch: gesture events with the scale since the gesture began.
  await setZoom(page, 1);
  await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    const gesture = (type: string, scale: number) => {
      const e = new UIEvent(type, { bubbles: true, cancelable: true });
      Object.assign(e, { scale, clientX: 640, clientY: 360 });
      canvas.dispatchEvent(e);
    };
    gesture('gesturestart', 1);
    gesture('gesturechange', 1.5);
    gesture('gesturechange', 0.5);
    gesture('gestureend', 0.5);
  });
  expect(await zoom(page)).toBeCloseTo(0.5, 3);

  // The zoom keys: = and shift+= (+) zoom in a step, - out, the numpad too.
  await setZoom(page, 1);
  await page.keyboard.press('Equal');
  await expect.poll(() => zoom(page)).toBeCloseTo(KEY_ZOOM_STEP, 3);
  await page.keyboard.press('Shift+Equal');
  await expect.poll(() => zoom(page)).toBeCloseTo(KEY_ZOOM_STEP ** 2, 3);
  await page.keyboard.press('Minus');
  await page.keyboard.press('NumpadSubtract');
  await expect.poll(() => zoom(page)).toBeCloseTo(1, 3);
  await page.keyboard.press('NumpadAdd');
  await expect.poll(() => zoom(page)).toBeCloseTo(KEY_ZOOM_STEP, 3);

  // Held, - zooms out down to the limit, into map mode; = back in, up to the other limit.
  await page.keyboard.down('Minus');
  await expect.poll(() => zoom(page), { timeout: 20_000 }).toBe(MIN_ZOOM);
  await page.keyboard.up('Minus');
  await expect.poll(() => page.evaluate(() => window.__beltworks!.mapView().target)).toBe(true);
  await page.keyboard.down('Equal');
  await expect.poll(() => zoom(page), { timeout: 20_000 }).toBe(MAX_ZOOM);
  await page.keyboard.up('Equal');
  await expect.poll(() => page.evaluate(() => window.__beltworks!.mapView().target)).toBe(false);

  // Listed in the help, rebindable in the settings, and listed in About with the new key.
  await page.keyboard.press('h');
  await expect(page.locator('#help-panel')).toContainText('Mouse wheel / pinch / = -');
  await closeWindows(page);
  await page.keyboard.press('Escape');
  await page.locator('#menu-settings').click();
  const key = page.locator('#key-zoomIn');
  await expect(key).toHaveText('=');
  await expect(page.locator('#key-zoomOut')).toHaveText('-');
  await key.click();
  await page.keyboard.press('z');
  await expect(key).toHaveText('Z');
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-panel')).toBeHidden();
  await page.locator('#menu-about').click();
  await expect(page.locator('#about-controls')).toContainText('Mouse wheel / pinch / Z -');
  await page.keyboard.press('Escape');
  await expect(page.locator('#about-panel')).toBeHidden();
  await closeMenu(page);
  await setZoom(page, 1);
  await page.keyboard.press('z');
  await expect.poll(() => zoom(page)).toBeCloseTo(KEY_ZOOM_STEP, 3);
  await page.keyboard.press('Equal');
  await page.waitForTimeout(200);
  expect(await zoom(page)).toBeCloseTo(KEY_ZOOM_STEP, 3);

  expect(errors).toEqual([]);
});

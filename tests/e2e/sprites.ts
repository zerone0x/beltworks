/**
 * Helpers for the sprite specs that build a scene from a test kit next to the
 * spawn (`?kit=`, docs/DECISIONS.md, D29) with real mouse and keyboard input
 * and take screenshots of it: `sceneArt.spec.ts`, `beltTiersArt.spec.ts` and
 * `insertersArt.spec.ts` (docs/ART.md, "Belts", "Inserters", "Poles").
 */

import { expect, type Page, type TestInfo } from '@playwright/test';
import { TILE_PX } from '../../src/render/camera';
import { Direction } from '../../src/sim/entities/direction';
import { closeWindows } from './windows';
import { turnGhost } from './ghost';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
export const tile = (x: number, y: number): Rect => ({ x, y, w: 1, h: 1 });

export const tileScreen = (page: Page, x: number, y: number) =>
  page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
export const entityAt = async (page: Page, x: number, y: number) =>
  (await page.evaluate(() => window.__beltworks!.entities())).find(
    (e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h,
  );
export const ghost = (page: Page) => page.evaluate(() => window.__beltworks!.ghost());
export const sprites = (page: Page) => page.evaluate(() => window.__beltworks!.sprites());
export const belts = (page: Page) => page.evaluate(() => window.__beltworks!.belts());

/** Starts a game with `kit`, waits for the terrain and both atlases; returns the errors seen. */
export async function start(page: Page, kit: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => errors.push(`requestfailed: ${req.url()}`));
  // With the rendered terrain (test builds default to the flat placeholder).
  await page.goto(`./?kit=${kit}&art=1`);
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });
  await expect
    .poll(async () => (await sprites(page)).models)
    .toEqual(expect.arrayContaining(['stone-furnace', 'transport-belt', 'burner-inserter']));
  return errors;
}

/**
 * Selects hotbar `key` and places its item over `r`, turned to `dir`; its
 * ghost shows the entity's sprite unless `sprite` is false.
 */
export async function place(
  page: Page,
  key: string,
  r: Rect,
  name: string,
  dir: number = Direction.North,
  sprite = true,
) {
  if ((await page.evaluate(() => window.__beltworks!.selectedSlot())) !== Number(key) - 1) {
    await page.keyboard.press(key);
  }
  const at = await tileScreen(page, r.x + (r.w - 1) / 2, r.y + (r.h - 1) / 2);
  await page.mouse.move(at.x, at.y);
  await expect.poll(async () => (await ghost(page))?.name).toBe(name);
  await turnGhost(page, dir);
  await expect.poll(() => ghost(page)).toMatchObject({ x: r.x, y: r.y, dir, valid: true });
  expect((await sprites(page)).ghost).toBe(sprite);
  await page.mouse.click(at.x, at.y);
  await expect.poll(async () => (await entityAt(page, r.x, r.y))?.name).toBe(name);
}

/** Opens the window of the entity covering `r`, with nothing in hand. */
export async function openEntityAt(page: Page, r: Rect, name: string) {
  await closeWindows(page);
  if ((await page.evaluate(() => window.__beltworks!.selectedSlot())) !== null) {
    await page.keyboard.press('q');
    await expect.poll(() => page.evaluate(() => window.__beltworks!.selectedSlot())).toBeNull();
  }
  const at = await tileScreen(page, r.x, r.y);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('#entity-panel')).toHaveAttribute('data-type', name);
}

/**
 * Centers the camera on tile `(x, y)` at `zoom`, with the pointer out of the
 * way, and attaches a screenshot `file` (with `clip`, of the tiles from
 * `clip[0]` to `clip[1]` only).
 */
export async function shoot(
  page: Page,
  testInfo: TestInfo,
  file: string,
  title: string,
  [x, y, zoom]: [number, number, number],
  clip?: [[number, number], [number, number]],
) {
  await page.mouse.move(5, 5);
  await page.evaluate(
    ([cx, cy, z]) => window.__beltworks!.setCamera(cx!, cy!, z),
    [x * TILE_PX, y * TILE_PX, zoom],
  );
  await page.waitForFunction(() => window.__beltworks!.terrainReady());
  await page.waitForTimeout(400);
  const shot = testInfo.outputPath(file);
  if (clip) {
    const from = await tileScreen(page, clip[0][0], clip[0][1]);
    const to = await tileScreen(page, clip[1][0], clip[1][1]);
    await page.screenshot({
      path: shot,
      clip: { x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y },
    });
  } else {
    await page.screenshot({ path: shot });
  }
  await testInfo.attach(title, { path: shot, contentType: 'image/png' });
}

/**
 * Helpers for e2e tests that walk the local player around with the keyboard.
 */

import type { Page } from '@playwright/test';

export const player = async (page: Page) =>
  (await page.evaluate(() => window.__beltworks!.player()))!;
export const camera = (page: Page) => page.evaluate(() => window.__beltworks!.camera());

/**
 * Animation frames per second over `ms` milliseconds (half a second for
 * failure diagnostics; longer where a test checks it, since a few frames in
 * a short window round coarsely).
 */
export const fps = (page: Page, ms = 500) =>
  page.evaluate(
    (duration) =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const start = performance.now();
        const tick = (now: number): void => {
          frames++;
          if (now - start < duration) requestAnimationFrame(tick);
          else resolve(Math.round(((frames * 1000) / (now - start)) * 10) / 10);
        };
        requestAnimationFrame(tick);
      }),
    ms,
  );

/**
 * The frame rate looking at a scene (camera at world `(x, y)`, `zoom`) and,
 * for comparison, at bare terrain `away` tiles north-west of it at the same
 * zoom, each over `ms` once the terrain there is baked. CI renders in
 * software on runners of varying speed, so a spec checking that sprites
 * don't slow the game to a crawl compares the two (the same page, the same
 * minute, the same machine) instead of holding the scene to an absolute
 * floor. Leaves the camera on the scene.
 */
export async function sceneFps(
  page: Page,
  [x, y, zoom]: [number, number, number],
  { away = 48, ms = 2000 } = {},
): Promise<{ scene: number; bare: number }> {
  const at = async (cx: number, cy: number) => {
    await page.evaluate(
      ([px, py, z]) => window.__beltworks!.setCamera(px!, py!, z),
      [cx, cy, zoom],
    );
    await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
      timeout: 30_000,
    });
    return fps(page, ms);
  };
  const bare = await at(x - away * 32, y - away * 32);
  const scene = await at(x, y);
  return { scene, bare };
}

/** Waits until the player stopped moving (two snapshots apart show the same position). */
export async function waitUntilStill(page: Page): Promise<{ x: number; y: number }> {
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
export async function walkNear(
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

/**
 * Like {@link walkNear}, but also converges at very low frame rates, where a
 * key released as soon as the player is in range still moves it for a frame
 * or two (a tile or more at 10 fps) and can overshoot a small range again
 * and again. It walks to within 3 tiles first, then nudges each axis that
 * is still off by tapping its key for a single animation frame (the input
 * turns into commands once per frame, so a tap moves the player for about
 * one frame) until the player stands within `tolerance` tiles.
 */
export async function walkClose(
  page: Page,
  tx: number,
  ty: number,
  tolerance: number,
): Promise<{ x: number; y: number }> {
  await walkNear(page, tx, ty, Math.max(tolerance, 3));
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
    const key = Math.abs(dx) > tolerance ? (dx > 0 ? 'd' : 'a') : dy > 0 ? 's' : 'w';
    await page.keyboard.down(key);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await page.keyboard.up(key);
  }
}

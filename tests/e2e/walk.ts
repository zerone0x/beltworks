/**
 * Helpers for e2e tests that walk the local player around with the keyboard.
 *
 * CI's software-rendered Chromium sometimes runs at 6 fps or less. The game
 * turns the held keys into a `Move` command once per rendered frame
 * (src/render/playerInput.ts) while the simulation keeps running at 60 UPS
 * in its worker, so at a low frame rate a key release takes effect late and
 * every frame of walking moves the player more than a tile. The helpers
 * measure the frame rate and adapt to it: their timeouts scale with it, they
 * release the keys early by what one frame of walking covers, and close to
 * the target they tap a key for a single frame at a time.
 */

import type { Page } from '@playwright/test';
import { SUBTILES_PER_TILE } from '../../src/sim/fixed';
import { PLAYER_SPEED } from '../../src/sim/player';
import { TICKS_PER_SECOND } from '../../src/worker/protocol';

export const player = async (page: Page) =>
  (await page.evaluate(() => window.__beltworks!.player()))!;
export const camera = (page: Page) => page.evaluate(() => window.__beltworks!.camera());

/** How far the player walks per second, in tiles (straight; about 8.9). */
const TILES_PER_SECOND = (PLAYER_SPEED * TICKS_PER_SECOND) / SUBTILES_PER_TILE;
/** How long a walk may take at 30 fps or faster; slower pages get proportionally longer. */
const WALK_TIMEOUT_MS = 30_000;
/** The frame rate `WALK_TIMEOUT_MS` is meant for. */
const FULL_SPEED_FPS = 30;
/** At most this many times `WALK_TIMEOUT_MS`, however slow the page. */
const MAX_SLOWDOWN = 8;

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

/** Resolves once the page rendered `frames` more animation frames. */
const nextFrames = (page: Page, frames: number) =>
  page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        let left = n;
        const tick = (): void => {
          if (--left <= 0) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    frames,
  );

/** The player's position and the tick of the snapshot it is from. */
const sample = (page: Page) =>
  page.evaluate(() => {
    const hook = window.__beltworks!;
    const p = hook.player()!;
    return { x: p.x, y: p.y, tick: hook.latestTick() };
  });

/** Ticks two snapshots must be apart to tell that the player stands still. */
const STILL_TICKS = 6;

/**
 * Waits until the player stopped moving: two snapshots at least
 * `STILL_TICKS` ticks apart show the same position. (On a slow page the
 * main thread can go longer than the polling interval without taking in a
 * new snapshot, so comparing by wall time alone could mistake a stale
 * position for a still player.)
 */
export async function waitUntilStill(page: Page): Promise<{ x: number; y: number }> {
  let last = await sample(page);
  for (;;) {
    await page.waitForTimeout(100);
    const now = await sample(page);
    if (now.x !== last.x || now.y !== last.y) last = now;
    else if (now.tick - last.tick >= STILL_TICKS) return { x: now.x, y: now.y };
  }
}

/** How fast the page renders, and what that means for walking. */
interface Pace {
  fps: number;
  /** Tiles the player walks during one rendered frame. */
  step: number;
  /** When the walk gives up (`Date.now()` time). */
  deadline: number;
}

async function measurePace(page: Page): Promise<Pace> {
  const rate = Math.max(1, await fps(page));
  const slowdown = Math.min(MAX_SLOWDOWN, Math.max(1, FULL_SPEED_FPS / rate));
  return {
    fps: rate,
    step: TILES_PER_SECOND / rate,
    deadline: Date.now() + WALK_TIMEOUT_MS * slowdown,
  };
}

/**
 * Walks the player with WASD until it stands still within `tolerance` tiles
 * of `(tx, ty)` (tile coordinates) on both axes, and returns where it stands.
 *
 * Far from the target it holds the keys, releasing each axis once the
 * player is within one frame of walking of the target on it (or within the
 * tolerance, if that is smaller), since the release only takes effect a
 * frame or two later; then it waits for the player to stop and measures
 * again. Within two frames of walking of the range, it taps one key for a
 * single rendered frame at a time instead (for two frames if a one-frame
 * tap didn't move the player). The timeout grows as the frame rate drops.
 *
 * It converges as long as a frame of walking is no more than twice the
 * tolerance (a 1.5-tile tolerance holds down to about 3 fps): pick
 * tolerances, and standing spots, with that much room.
 */
export async function walkNear(
  page: Page,
  tx: number,
  ty: number,
  tolerance: number,
): Promise<{ x: number; y: number }> {
  const pace = await measurePace(page);
  let tapFrames = 1;
  let tapped: { x: number; y: number } | null = null;
  for (;;) {
    const p = await waitUntilStill(page);
    const dx = tx - p.x;
    const dy = ty - p.y;
    if (Math.abs(dx) <= tolerance && Math.abs(dy) <= tolerance) return p;
    if (Date.now() > pace.deadline) {
      throw new Error(
        `walk to (${tx}, ${ty}) within ${tolerance} timed out at (${p.x}, ${p.y}); ` +
          `page at ${await fps(page)} fps (${pace.fps} fps when the walk started)`,
      );
    }
    // A tap that didn't move the player ended before the game read the key: hold the next one longer.
    if (tapped && tapped.x === p.x && tapped.y === p.y) tapFrames = Math.min(tapFrames + 1, 3);
    tapped = null;

    const offX = Math.abs(dx) - tolerance;
    const offY = Math.abs(dy) - tolerance;
    if (Math.max(offX, offY) <= 2 * pace.step) {
      // Close: one axis at a time, a frame of walking at a time.
      const key = offX > 0 ? (dx > 0 ? 'd' : 'a') : dy > 0 ? 's' : 'w';
      await page.keyboard.down(key);
      await nextFrames(page, tapFrames);
      await page.keyboard.up(key);
      tapped = p;
      continue;
    }

    // Far: hold the keys of every axis still off. Each is released once the
    // remaining distance along it (positive while short of the target) is at
    // most `release`, so the frames it still walks end close to the target.
    const release = Math.min(tolerance, pace.step);
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
        if (left(q) <= release || Date.now() > pace.deadline) {
          delete remaining[key];
          await page.keyboard.up(key);
        }
      }
    }
  }
}

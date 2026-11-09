/**
 * The player character's sprites (docs/ART.md, "Player"; D67), end to end
 * with real keyboard input: standing idle facing the camera, walking in
 * several directions with the walk cycle running and facing the way it
 * walks, and idle again facing the way it stopped; `art-player` screenshots
 * at 1× and 2× zoom.
 */

import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { TILE_PX } from '../../src/render/camera';
import { frames, player } from './walk';

const playerSprite = (page: Page) => page.evaluate(() => window.__beltworks!.playerSprite());

/** A screenshot of the `size`² pixels around the screen's center (where the followed player stands). */
async function shootPlayer(page: Page, testInfo: TestInfo, file: string, size: number) {
  await frames(page, 2);
  const view = page.viewportSize()!;
  const shot = testInfo.outputPath(file);
  await page.screenshot({
    path: shot,
    clip: {
      x: view.width / 2 - size / 2,
      y: view.height / 2 - size * 0.6,
      width: size,
      height: size,
    },
  });
  await testInfo.attach(file, { path: shot, contentType: 'image/png' });
}

/** Zooms to `zoom` around the player, still following it. */
async function zoomTo(page: Page, zoom: number) {
  const p = await player(page);
  await page.evaluate(
    ([x, y, z]) => window.__beltworks!.setCamera(x!, y!, z),
    [p.x * TILE_PX, p.y * TILE_PX, zoom],
  );
  await page.keyboard.press('f');
  await expect.poll(() => page.evaluate(() => window.__beltworks!.following())).toBe(true);
}

/** Directions to walk in: the keys held and the facing they give (0 north, clockwise in eighths). */
const WALKS: { keys: string[]; facing: number; name: string }[] = [
  { keys: ['d'], facing: 2, name: 'east' },
  { keys: ['w', 'a'], facing: 7, name: 'north-west' },
  { keys: ['s'], facing: 4, name: 'south' },
  { keys: ['s', 'a'], facing: 5, name: 'south-west' },
];

test('the player is drawn as the engineer, idle and walking in 8 directions', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  await page.goto('./?art=1');
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.sprites())).models)
    .toEqual(expect.arrayContaining(['player', 'player:walk', 'player:mine']));

  // Standing, facing the camera.
  await expect.poll(() => playerSprite(page)).toEqual({ pose: 'idle', facing: 4, frame: 0 });
  await page.mouse.move(5, 5);
  for (const zoom of [1, 2]) {
    await zoomTo(page, zoom);
    await shootPlayer(page, testInfo, `art-player-idle-${zoom}x.png`, 140 * zoom);
  }

  for (const [i, walk] of WALKS.entries()) {
    const zoom = i % 2 === 0 ? 1 : 2;
    await zoomTo(page, zoom);
    for (const key of walk.keys) await page.keyboard.down(key);
    await expect
      .poll(() => playerSprite(page))
      .toMatchObject({ pose: 'walk', facing: walk.facing });
    // The walk cycle runs: several different frames while walking.
    const seen = new Set<number>();
    await expect
      .poll(async () => {
        seen.add((await playerSprite(page))!.frame);
        return seen.size;
      })
      .toBeGreaterThanOrEqual(3);
    await shootPlayer(page, testInfo, `art-player-walk-${walk.name}-${zoom}x.png`, 140 * zoom);
    for (const key of walk.keys) await page.keyboard.up(key);
    // Stopped: idle, still facing the way it walked.
    await expect
      .poll(() => playerSprite(page))
      .toEqual({ pose: 'idle', facing: walk.facing, frame: 0 });
  }
  await shootPlayer(page, testInfo, 'art-player-idle-south-west-2x.png', 280);
  expect(errors).toEqual([]);
});

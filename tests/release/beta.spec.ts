/**
 * The release check (#92): the production build (no test hook) played with
 * real input only, as a player on the deployed site would. A new game from
 * the title screen follows the first objectives (walk to the stone patch by
 * the tracker's directions, mine, craft a furnace), saves and continues
 * after a reload; then a factory researching with red and green science
 * (the `m3` benchmark scene, built in Node and imported as a save file)
 * runs and researches in the same build. Screenshots go into the test
 * output. Run with `npm run test:release` (playwright.release.config.ts).
 */

import { gzipSync } from 'node:zlib';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { saveSim } from '../../src/sim/save/save';
import { m3 } from '../../tools/bench/scenes/m3';

/** Keys to walk towards each of the tracker's eight directions. */
const WALK: Record<string, string[]> = {
  east: ['d'],
  'south-east': ['s', 'd'],
  south: ['s'],
  'south-west': ['s', 'a'],
  west: ['a'],
  'north-west': ['w', 'a'],
  north: ['w'],
  'north-east': ['w', 'd'],
};

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  return errors;
}

async function shot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const path = testInfo.outputPath(name);
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}

/** Frames per second over `ms`, as the page's `requestAnimationFrame` sees them. */
const fps = (page: Page, ms: number) =>
  page.evaluate(
    (span) =>
      new Promise<number>((resolve) => {
        let frames = 0;
        const start = performance.now();
        const frame = (): void => {
          frames++;
          if (performance.now() - start < span) requestAnimationFrame(frame);
          else resolve((frames * 1000) / (performance.now() - start));
        };
        requestAnimationFrame(frame);
      }),
    ms,
  );

const step = (page: Page) => page.locator('#onboarding').getAttribute('data-step');

test('a new game: first objectives with real input, save, reload and continue', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await page.goto('./');
  await expect(page.locator('#start-screen')).toBeVisible();
  await expect(page.locator('#title-version')).toHaveText(/^v\d+\.\d+\.\d+/);
  await shot(page, testInfo, 'release-title.png');
  await page.locator('#title-seed').fill('1');
  await page.locator('#start-new-game').click();
  await expect.poll(() => step(page), { timeout: 30_000 }).toBe('mine');

  // The debug overlay is off for players until F3.
  await expect(page.locator('#debug-overlay')).toBeHidden();
  await page.keyboard.press('F3');
  await expect(page.locator('#debug-overlay')).toBeVisible();

  // Walk to the stone patch the way the tracker points, until it says "right here".
  const where = page.locator('#onboarding-where');
  for (let i = 0; i < 200; i++) {
    const text = (await where.textContent()) ?? '';
    if (text.includes('right here')) break;
    const dir = /tiles (\S+)$/.exec(text)?.[1] ?? '';
    const keys = WALK[dir];
    if (!keys) {
      await page.waitForTimeout(100);
      continue;
    }
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForTimeout(250);
    for (const k of keys) await page.keyboard.up(k);
  }
  await expect(where).toContainText('right here');

  // Mine stone at the player's feet: the tile readout says what is under the cursor.
  const box = page.viewportSize()!;
  const cx = box.width / 2;
  const cy = box.height / 2;
  let found = false;
  for (const [dx, dy] of [
    [0, 0],
    [32, 0],
    [-32, 0],
    [0, 32],
    [0, -32],
    [32, 32],
    [-32, -32],
    [32, -32],
    [-32, 32],
  ] as const) {
    await page.mouse.move(cx + dx, cy + dy);
    await page.waitForTimeout(100);
    if ((await page.locator('#debug-overlay .tile-readout').textContent())?.includes('stone')) {
      found = true;
      break;
    }
  }
  expect(found).toBe(true);
  await page.mouse.down({ button: 'right' });
  await expect.poll(() => step(page), { timeout: 30_000 }).toBe('craft');
  await page.mouse.up({ button: 'right' });

  // Craft a furnace from the inventory's crafting panel.
  await page.keyboard.press('e');
  await page.locator('#crafting-panel .recipe[data-recipe="stone-furnace"]').click();
  await expect.poll(() => step(page), { timeout: 30_000 }).toBe('drill');
  await page.keyboard.press('e');
  await shot(page, testInfo, 'release-objectives.png');

  // Save from the game menu, reload, continue.
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu-version')).toContainText('Beltworks v');
  await page.locator('#menu-save-name').fill('Release check');
  await page.locator('#menu-save').click();
  await expect(page.locator('#menu-status')).toHaveText('Saved “Release check”.');
  await page.reload();
  await expect(page.locator('#start-latest')).toContainText('Release check');
  await page.locator('#start-continue').click();
  await expect(page.locator('#save-toast')).toContainText('Loaded “Release check”');
  await expect.poll(() => step(page)).toBe('drill');
  expect(errors).toEqual([]);
});

test('a factory researching with red and green science runs in the production build', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  // Built in Node through commands, as the benchmark does: 1 170 entities, labs on logistics 2.
  const save = gzipSync(saveSim(m3.build().sim));
  await page.goto('./');
  await page.locator('#start-new-game').click();
  await expect(page.locator('#menu-button')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('#menu-import-file').setInputFiles({
    name: 'm3-science.bwsave',
    mimeType: 'application/octet-stream',
    buffer: save,
  });
  await expect(page.locator('#menu-status')).toHaveText('Imported “m3-science”.');
  await page.locator('.save-slot', { hasText: 'm3-science' }).locator('.save-slot-load').click();
  await expect(page.locator('#save-toast')).toContainText('Loaded “m3-science”');

  // Research advances with no input.
  const status = page.locator('#research-status');
  await expect(status).toContainText('Researching Logistics 2', { timeout: 30_000 });
  const percent = async () => Number(/(\d+)%/.exec((await status.textContent()) ?? '')?.[1]);
  const before = await percent();
  const start = Date.now();
  // A unit takes 30 s in a lab, after the packs' chains fill up.
  await expect.poll(percent, { timeout: 120_000, intervals: [1000] }).toBeGreaterThan(before + 2);
  const after = await percent();
  const seconds = Math.round((Date.now() - start) / 1000);
  const rate = await fps(page, 3000);
  await page.keyboard.press('F3');
  await shot(page, testInfo, 'release-science.png');
  const overlay = (await page.locator('#debug-overlay').textContent()) ?? '';
  await testInfo.attach('numbers', {
    body: `research ${String(before)}% -> ${String(after)}% in ${String(seconds)} s; ${rate.toFixed(1)} fps (software rendering); ${overlay}`,
    contentType: 'text/plain',
  });
  console.log(
    `release check: research ${String(before)}% -> ${String(after)}% in ${String(seconds)} s, ${rate.toFixed(1)} fps, ${overlay}`,
  );
  expect(errors).toEqual([]);
});

test('the demo factory starts from ?demo and from the title screen, and researches', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  // The link: straight into the factory, without the title screen or the objectives.
  await page.goto('./?demo');
  const status = page.locator('#research-status');
  await expect(status).toContainText('Researching Automation 2', { timeout: 60_000 });
  await expect(page.locator('#start-screen')).toHaveCount(0);
  await expect(page.locator('#onboarding')).toHaveCount(0);
  const percent = async () => Number(/(\d+)%/.exec((await status.textContent()) ?? '')?.[1]);
  const before = await percent();
  const start = Date.now();
  // A unit is 2.5%; the two labs finish one about every 5 s.
  await expect
    .poll(percent, { timeout: 90_000, intervals: [1000] })
    .toBeGreaterThanOrEqual(before + 5);
  const after = await percent();
  const seconds = Math.round((Date.now() - start) / 1000);
  await shot(page, testInfo, 'release-demo.png');
  console.log(
    `release check: demo research ${String(before)}% -> ${String(after)}% in ${String(seconds)} s`,
  );

  // The button: the game menu's New game (confirmed) leads back to the title screen.
  await page.keyboard.press('Escape');
  await page.locator('#menu-new-game').click();
  await page.locator('#menu-new-game').click();
  await page.locator('#title-demo').click();
  await expect(status).toContainText('Researching Automation 2', { timeout: 60_000 });
  expect(errors).toEqual([]);
});

/**
 * The demo factory (#142, docs/DECISIONS.md, D72): `?demo` and the title
 * screen's "Demo factory" button start it in the build that deploys (this
 * suite's build differs from it only by the test hook, which these tests
 * use to read the game). The worker builds the factory through commands on
 * its own seed; within a minute of game time ore is mined and smelted, both
 * science packs are made, the labs use them and the research bar moves.
 */

import { expect, test, type Page } from '@playwright/test';
import { MachineState } from '../../src/sim/entities/machine';
import { DEMO_SEED } from '../../src/sim/scenarios/demoInfo';
import { setTimeScale } from './timeScale';

const ready = (page: Page) =>
  page.waitForFunction(
    () => window.__beltworks?.player() != null && window.__beltworks.latestTick() > 0,
    null,
    { timeout: 60_000 },
  );

const units = (page: Page) =>
  page.evaluate(() => window.__beltworks!.research().techs['automation-2']!.unitsDone);

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

test('?demo runs the factory from ore to research', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.goto('./?demo');
  await ready(page);
  // No objectives: the factory is built already; the camera frames it instead of following.
  await expect(page.locator('#onboarding')).toHaveCount(0);
  const camera = await page.evaluate(() => ({
    ...window.__beltworks!.camera(),
    following: window.__beltworks!.following(),
  }));
  expect(camera.following).toBe(false);
  expect(camera.zoom).toBeGreaterThanOrEqual(0.3);
  expect(camera.zoom).toBeLessThanOrEqual(1);
  await expect(page.locator('#start-screen')).toHaveCount(0);
  const research = await page.evaluate(() => window.__beltworks!.research().current);
  expect(research).toBe('automation-2');

  // A minute of game time, counted in the worker, sped up.
  await page.evaluate(() => window.__beltworks!.capture.production(true));
  const before = await units(page);
  const tick0 = await page.evaluate(() => window.__beltworks!.latestTick());
  await setTimeScale(page, 8);
  await page.waitForFunction((t) => window.__beltworks!.latestTick() >= t + 3600, tick0, {
    timeout: 90_000,
  });
  // Key machines are at work at the end of it.
  const working = await page.evaluate((state) => {
    const at: Record<string, number> = {};
    for (const e of window.__beltworks!.entities()) {
      if (e.status === state) at[e.name] = (at[e.name] ?? 0) + 1;
    }
    return at;
  }, MachineState.Working);
  await setTimeScale(page, 1);
  const counts = await page.evaluate(() => window.__beltworks!.capture.production(false));
  expect(counts.ticks).toBeGreaterThanOrEqual(3600);
  for (const ore of ['iron-ore', 'copper-ore', 'coal'])
    expect(counts.mined[ore], ore).toBeGreaterThan(50);
  for (const item of [
    'iron-plate',
    'copper-plate',
    'iron-gear-wheel',
    'electronic-circuit',
    'automation-science-pack',
    'logistic-science-pack',
  ]) {
    expect(counts.made[item], item).toBeGreaterThan(5);
  }
  expect(counts.consumed['automation-science-pack']).toBeGreaterThan(5);
  expect(counts.consumed['logistic-science-pack']).toBeGreaterThan(5);
  expect(await units(page)).toBeGreaterThan(before + 5);
  expect(working['stone-furnace'] ?? 0).toBeGreaterThanOrEqual(8);
  expect(working['electric-mining-drill'] ?? 0).toBeGreaterThanOrEqual(8);
  expect(working['assembling-machine-1'] ?? 0).toBeGreaterThanOrEqual(4);
  expect(working.boiler ?? 0).toBe(2);
  // The research bar at the top of the screen shows it.
  await expect(page.getByText(/Researching Automation 2: \d+%/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('the title screen starts the demo factory', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('./?title=1');
  await expect(page.locator('#title-demo')).toBeVisible();
  await page.locator('#title-demo').click();
  await ready(page);
  await expect(page.locator('#start-screen')).toHaveCount(0);
  expect(await page.evaluate(() => window.__beltworks!.research().current)).toBe('automation-2');
  const entities = await page.evaluate(() => window.__beltworks!.entities().length);
  expect(entities).toBeGreaterThan(200);
  // The game menu offers the demo's seed to share.
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu-seed')).toHaveText(String(DEMO_SEED));
  expect(errors).toEqual([]);
});

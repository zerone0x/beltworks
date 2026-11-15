/**
 * The demo factory (#142, docs/DECISIONS.md, D72): `?demo` and the title
 * screen's "Demo factory" button start it in the build that deploys (this
 * suite's build differs from it only by the test hook, which these tests
 * use to read the game). The worker builds the factory through commands on
 * its own seed and researches its military branch while it warms up (D77);
 * then, in two minutes of game time, ore and stone are mined and smelted, the
 * three science packs are made, the labs use them on research speed and the
 * research bar moves.
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

/**
 * Units the labs finished, over every technology; research speed's levels
 * count with their units (level n takes 100 × n, D74).
 */
const units = (page: Page) =>
  page.evaluate(() =>
    Object.values(window.__beltworks!.research().techs).reduce(
      (n, t) => n + t.unitsDone + (100 * t.levels * (t.levels + 1)) / 2,
      0,
    ),
  );

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
  // The worker takes a moment to build the factory, and the page says so meanwhile.
  await expect(page.locator('#demo-building')).toHaveText('Building the demo factory…');
  await ready(page);
  await expect(page.locator('#demo-building')).toHaveCount(0);
  // No objectives: the factory is built already; the camera frames it instead of following.
  await expect(page.locator('#onboarding')).toHaveCount(0);
  const camera = await page.evaluate(() => ({
    ...window.__beltworks!.camera(),
    following: window.__beltworks!.following(),
  }));
  expect(camera.following).toBe(false);
  expect(camera.zoom).toBeGreaterThanOrEqual(0.25);
  expect(camera.zoom).toBeLessThanOrEqual(1);
  await expect(page.locator('#start-screen')).toHaveCount(0);
  const research = await page.evaluate(() => window.__beltworks!.research());
  expect(research.current).toBe('research-speed');
  expect(research.techs['military-science-pack']!.researched).toBe(true);

  // Two minutes of game time, counted in the worker, sped up.
  await page.evaluate(() => window.__beltworks!.capture.production(true));
  const before = await units(page);
  const tick0 = await page.evaluate(() => window.__beltworks!.latestTick());
  await setTimeScale(page, 8);
  await page.waitForFunction((t) => window.__beltworks!.latestTick() >= t + 7200, tick0, {
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
  expect(counts.ticks).toBeGreaterThanOrEqual(7200);
  for (const ore of ['iron-ore', 'copper-ore', 'coal', 'stone'])
    expect(counts.mined[ore], ore).toBeGreaterThan(50);
  for (const item of [
    'iron-plate',
    'copper-plate',
    'steel-plate',
    'stone-brick',
    'iron-gear-wheel',
    'electronic-circuit',
    'grenade',
    'piercing-rounds-magazine',
    'automation-science-pack',
    'logistic-science-pack',
    'military-science-pack',
  ]) {
    expect(counts.made[item], item).toBeGreaterThan(5);
  }
  for (const pack of ['automation-science-pack', 'logistic-science-pack', 'military-science-pack'])
    expect(counts.consumed[pack], pack).toBeGreaterThan(5);
  // Research speed at a quarter of a unit a second (D77): 30 units in two minutes.
  expect(await units(page)).toBeGreaterThan(before + 20);
  expect(working['stone-furnace'] ?? 0).toBeGreaterThanOrEqual(18);
  expect(working['electric-mining-drill'] ?? 0).toBeGreaterThanOrEqual(12);
  expect(working['assembling-machine-1'] ?? 0).toBeGreaterThanOrEqual(5);
  expect(working.lab ?? 0).toBeGreaterThanOrEqual(1);
  expect(working.boiler ?? 0).toBe(3);
  // The labs stay on research speed, which the research bar at the top of the screen shows.
  const after = await page.evaluate(() => window.__beltworks!.research());
  expect(after.current).toBe('research-speed');
  await expect(page.getByText(/Researching Research speed \d+: \d+%/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('the title screen starts the demo factory', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('./?title=1');
  await expect(page.locator('#title-demo')).toBeVisible();
  await page.locator('#title-demo').click();
  await ready(page);
  await expect(page.locator('#start-screen')).toHaveCount(0);
  expect(await page.evaluate(() => window.__beltworks!.research().current)).toBe('research-speed');
  const entities = await page.evaluate(() => window.__beltworks!.entities().length);
  expect(entities).toBeGreaterThan(200);
  // The game menu offers the demo's seed to share.
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu-seed')).toHaveText(String(DEMO_SEED));
  expect(errors).toEqual([]);
});

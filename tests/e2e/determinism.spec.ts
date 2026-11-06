import { expect, test } from '@playwright/test';
import { DETERMINISM_TICKS } from '../../src/sim/scenarios/determinism';
import { DETERMINISM_EXPECTED_HASH } from '../sim/determinism.expected';

test('the determinism scenario hashes the same in Chromium as in Node', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => window.__beltworks !== undefined);

  const result = await page.evaluate(() => window.__beltworks!.runDeterminism());
  expect(result.tick).toBe(DETERMINISM_TICKS);
  expect(result.hash.toString(16)).toBe(DETERMINISM_EXPECTED_HASH.toString(16));
});

test('the worker runs the simulation at about 60 UPS and the overlay shows it', async ({
  page,
}) => {
  await page.goto('./');
  const overlay = page.locator('#debug-overlay');
  await expect(overlay).toBeVisible();

  // Stats arrive twice a second; UPS needs two of them.
  await expect(overlay).toHaveAttribute('data-ups', /\d/, { timeout: 5_000 });
  await page.waitForTimeout(1_500);
  const ups = Number(await overlay.getAttribute('data-ups'));
  // Generous bounds: CI machines are noisy, but the loop must be neither stalled nor unthrottled.
  expect(ups).toBeGreaterThan(40);
  expect(ups).toBeLessThan(75);

  const tickA = await page.evaluate(() => window.__beltworks!.latestTick());
  await page.waitForTimeout(500);
  const tickB = await page.evaluate(() => window.__beltworks!.latestTick());
  expect(tickB).toBeGreaterThan(tickA);
  await expect(overlay).toContainText(/tick \d+ \| UPS \d+\.\d \| tick \d+\.\d{3} ms/);
});

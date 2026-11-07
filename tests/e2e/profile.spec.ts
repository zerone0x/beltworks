import { expect, test } from '@playwright/test';

/**
 * Keeps the render profile (docs/TOOLING.md, "Render profile") working: a
 * short run on the small render scene. The real profile runs locally
 * (`npm run profile:render`), not in CI: software rendering on shared
 * runners says little about frame times.
 */
test('the render profile runs on the scripted factory', async ({ page }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('./?scene=1k');
  await page.waitForFunction(() => window.__beltworks !== undefined);
  const report = await page.evaluate(() =>
    window.__beltworks!.renderProfile({
      stages: ['pan factory 0.5x', 'factory 1x'],
      durationMs: 300,
      minFrames: 3,
    }),
  );
  expect(report.stages.map((s) => s.name)).toEqual(['pan factory 0.5x', 'factory 1x']);
  for (const stage of report.stages) {
    expect(stage.frames).toBeGreaterThanOrEqual(3);
    expect(stage.interval.p50).toBeGreaterThan(0);
    expect(stage.work.max).toBeGreaterThan(0);
  }
  // The scene replaced the simulation's entities: a factory around the spawn.
  const still = report.stages[1];
  expect(still!.entities).toBeGreaterThan(500);
  expect(still!.belts).toBeGreaterThan(300);
  expect(still!.beltItems).toBe(8 * still!.belts);
  // Only what is on screen has sprites.
  const sprites = await page.evaluate(() => window.__beltworks!.sprites());
  expect(sprites.belts).toBeGreaterThan(0);
  expect(sprites.belts).toBeLessThan(still!.belts);
  expect(errors).toEqual([]);
});

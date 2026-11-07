/**
 * The scripted render profile (docs/TOOLING.md, "Render profile"): opens the
 * game with a render scene, runs `renderProfile` (src/profile/renderProfile.ts)
 * and writes the report to `profile-results/render.json` and `.md`.
 *
 * Environment: `PROFILE_SCENE` (default `10k`), `PROFILE_MS` (recorded time
 * per stage, default 3000), `PROFILE_STAGES` (comma-separated stage names),
 * `PROFILE_FRAMES` (at least this many frames per stage, default 20),
 * `PROFILE_TEXELS` (the terrain's texel cap, `?texels=`; default: the
 * renderer's), `PROFILE_ART=0` (placeholder terrain), `PROFILE_OUT` (output
 * file stem, default `profile-results/render`).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from '@playwright/test';
import { formatReport, type ProfileOptions } from '../../src/profile/renderProfile';

test('render profile', async ({ page }) => {
  const env = process.env;
  const params = new URLSearchParams({ scene: env.PROFILE_SCENE ?? '10k' });
  params.set('art', env.PROFILE_ART === '0' ? '0' : '1');
  if (env.PROFILE_TEXELS) params.set('texels', env.PROFILE_TEXELS);
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto(`./?${params.toString()}`);
  await page.waitForFunction(() => window.__beltworks !== undefined);
  const options: ProfileOptions = {
    ...(env.PROFILE_MS && { durationMs: Number(env.PROFILE_MS) }),
    ...(env.PROFILE_STAGES && { stages: env.PROFILE_STAGES.split(',') }),
    ...(env.PROFILE_FRAMES && { minFrames: Number(env.PROFILE_FRAMES) }),
  };
  const report = await page.evaluate((opts) => window.__beltworks!.renderProfile(opts), options);
  const text = formatReport(report);
  console.log(`\n${text}\n`);
  const out = env.PROFILE_OUT ?? 'profile-results/render';
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(`${out}.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${out}.md`, `${text}\n`);
  if (errors.length > 0) throw new Error(`errors during the profile:\n${errors.join('\n')}`);
});

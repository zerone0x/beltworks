/**
 * Public beta readiness (#92, D61): a crashed simulation (or one that fails
 * to start) offers the newest save, a browser without what the game needs
 * gets a message, and the version and About (controls, credits, licenses)
 * are on the title screen and in the game menu.
 */

import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// src/version.ts's source (Node can't import JSON without an import attribute).
const VERSION_LABEL = `v${(JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version}`;

const ready = (page: Page) =>
  page.waitForFunction(
    () => window.__beltworks?.player() != null && window.__beltworks.latestTick() > 0,
  );

test('a crashed simulation says so and loads the newest save', async ({ page }) => {
  await page.goto('./');
  await ready(page);
  const id = await page.evaluate(() => window.__beltworks!.autosave());
  expect(id).not.toBeNull();
  await page.evaluate(() => {
    window.__beltworks!.crash();
  });
  const dialog = page.locator('#sim-crashed');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('crash requested by a test');
  // Esc doesn't open the game menu behind the message.
  await page.keyboard.press('Escape');
  await expect(page.locator('#game-menu')).toBeHidden();
  await expect(dialog).toBeVisible();
  // The simulation stopped: no more ticks.
  const tick = await page.evaluate(() => window.__beltworks!.latestTick());
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.__beltworks!.latestTick())).toBe(tick);
  await page.locator('#crash-load').click();
  await expect(page.locator('#save-toast')).toContainText('Loaded');
  await ready(page);
  await expect(page.locator('#sim-crashed')).toHaveCount(0);
});

test('a simulation that fails to start says so instead of hanging', async ({ page }) => {
  // The worker gets a starting kit it refuses, as if starting the game threw.
  await page.addInitScript(() => {
    class Patched extends Worker {
      override postMessage(msg: unknown, transfer?: unknown): void {
        const m = msg as { type?: string; startingKit?: unknown };
        if (m.type === 'init') m.startingKit = [{ item: -1, count: 1 }];
        super.postMessage(msg, transfer as StructuredSerializeOptions);
      }
    }
    globalThis.Worker = Patched;
  });
  await page.goto('./');
  const dialog = page.locator('#sim-crashed');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('invalid starting kit entry');
  await expect(page.locator('#crash-title')).toBeVisible();
});

test('a browser without what the game needs gets a message instead of the game', async ({
  page,
}) => {
  await page.addInitScript(() => {
    delete (globalThis as { DecompressionStream?: unknown }).DecompressionStream;
  });
  await page.goto('./');
  const message = page.locator('#unsupported-browser');
  await expect(message).toBeVisible();
  await expect(message.locator('.fatal-details')).toHaveText('Compression Streams (gzip)');
  await expect(page.locator('#app canvas')).toHaveCount(0);
});

test('the version and About show on the title screen and in the game menu', async ({ page }) => {
  await page.goto('./?title=1');
  await expect(page.locator('#title-version')).toHaveText(VERSION_LABEL);
  await page.locator('#title-about').click();
  const about = page.locator('#about-panel');
  await expect(about).toBeVisible();
  await expect(about.locator('#about-version')).toContainText(VERSION_LABEL);
  await expect(about.locator('#about-controls')).toContainText('Walk');
  await expect(about.getByRole('link', { name: 'MIT License' })).toHaveAttribute(
    'href',
    /\/LICENSE$/,
  );
  const licenses = about.getByRole('link', { name: 'Full license texts' });
  const text = await (await page.request.get((await licenses.getAttribute('href'))!)).text();
  expect(text).toContain('pixi.js');
  await page.keyboard.press('Escape');
  await expect(about).toBeHidden();
  await page.locator('#start-new-game').click();
  await ready(page);
  await page.keyboard.press('Escape');
  await expect(page.locator('#menu-version')).toHaveText(`Beltworks ${VERSION_LABEL}`);
  await page.locator('#menu-about').click();
  await expect(about).toBeVisible();
  await page.locator('#about-back').click();
  await expect(about).toBeHidden();
  await expect(page.locator('#menu-resume')).toBeVisible();
});

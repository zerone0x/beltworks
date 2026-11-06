import { expect, test } from '@playwright/test';

test('page loads, renders a canvas, and logs no errors', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(`console.error: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    errors.push(`pageerror: ${err.message}`);
  });
  page.on('requestfailed', (req) => {
    errors.push(`requestfailed: ${req.url()}`);
  });

  const response = await page.goto('./');
  expect(response?.ok()).toBe(true);
  await expect(page).toHaveTitle('Beltworks');

  const canvas = page.locator('canvas');
  await expect(canvas).toHaveCount(1);
  await expect(canvas).toBeVisible();

  // The canvas should fill the viewport.
  const box = await canvas.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  expect(viewport).not.toBeNull();
  expect(Math.round(box!.width)).toBe(viewport!.width);
  expect(Math.round(box!.height)).toBe(viewport!.height);

  // Give the renderer a few frames to surface asynchronous errors.
  await page.waitForTimeout(500);
  await testInfo.attach('screenshot', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  expect(errors).toEqual([]);
});

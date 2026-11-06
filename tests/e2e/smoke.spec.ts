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

  // The game canvas (UI panels may have canvases of their own, like the power panel's graph).
  const canvas = page.locator('#app > canvas');
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

test('H and the hint in the corner show the controls; Escape hides them', async ({ page }) => {
  await page.goto('./');
  const hint = page.locator('#help-hint');
  const help = page.locator('#help-panel');
  await expect(hint).toBeVisible();
  await expect(hint).toHaveText('H: controls');
  await expect(help).toBeHidden();

  await page.keyboard.press('h');
  await expect(help).toBeVisible();
  for (const text of ['WASD', 'Hold right mouse', 'Left click / drag', 'R', 'Esc']) {
    await expect(help.getByRole('cell', { name: text, exact: true })).toBeVisible();
  }
  await page.keyboard.press('h');
  await expect(help).toBeHidden();

  await hint.click();
  await expect(help).toBeVisible();
  // The hint gives the keyboard back to the game: Escape still reaches the windows.
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
});

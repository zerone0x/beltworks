import { expect, test } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { STARTING_KIT } from '../../src/data/start';
import { closeMenu } from './windows';

// Checks how the audio is wired, not what comes out of the speakers (D55).
test('audio starts on the first click, plays a placement, and mutes while the tab is hidden', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('./?audio=1');
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  const audio = () => page.evaluate(() => window.__beltworks!.audio());

  // No context before a user gesture (autoplay rules).
  expect(await audio()).toMatchObject({ unlocked: false, contextState: null, music: null });

  await page.locator('#app > canvas').click({ position: { x: 30, y: 200 } });
  await expect.poll(async () => (await audio()).contextState).toBe('running');
  const state = await audio();
  expect(state).toMatchObject({ unlocked: true, wired: true, hidden: false });
  expect(state.gains.master).toBeGreaterThan(0);
  expect(state.music?.tracksStarted).toBeLessThanOrEqual(1); // the generative music is set up

  // Placing a chest next to the player makes the placement sound.
  const key = String(STARTING_KIT.findIndex((s) => s.item === ItemId.WoodenChest) + 1);
  const player = (await page.evaluate(() => window.__beltworks!.player()))!;
  const tile = { x: Math.floor(player.x) + 2, y: Math.floor(player.y) };
  const at = await page.evaluate(
    ([x, y]) => window.__beltworks!.tileToScreen(x!, y!),
    [tile.x, tile.y],
  );
  await page.keyboard.press(key);
  await page.mouse.click(at.x, at.y);
  await expect.poll(async () => (await audio()).played.place ?? 0).toBeGreaterThanOrEqual(1);

  // A hidden tab mutes and suspends the audio; showing it again resumes.
  const setHidden = (hidden: boolean) =>
    page.evaluate((h) => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => (h ? 'hidden' : 'visible'),
      });
      document.dispatchEvent(new Event('visibilitychange'));
    }, hidden);
  await setHidden(true);
  await expect.poll(async () => (await audio()).contextState).toBe('suspended');
  expect((await audio()).gains.master).toBe(0);
  await setHidden(false);
  await expect.poll(async () => (await audio()).contextState).toBe('running');
  expect(errors).toEqual([]);
});

test('the volume sliders in the settings reach the audio engine at once', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('./?audio=1');
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  const gains = async () => (await page.evaluate(() => window.__beltworks!.audio())).gains;
  // The defaults (80 / 100 / 60 %) on the squared curve.
  const defaults = await gains();
  expect(defaults.master).toBeCloseTo(0.64, 6);
  expect(defaults.sfx).toBe(1);
  expect(defaults.music).toBeCloseTo(0.36, 6);

  await page.keyboard.press('Escape');
  await page.locator('#menu-settings').click();
  await expect(page.locator('#settings-panel')).toBeVisible();
  await expect(page.locator('#settings-panel')).not.toContainText('no sound yet');
  await page.locator('#setting-volume-master').fill('50');
  await expect.poll(async () => (await gains()).master).toBe(0.25);
  await page.locator('#setting-volume-sfx').fill('20');
  await expect.poll(async () => (await gains()).sfx).toBeCloseTo(0.04, 6);
  await page.locator('#setting-volume-music').fill('0');
  await expect.poll(async () => (await gains()).music).toBe(0);
  await closeMenu(page);

  // Stored with the settings: a reload starts at the same volumes.
  await page.reload();
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  expect((await gains()).master).toBe(0.25);
  expect(errors).toEqual([]);
});

test('the loudest mix stays below full scale at 100% volume', async ({ page }) => {
  await page.goto('./');
  await page.waitForFunction(() => window.__beltworks != null);
  // Every loop voice, the music and bursts of every one-shot at once, rendered offline.
  const peak = await page.evaluate(() => window.__beltworks!.audioMixPeak());
  console.log(`loudest mix peak: ${peak.toFixed(3)}`);
  expect(peak).toBeGreaterThan(0.3);
  expect(peak).toBeLessThanOrEqual(1);
});

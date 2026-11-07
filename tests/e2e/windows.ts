/**
 * Closing windows in e2e tests. `Escape` closes the open window, and with
 * none open it opens the game menu (#86): specs that press it just to be sure
 * nothing is open close the menu again with `closeWindows`.
 */

import type { Page } from '@playwright/test';

/** Presses `Escape` to close any open window, then closes the game menu if that opened it. */
export async function closeWindows(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  if (await page.locator('#game-menu').isVisible()) await page.keyboard.press('Escape');
}

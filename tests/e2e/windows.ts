/**
 * Closing windows in e2e tests. `Escape` closes every open window, and with
 * none open it opens the game menu (#86). The helpers press it only when
 * there is something to close and then check the expected state, so a
 * regression where one press both closes a window and opens the menu fails
 * the test instead of being tidied away.
 */

import { expect, type Page } from '@playwright/test';

/** The game's windows that `Escape` closes (the game menu aside). */
const WINDOWS = ['#entity-panel', '#inventory-panel', '#power-panel', '#tech-tree', '#help-panel'];

/** Which of `WINDOWS` are open, in one round trip. */
const openWindows = (page: Page) =>
  page.evaluate(
    (ids) =>
      ids.filter((id) => {
        const el = document.querySelector<HTMLElement>(id);
        return !!el && el.checkVisibility();
      }),
    WINDOWS,
  );

/**
 * Closes the open windows with `Escape`, if any are open (the game menu must
 * not be), then checks that they closed and the menu stayed shut.
 */
export async function closeWindows(page: Page): Promise<void> {
  const menu = page.locator('#game-menu');
  await expect(menu, 'closeWindows: the game menu is open; use closeMenu').toBeHidden();
  if ((await openWindows(page)).length > 0) {
    await page.keyboard.press('Escape');
    await expect.poll(() => openWindows(page), { message: 'windows left open' }).toEqual([]);
  }
  await expect(menu, 'Escape opened the game menu as well').toBeHidden();
}

/**
 * Closes the game menu with `Escape`: from the settings it first goes back
 * to the menu, then the menu closes, and no window was open behind it.
 */
export async function closeMenu(page: Page): Promise<void> {
  const menu = page.locator('#game-menu');
  await expect(menu).toBeVisible();
  const settings = page.locator('#settings-panel');
  if (await settings.isVisible()) {
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await expect(menu).toBeVisible();
  }
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  expect(await openWindows(page)).toEqual([]);
}

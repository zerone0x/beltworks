import { gzipSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { STARTING_KIT } from '../../src/data/start';
import { DAMAGED_SAVE_MESSAGE } from '../../src/save/compress';
import { closeMenu } from './windows';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

const ready = (page: Page) =>
  page.waitForFunction(
    () => window.__beltworks?.player() != null && window.__beltworks.latestTick() > 0,
  );
const entities = (page: Page) => page.evaluate(() => window.__beltworks!.entities());
const countOf = async (page: Page, item: number) =>
  (await page.evaluate(() => window.__beltworks!.inventory())).reduce(
    (n, s) => n + (s.item === item ? s.count : 0),
    0,
  );

/** Selects the item on hotbar key `key`, places it on tile `(x, y)` and puts it away again. */
async function place(page: Page, key: string, name: string, x: number, y: number): Promise<void> {
  await page.keyboard.press(key);
  await expect
    .poll(() => page.evaluate(() => window.__beltworks!.selectedSlot()))
    .toBe(Number(key) - 1);
  const at = await page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
  await page.mouse.move(at.x, at.y);
  await expect
    .poll(() => page.evaluate(() => window.__beltworks!.ghost()))
    .toMatchObject({ name, x, y, valid: true });
  await page.mouse.click(at.x, at.y);
  await expect
    .poll(async () => (await entities(page)).some((e) => e.name === name && e.x === x && e.y === y))
    .toBe(true);
  await page.keyboard.press('q');
  await expect.poll(() => page.evaluate(() => window.__beltworks!.selectedSlot())).toBeNull();
}

test('build, save, reload the page and continue: the factory is intact', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('./');
  await ready(page);
  // A new game without saves starts right away (no start screen).
  await expect(page.locator('#start-screen')).toHaveCount(0);

  const chestKey = String(STARTING_KIT.findIndex((s) => s.item === ItemId.WoodenChest) + 1);
  const furnaceKey = String(STARTING_KIT.findIndex((s) => s.item === ItemId.StoneFurnace) + 1);
  await place(page, chestKey, 'wooden-chest', 2, 0);
  await place(page, furnaceKey, 'stone-furnace', -3, 1);
  await expect.poll(async () => (await entities(page)).length).toBe(2);
  const built = (await entities(page)).map(({ name, x, y, dir }) => ({ name, x, y, dir }));
  const chests = await countOf(page, ItemId.WoodenChest);
  const furnaces = await countOf(page, ItemId.StoneFurnace);

  // An autosave, then a save from the menu (Esc), which is the newest.
  expect(await page.evaluate(() => window.__beltworks!.autosave())).toBe('autosave-1');
  const tickBefore = await page.evaluate(() => window.__beltworks!.latestTick());
  await page.keyboard.press('Escape');
  await expect(page.locator('#game-menu')).toBeVisible();
  await page.locator('#menu-save-name').fill('my base');
  await page.locator('#menu-save').click();
  await expect(page.locator('#menu-status')).toHaveText('Saved “my base”.');
  await expect(page.locator('#menu-slots .save-slot-name')).toHaveText(['my base', 'Autosave 1']);
  await page.keyboard.press('Escape');
  await expect(page.locator('#game-menu')).toBeHidden();

  // Reload: the start screen offers the newest save; Continue loads it.
  await page.reload();
  await expect(page.locator('#start-latest')).toContainText('my base');
  await page.locator('#start-continue').click();
  await ready(page);
  await expect(page.locator('#save-toast')).toHaveText('Loaded “my base”.');
  expect(await page.evaluate(() => window.__beltworks!.latestTick())).toBeGreaterThanOrEqual(
    tickBefore,
  );
  await expect
    .poll(async () => (await entities(page)).map(({ name, x, y, dir }) => ({ name, x, y, dir })))
    .toEqual(built);
  expect(await countOf(page, ItemId.WoodenChest)).toBe(chests);
  expect(await countOf(page, ItemId.StoneFurnace)).toBe(furnaces);

  // The menu lists both saves; Delete asks for a second click.
  await page.keyboard.press('Escape');
  const autosave = page.locator('#menu-slots tr[data-slot="autosave-1"] .save-slot-delete');
  await autosave.click();
  await expect(autosave).toHaveText('Sure?');
  await autosave.click();
  await expect(page.locator('#menu-slots .save-slot-name')).toHaveText(['my base']);
  expect(errors).toEqual([]);
});

test('the game pauses behind the menu and resumes when it closes', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('./');
  await ready(page);
  const tick = () => page.evaluate(() => window.__beltworks!.latestTick());
  const running = await tick();
  await expect.poll(tick).toBeGreaterThan(running);

  await page.keyboard.press('Escape');
  await expect(page.locator('#game-menu')).toBeVisible();
  // A snapshot already on its way may still land: wait until the counter
  // stops, then check that it stays stopped while the menu is open.
  await expect
    .poll(async () => {
      const before = await tick();
      await page.waitForTimeout(250);
      return (await tick()) - before;
    })
    .toBe(0);
  const paused = await tick();
  await page.waitForTimeout(1000);
  expect(await tick()).toBe(paused);

  await page.keyboard.press('Escape');
  await expect(page.locator('#game-menu')).toBeHidden();
  await expect.poll(tick).toBeGreaterThan(paused);
  expect(errors).toEqual([]);
});

/** The autosave slots in IndexedDB (src/save/store.ts), with the tick each was made at, by id. */
const autosaves = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<{ id: string; tick: number }[]>((resolve, reject) => {
        const open = indexedDB.open('beltworks');
        open.onerror = () => reject(open.error ?? new Error('open failed'));
        open.onsuccess = () => {
          const get = open.result.transaction('slots').objectStore('slots').getAll();
          get.onerror = () => reject(get.error ?? new Error('getAll failed'));
          get.onsuccess = () => {
            open.result.close();
            resolve(
              (get.result as { id: string; tick: number; autosave: boolean }[])
                .filter((s) => s.autosave)
                .map(({ id, tick }) => ({ id, tick }))
                .sort((a, b) => a.id.localeCompare(b.id)),
            );
          };
        };
      }),
  );

test('autosaves count play time: none while the menu pauses the game (#107)', async ({ page }) => {
  const errors = collectErrors(page);
  // Autosave every 2 s of play (120 ticks).
  const INTERVAL = 120;
  await page.goto('./?autosave=2');
  await ready(page);
  const tick = () => page.evaluate(() => window.__beltworks!.latestTick());
  const newest = (slots: { tick: number }[]) => Math.max(0, ...slots.map((s) => s.tick));
  // The first autosave comes after 2 s of play.
  await expect.poll(async () => (await autosaves(page)).length).toBeGreaterThan(0);
  expect(newest(await autosaves(page))).toBeGreaterThanOrEqual(INTERVAL);

  // The menu pauses the game (once a snapshot on its way has landed) for longer than the
  // interval: no autosave meanwhile.
  await page.keyboard.press('Escape');
  await expect(page.locator('#game-menu')).toBeVisible();
  await expect
    .poll(async () => {
      const before = await tick();
      await page.waitForTimeout(250);
      return (await tick()) - before;
    })
    .toBe(0);
  const before = await autosaves(page);
  await page.waitForTimeout(3_000);
  expect(await autosaves(page)).toEqual(before);

  // Playing on, the next one comes 2 s of play after the last.
  await closeMenu(page);
  await expect.poll(async () => newest(await autosaves(page))).toBeGreaterThan(newest(before));
  expect(newest(await autosaves(page)) - newest(before)).toBeGreaterThanOrEqual(INTERVAL);
  expect(errors).toEqual([]);
});

test('a save file damaged inside its gzip stream is refused with a clear message', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('./');
  await ready(page);
  // A gzipped file (bytes that don't compress to almost nothing) damaged
  // past its 10-byte header, so it still looks like one.
  const packed = gzipSync(
    Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 2654435761) >>> 24)),
  );
  for (let i = 12; i < 32; i++) packed[i] = packed[i]! ^ 0xff;
  await page.keyboard.press('Escape');
  await expect(page.locator('#game-menu')).toBeVisible();
  await page.locator('#menu-import-file').setInputFiles({
    name: 'bad.bwsave',
    mimeType: 'application/octet-stream',
    buffer: packed,
  });
  await expect(page.locator('#menu-status')).toHaveText(`bad.bwsave: ${DAMAGED_SAVE_MESSAGE}`);
  await expect(page.locator('#menu-slots .save-slot')).toHaveCount(0);
  expect(errors).toEqual([]);
});

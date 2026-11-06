import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { STARTING_KIT } from '../../src/data/start';
import { Direction } from '../../src/sim/entities/direction';
import { INSERTER_SWING_TICKS } from '../../src/sim/entities/inserter';
import { MachineState } from '../../src/sim/entities/machine';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

async function open(page: Page): Promise<void> {
  await page.goto('./');
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });
  // Zoom in around the player (the camera follows it), so slots and arms are easy to see.
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, -460);
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.camera())).zoom)
    .toBeGreaterThan(1.9);
  await page.waitForFunction(() => window.__beltworks!.terrainReady());
}

const tileScreen = (page: Page, x: number, y: number) =>
  page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
const ghost = (page: Page) => page.evaluate(() => window.__beltworks!.ghost());
const entityAt = async (page: Page, x: number, y: number) =>
  (await page.evaluate(() => window.__beltworks!.entities())).find(
    (e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h,
  );
const inserterAt = async (page: Page, x: number, y: number) =>
  (await page.evaluate(() => window.__beltworks!.inserters())).find((i) => i.x === x && i.y === y);
const countOf = async (page: Page, item: number) =>
  (await page.evaluate(() => window.__beltworks!.inventory())).reduce(
    (n, s) => n + (s.item === item ? s.count : 0),
    0,
  );
const keyFor = (item: number): string => String(STARTING_KIT.findIndex((s) => s.item === item) + 1);

/** Places the selected item on tile `(x, y)`, turning the ghost to face `dir` first. */
async function placeAt(page: Page, name: string, x: number, y: number, dir?: number) {
  const at = await tileScreen(page, x, y);
  await page.mouse.move(at.x, at.y);
  await expect.poll(async () => (await ghost(page))?.name).toBe(name);
  if (dir !== undefined) {
    for (let i = 0; i < 4 && (await ghost(page))?.dir !== dir; i++) {
      const before = (await ghost(page))?.dir;
      await page.keyboard.press('r');
      await expect.poll(async () => (await ghost(page))?.dir).not.toBe(before);
    }
  }
  await expect.poll(() => ghost(page)).toMatchObject({ x, y, valid: true });
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => entityAt(page, x, y)).toMatchObject({ name });
}

test('an inserter fuels itself from a chest of coal and moves the rest into another chest', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await open(page);
  const panel = page.locator('#entity-panel');

  // Chest on (-5, -2) → inserter on (-4, -2) facing east → chest on (-3, -2):
  // left of the player, clear of the panel on the right.
  await page.keyboard.press(keyFor(ItemId.WoodenChest));
  await placeAt(page, 'wooden-chest', -5, -2);
  await placeAt(page, 'wooden-chest', -3, -2);
  await page.keyboard.press(keyFor(ItemId.BurnerInserter));
  await placeAt(page, 'burner-inserter', -4, -2, Direction.East);
  await expect.poll(async () => (await entityAt(page, -4, -2))?.dir).toBe(Direction.East);
  await page.keyboard.press('q');

  // Its GUI: no fuel, an empty hand, the arm at the source.
  let at = await tileScreen(page, -4, -2);
  await page.mouse.click(at.x, at.y);
  await expect(panel).toHaveAttribute('data-type', 'burner-inserter');
  await expect(panel).toHaveAttribute('data-status', 'no-fuel');
  await expect(panel.locator('.status')).toHaveText('No fuel');
  const slot = (role: string) => panel.locator(`[data-role="${role}"] .slot`);
  await expect(slot('fuel')).toHaveAttribute('data-count', '0');
  await expect(slot('hand')).toHaveAttribute('data-count', '0');
  await expect(slot('input')).toHaveCount(0);
  expect(await inserterAt(page, -4, -2)).toMatchObject({ arm: 0, held: 0, swing: 0 });

  // All the coal into the source chest; nothing else comes from the player.
  await page.keyboard.press('Escape');
  at = await tileScreen(page, -5, -2);
  await page.mouse.click(at.x, at.y);
  await expect(panel).toHaveAttribute('data-type', 'wooden-chest');
  await panel.locator('.player-inventory .slot[data-item="coal"]').click();
  await expect.poll(() => countOf(page, ItemId.Coal)).toBe(0);
  await page.keyboard.press('Escape');

  // Back to the inserter: it took one coal for itself and is swinging with another.
  at = await tileScreen(page, -4, -2);
  await page.mouse.click(at.x, at.y);
  await expect(panel).toHaveAttribute('data-type', 'burner-inserter');
  await expect(panel).toHaveAttribute('data-status', 'working');
  await expect(panel.locator('.status')).toHaveText('Working');
  await expect.poll(async () => (await entityAt(page, -4, -2))?.status).toBe(MachineState.Working);

  // Shot with the arm half way, holding coal (polled every frame).
  await page.waitForFunction(
    (swing) =>
      window
        .__beltworks!.inserters()
        .some(
          (i) =>
            i.x === -4 &&
            i.y === -2 &&
            i.held !== 0 &&
            i.arm >= swing * 0.4 &&
            i.arm <= swing * 0.6,
        ),
    INSERTER_SWING_TICKS,
    { timeout: 20_000, polling: 'raf' },
  );
  const shot = testInfo.outputPath('m1-inserter.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('an inserter swinging coal between two chests, and its GUI', {
    path: shot,
    contentType: 'image/png',
  });
  await expect(slot('hand')).toHaveAttribute('data-item', 'coal');

  // Ten coal: the inserter keeps two (one burning, one in its fuel slot, taken
  // when the slot ran empty on its second pickup), eight end up in the target
  // chest, one per 1.2 s.
  await page.keyboard.press('Escape');
  at = await tileScreen(page, -3, -2);
  await page.mouse.click(at.x, at.y);
  await expect(panel).toHaveAttribute('data-type', 'wooden-chest');
  const target = panel.locator('.entity-slots .slot').first();
  await expect(target).toHaveAttribute('data-item', 'coal', { timeout: 10_000 });
  await expect(target).toHaveAttribute('data-count', '8', { timeout: 30_000 });
  // The source is empty: the inserter sleeps until something arrives there.
  await expect
    .poll(async () => (await entityAt(page, -4, -2))?.status)
    .toBe(MachineState.WaitingForSource);
  await expect.poll(() => inserterAt(page, -4, -2)).toMatchObject({ arm: 0, held: 0, swing: 0 });
  await page.keyboard.press('Escape');
  at = await tileScreen(page, -4, -2);
  await page.mouse.click(at.x, at.y);
  await expect(panel).toHaveAttribute('data-type', 'burner-inserter');
  await expect(panel).toHaveAttribute('data-status', 'waiting-for-source');
  await expect(panel.locator('.status')).toHaveText('Waiting for source');
  await expect(slot('fuel')).toHaveAttribute('data-count', '1');
  await expect(slot('hand')).toHaveAttribute('data-count', '0');
  expect(errors).toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { STARTING_KIT } from '../../src/data/start';
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
  // Zoom in around the player (the camera follows it).
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, -300);
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.camera())).zoom)
    .toBeGreaterThan(1.4);
  await page.waitForFunction(() => window.__beltworks!.terrainReady());
}

const tileScreen = (page: Page, x: number, y: number) =>
  page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
const countOf = async (page: Page, item: number) =>
  (await page.evaluate(() => window.__beltworks!.inventory())).reduce(
    (n, s) => n + (s.item === item ? s.count : 0),
    0,
  );
const entityAt = async (page: Page, x: number, y: number) =>
  (await page.evaluate(() => window.__beltworks!.entities())).find(
    (e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h,
  );
const ghost = (page: Page) => page.evaluate(() => window.__beltworks!.ghost());
const power = (page: Page) => page.evaluate(() => window.__beltworks!.power());
const generators = (page: Page) => page.evaluate(() => window.__beltworks!.generators());

/** Hotbar key (`1`–`0`) of the starting-kit slot holding `item`. */
const keyFor = (item: number): string => String(STARTING_KIT.findIndex((s) => s.item === item) + 1);

/**
 * Places the entity in hand with its top-left tile at `(x, y)`, pointing at
 * tile `(cx, cy)` (the ghost centers its footprint on the cursor).
 */
async function place(page: Page, name: string, x: number, y: number, cx: number, cy: number) {
  const at = await tileScreen(page, cx, cy);
  await page.mouse.move(at.x, at.y);
  await expect.poll(() => ghost(page)).toMatchObject({ name, x, y, valid: true });
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => entityAt(page, x, y)).toMatchObject({ name, x, y });
  return (await entityAt(page, x, y))!;
}

test('a boiler feeds two steam engines on a network, with GUIs for both', async ({
  page,
}, testInfo) => {
  const errors = collectErrors(page);
  await open(page);
  const panel = page.locator('#entity-panel');

  // The player stands on (0, 0). A boiler facing north on (3..4, 1..3); two
  // engines side by side in front of it, on (1..3, -4..0) and (4..6, -4..0).
  await page.keyboard.press(keyFor(ItemId.Boiler));
  // An even width centers on a tile edge: point at the edge between x = 3 and 4.
  const boiler = await place(page, 'boiler', 3, 1, 3.5, 2);
  expect(boiler.status).toBe(MachineState.NoFuel);
  await page.keyboard.press(keyFor(ItemId.SteamEngine));
  const west = await place(page, 'steam-engine', 1, -4, 2, -2);
  const east = await place(page, 'steam-engine', 4, -4, 5, -2);
  expect(await countOf(page, ItemId.SteamEngine)).toBe(0);
  // A pole above them, covering both.
  await page.keyboard.press(keyFor(ItemId.SmallElectricPole));
  await place(page, 'small-electric-pole', 3, -5, 3, -5);

  // The engines are producers on the pole's network, with no steam yet.
  await expect
    .poll(async () =>
      (await power(page)).members.map((m) => [m.id, m.maxOutput]).sort((a, b) => a[0]! - b[0]!),
    )
    .toEqual([
      [west.id, 0],
      [east.id, 0],
    ]);
  expect((await entityAt(page, 2, -2))!.status).toBe(MachineState.NoInput);

  // Open the boiler with nothing in hand and fuel it from the inventory.
  await page.keyboard.press('q');
  let at = await tileScreen(page, 3, 2);
  await page.mouse.click(at.x, at.y);
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-type', 'boiler');
  await expect(panel).toHaveAttribute('data-status', 'no-fuel');
  await panel.locator('.player-inventory .slot[data-item="coal"]').click();
  await expect(panel.locator('[data-role="fuel"] .slot')).toHaveAttribute('data-item', 'coal');
  // No consumers on the network: the boiler waits and burns nothing.
  await expect(panel).toHaveAttribute('data-status', 'no-demand');
  await expect(panel.locator('[data-role="power"]')).toHaveText('Output: 0 W / 1.8 MW');
  await expect(panel.locator('[data-role="fuel"] .slot')).toHaveAttribute('data-count', '10');

  // Now each engine can deliver 900 kW, but nothing is drawn: the flywheels stand still.
  await expect
    .poll(async () => (await power(page)).members.map((m) => [m.maxOutput, m.drawn]))
    .toEqual([
      [15_000, 0],
      [15_000, 0],
    ]);
  const net = (await power(page)).members[0]!.network;
  expect(net).toBeGreaterThan(0);
  expect((await power(page)).networks.find((n) => n.id === net)).toMatchObject({
    supply: 30_000,
    demand: 0,
  });
  expect((await generators(page)).map((g) => g.speed)).toEqual([0, 0]);

  // The engine's GUI shows its output, its maximum and the network.
  at = await tileScreen(page, 2, -2);
  await page.mouse.click(at.x, at.y);
  await expect(panel).toHaveAttribute('data-type', 'steam-engine');
  await expect(panel).toHaveAttribute('data-status', 'no-demand');
  await expect(panel.locator('[data-role="power"]')).toHaveText('Output: 0 W / 900 kW');
  await expect(panel.locator('[data-role="network"]')).toHaveText('Network: 100% satisfied');
  const shot = testInfo.outputPath('m2-steam.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('a boiler, two steam engines, a pole and the engine GUI', {
    path: shot,
    contentType: 'image/png',
  });

  // Without the pole the engine isn't connected.
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  at = await tileScreen(page, 3, -5);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expect.poll(() => entityAt(page, 3, -5)).toBeUndefined();
  at = await tileScreen(page, 2, -2);
  await page.mouse.click(at.x, at.y);
  await expect(panel).toHaveAttribute('data-type', 'steam-engine');
  await expect(panel.locator('[data-role="network"]')).toHaveText('Not connected');
  expect(errors).toEqual([]);
});

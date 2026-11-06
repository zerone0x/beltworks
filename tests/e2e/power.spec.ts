import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { STARTING_KIT } from '../../src/data/start';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

const tileScreen = (page: Page, x: number, y: number) =>
  page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
const power = (page: Page) => page.evaluate(() => window.__beltworks!.power());
const focus = (page: Page) => page.evaluate(() => window.__beltworks!.powerFocus());
const poleAt = async (page: Page, x: number, y: number) =>
  (await power(page)).poles.find((p) => p.x === x && p.y === y);
const networkOf = async (page: Page, x: number, y: number) => (await poleAt(page, x, y))?.network;

/** Hotbar key (`1`–`0`) of the starting-kit slot holding `item`. */
const keyFor = (item: number): string => String(STARTING_KIT.findIndex((s) => s.item === item) + 1);

test('poles wire up within reach, split and merge networks, and show supply area and reach', async ({
  page,
}, testInfo) => {
  const errors = collectErrors(page);
  await page.goto('./');
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  // Zoom in a little around the player (the camera follows it).
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, -200);
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.camera())).zoom)
    .toBeGreaterThan(1.3);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });

  // The player stands on (0, 0). Poles 7 tiles apart in a row south of it: wired in a chain.
  await page.keyboard.press(keyFor(ItemId.SmallElectricPole));
  const placePole = async (x: number, y: number, connects: number[]) => {
    const at = await tileScreen(page, x, y);
    await page.mouse.move(at.x, at.y);
    await expect
      .poll(() => focus(page))
      .toEqual({
        kind: 'ghost',
        name: 'small-electric-pole',
        x,
        y,
        connects,
      });
    expect((await page.evaluate(() => window.__beltworks!.ghost()))!.valid).toBe(true);
    await page.mouse.click(at.x, at.y);
    await expect.poll(() => poleAt(page, x, y)).toBeDefined();
    return (await poleAt(page, x, y))!.id;
  };
  const west = await placePole(-7, 2, []);
  const bridge = await placePole(0, 2, [west]);
  const east = await placePole(7, 2, [bridge]);
  await expect
    .poll(async () => (await power(page)).wires)
    .toEqual([
      [west, bridge],
      [bridge, east],
    ]);
  const net = (await networkOf(page, -7, 2))!;
  expect(await networkOf(page, 0, 2)).toBe(net);
  expect(await networkOf(page, 7, 2)).toBe(net);

  // Picking up the bridge splits the network: the west pole keeps its id.
  let at = await tileScreen(page, 0, 2);
  await page.mouse.move(at.x, at.y);
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await expect.poll(() => poleAt(page, 0, 2)).toBeUndefined();
  await expect.poll(async () => (await power(page)).networks.length).toBe(2);
  expect((await power(page)).wires).toEqual([]);
  expect(await networkOf(page, -7, 2)).toBe(net);
  expect(await networkOf(page, 7, 2)).not.toBe(net);

  // Putting it back merges them again, into the lower id.
  const rebridge = await placePole(0, 2, [west, east]);
  await expect.poll(() => networkOf(page, 7, 2)).toBe(net);
  expect((await power(page)).networks.map((n) => n.id)).toEqual([net]);

  // The ghost of a fourth pole previews its wires to the two poles in reach.
  at = await tileScreen(page, 3, -3);
  await page.mouse.move(at.x, at.y);
  await expect.poll(() => focus(page)).toMatchObject({ kind: 'ghost', connects: [east, rebridge] });
  const shot = testInfo.outputPath('m2-poles.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('poles, wires, supply areas and a pole ghost', {
    path: shot,
    contentType: 'image/png',
  });

  // With nothing held, hovering a pole shows its own area, reach and wires.
  await page.keyboard.press('q');
  at = await tileScreen(page, -7, 2);
  await page.mouse.move(at.x, at.y);
  await expect
    .poll(() => focus(page))
    .toEqual({
      kind: 'pole',
      name: 'small-electric-pole',
      x: -7,
      y: 2,
      connects: [rebridge],
    });
  at = await tileScreen(page, -3, -3);
  await page.mouse.move(at.x, at.y);
  await expect.poll(() => focus(page)).toBeNull();
  expect(errors).toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { STARTING_KIT } from '../../src/data/start';
import { BeltShape } from '../../src/sim/belts/belts';
import { BeltLane } from '../../src/sim/belts/line';
import { Direction } from '../../src/sim/entities/direction';

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
  await page.mouse.wheel(0, -460);
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.camera())).zoom)
    .toBeGreaterThan(1.9);
  await page.waitForFunction(() => window.__beltworks!.terrainReady());
}

const belts = (page: Page) => page.evaluate(() => window.__beltworks!.belts());
const beltAt = async (page: Page, x: number, y: number) =>
  (await belts(page)).find((b) => b.x === x && b.y === y);
const countOf = async (page: Page, item: number) =>
  (await page.evaluate(() => window.__beltworks!.inventory())).reduce(
    (n, s) => n + (s.item === item ? s.count : 0),
    0,
  );
const keyFor = (item: number): string => String(STARTING_KIT.findIndex((s) => s.item === item) + 1);

/** Places a belt on tile `(x, y)` with the ghost facing `dir` (pressing R until it does). */
async function placeBelt(page: Page, x: number, y: number, dir: number): Promise<void> {
  const at = await page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
  await page.mouse.move(at.x, at.y);
  for (let i = 0; i < 4; i++) {
    const g = await page.evaluate(() => window.__beltworks!.ghost());
    if (g?.dir === dir) break;
    await page.keyboard.press('r');
    await expect
      .poll(async () => (await page.evaluate(() => window.__beltworks!.ghost()))?.dir)
      .not.toBe(g?.dir);
  }
  await expect
    .poll(() => page.evaluate(() => window.__beltworks!.ghost()))
    .toMatchObject({ name: 'transport-belt', x, y, dir, valid: true });
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => beltAt(page, x, y)).toMatchObject({ dir });
}

/** Offsets of the items on lane `lane` of a belt, sorted. */
const offsets = (belt: { items: { lane: number; offset: number }[] } | undefined, lane: number) =>
  (belt?.items ?? [])
    .filter((i) => i.lane === lane)
    .map((i) => i.offset)
    .sort((a, b) => a - b);

test('belts carry items through a curve and a side-load to the end of the line', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await open(page);
  await page.keyboard.press(keyFor(ItemId.TransportBelt));

  // East along y = -2 from x = 1 to 5, then the corner at (6, -2) turns south down to (6, 1).
  for (let x = 1; x <= 5; x++) await placeBelt(page, x, -2, Direction.East);
  for (let y = -2; y <= 1; y++) await placeBelt(page, 6, y, Direction.South);
  // A side-loader pointing north into (3, -2) from below: it feeds the right lane.
  await placeBelt(page, 3, -1, Direction.North);
  await expect.poll(async () => (await beltAt(page, 6, -2))?.shape).toBe(BeltShape.CurveFromRight);
  expect((await beltAt(page, 5, -2))?.shape).toBe(BeltShape.Straight);
  await page.keyboard.press('q');

  // Drop the ten coal: pairs onto (1, -2) (one per lane) and onto the side-loader,
  // each time once the previous ones have moved on.
  let coal = await countOf(page, ItemId.Coal);
  expect(coal).toBe(10);
  for (const [x, y] of [
    [1, -2],
    [3, -1],
    [1, -2],
    [3, -1],
    [1, -2],
  ] as const) {
    await expect
      .poll(async () => (await beltAt(page, x, y))?.items.every((i) => i.offset < 64))
      .toBe(true);
    expect(
      await page.evaluate(([tx, ty]) => window.__beltworks!.dropOnBelt(tx!, ty!, 3, 2), [x, y]),
    ).toBe(true);
    coal -= 2;
    await expect.poll(() => countOf(page, ItemId.Coal)).toBe(coal);
  }

  // Shot once the first coal nears the corner (polled every frame, so the line is still spread out).
  await page.waitForFunction(
    () => window.__beltworks!.belts().some((b) => b.x === 5 && b.y === -2 && b.items.length > 0),
    undefined,
    { timeout: 20_000, polling: 'raf' },
  );
  const shot = testInfo.outputPath('m1-belts.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('belts with items', { path: shot, contentType: 'image/png' });

  // Everything ends up packed at the end of the line: three coal on the left
  // lane, seven on the right (three of its own plus the four side-loaded).
  await expect
    .poll(async () => offsets(await beltAt(page, 6, 1), BeltLane.Right), { timeout: 30_000 })
    .toEqual([0, 64, 128, 192]);
  await expect
    .poll(async () => offsets(await beltAt(page, 6, 1), BeltLane.Left), { timeout: 30_000 })
    .toEqual([0, 64, 128]);
  await expect
    .poll(async () => offsets(await beltAt(page, 6, 0), BeltLane.Right), { timeout: 30_000 })
    .toEqual([0, 64, 128]);
  const all = (await belts(page)).flatMap((b) => b.items);
  expect(all).toHaveLength(10);
  expect(all.every((i) => i.item === ItemId.Coal)).toBe(true);
  expect(errors).toEqual([]);
});

/**
 * The logistics sprites (docs/ART.md, "Belts", "Inserters", "Poles"), end
 * to end, from test kits (`?kit=`, docs/DECISIONS.md, D29) with real mouse
 * and keyboard input next to the spawn:
 *
 * - a clockwise belt loop (straight belts and curves), a burner and a
 *   long-handed inserter feeding it coal from chests, an electric and a fast
 *   inserter taking it off into chests, and steam power with poles wired
 *   across the scene: belts, inserters (with their arms) and poles are drawn
 *   with sprites, the arms swing and hold items (`art-logistics` screenshots
 *   at 1× and 2× zoom);
 * - a line of each belt tier with an underground pair and a curve, carrying
 *   coal: every belt drawn with sprites, the undergrounds with their hoods
 *   (`art-logistics-belts` screenshot at 1×).
 */

import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { TILE_PX } from '../../src/render/camera';
import { UndergroundMode } from '../../src/sim/belts/underground';
import { Direction } from '../../src/sim/entities/direction';
import { MachineState } from '../../src/sim/entities/machine';
import { sceneFps } from './walk';
import { closeWindows } from './windows';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}
const tile = (x: number, y: number): Rect => ({ x, y, w: 1, h: 1 });

const tileScreen = (page: Page, x: number, y: number) =>
  page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
const entityAt = async (page: Page, x: number, y: number) =>
  (await page.evaluate(() => window.__beltworks!.entities())).find(
    (e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h,
  );
const ghost = (page: Page) => page.evaluate(() => window.__beltworks!.ghost());
const sprites = (page: Page) => page.evaluate(() => window.__beltworks!.sprites());
const belts = (page: Page) => page.evaluate(() => window.__beltworks!.belts());

/** Starts a game with `kit`, waits for the terrain and both atlases; returns the errors seen. */
async function start(page: Page, kit: string): Promise<string[]> {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => errors.push(`requestfailed: ${req.url()}`));
  // With the rendered terrain (test builds default to the flat placeholder).
  await page.goto(`./?kit=${kit}&art=1`);
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });
  await expect
    .poll(async () => (await sprites(page)).models)
    .toEqual(expect.arrayContaining(['stone-furnace', 'transport-belt', 'burner-inserter']));
  return errors;
}

/**
 * Selects hotbar `key` and places its item over `r`, turned to `dir`; its
 * ghost shows the entity's sprite unless `sprite` is false.
 */
async function place(
  page: Page,
  key: string,
  r: Rect,
  name: string,
  dir: number = Direction.North,
  sprite = true,
) {
  if ((await page.evaluate(() => window.__beltworks!.selectedSlot())) !== Number(key) - 1) {
    await page.keyboard.press(key);
  }
  const at = await tileScreen(page, r.x + (r.w - 1) / 2, r.y + (r.h - 1) / 2);
  await page.mouse.move(at.x, at.y);
  await expect.poll(async () => (await ghost(page))?.name).toBe(name);
  while ((await ghost(page))?.dir !== dir) {
    await page.keyboard.press('r');
    await page.waitForTimeout(50);
  }
  await expect.poll(() => ghost(page)).toMatchObject({ x: r.x, y: r.y, dir, valid: true });
  expect((await sprites(page)).ghost).toBe(sprite);
  await page.mouse.click(at.x, at.y);
  await expect.poll(async () => (await entityAt(page, r.x, r.y))?.name).toBe(name);
}

/** Opens the window of the entity covering `r`, with nothing in hand. */
async function openEntityAt(page: Page, r: Rect, name: string) {
  await closeWindows(page);
  if ((await page.evaluate(() => window.__beltworks!.selectedSlot())) !== null) {
    await page.keyboard.press('q');
    await expect.poll(() => page.evaluate(() => window.__beltworks!.selectedSlot())).toBeNull();
  }
  const at = await tileScreen(page, r.x, r.y);
  await page.mouse.click(at.x, at.y);
  await expect(page.locator('#entity-panel')).toHaveAttribute('data-type', name);
}

/**
 * Centers the camera on tile `(x, y)` at `zoom`, with the pointer out of the
 * way, and attaches a screenshot `file` (with `clip`, of the tiles from
 * `clip[0]` to `clip[1]` only).
 */
async function shoot(
  page: Page,
  testInfo: import('@playwright/test').TestInfo,
  file: string,
  title: string,
  [x, y, zoom]: [number, number, number],
  clip?: [[number, number], [number, number]],
) {
  await page.mouse.move(5, 5);
  await page.evaluate(
    ([cx, cy, z]) => window.__beltworks!.setCamera(cx!, cy!, z),
    [x * TILE_PX, y * TILE_PX, zoom],
  );
  await page.waitForFunction(() => window.__beltworks!.terrainReady());
  await page.waitForTimeout(400);
  const shot = testInfo.outputPath(file);
  if (clip) {
    const from = await tileScreen(page, clip[0][0], clip[0][1]);
    const to = await tileScreen(page, clip[1][0], clip[1][1]);
    await page.screenshot({
      path: shot,
      clip: { x: from.x, y: from.y, width: to.x - from.x, height: to.y - from.y },
    });
  } else {
    await page.screenshot({ path: shot });
  }
  await testInfo.attach(title, { path: shot, contentType: 'image/png' });
}

/** A clockwise loop over x -7..-4, y -7..-4: each belt and the way it faces. */
const LOOP: [number, number, Direction][] = [
  [-7, -7, Direction.East],
  [-6, -7, Direction.East],
  [-5, -7, Direction.East],
  [-4, -7, Direction.South],
  [-4, -6, Direction.South],
  [-4, -5, Direction.South],
  [-4, -4, Direction.West],
  [-5, -4, Direction.West],
  [-6, -4, Direction.West],
  [-7, -4, Direction.North],
  [-7, -5, Direction.North],
  [-7, -6, Direction.North],
];

/** Inserters around the loop, the chests they work with, and the power (all in build reach of the spawn). */
const SCENE = {
  coalChest: tile(-6, -2),
  // Coal from the chest onto the loop's bottom row.
  burner: { ...tile(-6, -3), dir: Direction.North },
  // Off the loop's right side into a chest east of it.
  electric: { ...tile(-3, -5), dir: Direction.East },
  electricChest: tile(-2, -5),
  // Off the top row into a chest north of it.
  fast: { ...tile(-5, -8), dir: Direction.North },
  fastChest: tile(-5, -9),
  // More coal from a chest two tiles south onto the bottom-left corner, two tiles north.
  long: { ...tile(-7, -2), dir: Direction.North },
  longChest: tile(-7, 0),
  engine: { x: 1, y: -9, w: 3, h: 5 },
  boiler: { x: 2, y: -4, w: 2, h: 3 },
  poles: [tile(0, -4), tile(-3, -3), tile(-4, -9), tile(-8, -1)],
} as const;

test('belts, inserters and poles are drawn with their pre-rendered sprites', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const KIT = [
    'transport-belt:20',
    'burner-inserter:1',
    'electric-inserter:1',
    'fast-inserter:1',
    'long-handed-inserter:1',
    'wooden-chest:4',
    'small-electric-pole:4',
    'boiler:1',
    'steam-engine:1',
    'coal:200',
  ].join(',');
  const KEY = {
    belt: '1',
    burner: '2',
    electric: '3',
    fast: '4',
    long: '5',
    chest: '6',
    pole: '7',
    boiler: '8',
    engine: '9',
  } as const;
  const errors = await start(page, KIT);
  const panel = page.locator('#entity-panel');
  const openAt = (r: Rect, name: string) => openEntityAt(page, r, name);

  for (const [x, y, dir] of LOOP) await place(page, KEY.belt, tile(x, y), 'transport-belt', dir);
  for (const chest of [SCENE.coalChest, SCENE.electricChest, SCENE.fastChest, SCENE.longChest]) {
    await place(page, KEY.chest, chest, 'wooden-chest');
  }
  await place(page, KEY.burner, SCENE.burner, 'burner-inserter', SCENE.burner.dir);
  await place(page, KEY.electric, SCENE.electric, 'electric-inserter', SCENE.electric.dir);
  await place(page, KEY.fast, SCENE.fast, 'fast-inserter', SCENE.fast.dir);
  await place(page, KEY.long, SCENE.long, 'long-handed-inserter', SCENE.long.dir);
  // Steam power (models from the power atlas).
  await place(page, KEY.engine, SCENE.engine, 'steam-engine', Direction.North);
  await place(page, KEY.boiler, SCENE.boiler, 'boiler', Direction.North);
  for (const pole of SCENE.poles) await place(page, KEY.pole, pole, 'small-electric-pole');

  // Coal for the boiler, and for the burner and long-handed inserters to put on the belt.
  await openAt(SCENE.boiler, 'boiler');
  await panel.locator('.player-inventory .slot[data-item="coal"]').first().click();
  for (const chest of [SCENE.coalChest, SCENE.longChest]) {
    await openAt(chest, 'wooden-chest');
    await panel.locator('.player-inventory .slot[data-item="coal"]').first().click();
  }
  await closeWindows(page);
  await expect(panel).toBeHidden();

  // Belts, inserters (with arms) and poles are sprites; the electric inserters have power.
  await expect.poll(async () => (await sprites(page)).belts).toBe(LOOP.length);
  await expect.poll(async () => (await sprites(page)).arms).toBe(4);
  for (const ins of [SCENE.electric, SCENE.fast, SCENE.long]) {
    await expect
      .poll(async () => (await entityAt(page, ins.x, ins.y))?.status)
      .not.toBe(MachineState.NoPower);
  }
  // Coal goes round the loop, and the inserters move it.
  await expect
    .poll(async () => (await belts(page)).reduce((n, b) => n + b.items.length, 0), {
      timeout: 30_000,
    })
    .toBeGreaterThan(0);
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.__beltworks!.inserters())).some((i) => i.held > 0),
      { timeout: 30_000 },
    )
    .toBe(true);

  // At 1× cropped to the scene (its tiles, the tall poles and their shadows), and at 2×.
  await shoot(
    page,
    testInfo,
    'art-logistics.png',
    'belts, inserters and poles at 1× zoom',
    [-2.5, -4.5, 1],
    [
      [-10.5, -11],
      [4.5, 1.5],
    ],
  );
  await shoot(
    page,
    testInfo,
    'art-logistics-2x.png',
    'belts, inserters and poles at 2× zoom',
    [-2.5, -4.5, 2],
  );
  // Sprites don't slow the frame rate down to a crawl: the scene (which also
  // draws the animated steam power sprites) keeps a good part of the frame
  // rate of bare terrain on the same page. CI renders in software on runners
  // of varying speed, so this is a ratio, not an absolute floor.
  const rate = await sceneFps(page, [-2.5 * TILE_PX, -4.5 * TILE_PX, 1]);
  expect(
    rate.scene,
    `${String(rate.scene)} fps, bare terrain ${String(rate.bare)}`,
  ).toBeGreaterThanOrEqual(rate.bare * 0.35);
  expect(errors).toEqual([]);
});

test('every belt tier, curves and underground belts are drawn with sprites', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const TIERS = [
    { belt: 'transport-belt', underground: 'underground-belt', x: 1 },
    { belt: 'fast-transport-belt', underground: 'fast-underground-belt', x: 4 },
    { belt: 'express-transport-belt', underground: 'express-underground-belt', x: 7 },
  ];
  // Keys 1–3 the belts, 4–6 the undergrounds.
  const KIT = [
    ...TIERS.map((t) => `${t.belt}:10`),
    ...TIERS.map((t) => `${t.underground}:2`),
    'coal:50',
  ].join(',');
  const errors = await start(page, KIT);
  const { North, East } = Direction;

  // Each tier: north from y = 3, under the ground from y = 1 to y = -3, then a
  // curve east at y = -5 and one more belt.
  for (const [i, t] of TIERS.entries()) {
    const beltKey = String(i + 1);
    const undergroundKey = String(i + 4);
    for (const y of [3, 2]) await place(page, beltKey, tile(t.x, y), t.belt, North);
    await place(page, undergroundKey, tile(t.x, 1), t.underground, North);
    await place(page, undergroundKey, tile(t.x, -3), t.underground, North);
    for (const y of [-4, -5]) await place(page, beltKey, tile(t.x, y), t.belt, North);
    await place(page, beltKey, tile(t.x + 1, -5), t.belt, East);
    expect((await belts(page)).find((b) => b.x === t.x && b.y === -3)?.mode).toBe(
      UndergroundMode.Exit,
    );
  }
  // Every belt is a sprite. Coal dropped at the start of every line comes up out of its exit.
  await expect.poll(async () => (await sprites(page)).belts).toBe(TIERS.length * 7);
  for (let k = 0; k < 6; k++) {
    for (const t of TIERS) {
      await page.evaluate(
        ([x, item]) => window.__beltworks!.dropOnBelt(x!, 3, item!, 2),
        [t.x, ItemId.Coal],
      );
    }
    await page.waitForTimeout(250);
  }
  await expect
    .poll(
      async () => {
        const all = await belts(page);
        return TIERS.every((t) =>
          all.some((b) => b.x - t.x <= 1 && b.x >= t.x && b.y <= -4 && b.items.length > 0),
        );
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  await shoot(
    page,
    testInfo,
    'art-logistics-belts.png',
    'belt tiers and undergrounds at 1× zoom',
    [4.5, -1, 1],
    [
      [-0.5, -7],
      [10.5, 4.5],
    ],
  );
  expect(errors).toEqual([]);
});

test('the four inserters side by side, with their arm shadows', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const TYPES = ['burner-inserter', 'fast-inserter', 'electric-inserter', 'long-handed-inserter'];
  const KIT = [
    ...TYPES.map((t) => `${t}:1`),
    'small-electric-pole:3',
    'boiler:1',
    'steam-engine:1',
    'coal:50',
  ].join(',');
  const errors = await start(page, KIT);
  // In a row, facing north, a tile apart (idle: arms at rest over the pickup tile), and steam
  // power wired to them as in the scene above, so the electric ones show no alert.
  const row = TYPES.map((name, i) => ({ name, ...tile(-9 + 2 * i, -5) }));
  for (const [i, ins] of row.entries()) {
    await place(page, String(i + 1), ins, ins.name, Direction.North);
  }
  await place(page, '7', { x: 1, y: -9, w: 3, h: 5 }, 'steam-engine', Direction.North);
  const boiler = { x: 2, y: -4, w: 2, h: 3 };
  await place(page, '6', boiler, 'boiler', Direction.North);
  for (const pole of [tile(0, -4), tile(-4, -3), tile(-8, -3)]) {
    await place(page, '5', pole, 'small-electric-pole');
  }
  await openEntityAt(page, boiler, 'boiler');
  await page.locator('#entity-panel .player-inventory .slot[data-item="coal"]').first().click();
  await closeWindows(page);
  await expect.poll(async () => (await sprites(page)).arms).toBe(TYPES.length);
  for (const ins of row.slice(1)) {
    await expect
      .poll(async () => (await entityAt(page, ins.x, ins.y))?.status)
      .not.toBe(MachineState.NoPower);
  }

  const clip: [[number, number], [number, number]] = [
    [-10, -6.5],
    [-1, -2],
  ];
  await shoot(page, testInfo, 'art-inserters.png', 'inserters at 1× zoom', [-5.5, -4.5, 1], clip);
  await shoot(
    page,
    testInfo,
    'art-inserters-2x.png',
    'inserters at 2× zoom',
    [-5.5, -4.5, 2],
    clip,
  );
  expect(errors).toEqual([]);
});

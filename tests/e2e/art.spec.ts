/**
 * The pre-rendered sprites (docs/ART.md), end to end: from a test kit
 * (`?kit=`, docs/DECISIONS.md, D29) it builds one of every entity that has a
 * model next to the spawn with real mouse and keyboard input (a burner
 * mining drill in each direction, a boiler with two steam engines, an
 * electric mining drill), lights the furnace and the boiler (an electric
 * inserter's idle drain gives the engines a load) and sets the assembling
 * machines' recipes, then checks that the atlases loaded and those entities
 * are drawn with sprites, the terrain with its rendered look and the items
 * with rendered icons, and takes the `art-first` screenshots at 1× and 2×
 * zoom and `art-world` (the starting area, at 1× and zoomed out).
 */

import { expect, test, type Page } from '@playwright/test';
import { ITEM_IDS } from '../../src/data/items';
import { TILE_PX } from '../../src/render/camera';
import { Direction } from '../../src/sim/entities/direction';
import { drillDropTile } from '../../src/sim/entities/drill';
import { MachineState } from '../../src/sim/entities/machine';
import { fps } from './walk';

/** The test kit, in hotbar order. */
const KIT = [
  'assembling-machine-1:1',
  'assembling-machine-2:1',
  'stone-furnace:1',
  'iron-chest:1',
  'wooden-chest:1',
  'burner-mining-drill:4',
  'boiler:1',
  'steam-engine:2',
  'small-electric-pole:1',
  'electric-mining-drill:1',
  'electric-inserter:1',
  'coal:20',
  'iron-ore:10',
].join(',');
const KEY = {
  am1: '1',
  am2: '2',
  furnace: '3',
  ironChest: '4',
  woodenChest: '5',
  drill: '6',
  boiler: '7',
  engine: '8',
  pole: '9',
  electricDrill: '0',
} as const;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Footprints around the spawn (the player stands on the corner of tiles (-1..0, -1..0)). */
const SCENE = {
  am1: { x: -9, y: -7, w: 3, h: 3 },
  am2: { x: -5, y: -7, w: 3, h: 3 },
  furnace: { x: -1, y: -6, w: 2, h: 2 },
  ironChest: { x: 2, y: -5, w: 1, h: 1 },
  woodenChest: { x: 4, y: -5, w: 1, h: 1 },
  // Steam power east of the spawn: the boiler facing south feeds two engines
  // in a row below it; the pole ties them to the electric drill and inserter.
  boiler: { x: 6, y: -6, w: 2, h: 3 },
  engines: [
    { x: 5, y: -3, w: 3, h: 5 },
    { x: 5, y: 2, w: 3, h: 5 },
  ],
  pole: { x: 4, y: 0, w: 1, h: 1 },
  electricDrill: { x: 2, y: -3, w: 3, h: 3 },
  inserter: { x: 2, y: 0, w: 1, h: 1 },
  drills: [
    { x: -9, y: 2, w: 2, h: 2, dir: Direction.North },
    { x: -6, y: 2, w: 2, h: 2, dir: Direction.East },
    { x: -3, y: 2, w: 2, h: 2, dir: Direction.South },
    { x: 1, y: 2, w: 2, h: 2, dir: Direction.West },
  ],
} as const;

const MODELS = [
  'assembling-machine-1',
  'assembling-machine-2',
  'boiler',
  'burner-mining-drill',
  'electric-mining-drill',
  'iron-chest',
  'lab',
  'steam-engine',
  'stone-furnace',
  'wooden-chest',
];

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('requestfailed', (req) => errors.push(`requestfailed: ${req.url()}`));
  return errors;
}

const tileScreen = (page: Page, x: number, y: number) =>
  page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
const entityAt = async (page: Page, x: number, y: number) =>
  (await page.evaluate(() => window.__beltworks!.entities())).find(
    (e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h,
  );
const ghost = (page: Page) => page.evaluate(() => window.__beltworks!.ghost());
const sprites = (page: Page) => page.evaluate(() => window.__beltworks!.sprites());

test('entities with models are drawn with their pre-rendered sprites', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  // Full terrain density even on a software renderer, for the screenshots.
  await page.goto(`./?kit=${KIT}&texels=32`);
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });
  // (The logistics atlas adds belts, inserters and poles: tests/e2e/artLogistics.spec.ts.)
  await expect
    .poll(async () => (await sprites(page)).models)
    .toEqual(expect.arrayContaining(MODELS));
  // The terrain's rendered look, at full density (`?texels=32`).
  await expect
    .poll(() => page.evaluate(() => window.__beltworks!.terrainStats().texelsPerTile))
    .toBe(32);
  // Every item has a rendered icon.
  await expect
    .poll(() => page.evaluate(() => window.__beltworks!.renderedIcons()))
    .toBe(ITEM_IDS.length);
  const panel = page.locator('#entity-panel');

  /** Selects hotbar `key` and places its item over `r`, turned to `dir`. */
  const place = async (key: string, r: Rect, name: string, dir: number = Direction.North) => {
    // Pressing the selected slot's key again would deselect it.
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
    // The ghost shows the entity's sprite if it has a model (and a drill's, the tile it drops onto).
    const loaded = (await sprites(page)).models;
    expect((await sprites(page)).ghost).toBe(loaded.includes(name));
    if (name === 'burner-mining-drill') {
      expect((await ghost(page))?.drop).toEqual(drillDropTile(r.x, r.y, dir as Direction));
    }
    await page.mouse.click(at.x, at.y);
    await expect.poll(async () => (await entityAt(page, r.x, r.y))?.name).toBe(name);
  };
  /** Opens the window of the entity covering `r`, with nothing in hand. */
  const openAt = async (r: Rect, name: string) => {
    await page.keyboard.press('Escape');
    if ((await page.evaluate(() => window.__beltworks!.selectedSlot())) !== null) {
      await page.keyboard.press('q');
      await expect.poll(() => page.evaluate(() => window.__beltworks!.selectedSlot())).toBeNull();
    }
    const at = await tileScreen(page, r.x, r.y);
    await page.mouse.click(at.x, at.y);
    await expect(panel).toHaveAttribute('data-type', name);
  };

  await place(KEY.am1, SCENE.am1, 'assembling-machine-1');
  await place(KEY.am2, SCENE.am2, 'assembling-machine-2');
  await place(KEY.furnace, SCENE.furnace, 'stone-furnace');
  await place(KEY.ironChest, SCENE.ironChest, 'iron-chest');
  await place(KEY.woodenChest, SCENE.woodenChest, 'wooden-chest');
  for (const d of SCENE.drills) {
    await place(KEY.drill, d, 'burner-mining-drill', d.dir);
  }
  await place(KEY.boiler, SCENE.boiler, 'boiler', Direction.South);
  for (const e of SCENE.engines) await place(KEY.engine, e, 'steam-engine', Direction.South);
  await place(KEY.pole, SCENE.pole, 'small-electric-pole');
  await place(KEY.electricDrill, SCENE.electricDrill, 'electric-mining-drill');
  // The electric inserter from the inventory (past the hotbar).
  await page.keyboard.press('Escape');
  await page.keyboard.press('e');
  await page.locator('#inventory-panel .slot[data-item="electric-inserter"]').click();
  await page.keyboard.press('e');
  const at = await tileScreen(page, SCENE.inserter.x, SCENE.inserter.y);
  await page.mouse.move(at.x, at.y);
  await expect.poll(async () => (await ghost(page))?.name).toBe('electric-inserter');
  await page.mouse.click(at.x, at.y);
  await expect
    .poll(async () => (await entityAt(page, SCENE.inserter.x, SCENE.inserter.y))?.name)
    .toBe('electric-inserter');

  // Recipes for the machines (their product icons show on top), coal and ore for the furnace.
  await openAt(SCENE.am1, 'assembling-machine-1');
  await panel.locator('button.recipe[data-recipe="iron-gear-wheel"]').click();
  await openAt(SCENE.am2, 'assembling-machine-2');
  await panel.locator('button.recipe[data-recipe="copper-cable"]').click();
  await openAt(SCENE.furnace, 'stone-furnace');
  await panel.locator('.player-inventory .slot[data-item="coal"]').click({ button: 'right' }); // half of it: the rest for the boiler
  await panel.locator('.player-inventory .slot[data-item="iron-ore"]').click();
  await expect(panel).toHaveAttribute('data-status', 'working');
  await openAt(SCENE.boiler, 'boiler');
  await panel.locator('.player-inventory .slot[data-item="coal"]').click();
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect
    .poll(async () => (await entityAt(page, SCENE.furnace.x, SCENE.furnace.y))?.status)
    .toBe(MachineState.Working);

  // The boiler burns for the inserter's drain, so its fire shows.
  await expect
    .poll(async () => (await entityAt(page, SCENE.boiler.x, SCENE.boiler.y))?.status)
    .toBe(MachineState.Working);

  // Every entity built is drawn with sprites (the pole and the inserter from
  // the logistics atlas); the working furnace and boiler animate.
  await expect.poll(async () => (await sprites(page)).entities).toBe(15);
  expect((await sprites(page)).animated).toBeGreaterThanOrEqual(1);
  const assemblers = await page.evaluate(() => window.__beltworks!.assemblers());
  expect(assemblers.map((a) => a.item).every((item) => item > 0)).toBe(true);

  // Screenshots at 1× and 2×, centered on the scene, with the pointer out of the way.
  await page.mouse.move(5, 5);
  for (const [zoom, file] of [
    [1, 'art-first.png'],
    [2, 'art-first-2x.png'],
  ] as const) {
    await page.evaluate(
      ([x, y, z]) => window.__beltworks!.setCamera(x!, y!, z),
      [-1 * TILE_PX, -0.5 * TILE_PX, zoom],
    );
    await page.waitForFunction(() => window.__beltworks!.terrainReady());
    await page.waitForTimeout(300);
    const shot = testInfo.outputPath(file);
    await page.screenshot({ path: shot });
    await testInfo.attach(`the first sprites at ${String(zoom)}× zoom`, {
      path: shot,
      contentType: 'image/png',
    });
  }
  // The starting area: the build among the ore patches, at 1× and zoomed out.
  for (const [zoom, file] of [
    [1, 'art-world.png'],
    [0.5, 'art-world-zoomed-out.png'],
  ] as const) {
    await page.evaluate(([z]) => window.__beltworks!.setCamera(0, -4 * 32, z), [zoom]);
    await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
      timeout: 20_000,
    });
    await page.waitForTimeout(300);
    const shot = testInfo.outputPath(file);
    await page.screenshot({ path: shot });
    await testInfo.attach(`the starting area at ${String(zoom)}× zoom`, {
      path: shot,
      contentType: 'image/png',
    });
  }
  // Sprites don't slow the frame rate down to a crawl (CI renders in software, so the bar is low).
  expect(await fps(page, 2000)).toBeGreaterThanOrEqual(4);
  expect(errors).toEqual([]);
});

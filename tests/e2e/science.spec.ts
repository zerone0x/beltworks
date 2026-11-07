/**
 * The M3 acceptance test (docs/ROADMAP.md, "Done when"): automated red and
 * green science research a technology with no further player input.
 *
 * Built next to the spawn with real keyboard and mouse input (the test hook
 * only reads state), on steam power:
 *
 * - **Red**: iron plates in a chest → inserter → assembling machine making
 *   gears → inserter → assembling machine making automation science packs
 *   (copper plates from a second chest) → inserter → lab.
 * - **Green**: electric inserters and transport belts, each in its own chest →
 *   inserter → assembling machine making logistic science packs → inserter → a belt →
 *   inserter → the same lab.
 *
 * The page starts with a test kit (`?kit=`, docs/DECISIONS.md, D29) holding
 * the machines and the raw materials, and with the technologies before
 * automation 2 researched (`?research=`, D38), so the logistic science pack
 * recipe is unlocked; `tests/sim/research.test.ts` checks that every
 * technology can be reached from a new game. Once the last chest is filled
 * the player stands still and the simulation runs 16× faster
 * (`fastForward`, D42) until automation 2 (40 units of red + green, 5 s
 * each) is researched: about 480 s of game time, bound by the green pack
 * machine (12 s a pack).
 */

import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { Direction } from '../../src/sim/entities/direction';
import { MachineState } from '../../src/sim/entities/machine';
import { fastForward } from './timeScale';

/** The test kit, in hotbar order (keys 1–0); the copper plates go past the hotbar. */
const KIT =
  'assembling-machine-1:3,lab:1,electric-inserter:50,iron-chest:4,small-electric-pole:5,' +
  'transport-belt:50,steam-engine:1,boiler:1,coal:50,iron-plate:100,copper-plate:50';
const RESEARCHED = 'automation,electronics,logistic-science-pack';
const KEY = {
  assembler: '1',
  lab: '2',
  inserter: '3',
  chest: '4',
  pole: '5',
  belt: '6',
  engine: '7',
  boiler: '8',
} as const;

const { North, East, South, West } = Direction;
type Rect = { x: number; y: number; w: number; h: number };
const at1 = (x: number, y: number): Rect => ({ x, y, w: 1, h: 1 });

/**
 * The layout around the spawn (the player stands on the corner of tiles
 * (-1..0, -1..0) the whole time; everything is within its 10-tile reach).
 * Inserters face the way they drop.
 */
const RIG = {
  gears: { x: -9, y: -3, w: 3, h: 3 },
  red: { x: -5, y: -3, w: 3, h: 3 },
  lab: { x: -5, y: 1, w: 3, h: 3 },
  green: { x: 2, y: 4, w: 3, h: 3 },
  engine: { x: 2, y: -5, w: 3, h: 5 },
  boiler: { x: 2, y: 0, w: 2, h: 3 },
  ironChest: at1(-8, -5),
  copperChest: at1(-4, -5),
  inserterChest: at1(6, 5),
  beltChest: at1(6, 4),
  inserters: [
    { ...at1(-8, -4), dir: South }, // iron plates → gears
    { ...at1(-6, -2), dir: East }, // gears → red packs
    { ...at1(-4, -4), dir: South }, // copper plates → red packs
    { ...at1(-4, 0), dir: South }, // red packs → lab
    { ...at1(5, 5), dir: West }, // electric inserters → green packs
    { ...at1(5, 4), dir: West }, // transport belts → green packs
    { ...at1(1, 5), dir: West }, // green packs → belt
    { ...at1(-4, 4), dir: North }, // belt → lab
  ],
  /** West from the green machine's output inserter to the lab's input inserter. */
  belt: [0, -1, -2, -3, -4].map((x) => at1(x, 5)),
  poles: [at1(-6, -1), at1(-6, -4), at1(1, -1), at1(3, 3), at1(-3, 4)],
} as const;

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
const center = (r: Rect) => [r.x + (r.w - 1) / 2, r.y + (r.h - 1) / 2] as const;
const entityAt = async (page: Page, x: number, y: number) =>
  (await page.evaluate(() => window.__beltworks!.entities())).find(
    (e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h,
  );
const ghost = (page: Page) => page.evaluate(() => window.__beltworks!.ghost());
const research = (page: Page) => page.evaluate(() => window.__beltworks!.research());
const selectedSlot = (page: Page) => page.evaluate(() => window.__beltworks!.selectedSlot());

test('automated red and green science research automation 2 without further input', async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await page.goto(`./?kit=${KIT}&research=${RESEARCHED}`);
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });
  const panel = page.locator('#entity-panel');
  const tree = page.locator('#tech-tree');

  /** Selects hotbar `key` (unless selected), turns the ghost to `dir` and places it over `r`. */
  const place = async (key: string, r: Rect, name: string, dir: Direction = North) => {
    // Pressing the selected slot's key again would put the item away.
    if ((await selectedSlot(page)) !== Number(key) - 1) await page.keyboard.press(key);
    const [cx, cy] = center(r);
    const pos = await tileScreen(page, cx, cy);
    await page.mouse.move(pos.x, pos.y);
    await expect.poll(async () => (await ghost(page))?.name).toBe(name);
    while ((await ghost(page))?.dir !== dir) {
      await page.keyboard.press('r');
      await page.waitForTimeout(50);
    }
    await expect.poll(() => ghost(page)).toMatchObject({ x: r.x, y: r.y, valid: true });
    await page.mouse.click(pos.x, pos.y);
    await expect.poll(async () => (await entityAt(page, r.x, r.y))?.name).toBe(name);
  };
  /** Opens the window of the entity covering `r`, with nothing in hand. */
  const openAt = async (r: Rect, name: string) => {
    await page.keyboard.press('Escape');
    if ((await selectedSlot(page)) !== null) {
      await page.keyboard.press('q');
      await expect.poll(() => selectedSlot(page)).toBeNull();
    }
    const [cx, cy] = center(r);
    const pos = await tileScreen(page, cx, cy);
    await page.mouse.click(pos.x, pos.y);
    await expect(panel).toHaveAttribute('data-type', name);
  };
  /** Moves the whole stack of `item` from the inventory into the open entity window. */
  const putIn = async (item: string) => {
    const slot = panel.locator(`.player-inventory .slot[data-item="${item}"]`);
    await slot.click();
    await expect(slot).toHaveCount(0);
  };
  /** Picks `recipe` in the open assembling machine's window. */
  const pickRecipe = async (recipe: string) => {
    const button = panel.locator(`button.recipe[data-recipe="${recipe}"]`);
    await button.click();
    await expect(button).toHaveAttribute('data-selected', 'true');
    await expect(panel).toHaveAttribute('data-status', 'no-input');
  };

  // Build: machines, inserters, the belt, power.
  await place(KEY.assembler, RIG.gears, 'assembling-machine-1');
  await place(KEY.assembler, RIG.red, 'assembling-machine-1');
  await place(KEY.assembler, RIG.green, 'assembling-machine-1');
  await place(KEY.lab, RIG.lab, 'lab');
  for (const chest of [RIG.ironChest, RIG.copperChest, RIG.inserterChest, RIG.beltChest]) {
    await place(KEY.chest, chest, 'iron-chest');
  }
  for (const ins of RIG.inserters) await place(KEY.inserter, ins, 'electric-inserter', ins.dir);
  for (const belt of RIG.belt) await place(KEY.belt, belt, 'transport-belt', West);
  for (const pole of RIG.poles) await place(KEY.pole, pole, 'small-electric-pole');
  await place(KEY.engine, RIG.engine, 'steam-engine');
  await place(KEY.boiler, RIG.boiler, 'boiler');

  // Recipes: gears, red packs, green packs (unlocked by the logistic science pack technology).
  await openAt(RIG.gears, 'assembling-machine-1');
  await pickRecipe('iron-gear-wheel');
  await openAt(RIG.red, 'assembling-machine-1');
  await pickRecipe('automation-science-pack');
  await openAt(RIG.green, 'assembling-machine-1');
  await pickRecipe('logistic-science-pack');

  // Research: automation 2 takes red and green packs.
  await page.keyboard.press('Escape');
  await page.keyboard.press('t');
  await expect(tree).toBeVisible();
  const automation2 = tree.locator('.tech[data-tech="automation-2"]');
  await expect(automation2).toHaveAttribute('data-state', 'available');
  // Its unlock shows the assembling machine 2's icon (redrawn from the item id when icons load).
  await expect(automation2.locator('.icon[data-unlock="assembling-machine-2"]')).toHaveAttribute(
    'data-item',
    String(ItemId.AssemblingMachine2),
  );
  await automation2.click();
  await expect(automation2).toHaveAttribute('data-state', 'current');
  await page.keyboard.press('t');
  await expect(tree).toBeHidden();

  // Fuel the boiler and fill the chests: the last input of the test.
  await openAt(RIG.boiler, 'boiler');
  await putIn('coal');
  await openAt(RIG.ironChest, 'iron-chest');
  await putIn('iron-plate');
  await openAt(RIG.copperChest, 'iron-chest');
  await putIn('copper-plate');
  // One ingredient per inserter: an inserter fed both from one chest can
  // stall the machine holding one it has no room for (#82).
  await openAt(RIG.inserterChest, 'iron-chest');
  await putIn('electric-inserter');
  await openAt(RIG.beltChest, 'iron-chest');
  await putIn('transport-belt');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();

  const machine = async (r: Rect) => (await entityAt(page, r.x, r.y))?.status;
  // Everything runs on its own: the gear machine starts first, the lab once packs arrive.
  await expect.poll(() => machine(RIG.gears)).toBe(MachineState.Working);
  await expect.poll(() => machine(RIG.green)).toBe(MachineState.Working);
  const before = await research(page);
  expect(before.current).toBe('automation-2');
  expect(before.techs['automation-2']).toEqual({ unitsDone: 0, researched: false });

  // The player stands still from here on; the simulation runs 16× faster.
  const shot = testInfo.outputPath('m3-science.png');
  await fastForward(page, 16, async () => {
    await expect
      .poll(async () => (await research(page)).techs['automation-2']?.unitsDone ?? 0, {
        timeout: 60_000,
      })
      .toBeGreaterThanOrEqual(20);
    await page.screenshot({ path: shot });
    await expect
      .poll(async () => (await research(page)).techs['automation-2'], {
        timeout: 60_000,
        intervals: [500],
      })
      .toEqual({ unitsDone: 40, researched: true });
  });
  await testInfo.attach('automated red and green science halfway through automation 2', {
    path: shot,
    contentType: 'image/png',
  });

  // Researched: nothing is current any more, the lab is idle, and the
  // assembling machine 2 recipe is unlocked.
  expect((await research(page)).current).toBe('');
  await expect.poll(() => machine(RIG.lab)).toBe(MachineState.NoResearch);
  await page.keyboard.press('t');
  await expect(automation2).toHaveAttribute('data-state', 'researched');
  await page.keyboard.press('t');
  await page.keyboard.press('e');
  await expect(
    page.locator('#crafting-panel .recipe[data-recipe="assembling-machine-2"]'),
  ).toHaveAttribute('data-locked', 'false');
  // No science pack ever went through the player's hands.
  const held = (await page.evaluate(() => window.__beltworks!.inventory())).map((s) => s.item);
  expect(held).not.toContain(ItemId.AutomationSciencePack);
  expect(held).not.toContain(ItemId.LogisticSciencePack);
  expect(errors).toEqual([]);
});

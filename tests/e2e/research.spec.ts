/**
 * Research, end to end: four labs on steam power next to the spawn, the
 * automation technology picked in the tech tree (`T`), the labs fed
 * automation science packs by hand, and research running to completion,
 * which unlocks the assembling machine in the crafting panel. All with real
 * keyboard and mouse input (the test hook only reads state). The page starts
 * with a test kit (`?kit=`, dev and test builds only; docs/DECISIONS.md,
 * D29), so nothing has to be crafted first.
 *
 * Automation is 10 units of 10 s; four labs research four units at once, so
 * it takes three rounds (30 s of game time).
 */

import { expect, test, type Page } from '@playwright/test';
import { MachineState } from '../../src/sim/entities/machine';

/** The test kit, in hotbar order. */
const KIT =
  'lab:4,boiler:1,steam-engine:1,small-electric-pole:2,coal:5,automation-science-pack:24,' +
  'electronic-circuit:3,iron-gear-wheel:5,iron-plate:9';
const KEY = { lab: '1', boiler: '2', engine: '3', pole: '4' } as const;

/**
 * Footprints around the spawn (the player starts on the corner of tiles
 * (-1..0, -1..0)): four labs west of it around a pole that supplies all of
 * them, and east of it a steam engine facing north with its boiler below
 * it and a pole, 7 tiles from the first, that covers the engine.
 */
const RIG = {
  labs: [
    { x: -9, y: -3, w: 3, h: 3 },
    { x: -5, y: -3, w: 3, h: 3 },
    { x: -9, y: 1, w: 3, h: 3 },
    { x: -5, y: 1, w: 3, h: 3 },
  ],
  labPole: { x: -6, y: 0, w: 1, h: 1 },
  engine: { x: 2, y: -5, w: 3, h: 5 },
  boiler: { x: 2, y: 0, w: 2, h: 3 },
  enginePole: { x: 1, y: 0, w: 1, h: 1 },
} as const;
type Rect = { x: number; y: number; w: number; h: number };

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
const entityAt = async (page: Page, x: number, y: number) =>
  (await page.evaluate(() => window.__beltworks!.entities())).find(
    (e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h,
  );
const ghost = (page: Page) => page.evaluate(() => window.__beltworks!.ghost());
const research = (page: Page) => page.evaluate(() => window.__beltworks!.research());

test('labs fed by hand research automation, which unlocks the assembling machine', async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await page.goto(`./?kit=${KIT}`);
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, -100);
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.camera())).zoom)
    .toBeGreaterThan(1.1);
  const panel = page.locator('#entity-panel');
  const tree = page.locator('#tech-tree');

  /** Selects hotbar `key` (unless it is selected) and places its item over `r` facing north. */
  const place = async (key: string, r: Rect, name: string) => {
    // Pressing the selected slot's key again would put the item away.
    const selected = await page.evaluate(() => window.__beltworks!.selectedSlot());
    if (selected !== Number(key) - 1) await page.keyboard.press(key);
    const at = await tileScreen(page, r.x + (r.w - 1) / 2, r.y + (r.h - 1) / 2);
    await page.mouse.move(at.x, at.y);
    await expect.poll(async () => (await ghost(page))?.name).toBe(name);
    await expect.poll(() => ghost(page)).toMatchObject({ x: r.x, y: r.y, valid: true });
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
    const at = await tileScreen(page, r.x + 1, r.y + 1);
    await page.mouse.click(at.x, at.y);
    await expect(panel).toHaveAttribute('data-type', name);
  };

  for (const lab of RIG.labs) await place(KEY.lab, lab, 'lab');
  await place(KEY.pole, RIG.labPole, 'small-electric-pole');
  await place(KEY.engine, RIG.engine, 'steam-engine');
  await place(KEY.boiler, RIG.boiler, 'boiler');
  await place(KEY.pole, RIG.enginePole, 'small-electric-pole');
  await openAt(RIG.boiler, 'boiler');
  await panel.locator('.player-inventory .slot[data-item="coal"]').click();
  await expect(panel.locator('[data-role="fuel"] .slot')).toHaveAttribute('data-item', 'coal');

  // A new lab has nothing to research.
  await openAt(RIG.labs[0], 'lab');
  await expect(panel).toHaveAttribute('data-status', 'no-research');

  // The tech tree: automation is available, electronics needs it first.
  await page.keyboard.press('Escape');
  await page.keyboard.press('t');
  await expect(tree).toBeVisible();
  const automation = tree.locator('.tech[data-tech="automation"]');
  await expect(automation).toHaveAttribute('data-state', 'available');
  await expect(tree.locator('.tech[data-tech="electronics"]')).toHaveAttribute(
    'data-state',
    'locked',
  );
  await expect(tree.locator('.tech[data-tech="logistics-2"] .state')).toHaveText(
    'Requires Logistics, Logistic science pack',
  );
  await automation.click();
  await expect(automation).toHaveAttribute('data-state', 'current');
  await expect.poll(async () => (await research(page)).current).toBe('automation');
  await expect(page.locator('#research-status')).toHaveAttribute('data-tech', 'automation');
  await page.keyboard.press('t');
  await expect(tree).toBeHidden();

  // Feed the labs: a right click moves half the stack (24 → 12, 6, 3, 2).
  for (const lab of RIG.labs) {
    await openAt(lab, 'lab');
    await panel
      .locator('.player-inventory .slot[data-item="automation-science-pack"]')
      .click({ button: 'right' });
    await expect(panel.locator('[data-role="packs"] .slot').first()).toHaveAttribute(
      'data-item',
      'automation-science-pack',
    );
    await expect(panel).toHaveAttribute('data-status', 'working');
  }
  await expect(panel.locator('[data-role="research"]')).toHaveText('Researching Automation');
  await expect(panel.locator('[data-role="power"]')).toHaveText('Power: 60 kW / 60 kW');
  await page.keyboard.press('Escape');
  const labs = async () =>
    (await page.evaluate(() => window.__beltworks!.entities())).filter((e) => e.name === 'lab');
  expect((await labs()).map((l) => l.status)).toEqual(Array(4).fill(MachineState.Working));

  // Progress shows in the tree while the labs work.
  await page.keyboard.press('t');
  await expect
    .poll(async () => Number(await automation.getAttribute('data-progress')), { timeout: 30_000 })
    .toBeGreaterThan(20);
  const shot = testInfo.outputPath('m3-research.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('the tech tree while four labs research automation', {
    path: shot,
    contentType: 'image/png',
  });

  // Three rounds of 10 s: researched, and nothing is being researched any more.
  await expect
    .poll(async () => (await research(page)).techs.automation, { timeout: 90_000 })
    .toEqual({ unitsDone: 10, researched: true });
  await expect(automation).toHaveAttribute('data-state', 'researched');
  await expect(tree.locator('.tech[data-tech="electronics"]')).toHaveAttribute(
    'data-state',
    'available',
  );
  await expect(page.locator('#research-status')).toBeHidden();
  await expect
    .poll(async () => (await labs()).map((l) => l.status))
    .toEqual(Array(4).fill(MachineState.NoResearch));
  await page.keyboard.press('t');

  // The assembling machine shows in the crafting panel now.
  await page.keyboard.press('e');
  const recipe = page.locator('#crafting-panel .recipe[data-recipe="assembling-machine-1"]');
  await expect(recipe).toHaveAttribute('data-locked', 'false');
  await expect(recipe).toHaveAttribute('data-craftable', '1');
  await expect(
    page.locator('#crafting-panel .recipe[data-recipe="fast-inserter"]'),
  ).toHaveAttribute('data-locked', 'true');
  expect(errors).toEqual([]);
});

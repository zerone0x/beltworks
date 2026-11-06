/**
 * The M2 acceptance test (docs/ROADMAP.md, "Done when"): machines visibly
 * slow down when power runs short and recover once more generators are
 * added. Everything is built with real keyboard and mouse input; the test
 * hook only reads state.
 *
 * Overloading one steam engine (900 kW) takes more than 10 electric drills
 * (90 kW each), and the default kit has 2, so the page starts with a test
 * kit (`?kit=`, dev and test builds only; docs/DECISIONS.md, D29).
 */

import { expect, test, type Page } from '@playwright/test';
import { ResourceId } from '../../src/data/resources';
import { Direction } from '../../src/sim/entities/direction';
import { MachineState } from '../../src/sim/entities/machine';
import { World } from '../../src/sim/world/world';
import { walkClose } from './walk';

/** Seed used by src/main.ts. */
const WORLD_SEED = 1;

/** The test kit, in hotbar order (keys 1–5; coal in the next two slots). */
const KIT =
  'electric-mining-drill:16,wooden-chest:8,small-electric-pole:10,boiler:2,steam-engine:2,coal:100';
const KEY = {
  drill: '1',
  chest: '2',
  pole: '3',
  boiler: '4',
  engine: '5',
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
const entities = (page: Page) => page.evaluate(() => window.__beltworks!.entities());
const entityAt = async (page: Page, x: number, y: number) =>
  (await entities(page)).find((e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h);
const ghost = (page: Page) => page.evaluate(() => window.__beltworks!.ghost());
const powerIcons = (page: Page) => page.evaluate(() => window.__beltworks!.powerIcons());

/** A footprint: top-left tile, size and direction. */
interface Spot {
  x: number;
  y: number;
  w: number;
  h: number;
  dir: Direction;
}

/**
 * A row of four pairs of electric drills on row `cy`, from column `x0`: in
 * each pair a drill north of a chest faces south and one south of it faces
 * north, both dropping into it (pairs 3 tiles apart, so the row is 12 wide
 * and 7 tall). Two poles on the row's middle line, in the gaps beside the
 * chests, cover all eight drills.
 */
function drillRow(x0: number, cy: number) {
  const one = (x: number, y: number): Spot => ({ x, y, w: 1, h: 1, dir: Direction.North });
  const cxs = [0, 1, 2, 3].map((i) => x0 + 1 + 3 * i);
  return {
    chests: cxs.map((cx) => one(cx, cy)),
    drills: cxs.flatMap((cx): Spot[] => [
      { x: cx - 1, y: cy - 3, w: 3, h: 3, dir: Direction.South },
      { x: cx - 1, y: cy + 1, w: 3, h: 3, dir: Direction.North },
    ]),
    poles: [one(cxs[0]! + 1, cy), one(cxs[2]! + 1, cy)],
  };
}
type DrillRow = ReturnType<typeof drillRow>;

/**
 * The build, on the iron patch north-east of the spawn (centered on
 * (18, -21) for seed 1): two rows of drills (x 12–23; the north one on
 * y -27..-21, the south one on y -20..-14) and, north of them, two
 * generators side by side (an engine facing north, its boiler below it),
 * with a pole between the boilers and one bridging to the drills.
 */
const NORTH = drillRow(12, -24);
const SOUTH = drillRow(12, -17);
const generator = (x: number, y: number) => ({
  engine: { x, y, w: 3, h: 5, dir: Direction.North },
  boiler: { x: x + 1, y: y + 5, w: 2, h: 3, dir: Direction.North },
});
const G1 = generator(13, -39);
const G2 = generator(17, -39);
const GEN_POLE: Spot = { x: 16, y: -33, w: 1, h: 1, dir: Direction.North };
const BRIDGE_POLE: Spot = { x: 16, y: -28, w: 1, h: 1, dir: Direction.North };
/** The chest measured: the first of the north row. */
const MEASURED = NORTH.chests[0]!;
/**
 * Where the player stands: between the generators and the north row, and
 * south of the south row, west and east, clear of everything built from
 * there and within build reach (10 tiles) of the half of a row it builds,
 * anywhere within `STAND_TOLERANCE` of the spot. CI's software-rendered
 * Chromium runs at about 14 fps, where a walk overshoots by most of a tile,
 * so the spots have a tile of room around them.
 */
const NORTH_WEST = { x: 14, y: -29 };
const NORTH_EAST = { x: 21, y: -29 };
const SOUTH_WEST = { x: 14, y: -11.5 };
const SOUTH_EAST = { x: 21, y: -11.5 };
const STAND_TOLERANCE = 1;

test('drills slow down on an overloaded network and recover with a second generator', async ({
  page,
}, testInfo) => {
  test.setTimeout(420_000);
  const errors = collectErrors(page);

  // Every drill has iron ore in the 5×5 area it mines.
  const world = new World(WORLD_SEED);
  for (const d of [...NORTH.drills, ...SOUTH.drills]) {
    let ore = 0;
    for (let y = d.y - 1; y <= d.y + 3; y++) {
      for (let x = d.x - 1; x <= d.x + 3; x++) {
        if (world.resourceAt(x, y) === ResourceId.IronOre) ore++;
      }
    }
    expect(ore, `no iron ore under the drill at (${d.x}, ${d.y})`).toBeGreaterThan(0);
  }

  await page.goto(`./?kit=${KIT}`);
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });
  expect((await page.evaluate(() => window.__beltworks!.inventory())).slice(0, 7)).toEqual([
    { item: expect.any(Number), count: 16 },
    { item: expect.any(Number), count: 8 },
    { item: expect.any(Number), count: 10 },
    { item: expect.any(Number), count: 2 },
    { item: expect.any(Number), count: 2 },
    { item: expect.any(Number), count: 50 },
    { item: expect.any(Number), count: 50 },
  ]);

  const entityPanel = page.locator('#entity-panel');
  const powerPanel = page.locator('#power-panel');

  /** Selects `key`, turns the ghost to `s.dir`, and places it over `s` (ghosts center on the cursor). */
  const place = async (key: string, s: Spot, name: string) => {
    // Pressing the selected slot's key again would put the item away.
    const slot = (Number(key) + 9) % 10;
    if ((await page.evaluate(() => window.__beltworks!.selectedSlot())) !== slot) {
      await page.keyboard.press(key);
    }
    const at = await tileScreen(page, s.x + (s.w - 1) / 2, s.y + (s.h - 1) / 2);
    await page.mouse.move(at.x, at.y);
    await expect.poll(async () => (await ghost(page))?.name).toBe(name);
    while ((await ghost(page))?.dir !== s.dir) {
      await page.keyboard.press('r');
      await page.waitForTimeout(50);
    }
    await expect.poll(() => ghost(page)).toMatchObject({ x: s.x, y: s.y, valid: true });
    await page.mouse.click(at.x, at.y);
    await expect.poll(async () => (await entityAt(page, s.x, s.y))?.name).toBe(name);
  };
  /** Places the west (0) or east (1) half of `row`: a pole and two pairs. */
  const placeHalfRow = async (row: DrillRow, half: 0 | 1) => {
    await place(KEY.pole, row.poles[half]!, 'small-electric-pole');
    const drills = row.drills.slice(4 * half, 4 * half + 4);
    // Drills facing south, then north, so the ghost turns only once.
    for (const d of drills.filter((d) => d.dir === Direction.South)) {
      await place(KEY.drill, d, 'electric-mining-drill');
    }
    for (const d of drills.filter((d) => d.dir === Direction.North)) {
      await place(KEY.drill, d, 'electric-mining-drill');
    }
    for (const c of row.chests.slice(2 * half, 2 * half + 2)) {
      await place(KEY.chest, c, 'wooden-chest');
    }
  };
  const placeGenerator = async (g: typeof G1) => {
    await place(KEY.engine, g.engine, 'steam-engine');
    await place(KEY.boiler, g.boiler, 'boiler');
  };
  /** Left-clicks tile `(x, y)` with nothing in hand. */
  const clickTile = async (x: number, y: number) => {
    await page.keyboard.press('Escape');
    // Q only deselects with something selected; with nothing, it is the pipette.
    if ((await page.evaluate(() => window.__beltworks!.selectedSlot())) !== null) {
      await page.keyboard.press('q');
      await expect.poll(() => page.evaluate(() => window.__beltworks!.selectedSlot())).toBeNull();
    }
    const at = await tileScreen(page, x, y);
    await page.mouse.click(at.x, at.y);
  };
  /** Fills boiler `g`'s fuel slot with a stack of coal through its window. */
  const fuel = async (g: typeof G1) => {
    await clickTile(g.boiler.x, g.boiler.y);
    await expect(entityPanel).toHaveAttribute('data-type', 'boiler');
    await entityPanel.locator('.player-inventory .slot[data-item="coal"]').first().click();
    await expect(entityPanel.locator('[data-role="fuel"] .slot')).toHaveAttribute(
      'data-item',
      'coal',
    );
    await page.keyboard.press('Escape');
  };
  /** Opens the power panel of pole `p`. */
  const openPowerPanel = async (p: Spot) => {
    await clickTile(p.x, p.y);
    await expect(powerPanel).toBeVisible();
    await expect(powerPanel).toHaveAttribute('data-network', /\d+/);
  };
  const drills = [...NORTH.drills, ...SOUTH.drills];
  const drillStates = async (n: number) => {
    const all = await entities(page);
    return drills
      .slice(0, n)
      .map((d) => all.find((e) => e.x === d.x && e.y === d.y && e.name === 'electric-mining-drill'))
      .map((e) => e?.status);
  };
  /**
   * Units each drill of the measured pair mined per 120 ticks (one unit at
   * full power), measured on the ore arriving in its chest over at least
   * `ticks` ticks.
   */
  const pairRate = async (ticks: number) => {
    await clickTile(MEASURED.x, MEASURED.y);
    await expect(entityPanel).toHaveAttribute('data-type', 'wooden-chest');
    // The chest's slots and the tick, from the same snapshot.
    const sample = () =>
      page.evaluate(() => ({
        tick: window.__beltworks!.latestTick(),
        ore: [
          ...document.querySelectorAll<HTMLElement>(
            '#entity-panel .entity-slots .slot[data-item="iron-ore"]',
          ),
        ].reduce((n, el) => n + Number(el.dataset.count), 0),
      }));
    await expect.poll(async () => (await sample()).ore).toBeGreaterThan(0);
    const start = await sample();
    let end = start;
    await expect
      .poll(
        async () => {
          end = await sample();
          return end.tick - start.tick;
        },
        { timeout: 120_000 },
      )
      .toBeGreaterThanOrEqual(ticks);
    await page.keyboard.press('Escape');
    return ((end.ore - start.ore) / (end.tick - start.tick)) * (120 / 2);
  };
  const screenshot = async (name: string, title: string) => {
    const path = testInfo.outputPath(name);
    await page.screenshot({ path });
    await testInfo.attach(title, { path, contentType: 'image/png' });
  };

  const walkTo = async (stand: { x: number; y: number }) => {
    await page.keyboard.press('Escape');
    await walkClose(page, stand.x, stand.y, STAND_TOLERANCE);
    await page.waitForFunction(() => window.__beltworks!.terrainReady());
  };

  // 1. One generator, eight drills (720 kW of 900 kW): full speed.
  await walkTo(NORTH_WEST);
  await placeGenerator(G1);
  await place(KEY.pole, GEN_POLE, 'small-electric-pole');
  await place(KEY.pole, BRIDGE_POLE, 'small-electric-pole');
  await placeHalfRow(NORTH, 0);
  await walkTo(NORTH_EAST);
  await placeHalfRow(NORTH, 1);
  await expect.poll(() => drillStates(8)).toEqual(Array(8).fill(MachineState.NoPower));
  await walkTo(NORTH_WEST);
  await fuel(G1);
  await expect.poll(() => drillStates(8)).toEqual(Array(8).fill(MachineState.Working));
  await expect.poll(() => powerIcons(page)).toBe(0);

  await openPowerPanel(GEN_POLE);
  await expect(powerPanel).toHaveAttribute('data-satisfaction', '100');
  await expect(powerPanel.locator('[data-role="satisfaction"]')).toHaveText('100%');
  await expect(powerPanel.locator('[data-role="production"]')).toHaveText('720 kW / 900 kW');
  await expect(powerPanel.locator('[data-role="consumption"]')).toHaveText('720 kW / 720 kW');
  await expect(powerPanel.locator('[data-role="producers"] .group')).toHaveCount(1);
  await expect(
    powerPanel.locator('[data-role="producers"] .group[data-type="steam-engine"]'),
  ).toHaveAttribute('data-count', '1');
  const drillGroup = powerPanel.locator(
    '[data-role="consumers"] .group[data-type="electric-mining-drill"]',
  );
  await expect(drillGroup).toHaveAttribute('data-count', '8');
  await expect(drillGroup.locator('[data-role="power"]')).toHaveText('720 kW / 720 kW');
  const full = await pairRate(1_200);
  expect(full).toBeGreaterThan(0.85);
  expect(full).toBeLessThan(1.15);

  // 2. Eight more drills on the same network (1.44 MW of 900 kW): every
  // drill slows down to 900 / 1 440 = 62.5% and shows the yellow bolt.
  await walkTo(SOUTH_WEST);
  await placeHalfRow(SOUTH, 0);
  await walkTo(SOUTH_EAST);
  await placeHalfRow(SOUTH, 1);
  await expect.poll(() => drillStates(16)).toEqual(Array(16).fill(MachineState.LowPower));
  await expect.poll(() => powerIcons(page)).toBe(16);
  await openPowerPanel(SOUTH.poles[0]!);
  await expect(powerPanel).toHaveAttribute('data-satisfaction', '62');
  await expect(powerPanel.locator('[data-role="satisfaction"]')).toHaveText('62%');
  await expect(powerPanel.locator('[data-role="production"]')).toHaveText('900 kW / 900 kW');
  await expect(powerPanel.locator('[data-role="consumption"]')).toHaveText(/ \/ 1\.4 MW$/);
  await expect(drillGroup).toHaveAttribute('data-count', '16');
  await screenshot('m2-overloaded.png', 'sixteen drills on one steam engine, and their network');
  await walkTo(NORTH_WEST);
  const slow = await pairRate(1_200);
  expect(slow).toBeGreaterThan(0.5);
  expect(slow).toBeLessThan(0.75);
  expect(slow).toBeLessThan(full * 0.8);

  // 3. A second boiler and engine (1.8 MW for 1.44 MW): back to full speed.
  await walkTo(NORTH_EAST);
  await placeGenerator(G2);
  await fuel(G2);
  await expect.poll(() => drillStates(16)).toEqual(Array(16).fill(MachineState.Working));
  await expect.poll(() => powerIcons(page)).toBe(0);
  await walkTo(NORTH_WEST);
  const recovered = await pairRate(1_200);
  expect(recovered).toBeGreaterThan(0.85);
  expect(recovered).toBeLessThan(1.15);

  await openPowerPanel(GEN_POLE);
  await expect(powerPanel).toHaveAttribute('data-satisfaction', '100');
  await expect(powerPanel.locator('[data-role="production"]')).toHaveText('1.4 MW / 1.8 MW');
  await expect(powerPanel.locator('[data-role="consumption"]')).toHaveText('1.4 MW / 1.4 MW');
  await expect(
    powerPanel.locator('[data-role="producers"] .group[data-type="steam-engine"]'),
  ).toHaveAttribute('data-count', '2');
  // The graph has a minute of history: the overload and the recovery.
  await expect
    .poll(async () =>
      Number(await powerPanel.locator('[data-role="graph"]').getAttribute('data-samples')),
    )
    .toBeGreaterThanOrEqual(30);
  // Zoom out (around the player) to show the whole build next to the panel.
  await page.mouse.move(160, 360);
  await page.mouse.wheel(0, 240);
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.camera())).zoom)
    .toBeLessThan(0.75);
  await page.waitForFunction(() => window.__beltworks!.terrainReady());
  await screenshot('m2-power.png', 'the power panel after the network recovered');

  // Escape closes it.
  await page.keyboard.press('Escape');
  await expect(powerPanel).toBeHidden();
  expect(await page.evaluate(() => window.__beltworks!.openPowerPanel())).toBe(0);
  expect(errors).toEqual([]);
});

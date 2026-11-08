/**
 * The M2 acceptance test (docs/ROADMAP.md, "Done when"): machines visibly
 * slow down when power runs short and recover once more generators are
 * added. Everything is built with real keyboard and mouse input; the test
 * hook only reads state.
 *
 * Overloading one steam engine (900 kW) takes more than 10 electric drills
 * (90 kW each), and the default kit has 2, so the page starts with a test
 * kit (`?kit=`, dev and test builds only; docs/DECISIONS.md, D29). The
 * player walks once, from the spawn to the iron patch next to it, and builds
 * everything from where it stops: CI's software-rendered Chromium can drop
 * to 6 fps, where every walk is slow and lands a tile or more off, so the
 * build has no walks in between. The rate measurements run the simulation
 * at 8× speed while the player stands still (`setTimeScale`, D42): they are
 * measured in ticks, so only the wall time changes.
 */

import { expect, test, type Page } from '@playwright/test';
import { ResourceId } from '../../src/data/resources';
import { Direction } from '../../src/sim/entities/direction';
import { MachineState } from '../../src/sim/entities/machine';
import { inBuildReach } from '../../src/sim/entities/placement';
import { SUBTILES_PER_TILE } from '../../src/sim/fixed';
import { World } from '../../src/sim/world/world';
import { fastForward } from './timeScale';
import { walkNear } from './walk';
import { closeWindows } from './windows';
import { turnGhost } from './ghost';

/** Seed used by src/main.ts. */
const WORLD_SEED = 1;

/** The test kit, in hotbar order (keys 1–5; coal in the next three slots). */
const KIT =
  'electric-mining-drill:16,wooden-chest:8,small-electric-pole:10,boiler:2,steam-engine:2,coal:150';
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
const one = (x: number, y: number): Spot => ({ x, y, w: 1, h: 1, dir: Direction.North });

/**
 * A row of four pairs of electric drills on row `cy`, from column `x0`: in
 * each pair a drill north of a chest faces south and one south of it faces
 * north, both dropping into it (pairs 3 tiles apart, so the row is 12 wide
 * and 7 tall). Two poles on the row's middle line, in the gaps beside the
 * chests, cover all eight drills.
 */
function drillRow(x0: number, cy: number) {
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
 * The build, laid out around the spot the player builds it from (tile
 * offsets from that spot; the player stands on the corner where tiles
 * (-1, -1) and (0, 0) meet): a corridor two tiles tall (y -1..0) for the
 * player, a row of drills north of it (y -8..-2) and one south of it
 * (y 1..7), both 12 wide (x -6..5), and at each end of the corridor a
 * generator (an engine facing north, its boiler below it), with a pole in
 * the corridor beside it that covers the engine and wires it to the drills'
 * poles. Every entity is within build reach (10 tiles) of the player
 * anywhere within a tile of the spot.
 */
const NORTH = drillRow(-6, -5);
const SOUTH = drillRow(-6, 4);
const generator = (x: number, y: number) => ({
  engine: { x, y, w: 3, h: 5, dir: Direction.North },
  boiler: { x: x + 1, y: y + 5, w: 2, h: 3, dir: Direction.North },
});
const G1 = generator(-9, -4);
const G2 = generator(6, -4);
const G1_POLE = one(-5, 0);
const G2_POLE = one(5, 0);
/** The chest measured: the first of the north row. */
const MEASURED = NORTH.chests[0]!;
const ALL: Spot[] = [
  ...NORTH.drills,
  ...NORTH.chests,
  ...NORTH.poles,
  ...SOUTH.drills,
  ...SOUTH.chests,
  ...SOUTH.poles,
  G1.engine,
  G1.boiler,
  G2.engine,
  G2.boiler,
  G1_POLE,
  G2_POLE,
];
/**
 * Where the build goes: on the iron patch north-east of the spawn (centered
 * on (18, -21) for seed 1). The player walks there to within
 * `STAND_TOLERANCE` (one rendered frame of walking is about 1.5 tiles at
 * 6 fps), and the build is then laid out around the tile corner nearest to
 * where it stopped, at most `MAX_SHIFT` tiles off `SITE` on each axis, so the
 * player stands within half a tile of the corridor's middle (the drills have
 * ore under them for every such shift, checked below).
 */
const SITE = { x: 18, y: -21 };
const STAND_TOLERANCE = 1.5;
const MAX_SHIFT = 1;
/**
 * Simulation speed while measuring rates (D42), and the ticks each
 * measurement spans: 40 s of game time at full speed, 5 s of wall time.
 * (The chest's window can lag the latest tick by a rendered frame, which
 * spans more ticks when sped up, so it measures over longer than it did at
 * normal speed.)
 */
const TIME_SCALE = 8;
const RATE_TICKS = 2_400;

test('drills slow down on an overloaded network and recover with a second generator', async ({
  page,
}, testInfo) => {
  test.setTimeout(420_000);
  const errors = collectErrors(page);

  // Every drill has iron ore in the 5×5 area it mines, wherever the build ends up.
  const world = new World(WORLD_SEED);
  for (let sy = -MAX_SHIFT; sy <= MAX_SHIFT; sy++) {
    for (let sx = -MAX_SHIFT; sx <= MAX_SHIFT; sx++) {
      for (const d of [...NORTH.drills, ...SOUTH.drills]) {
        const dx = SITE.x + sx + d.x;
        const dy = SITE.y + sy + d.y;
        let ore = 0;
        for (let y = dy - 1; y <= dy + 3; y++) {
          for (let x = dx - 1; x <= dx + 3; x++) {
            if (world.resourceAt(x, y) === ResourceId.IronOre) ore++;
          }
        }
        expect(ore, `no iron ore under the drill at (${dx}, ${dy})`).toBeGreaterThan(0);
      }
    }
  }

  await page.goto(`./?kit=${KIT}`);
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });
  expect((await page.evaluate(() => window.__beltworks!.inventory())).slice(0, 8)).toEqual([
    { item: expect.any(Number), count: 16 },
    { item: expect.any(Number), count: 8 },
    { item: expect.any(Number), count: 10 },
    { item: expect.any(Number), count: 2 },
    { item: expect.any(Number), count: 2 },
    { item: expect.any(Number), count: 50 },
    { item: expect.any(Number), count: 50 },
    { item: expect.any(Number), count: 50 },
  ]);

  const entityPanel = page.locator('#entity-panel');
  const powerPanel = page.locator('#power-panel');

  // The only walk: to the site. The build goes around the tile corner
  // nearest to where the player stopped (within `MAX_SHIFT` of the site).
  const stand = await walkNear(page, SITE.x, SITE.y, STAND_TOLERANCE);
  await page.waitForFunction(() => window.__beltworks!.terrainReady());
  const shift = (d: number) => Math.max(-MAX_SHIFT, Math.min(MAX_SHIFT, Math.round(d)));
  const origin = { x: SITE.x + shift(stand.x - SITE.x), y: SITE.y + shift(stand.y - SITE.y) };
  /** Spot `s` of the layout, in world tiles. */
  const onSite = (s: Spot): Spot => ({ ...s, x: origin.x + s.x, y: origin.y + s.y });
  for (const s of ALL.map(onSite)) {
    expect(
      inBuildReach(stand.x * SUBTILES_PER_TILE, stand.y * SUBTILES_PER_TILE, s.x, s.y, s.w, s.h),
      `(${s.x}, ${s.y}) out of reach from (${stand.x}, ${stand.y})`,
    ).toBe(true);
  }

  /** Selects `key`, turns the ghost to `s.dir`, and places it over `s` (ghosts center on the cursor). */
  const place = async (key: string, spot: Spot, name: string) => {
    const s = onSite(spot);
    // Pressing the selected slot's key again would put the item away.
    const slot = (Number(key) + 9) % 10;
    if ((await page.evaluate(() => window.__beltworks!.selectedSlot())) !== slot) {
      await page.keyboard.press(key);
    }
    const at = await tileScreen(page, s.x + (s.w - 1) / 2, s.y + (s.h - 1) / 2);
    await page.mouse.move(at.x, at.y);
    await expect.poll(async () => (await ghost(page))?.name).toBe(name);
    await turnGhost(page, s.dir);
    await expect.poll(() => ghost(page)).toMatchObject({ x: s.x, y: s.y, valid: true });
    await page.mouse.click(at.x, at.y);
    await expect.poll(async () => (await entityAt(page, s.x, s.y))?.name).toBe(name);
  };
  /** Places the poles and chests of `row`. */
  const placeRowFrame = async (row: DrillRow) => {
    for (const p of row.poles) await place(KEY.pole, p, 'small-electric-pole');
    for (const c of row.chests) await place(KEY.chest, c, 'wooden-chest');
  };
  /** Places the drills of `row`: those facing south, then north, so the ghost turns only once. */
  const placeRowDrills = async (row: DrillRow) => {
    for (const d of row.drills.filter((d) => d.dir === Direction.South)) {
      await place(KEY.drill, d, 'electric-mining-drill');
    }
    for (const d of row.drills.filter((d) => d.dir === Direction.North)) {
      await place(KEY.drill, d, 'electric-mining-drill');
    }
  };
  const placeGenerator = async (g: typeof G1) => {
    await place(KEY.engine, g.engine, 'steam-engine');
    await place(KEY.boiler, g.boiler, 'boiler');
  };
  /** Left-clicks spot `s` of the layout with nothing in hand. */
  const clickSpot = async (spot: Spot) => {
    const { x, y } = onSite(spot);
    await closeWindows(page);
    // Q only deselects with something selected; with nothing, it is the pipette.
    if ((await page.evaluate(() => window.__beltworks!.selectedSlot())) !== null) {
      await page.keyboard.press('q');
      await expect.poll(() => page.evaluate(() => window.__beltworks!.selectedSlot())).toBeNull();
    }
    const at = await tileScreen(page, x, y);
    await page.mouse.click(at.x, at.y);
  };
  /** Fills boiler `g`'s fuel slot (or tops it up) from a stack of coal through its window. */
  const fuel = async (g: typeof G1) => {
    await clickSpot(g.boiler);
    await expect(entityPanel).toHaveAttribute('data-type', 'boiler');
    await entityPanel.locator('.player-inventory .slot[data-item="coal"]').first().click();
    await expect(entityPanel.locator('[data-role="fuel"] .slot')).toHaveAttribute(
      'data-item',
      'coal',
    );
    await closeWindows(page);
  };
  /** Opens the power panel of pole `p`. */
  const openPowerPanel = async (p: Spot) => {
    await clickSpot(p);
    await expect(powerPanel).toBeVisible();
    await expect(powerPanel).toHaveAttribute('data-network', /\d+/);
  };
  const drills = [...NORTH.drills, ...SOUTH.drills];
  const drillStates = async (n: number) => {
    const all = await entities(page);
    return drills
      .slice(0, n)
      .map(onSite)
      .map((d) => all.find((e) => e.x === d.x && e.y === d.y && e.name === 'electric-mining-drill'))
      .map((e) => e?.status);
  };
  /**
   * Units each drill of the measured pair mined per 120 ticks (one unit at
   * full power), measured on the ore arriving in its chest over at least
   * `ticks` ticks, with the simulation at `TIME_SCALE`× speed.
   */
  const pairRate = (ticks: number) => fastForward(page, TIME_SCALE, () => measurePairRate(ticks));
  const measurePairRate = async (ticks: number) => {
    await clickSpot(MEASURED);
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
        { timeout: 60_000 },
      )
      .toBeGreaterThanOrEqual(ticks);
    await closeWindows(page);
    return ((end.ore - start.ore) / (end.tick - start.tick)) * (120 / 2);
  };
  const screenshot = async (name: string, title: string) => {
    const path = testInfo.outputPath(name);
    await page.screenshot({ path });
    await testInfo.attach(title, { path, contentType: 'image/png' });
  };

  // 1. One generator, eight drills (720 kW of 900 kW): full speed. Its
  // boiler's stack of coal lasts about 4 minutes of game time (less when
  // overloaded), so everything but the south drills and the second
  // generator goes up before it is fuelled (nothing draws power until then).
  await placeGenerator(G1);
  await place(KEY.pole, G1_POLE, 'small-electric-pole');
  await place(KEY.pole, G2_POLE, 'small-electric-pole');
  await placeRowFrame(NORTH);
  await placeRowDrills(NORTH);
  await placeRowFrame(SOUTH);
  await expect.poll(() => drillStates(8)).toEqual(Array(8).fill(MachineState.NoPower));
  await fuel(G1);
  await expect.poll(() => drillStates(8)).toEqual(Array(8).fill(MachineState.Working));
  await expect.poll(() => powerIcons(page)).toBe(0);

  await openPowerPanel(G1_POLE);
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
  const full = await pairRate(RATE_TICKS);
  expect(full).toBeGreaterThan(0.85);
  expect(full).toBeLessThan(1.15);

  // 2. Eight more drills on the same network (1.44 MW of 900 kW): every
  // drill slows down to 900 / 1 440 = 62.5% and shows the yellow bolt.
  await placeRowDrills(SOUTH);
  await expect.poll(() => drillStates(16)).toEqual(Array(16).fill(MachineState.LowPower));
  await expect.poll(() => powerIcons(page)).toBe(16);
  await openPowerPanel(SOUTH.poles[0]!);
  await expect(powerPanel).toHaveAttribute('data-satisfaction', '62');
  await expect(powerPanel.locator('[data-role="satisfaction"]')).toHaveText('62%');
  await expect(powerPanel.locator('[data-role="production"]')).toHaveText('900 kW / 900 kW');
  await expect(powerPanel.locator('[data-role="consumption"]')).toHaveText(/ \/ 1\.4 MW$/);
  await expect(drillGroup).toHaveAttribute('data-count', '16');
  await screenshot('m2-overloaded.png', 'sixteen drills on one steam engine, and their network');
  // Top up the boiler: on a slow runner, building the south row can take a
  // good part of what its first stack lasts.
  await fuel(G1);
  const slow = await pairRate(RATE_TICKS);
  expect(slow).toBeGreaterThan(0.5);
  expect(slow).toBeLessThan(0.75);
  expect(slow).toBeLessThan(full * 0.8);

  // 3. A second boiler and engine (1.8 MW for 1.44 MW): back to full speed.
  await placeGenerator(G2);
  await fuel(G2);
  await expect.poll(() => drillStates(16)).toEqual(Array(16).fill(MachineState.Working));
  await expect.poll(() => powerIcons(page)).toBe(0);
  const recovered = await pairRate(RATE_TICKS);
  expect(recovered).toBeGreaterThan(0.85);
  expect(recovered).toBeLessThan(1.15);

  await openPowerPanel(G1_POLE);
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
  await closeWindows(page);
  await expect(powerPanel).toBeHidden();
  expect(await page.evaluate(() => window.__beltworks!.openPowerPanel())).toBe(0);
  expect(errors).toEqual([]);
});

import { expect, test, type Page } from '@playwright/test';
import { ItemId } from '../../src/data/items';
import { ResourceId } from '../../src/data/resources';
import { STARTING_KIT } from '../../src/data/start';
import { isBuildable } from '../../src/data/tiles';
import { Direction } from '../../src/sim/entities/direction';
import { MachineState } from '../../src/sim/entities/machine';
import { inBuildReach } from '../../src/sim/entities/placement';
import { SUBTILES_PER_TILE, fixedToTile } from '../../src/sim/fixed';
import { PLAYER_HALF_SIZE } from '../../src/sim/player';
import { startingPatches } from '../../src/sim/world/generate';
import { World } from '../../src/sim/world/world';
import { walkNear } from './walk';
import { closeWindows } from './windows';
import { turnGhost } from './ghost';

/** Seed used by src/main.ts. */
const WORLD_SEED = 1;

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
const powerIcons = (page: Page) => page.evaluate(() => window.__beltworks!.powerIcons());

/** Hotbar key (`1`–`0`) of the starting-kit slot holding `item`. */
const keyFor = (item: number): string =>
  String((STARTING_KIT.findIndex((s) => s.item === item) + 1) % 10);

/** A rectangle of tiles: top-left tile and size. */
interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The footprints of the rig whose electric drill has its top-left tile at
 * `(x, y)`: the drill facing east, a chest on its drop tile, and steam power
 * west of it: an engine facing north, the boiler feeding it from below, and
 * a pole whose supply area covers the drill and the engine.
 */
function rigOf(x: number, y: number) {
  return {
    drill: { x, y, w: 3, h: 3 },
    chest: { x: x + 3, y: y + 1, w: 1, h: 1 },
    engine: { x: x - 4, y: y - 2, w: 3, h: 5 },
    boiler: { x: x - 3, y: y + 3, w: 2, h: 3 },
    pole: { x: x - 1, y: y + 3, w: 1, h: 1 },
  };
}

/**
 * A rig (see `rigOf`) with iron ore under the drill's center, every tile
 * buildable, free of trees and of the player at `(sx, sy)` (tiles), and in
 * build reach; the nearest one.
 */
function findRig(world: World, sx: number, sy: number) {
  const px = Math.round(sx * SUBTILES_PER_TILE);
  const py = Math.round(sy * SUBTILES_PER_TILE);
  const [bx0, bx1] = [fixedToTile(px - PLAYER_HALF_SIZE), fixedToTile(px + PLAYER_HALF_SIZE - 1)];
  const [by0, by1] = [fixedToTile(py - PLAYER_HALF_SIZE), fixedToTile(py + PLAYER_HALF_SIZE - 1)];
  const clear = (r: Rect) => {
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) {
        if (!isBuildable(world.tileAt(x, y)) || world.treeAt(x, y)) return false;
        if (x >= bx0 && x <= bx1 && y >= by0 && y <= by1) return false;
      }
    }
    return inBuildReach(px, py, r.x, r.y, r.w, r.h);
  };
  const [cx, cy] = [Math.floor(sx), Math.floor(sy)];
  const found: { x: number; y: number }[] = [];
  for (let y = cy - 6; y <= cy + 4; y++) {
    for (let x = cx - 5; x <= cx + 6; x++) {
      if (
        world.resourceAt(x + 1, y + 1) === ResourceId.IronOre &&
        Object.values(rigOf(x, y)).every(clear)
      ) {
        found.push({ x, y });
      }
    }
  }
  const dist = (p: { x: number; y: number }) => (p.x + 1.5 - sx) ** 2 + (p.y + 1.5 - sy) ** 2;
  found.sort((a, b) => dist(a) - dist(b));
  return found[0];
}

test('an electric drill shows no power until a boiler and steam engine power it', async ({
  page,
}, testInfo) => {
  // Walking with the keyboard is slow on CI's software-rendered Chromium.
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await page.goto('./');
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, -200);
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.camera())).zoom)
    .toBeGreaterThan(1.3);

  const patch = startingPatches(WORLD_SEED).find((p) => p.ore === ResourceId.IronOre)!;
  const stand = await walkNear(page, patch.x + 0.5, patch.y + 0.5, 1.5);
  await page.waitForFunction(() => window.__beltworks!.terrainReady());
  const origin = findRig(new World(WORLD_SEED), stand.x, stand.y);
  expect(origin, `no room for the rig around (${stand.x}, ${stand.y})`).toBeDefined();
  const rig = rigOf(origin!.x, origin!.y);
  const panel = page.locator('#entity-panel');
  const slot = (role: string) => panel.locator(`[data-role="${role}"] .slot`);

  /** Selects `item`, turns its ghost to `dir`, and places it over `r` (ghosts center on the cursor). */
  const place = async (item: number, r: Rect, dir: Direction, name: string) => {
    await page.keyboard.press(keyFor(item));
    const at = await tileScreen(page, r.x + (r.w - 1) / 2, r.y + (r.h - 1) / 2);
    await page.mouse.move(at.x, at.y);
    await expect.poll(async () => (await ghost(page))?.name).toBe(name);
    await turnGhost(page, dir);
    await expect.poll(() => ghost(page)).toMatchObject({ x: r.x, y: r.y, valid: true });
    await page.mouse.click(at.x, at.y);
    await expect.poll(async () => (await entityAt(page, r.x, r.y))?.name).toBe(name);
  };
  /** Opens the window of the entity covering `r`, with nothing in hand. */
  const openAt = async (r: Rect, name: string) => {
    await closeWindows(page);
    // Q only deselects with something selected; with nothing, it is the pipette.
    if ((await page.evaluate(() => window.__beltworks!.selectedSlot())) !== null) {
      await page.keyboard.press('q');
      await expect.poll(() => page.evaluate(() => window.__beltworks!.selectedSlot())).toBeNull();
    }
    const at = await tileScreen(page, r.x, r.y);
    await page.mouse.click(at.x, at.y);
    await expect(panel).toHaveAttribute('data-type', name);
  };

  // The drill (hotbar key 0) and a chest in front of it. Not connected: no power, a red icon.
  await place(ItemId.ElectricMiningDrill, rig.drill, Direction.East, 'electric-mining-drill');
  await place(ItemId.WoodenChest, rig.chest, Direction.North, 'wooden-chest');
  await expect
    .poll(async () => (await entityAt(page, rig.drill.x, rig.drill.y))?.status)
    .toBe(MachineState.NoPower);
  await expect.poll(() => powerIcons(page)).toBe(1);

  // Its window: no fuel slot, its output, "No power", and no network.
  await openAt(rig.drill, 'electric-mining-drill');
  await expect(panel).toHaveAttribute('data-status', 'no-power');
  await expect(panel.locator('.status')).toHaveText('No power');
  await expect(slot('fuel')).toHaveCount(0);
  await expect(slot('output')).toHaveCount(1);
  await expect(panel.locator('[data-role="power"]')).toHaveText('Power: 0 W / 90 kW');
  await expect(panel.locator('[data-role="network"]')).toHaveText('Not connected');
  // Coal clicked in the inventory goes nowhere: an electric drill takes nothing.
  await panel.locator('.player-inventory .slot[data-item="coal"]').click();
  await page.waitForTimeout(300);
  await expect(slot('output')).not.toHaveAttribute('data-item', 'coal');
  const dark = testInfo.outputPath('m2-electric-no-power.png');
  await page.screenshot({ path: dark });
  await testInfo.attach('an unpowered electric drill and its window', {
    path: dark,
    contentType: 'image/png',
  });
  await closeWindows(page);

  // Steam power west of it: an engine, its boiler and a pole over the engine and the drill.
  await place(ItemId.SteamEngine, rig.engine, Direction.North, 'steam-engine');
  await place(ItemId.Boiler, rig.boiler, Direction.North, 'boiler');
  await place(ItemId.SmallElectricPole, rig.pole, Direction.North, 'small-electric-pole');
  // On a network now, but the boiler has no fuel: still no power.
  await page.waitForTimeout(300);
  expect((await entityAt(page, rig.drill.x, rig.drill.y))?.status).toBe(MachineState.NoPower);
  await openAt(rig.boiler, 'boiler');
  await panel.locator('.player-inventory .slot[data-item="coal"]').click();
  await expect(slot('fuel')).toHaveAttribute('data-item', 'coal');

  // The drill runs at full power (the engine gives up to 900 kW, it draws 90 kW).
  await expect
    .poll(async () => (await entityAt(page, rig.drill.x, rig.drill.y))?.status)
    .toBe(MachineState.Working);
  await expect.poll(() => powerIcons(page)).toBe(0);
  await expect(panel.locator('[data-role="power"]')).toHaveText('Output: 90 kW / 1.8 MW');
  // One ore every 2 s into the chest.
  await openAt(rig.chest, 'wooden-chest');
  await expect(panel.locator('.entity-slots .slot[data-item="iron-ore"]')).toHaveCount(1, {
    timeout: 30_000,
  });
  await openAt(rig.drill, 'electric-mining-drill');
  await expect(panel).toHaveAttribute('data-status', 'working');
  await expect(panel.locator('[data-role="power"]')).toHaveText('Power: 90 kW / 90 kW');
  await expect(panel.locator('[data-role="network"]')).toHaveText('Network: 100% satisfied');
  await expect
    .poll(async () =>
      Number(await panel.locator('[data-role="progress"]').getAttribute('data-value')),
    )
    .toBeGreaterThan(0);
  const shot = testInfo.outputPath('m2-electric.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('an electric drill on steam power, and its window', {
    path: shot,
    contentType: 'image/png',
  });
  expect(errors).toEqual([]);
});

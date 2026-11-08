import { expect, test, type Page } from '@playwright/test';
import { ENTITIES, EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { ResourceId } from '../../src/data/resources';
import { STARTING_KIT } from '../../src/data/start';
import { isBuildable } from '../../src/data/tiles';
import { TILE_PX } from '../../src/render/camera';
import { Direction } from '../../src/sim/entities/direction';
import { drillDropTile } from '../../src/sim/entities/drill';
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

async function open(page: Page): Promise<void> {
  await page.goto('./');
  await page.waitForFunction(() => window.__beltworks?.player() != null);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 10_000,
  });
  // Zoom in around the player (the camera follows it), so slots and shapes are easy to hit.
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, -460);
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.camera())).zoom)
    .toBeGreaterThan(1.9);
  await page.waitForFunction(() => window.__beltworks!.terrainReady());
}

/** Screen position of the center of tile `(x, y)`, or of its top-left corner. */
async function tileScreen(page: Page, x: number, y: number, corner = false) {
  const at = await page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
  const zoom = (await page.evaluate(() => window.__beltworks!.camera())).zoom;
  const shift = corner ? (TILE_PX / 2) * zoom : 0;
  return { x: at.x - shift, y: at.y - shift };
}

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

/** Hotbar key (`1`–`0`) of the starting-kit slot holding `item`. */
const keyFor = (item: number): string => String(STARTING_KIT.findIndex((s) => s.item === item) + 1);

/**
 * A drill facing east with iron ore under all four tiles, and a furnace on
 * its drop tile, both in build reach of a player standing at `(sx, sy)`
 * (tiles) and clear of its collision box; nearest to the player first.
 */
function findLayout(world: World, sx: number, sy: number) {
  const px = Math.round(sx * SUBTILES_PER_TILE);
  const py = Math.round(sy * SUBTILES_PER_TILE);
  const [bx0, bx1] = [fixedToTile(px - PLAYER_HALF_SIZE), fixedToTile(px + PLAYER_HALF_SIZE - 1)];
  const [by0, by1] = [fixedToTile(py - PLAYER_HALF_SIZE), fixedToTile(py + PLAYER_HALF_SIZE - 1)];
  const clear = (x: number, y: number) =>
    isBuildable(world.tileAt(x, y)) && !(x >= bx0 && x <= bx1 && y >= by0 && y <= by1);
  const tiles = (x: number, y: number) => [
    [x, y],
    [x + 1, y],
    [x, y + 1],
    [x + 1, y + 1],
  ];
  const candidates: { drill: { x: number; y: number }; furnace: { x: number; y: number } }[] = [];
  const [cx, cy] = [Math.floor(sx), Math.floor(sy)];
  for (let y = cy - 4; y <= cy + 3; y++) {
    for (let x = cx - 6; x <= cx + 3; x++) {
      const furnace = drillDropTile(x, y, Direction.East);
      const ok =
        tiles(x, y).every(
          ([tx, ty]) => clear(tx!, ty!) && world.resourceAt(tx!, ty!) === ResourceId.IronOre,
        ) &&
        tiles(furnace.x, furnace.y).every(([tx, ty]) => clear(tx!, ty!)) &&
        inBuildReach(px, py, x, y, 2, 2) &&
        inBuildReach(px, py, furnace.x, furnace.y, 2, 2);
      if (ok) candidates.push({ drill: { x, y }, furnace });
    }
  }
  const dist = (c: (typeof candidates)[number]) =>
    (c.drill.x + 2 - sx) ** 2 + (c.drill.y + 1 - sy) ** 2;
  candidates.sort((a, b) => dist(a) - dist(b));
  return candidates[0];
}

test('a fuelled drill on iron ore feeds a furnace, which makes plates on its own', async ({
  page,
}, testInfo) => {
  // Walking with the keyboard is slow on CI's software-rendered Chromium.
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  await open(page);
  const patch = startingPatches(WORLD_SEED).find((p) => p.ore === ResourceId.IronOre)!;
  const stand = await walkNear(page, patch.x + 0.5, patch.y + 0.5, 1.5);
  const layout = findLayout(new World(WORLD_SEED), stand.x, stand.y);
  expect(layout, `no room for a drill and a furnace around (${stand.x}, ${stand.y})`).toBeDefined();
  const { drill: d, furnace: f } = layout!;

  // The furnace first: a 2×2 ghost snaps to the tile corner under the cursor.
  await page.keyboard.press(keyFor(ItemId.StoneFurnace));
  let at = await tileScreen(page, f.x + 1, f.y + 1, true);
  await page.mouse.move(at.x, at.y);
  await expect.poll(() => ghost(page)).toMatchObject({ x: f.x, y: f.y, valid: true });
  await page.mouse.click(at.x, at.y);
  await expect.poll(() => entityAt(page, f.x, f.y)).toMatchObject({ name: 'stone-furnace' });

  // Then the drill, turned to face the furnace.
  await page.keyboard.press(keyFor(ItemId.BurnerMiningDrill));
  at = await tileScreen(page, d.x + 1, d.y + 1, true);
  await page.mouse.move(at.x, at.y);
  await expect
    .poll(async () => (await ghost(page))?.name)
    .toBe(ENTITIES[EntityTypeId.BurnerMiningDrill].name);
  await turnGhost(page, Direction.East);
  await expect
    .poll(() => ghost(page))
    .toMatchObject({ x: d.x, y: d.y, dir: Direction.East, valid: true });
  await page.mouse.click(at.x, at.y);
  await expect
    .poll(() => entityAt(page, d.x, d.y))
    .toMatchObject({ name: 'burner-mining-drill', dir: Direction.East });
  // Without fuel it waits.
  await expect.poll(async () => (await entityAt(page, d.x, d.y))?.status).toBe(MachineState.NoFuel);

  // Open the drill and give it half the coal (right click).
  await page.keyboard.press('q');
  at = await tileScreen(page, d.x, d.y);
  await page.mouse.click(at.x, at.y);
  const panel = page.locator('#entity-panel');
  const slot = (role: string) => panel.locator(`[data-role="${role}"] .slot`);
  await expect(panel).toHaveAttribute('data-type', 'burner-mining-drill');
  await expect(panel).toHaveAttribute('data-status', 'no-fuel');
  await expect(panel.locator('.status')).toHaveText('No fuel');
  // A drill has no input slot.
  await expect(slot('input')).toHaveCount(0);
  await panel.locator('.player-inventory .slot[data-item="coal"]').click({ button: 'right' });
  await expect(slot('fuel')).toHaveAttribute('data-item', 'coal');
  await expect(slot('fuel')).toHaveAttribute('data-count', '4');
  await expect.poll(() => countOf(page, ItemId.Coal)).toBe(5);
  await expect(panel).toHaveAttribute('data-status', 'working');
  await expect(panel.locator('.status')).toHaveText('Working');

  // The furnace gets the rest of the coal; nothing else comes from the player.
  await closeWindows(page);
  await expect(panel).toBeHidden();
  at = await tileScreen(page, f.x + 1, f.y + 1);
  await page.mouse.click(at.x, at.y);
  await expect(panel).toHaveAttribute('data-type', 'stone-furnace');
  await panel.locator('.player-inventory .slot[data-item="coal"]').click();
  await expect(slot('fuel')).toHaveAttribute('data-item', 'coal');
  await expect.poll(() => countOf(page, ItemId.Coal)).toBe(0);

  // One ore every 240 ticks from the drill, one plate 192 ticks after each ore.
  await expect(slot('output')).toHaveAttribute('data-item', 'iron-plate', { timeout: 60_000 });
  await expect(slot('output')).toHaveAttribute('data-count', '2', { timeout: 60_000 });
  expect(await countOf(page, ItemId.IronOre)).toBe(0);
  expect(await countOf(page, ItemId.IronPlate)).toBe(0);
  await expect
    .poll(async () => (await entityAt(page, d.x, d.y))?.status)
    .toBe(MachineState.Working);

  // Back to the drill's GUI for the screenshot: working, with its progress showing.
  await closeWindows(page);
  at = await tileScreen(page, d.x, d.y);
  await page.mouse.click(at.x, at.y);
  await expect(panel).toHaveAttribute('data-type', 'burner-mining-drill');
  await expect(panel).toHaveAttribute('data-status', 'working');
  await expect
    .poll(async () =>
      Number(await panel.locator('[data-role="progress"]').getAttribute('data-value')),
    )
    .toBeGreaterThan(0);
  const shot = testInfo.outputPath('m1-drill.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('a drill feeding a furnace, and its GUI', {
    path: shot,
    contentType: 'image/png',
  });
  expect(errors).toEqual([]);
});

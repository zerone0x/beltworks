/**
 * The M1 "Done when" (docs/ROADMAP.md): from a new game with the starting
 * kit, the player builds iron ore → burner mining drill → belt → burner
 * inserter → stone furnace → burner inserter → wooden chest with real
 * keyboard and mouse input, fuels everything through the entity GUI, and the
 * chest then fills with iron plates without any further input.
 *
 * The test hook (src/testHook.ts) is only used to read state: where the
 * player stands, the ghost, the entities and belts the renderer knows, and
 * the inventory; the ore layout comes from a main-thread `World` with the
 * game's seed. Every wait polls state with generous timeouts, so the test
 * holds up on CI's slow software-rendered Chromium.
 */

import { expect, test, type Page } from '@playwright/test';
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
  await page.waitForFunction(() => window.__beltworks?.player() != null, undefined, {
    timeout: 30_000,
  });
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 30_000,
  });
}

/** Zooms in around the player with the wheel (the camera follows it). */
async function zoomIn(page: Page): Promise<void> {
  await page.mouse.move(100, 100);
  await page.mouse.wheel(0, -280);
  await expect
    .poll(async () => (await page.evaluate(() => window.__beltworks!.camera())).zoom)
    .toBeGreaterThan(1.45);
  await page.waitForFunction(() => window.__beltworks!.terrainReady(), undefined, {
    timeout: 30_000,
  });
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
const statusAt = async (page: Page, x: number, y: number) => (await entityAt(page, x, y))?.status;
const ghost = (page: Page) => page.evaluate(() => window.__beltworks!.ghost());
/** Hotbar key (`1`–`0`) of the starting-kit slot holding `item`. */
const keyFor = (item: number): string => String(STARTING_KIT.findIndex((s) => s.item === item) + 1);

interface Tile {
  x: number;
  y: number;
}

/** Belts between the drill and the first inserter. */
const BELTS = 4;
/** Tiles the chain spans from west to east. */
const CHAIN_LENGTH = 2 + BELTS + 1 + 2 + 1 + 1;

/**
 * The chain, all facing east on one row: a drill on 2×2 iron ore, a row of
 * belts from its drop tile, an inserter, a furnace, an inserter and a chest.
 */
interface Layout {
  drill: Tile;
  belts: Tile[];
  pick: Tile;
  furnace: Tile;
  put: Tile;
  chest: Tile;
}

function layoutAt(x: number, y: number): Layout {
  const drop = drillDropTile(x, y, Direction.East);
  const at = (dx: number): Tile => ({ x: drop.x + dx, y: drop.y });
  return {
    drill: { x, y },
    belts: Array.from({ length: BELTS }, (_, i) => at(i)),
    pick: at(BELTS),
    furnace: at(BELTS + 1),
    put: at(BELTS + 3),
    chest: at(BELTS + 4),
  };
}

/** Every entity of the layout as its top-left tile and footprint size. */
function footprints(l: Layout): { tile: Tile; size: number }[] {
  return [
    { tile: l.drill, size: 2 },
    ...l.belts.map((tile) => ({ tile, size: 1 })),
    { tile: l.pick, size: 1 },
    { tile: l.furnace, size: 2 },
    { tile: l.put, size: 1 },
    { tile: l.chest, size: 1 },
  ];
}

/**
 * A layout whose drill stands on iron ore only, on buildable tiles clear of
 * the player's collision box at `(sx, sy)` (tiles), with every entity in
 * build reach from there; the one centered closest to the player.
 */
function findLayout(world: World, sx: number, sy: number): Layout | undefined {
  const px = Math.round(sx * SUBTILES_PER_TILE);
  const py = Math.round(sy * SUBTILES_PER_TILE);
  const [bx0, bx1] = [fixedToTile(px - PLAYER_HALF_SIZE), fixedToTile(px + PLAYER_HALF_SIZE - 1)];
  const [by0, by1] = [fixedToTile(py - PLAYER_HALF_SIZE), fixedToTile(py + PLAYER_HALF_SIZE - 1)];
  const clear = (x: number, y: number) =>
    isBuildable(world.tileAt(x, y)) && !(x >= bx0 && x <= bx1 && y >= by0 && y <= by1);
  const [cx, cy] = [Math.floor(sx), Math.floor(sy)];
  let best: Layout | undefined;
  let bestDist = Infinity;
  for (let y = cy - 6; y <= cy + 6; y++) {
    for (let x = cx - 14; x <= cx + 4; x++) {
      const l = layoutAt(x, y);
      const ok =
        footprints(l).every(({ tile, size }) => {
          for (let dy = 0; dy < size; dy++) {
            for (let dx = 0; dx < size; dx++) {
              if (!clear(tile.x + dx, tile.y + dy)) return false;
            }
          }
          return inBuildReach(px, py, tile.x, tile.y, size, size);
        }) &&
        [0, 1].every((dy) =>
          [0, 1].every((dx) => world.resourceAt(x + dx, y + dy) === ResourceId.IronOre),
        );
      // Prefer the chain centered 3 tiles left of the player, so it stays
      // clear of the entity window on the right of the screen.
      const dist = (x + CHAIN_LENGTH / 2 - (sx - 3)) ** 2 + (y + 1 - sy) ** 2;
      if (ok && dist < bestDist) {
        best = l;
        bestDist = dist;
      }
    }
  }
  return best;
}

/**
 * Places the selected item (named `name`) with its top-left tile on `at`,
 * pressing R until the ghost faces `dir` (if given). A 2×2 ghost centers on
 * the tile corner nearest the cursor, a 1×1 ghost sits on the tile under it.
 * With `hold`, the button stays down afterwards (to drag a row).
 */
async function place(
  page: Page,
  name: string,
  at: Tile,
  size: number,
  dir?: number,
  { hold = false } = {},
) {
  const target =
    size === 2
      ? await tileScreen(page, at.x + 1, at.y + 1, true)
      : await tileScreen(page, at.x, at.y);
  await page.mouse.move(target.x, target.y);
  await expect.poll(async () => (await ghost(page))?.name).toBe(name);
  for (let i = 0; dir !== undefined && i < 4 && (await ghost(page))?.dir !== dir; i++) {
    const before = (await ghost(page))?.dir;
    await page.keyboard.press('r');
    await expect.poll(async () => (await ghost(page))?.dir).not.toBe(before);
  }
  await expect.poll(() => ghost(page)).toMatchObject({ x: at.x, y: at.y, valid: true });
  if (hold) {
    await page.mouse.down();
  } else {
    await page.mouse.click(target.x, target.y);
  }
  await expect.poll(() => entityAt(page, at.x, at.y)).toMatchObject({ name, x: at.x, y: at.y });
}

test('a drill, a belt, inserters, a furnace and a chest make iron plates on their own', async ({
  page,
}, testInfo) => {
  // Walking with the keyboard and building with the mouse is slow on CI's software-rendered Chromium.
  test.setTimeout(300_000);
  const errors = collectErrors(page);
  await open(page);
  await zoomIn(page);

  // Walk to the iron patch and find room for the chain around the player.
  const patch = startingPatches(WORLD_SEED).find((p) => p.ore === ResourceId.IronOre)!;
  const stand = await walkNear(page, patch.x + 0.5, patch.y + 0.5, 1.5);
  const layout = findLayout(new World(WORLD_SEED), stand.x, stand.y);
  expect(layout, `no room for the chain around (${stand.x}, ${stand.y})`).toBeDefined();
  const l = layout!;

  // Build from the chest backwards with real clicks, everything facing east.
  const E = Direction.East;
  await page.keyboard.press(keyFor(ItemId.WoodenChest));
  await place(page, 'wooden-chest', l.chest, 1);
  await page.keyboard.press(keyFor(ItemId.BurnerInserter));
  await place(page, 'burner-inserter', l.put, 1, E);
  await place(page, 'burner-inserter', l.pick, 1, E);
  await page.keyboard.press(keyFor(ItemId.StoneFurnace));
  await place(page, 'stone-furnace', l.furnace, 2);
  // The belts in one drag: place the first, then hold the button and move
  // tile by tile (waiting for each, since input is sampled once per frame).
  await page.keyboard.press(keyFor(ItemId.TransportBelt));
  const [first, ...rest] = l.belts;
  await place(page, 'transport-belt', first!, 1, E, { hold: true });
  for (const t of rest) {
    const at = await tileScreen(page, t.x, t.y);
    await page.mouse.move(at.x, at.y, { steps: 4 });
    await expect.poll(() => entityAt(page, t.x, t.y)).toMatchObject({ name: 'transport-belt' });
  }
  await page.mouse.up();
  await expect.poll(() => countOf(page, ItemId.TransportBelt)).toBe(10 - BELTS);
  await page.keyboard.press(keyFor(ItemId.BurnerMiningDrill));
  await place(page, 'burner-mining-drill', l.drill, 2, E);
  await page.keyboard.press('q');
  await expect.poll(() => ghost(page)).toBeNull();
  for (const t of [l.drill, ...l.belts, l.pick, l.put]) {
    expect((await entityAt(page, t.x, t.y))?.dir).toBe(E);
  }
  // Nothing has fuel yet.
  await expect.poll(() => statusAt(page, l.drill.x, l.drill.y)).toBe(MachineState.NoFuel);
  await expect.poll(() => statusAt(page, l.pick.x, l.pick.y)).toBe(MachineState.NoFuel);
  await expect.poll(() => statusAt(page, l.put.x, l.put.y)).toBe(MachineState.NoFuel);

  // Fuel through the GUI: right-click inserts half of the coal stack, left-click all of it.
  const panel = page.locator('#entity-panel');
  const coal = panel.locator('.player-inventory .slot[data-item="coal"]');
  const fuel = async (at: Tile, type: string, button: 'left' | 'right', left: number) => {
    const c = await tileScreen(page, at.x, at.y);
    await page.mouse.click(c.x, c.y);
    await expect(panel).toHaveAttribute('data-type', type);
    await coal.click({ button });
    await expect.poll(() => countOf(page, ItemId.Coal)).toBe(left);
    // The fuel slot may already be empty again: a machine with work to do
    // starts burning a single unit at once.
    await expect.poll(() => statusAt(page, at.x, at.y)).not.toBe(MachineState.NoFuel);
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  };
  // 10 coal: 5 for the drill (33 ores), 3 for the furnace, 1 for each inserter (33 swings).
  await fuel(l.drill, 'burner-mining-drill', 'right', 5);
  await fuel(l.furnace, 'stone-furnace', 'right', 2);
  await fuel(l.pick, 'burner-inserter', 'right', 1);
  await fuel(l.put, 'burner-inserter', 'left', 0);

  // From here on the player only watches. The chest's window shows what
  // arrives (opening it sends no command); the snapshots show the rest. It
  // replaces the inventory window, which it shows anyway.
  const inventory = page.locator('#inventory-panel');
  await page.keyboard.press('e');
  await expect(inventory).toBeVisible();
  const chest = await tileScreen(page, l.chest.x, l.chest.y);
  await page.mouse.click(chest.x, chest.y);
  await expect(panel).toHaveAttribute('data-type', 'wooden-chest');
  await expect(inventory).toBeHidden();
  const box = panel.locator('.entity-slots .slot').first();
  await expect(box).toHaveAttribute('data-count', '0');

  // The drill mines an ore every 4 s and drops it onto the belt, which carries
  // it to the first inserter.
  await expect.poll(() => statusAt(page, l.drill.x, l.drill.y)).toBe(MachineState.Working);
  // (An ore spends only a third of the drill's cycle on the belts, so this is
  // checked on every frame in the page rather than polled from here.)
  await page.waitForFunction(
    ([ore, belts]) =>
      window
        .__beltworks!.belts()
        .some(
          (b) =>
            belts.some((t) => t.x === b.x && t.y === b.y) && b.items.some((i) => i.item === ore),
        ),
    [ItemId.IronOre, l.belts] as const,
    { timeout: 60_000, polling: 'raf' },
  );
  // The inserter swings it into the furnace, which smelts it.
  await expect
    .poll(() => statusAt(page, l.furnace.x, l.furnace.y), { timeout: 60_000 })
    .toBe(MachineState.Working);
  // The second inserter moves the plates into the chest.
  await expect(box).toHaveAttribute('data-item', 'iron-plate', { timeout: 90_000 });
  const plates = async () => Number(await box.getAttribute('data-count'));
  expect(await plates()).toBeGreaterThan(0);

  // Shot while the next ore is on its way along the belt and the furnace
  // still smelts the last one (polled every frame).
  await page.waitForFunction(
    ([ore, belt, furnace, working]) =>
      window
        .__beltworks!.belts()
        .some(
          (b) =>
            b.x === belt.x &&
            b.y === belt.y &&
            b.items.some((i) => i.item === ore && i.offset > 128),
        ) &&
      window
        .__beltworks!.entities()
        .some((e) => e.x === furnace.x && e.y === furnace.y && e.status === working),
    [ItemId.IronOre, l.belts[1]!, l.furnace, MachineState.Working] as const,
    { timeout: 60_000, polling: 'raf' },
  );
  const shot = testInfo.outputPath('m1-chain.png');
  await page.screenshot({ path: shot });
  await testInfo.attach('the M1 automation chain filling a chest with iron plates', {
    path: shot,
    contentType: 'image/png',
  });
  // And it keeps going: more plates arrive, still without any input.
  const before = await plates();
  await expect.poll(plates, { timeout: 90_000 }).toBeGreaterThan(before);

  // The plates came out of the chain, not out of the player's pockets.
  expect(await countOf(page, ItemId.IronOre)).toBe(0);
  expect(await countOf(page, ItemId.IronPlate)).toBe(0);
  // E closes the chest's window (rather than opening a second inventory).
  await page.keyboard.press('e');
  await expect(panel).toBeHidden();
  await expect(inventory).toBeHidden();
  expect(errors).toEqual([]);
});

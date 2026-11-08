/**
 * Building the M1 iron plate line in e2e tests (chain.spec.ts, the M1 "Done
 * when", and onboarding.spec.ts): drill → belts → inserter → furnace →
 * inserter → chest facing east on one row, found around the player on the
 * starting iron patch, placed with real mouse and keyboard input. The test
 * hook only reads state (ghost, entities, inventory, camera).
 */

import { expect, type Page } from '@playwright/test';
import { ResourceId } from '../../src/data/resources';
import { STARTING_KIT } from '../../src/data/start';
import { isBuildable } from '../../src/data/tiles';
import { TILE_PX } from '../../src/render/camera';
import { Direction } from '../../src/sim/entities/direction';
import { drillDropTile } from '../../src/sim/entities/drill';
import { inBuildReach } from '../../src/sim/entities/placement';
import { SUBTILES_PER_TILE, fixedToTile } from '../../src/sim/fixed';
import { PLAYER_HALF_SIZE } from '../../src/sim/player';
import { World } from '../../src/sim/world/world';

/** Zooms in around the player with the wheel (the camera follows it). */
export async function zoomIn(page: Page): Promise<void> {
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
export async function tileScreen(page: Page, x: number, y: number, corner = false) {
  const at = await page.evaluate(([tx, ty]) => window.__beltworks!.tileToScreen(tx!, ty!), [x, y]);
  const zoom = (await page.evaluate(() => window.__beltworks!.camera())).zoom;
  const shift = corner ? (TILE_PX / 2) * zoom : 0;
  return { x: at.x - shift, y: at.y - shift };
}

export const countOf = async (page: Page, item: number) =>
  (await page.evaluate(() => window.__beltworks!.inventory())).reduce(
    (n, s) => n + (s.item === item ? s.count : 0),
    0,
  );
export const entityAt = async (page: Page, x: number, y: number) =>
  (await page.evaluate(() => window.__beltworks!.entities())).find(
    (e) => x >= e.x && x < e.x + e.w && y >= e.y && y < e.y + e.h,
  );
export const statusAt = async (page: Page, x: number, y: number) =>
  (await entityAt(page, x, y))?.status;
export const ghost = (page: Page) => page.evaluate(() => window.__beltworks!.ghost());
/** Hotbar key (`1`–`0`) of the starting-kit slot holding `item`. */
export const keyFor = (item: number): string =>
  String(STARTING_KIT.findIndex((s) => s.item === item) + 1);

export interface Tile {
  x: number;
  y: number;
}

/** Belts between the drill and the first inserter. */
export const BELTS = 4;
/** Tiles the chain spans from west to east. */
export const CHAIN_LENGTH = 2 + BELTS + 1 + 2 + 1 + 1;

/**
 * The chain, all facing east on one row: a drill on 2×2 iron ore, a row of
 * belts from its drop tile, an inserter, a furnace, an inserter and a chest.
 */
export interface Layout {
  drill: Tile;
  belts: Tile[];
  pick: Tile;
  furnace: Tile;
  put: Tile;
  chest: Tile;
}

export function layoutAt(x: number, y: number): Layout {
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
export function footprints(l: Layout): { tile: Tile; size: number }[] {
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
export function findLayout(world: World, sx: number, sy: number): Layout | undefined {
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
export async function place(
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

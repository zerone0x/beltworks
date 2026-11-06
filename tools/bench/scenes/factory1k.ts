/**
 * The 1k-entity scene: exactly `FACTORY_1K_ENTITIES` entities in two
 * repeated patterns, all inside the flat starting area of a fixed seed.
 *
 * - **Smelting cells**, 12 per starting ore patch (48 in total), in a 12×12
 *   grid centered on the patch. Each cell is one row of
 *   `drill → furnace → (inserter spot) → chest` (mirrored on the west half,
 *   so the drills sit on the middle of the patch): the fuelled drill mines
 *   into the fuelled furnace, which smelts (or, on the coal patch, burns)
 *   what it gets.
 * - **Belt blocks** (30) in the rest of the area: a closed two-row belt loop
 *   of 12 belts per row with iron plates on it (they circulate forever), and
 *   4 or 5 chests one row below it, behind an inserter spot each.
 *
 * Inserter spots: burner inserters (issue #17) aren't simulated yet, so the
 * tile between each furnace and its chest, and each tile between a loop and
 * a chest, is left empty. Once inserters work, place one on every spot
 * (`inserterSpots()` below lists them) to turn the cells into
 * drill → furnace → inserter → chest chains and let the chests fill from the
 * loops; that changes the scene, so update tools/bench/baseline.json in the
 * same PR.
 */

import { entityForItem } from '../../../src/data/entities';
import { ItemId, type ItemStack } from '../../../src/data/items';
import { Direction } from '../../../src/sim/entities/direction';
import { Sim } from '../../../src/sim/tick';
import { startingPatches } from '../../../src/sim/world/generate';
import { Builder, type Placement } from '../builder';
import type { BenchScene, BuiltScene } from '../scene';

export const FACTORY_1K_SEED = 0xbe_4c_01;
export const FACTORY_1K_ENTITIES = 1000;

/** Smelting cells per ore patch: 2 per row (west and east half) × 6 rows. */
const CELLS_PER_PATCH = 12;
const CELL_ENTITIES = 3;
const BLOCKS = 30;
/** A loop row is this long, so a loop has twice as many belts. */
const LOOP_LENGTH = 12;
const LOOP_BELTS = 2 * LOOP_LENGTH;
/** Chest columns of a belt block, relative to its left edge (the first 4 or 5 are used). */
const CHEST_COLUMNS = [1, 4, 7, 10, 11] as const;
/** A belt block is 12 tiles wide plus a 1-tile aisle, and 4 rows plus an aisle row. */
const BLOCK_W = LOOP_LENGTH + 1;
const BLOCK_H = 5;
/** Belt blocks stay within this many tiles of the spawn (the flat starting area is 44). */
const AREA_RADIUS = 43;
/** Every second belt gets two plates, one per lane. */
const PLATES_PER_BELT_PAIR = 2;
const DRILL_COAL = 8;
const FURNACE_COAL = 4;

/** A rectangle of tiles, inclusive. */
interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;

/** Whether every tile of `r` lies within `radius` of the spawn (tile centers). */
function insideRadius(r: Rect, radius: number): boolean {
  const corner = (x: number, y: number): boolean =>
    (x + 0.5) * (x + 0.5) + (y + 0.5) * (y + 0.5) <= radius * radius;
  return corner(r.x0, r.y0) && corner(r.x1, r.y0) && corner(r.x0, r.y1) && corner(r.x1, r.y1);
}

/** The smelting cells around patch center `(cx, cy)`, top row first. */
function smeltingCells(cx: number, cy: number): Placement[][] {
  const rows: Placement[][] = [];
  for (let row = 0; row < CELLS_PER_PATCH / 2; row++) {
    const y = cy - 6 + 2 * row;
    rows.push([
      // West half, mirrored: chest, inserter spot (cx - 5), furnace, drill facing west.
      { item: ItemId.WoodenChest, x: cx - 6, y, dir: Direction.North },
      { item: ItemId.StoneFurnace, x: cx - 4, y, dir: Direction.North },
      // Drops onto (cx - 3, y + 1), the furnace's bottom-right tile.
      { item: ItemId.BurnerMiningDrill, x: cx - 2, y, dir: Direction.West },
      // East half: drill facing east, furnace, inserter spot (cx + 4), chest.
      // Drops onto (cx + 2, y), the furnace's top-left tile.
      { item: ItemId.BurnerMiningDrill, x: cx, y, dir: Direction.East },
      { item: ItemId.StoneFurnace, x: cx + 2, y, dir: Direction.North },
      { item: ItemId.WoodenChest, x: cx + 5, y, dir: Direction.North },
    ]);
  }
  return rows;
}

/** The belts of the loop whose top-left belt is `(x, y)`: east along row y, west along row y + 1. */
function loopBelts(x: number, y: number): Placement[] {
  const belts: Placement[] = [];
  const belt = (bx: number, by: number, dir: Direction): Placement => ({
    item: ItemId.TransportBelt,
    x: bx,
    y: by,
    dir,
  });
  for (let i = 0; i < LOOP_LENGTH - 1; i++) belts.push(belt(x + i, y, Direction.East));
  belts.push(belt(x + LOOP_LENGTH - 1, y, Direction.South));
  for (let i = LOOP_LENGTH - 1; i > 0; i--) belts.push(belt(x + i, y + 1, Direction.West));
  belts.push(belt(x, y + 1, Direction.North));
  return belts;
}

/**
 * Top-left tiles of the belt blocks: a 13×5 lattice over the starting area,
 * keeping the blocks that lie inside `AREA_RADIUS` and clear of the smelting
 * grids, in serpentine order (row by row, alternating direction) so the
 * builder walks little.
 */
function blockOrigins(reserved: readonly Rect[]): { x: number; y: number }[] {
  const origins: { x: number; y: number }[] = [];
  const first = -AREA_RADIUS;
  for (let row = 0; first + row * BLOCK_H + BLOCK_H - 1 <= AREA_RADIUS; row++) {
    const y = first + row * BLOCK_H;
    const line: { x: number; y: number }[] = [];
    for (let col = 0; first + col * BLOCK_W + BLOCK_W - 1 <= AREA_RADIUS; col++) {
      const x = first + col * BLOCK_W;
      const rect = { x0: x, y0: y, x1: x + BLOCK_W - 1, y1: y + BLOCK_H - 1 };
      if (insideRadius(rect, AREA_RADIUS) && !reserved.some((r) => overlaps(r, rect))) {
        line.push({ x, y });
      }
    }
    if (row % 2 === 1) line.reverse();
    origins.push(...line);
  }
  return origins;
}

/** The scene's layout, without building it (also used by the tests). */
export function factory1kLayout(): {
  patches: { x: number; y: number }[];
  blocks: { x: number; y: number }[];
  /** Belt blocks that get a fifth chest, so the scene has exactly `FACTORY_1K_ENTITIES`. */
  fiveChestBlocks: number;
} {
  const patches = startingPatches(FACTORY_1K_SEED).map(({ x, y }) => ({ x, y }));
  // The grids plus a margin for the builder, who stands just north and south of them.
  const reserved = patches.map(({ x, y }) => ({ x0: x - 7, y0: y - 8, x1: x + 6, y1: y + 7 }));
  const origins = blockOrigins(reserved);
  if (origins.length < BLOCKS) {
    throw new Error(`only ${String(origins.length)} belt blocks fit, need ${String(BLOCKS)}`);
  }
  const fixed = patches.length * CELLS_PER_PATCH * CELL_ENTITIES + BLOCKS * (LOOP_BELTS + 4);
  const fiveChestBlocks = FACTORY_1K_ENTITIES - fixed;
  if (fiveChestBlocks < 0 || fiveChestBlocks > BLOCKS) {
    throw new Error(
      `can't reach ${String(FACTORY_1K_ENTITIES)} entities (fixed part: ${String(fixed)})`,
    );
  }
  return { patches, blocks: origins.slice(0, BLOCKS), fiveChestBlocks };
}

/**
 * Tiles left empty for burner inserters, as `[x, y, dir]` with `dir` the
 * direction the inserter would face (towards its drop target).
 */
export function inserterSpots(): (readonly [number, number, Direction])[] {
  const { patches, blocks, fiveChestBlocks } = factory1kLayout();
  const spots: (readonly [number, number, Direction])[] = [];
  for (const { x, y } of patches) {
    for (let row = 0; row < CELLS_PER_PATCH / 2; row++) {
      spots.push(
        [x - 5, y - 6 + 2 * row, Direction.West],
        [x + 4, y - 6 + 2 * row, Direction.East],
      );
    }
  }
  blocks.forEach(({ x, y }, i) => {
    const chests = i < fiveChestBlocks ? 5 : 4;
    for (const col of CHEST_COLUMNS.slice(0, chests)) spots.push([x + col, y + 2, Direction.South]);
  });
  return spots;
}

/** What the builder carries: exactly what the scene uses. */
function kit(): ItemStack[] {
  const { patches, fiveChestBlocks } = factory1kLayout();
  const cells = patches.length * CELLS_PER_PATCH;
  return [
    { item: ItemId.TransportBelt, count: BLOCKS * LOOP_BELTS },
    { item: ItemId.WoodenChest, count: cells + BLOCKS * 4 + fiveChestBlocks },
    { item: ItemId.BurnerMiningDrill, count: cells },
    { item: ItemId.StoneFurnace, count: cells },
    { item: ItemId.Coal, count: cells * (DRILL_COAL + FURNACE_COAL) },
    { item: ItemId.IronPlate, count: (BLOCKS * LOOP_BELTS * PLATES_PER_BELT_PAIR) / 2 },
  ];
}

function build(): BuiltScene {
  const { patches, blocks, fiveChestBlocks } = factory1kLayout();
  const sim = new Sim({ seed: FACTORY_1K_SEED, startingKit: kit() });
  const builder = new Builder(sim);
  const counts: Record<string, number> = {};
  const count = (placements: readonly Placement[]): void => {
    for (const { item } of placements) {
      const name = entityForItem(item)?.name ?? String(item);
      counts[name] = (counts[name] ?? 0) + 1;
    }
  };

  for (const { x, y } of patches) {
    const rows = smeltingCells(x, y);
    // Stand just north of the grid for its top half, just south for the bottom half.
    for (const [standY, half] of [
      [y - 7, rows.slice(0, 3)],
      [y + 6, rows.slice(3)],
    ] as const) {
      builder.walkTo(x, standY);
      const placements = half.flat();
      const ids = builder.place(placements);
      count(placements);
      builder.insert(
        placements.flatMap((p, i) =>
          p.item === ItemId.BurnerMiningDrill
            ? [{ entity: ids[i]!, item: ItemId.Coal, count: DRILL_COAL }]
            : p.item === ItemId.StoneFurnace
              ? [{ entity: ids[i]!, item: ItemId.Coal, count: FURNACE_COAL }]
              : [],
        ),
      );
    }
  }

  let beltItems = 0;
  blocks.forEach(({ x, y }, i) => {
    // Stand in the middle of the aisle row below the chests.
    builder.walkTo(x + LOOP_LENGTH / 2, y + 4);
    const belts = loopBelts(x, y);
    const chests = CHEST_COLUMNS.slice(0, i < fiveChestBlocks ? 5 : 4).map((col): Placement => ({
      item: ItemId.WoodenChest,
      x: x + col,
      y: y + 3,
      dir: Direction.North,
    }));
    const ids = builder.place([...belts, ...chests]);
    count(belts);
    count(chests);
    const plates = belts
      .map((_, b) => ({ entity: ids[b]!, item: ItemId.IronPlate, count: PLATES_PER_BELT_PAIR }))
      .filter((_, b) => b % 2 === 0);
    builder.insert(plates);
    beltItems += plates.length * PLATES_PER_BELT_PAIR;
  });

  const placed = sim.state.entities.count;
  if (placed !== FACTORY_1K_ENTITIES) {
    throw new Error(
      `scene has ${String(placed)} entities, expected ${String(FACTORY_1K_ENTITIES)}`,
    );
  }
  return { sim, setupTicks: sim.tick, entityCounts: counts, beltItems };
}

export const factory1k: BenchScene = {
  name: '1k',
  description:
    '1 000 entities: 48 drill → furnace → chest cells on the 4 starting ore patches, 30 belt loops with plates, chests',
  targetMeanMs: 1,
  build,
};

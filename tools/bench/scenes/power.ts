/**
 * The power scene: four electric districts, one around each starting ore
 * patch of a fixed seed, each its own network, built from 5×5 blocks laid
 * out on a lattice. Every block has a small electric pole on its tile
 * (1, 1), so neighbouring blocks' poles are 5 tiles apart and wire up.
 *
 * - **Plants** take a column of three blocks: a boiler facing north with
 *   steam engines lined up end to end in front of it, on the column's tiles
 *   x 2–4. Districts 0 and 2 have one plant with one engine (900 kW) and run
 *   overloaded (satisfaction below 1); 1 and 3 have two plants with two
 *   engines each (3.6 MW) and power to spare.
 * - **Drill blocks** on the ore: an electric mining drill facing south drops
 *   into a chest; an electric inserter moves the ore on into a second chest.
 * - **Ring blocks** everywhere else: four chests around the pole, and four
 *   electric inserters passing coal from chest to chest around the ring, so
 *   they keep swinging for as long as the scene runs.
 *
 * Blocks that would cover water, a tree or the spawn are left out. The
 * boilers are fuelled last, once every district is built, with a stack of
 * coal each (enough for the warm-up and measured ticks at full load).
 *
 * The scene is built by four players, one per district.
 */

import { entityForItem } from '../../../src/data/entities';
import { ItemId, type ItemStack, type RealItemId } from '../../../src/data/items';
import { isBuildable } from '../../../src/data/tiles';
import { Direction } from '../../../src/sim/entities/direction';
import { Sim } from '../../../src/sim/tick';
import { startingPatches } from '../../../src/sim/world/generate';
import { World } from '../../../src/sim/world/world';
import { Builder, type Insertion, type Placement } from '../builder';
import type { BenchScene, BuiltScene } from '../scene';

export const POWER_SEED = 0xbe_4c_02;
/** One district (and builder) per starting ore patch. */
export const POWER_DISTRICTS = 4;
/** Blocks per district side. */
const GRID = 6;
const BLOCK = 5;
/** Blocks in a plant column. */
const PLANT_BLOCKS = 3;
/** Coal in each ring chest, and in each boiler. */
const RING_CHEST_COAL = 4;
const BOILER_COAL = 50;

const { North, East, South, West } = Direction;

const place = (item: number, x: number, y: number, dir: Direction = North): Placement => ({
  item,
  x,
  y,
  dir,
});

export type BlockKind = 'plant' | 'drill' | 'ring';

/** One block: its top-left tile and what it holds. */
export interface Block {
  kind: BlockKind;
  x: number;
  y: number;
  /** Steam engines of a plant (1 or 2). */
  engines?: number;
}

/** A block position of a district's grid: column, row and top-left tile. */
interface Cell {
  c: number;
  r: number;
  x: number;
  y: number;
}

export interface District {
  /** Plants in the district (1 or 2). */
  plants: number;
  /** Blocks in build order (serpentine, column by column). */
  blocks: Block[];
}

/** The entities of a block with its top-left tile at `(x, y)`. A plant's entities are in its first block. */
function blockPlacements({ kind, x, y, engines = 2 }: Block): Placement[] {
  const pole = place(ItemId.SmallElectricPole, x + 1, y + 1);
  switch (kind) {
    case 'plant':
      // Engines end to end, the boiler below them feeding the lower one;
      // the poles of the column's three blocks cover both engines.
      return [
        ...(engines === 2 ? [place(ItemId.SteamEngine, x + 2, y, North)] : []),
        place(ItemId.SteamEngine, x + 2, y + 5, North),
        place(ItemId.Boiler, x + 3, y + 10, North),
        pole,
        place(ItemId.SmallElectricPole, x + 1, y + 6),
        place(ItemId.SmallElectricPole, x + 1, y + 11),
      ];
    case 'drill':
      // The drill (x + 2..4, y..y + 2) drops onto (x + 3, y + 3).
      return [
        place(ItemId.ElectricMiningDrill, x + 2, y, South),
        place(ItemId.WoodenChest, x + 3, y + 3),
        place(ItemId.ElectricInserter, x + 2, y + 3, West),
        place(ItemId.WoodenChest, x + 1, y + 3),
        pole,
      ];
    case 'ring':
      // Chests on the corners of the 3×3 around the pole, inserters on its
      // edges passing items clockwise.
      return [
        place(ItemId.WoodenChest, x, y),
        place(ItemId.WoodenChest, x + 2, y),
        place(ItemId.WoodenChest, x + 2, y + 2),
        place(ItemId.WoodenChest, x, y + 2),
        place(ItemId.ElectricInserter, x + 1, y, East),
        place(ItemId.ElectricInserter, x + 2, y + 1, South),
        place(ItemId.ElectricInserter, x + 1, y + 2, West),
        place(ItemId.ElectricInserter, x, y + 1, North),
        pole,
      ];
  }
}

/** Where the builder stands for a block: a tile nothing is built on. */
const standFor = ({ kind, x, y }: Block): { x: number; y: number } =>
  kind === 'plant' ? { x, y: y + 4 } : { x: x + 3, y: y + 4 };

/** Coal for the ring chests of a block (the boilers are fuelled at the end). */
function ringCoal(block: Block, ids: readonly number[]): Insertion[] {
  if (block.kind !== 'ring') return [];
  return ids.slice(0, 4).map((entity) => ({ entity, item: ItemId.Coal, count: RING_CHEST_COAL }));
}

/** Whether every tile of the `w`×`h` rectangle at `(x, y)` can be built on (no water, no tree, not the spawn). */
function clear(world: World, x: number, y: number, w: number, h: number): boolean {
  for (let ty = y; ty < y + h; ty++) {
    for (let tx = x; tx < x + w; tx++) {
      if (!isBuildable(world.tileAt(tx, ty)) || world.treeAt(tx, ty)) return false;
      if (tx >= -2 && tx <= 1 && ty >= -2 && ty <= 1) return false;
    }
  }
  return true;
}

/** Whether the drill of a drill block at `(x, y)` has ore in at least half of the 5×5 tiles it mines. */
function onOre(world: World, x: number, y: number): boolean {
  let ore = 0;
  for (let ty = y - 1; ty <= y + 3; ty++) {
    for (let tx = x + 1; tx <= x + 5; tx++) {
      if (world.resourceAt(tx, ty) !== 0) ore++;
    }
  }
  return ore >= 13;
}

/** The scene's layout, without building it (also used by the tests). */
export function powerLayout(): District[] {
  const world = new World(POWER_SEED);
  // Each district's grid is centered on its patch, snapped to the 5-tile
  // lattice around the origin.
  const origins = startingPatches(POWER_SEED).map((patch) => ({
    x0: Math.round((patch.x - (GRID * BLOCK) / 2) / BLOCK) * BLOCK,
    y0: Math.round((patch.y - (GRID * BLOCK) / 2) / BLOCK) * BLOCK,
  }));
  const cells = (d: number): Cell[] => {
    const { x0, y0 } = origins[d]!;
    return Array.from({ length: GRID * GRID }, (_, i) => {
      const c = Math.floor(i / GRID);
      const r = i % GRID;
      return { c, r, x: x0 + c * BLOCK, y: y0 + r * BLOCK };
    });
  };
  // A block next to (or on) a block of another district is left out on both
  // sides, so districts are at least two blocks (10 tiles) apart and their
  // poles never connect: each district is a network of its own.
  const near = (a: Cell, b: Cell): boolean =>
    Math.abs(a.x - b.x) <= BLOCK && Math.abs(a.y - b.y) <= BLOCK;
  const all = origins.map((_, d) => cells(d));
  const free = all.map((mine, d) =>
    mine.filter((cell) => !all.some((other, e) => e !== d && other.some((o) => near(cell, o)))),
  );
  return free.map((mine, d) => {
    const { x0, y0 } = origins[d]!;
    const has = (c: number, r: number): boolean => mine.some((k) => k.c === c && k.r === r);
    const plants = d % 2 === 0 ? 1 : 2;
    // Plants take the westmost columns whose top three blocks are left and clear.
    const plantCols: number[] = [];
    for (let c = 0; c < GRID && plantCols.length < plants; c++) {
      const room = clear(world, x0 + c * BLOCK, y0, BLOCK, PLANT_BLOCKS * BLOCK);
      if (room && [0, 1, 2].every((r) => has(c, r))) plantCols.push(c);
    }
    if (plantCols.length < plants) {
      throw new Error(`no room for the plants of district ${String(d)}`);
    }
    const blocks: Block[] = [];
    // Serpentine order: down the even columns, up the odd ones.
    const ordered = mine
      .slice()
      .sort((a, b) => a.c - b.c || (a.c % 2 === 0 ? a.r - b.r : b.r - a.r));
    for (const { c, r, x, y } of ordered) {
      if (plantCols.includes(c) && r < PLANT_BLOCKS) {
        if (r === 0) blocks.push({ kind: 'plant', x, y, engines: plants });
        continue;
      }
      if (!clear(world, x, y, BLOCK, BLOCK)) continue;
      blocks.push({ kind: onOre(world, x, y) ? 'drill' : 'ring', x, y });
    }
    return { plants, blocks };
  });
}

/** What builder `d` needs for district `district`. */
function needs(district: District): Map<number, number> {
  const need = new Map<number, number>();
  const add = (item: number, count: number): void => {
    need.set(item, (need.get(item) ?? 0) + count);
  };
  for (const block of district.blocks) {
    const placements = blockPlacements(block);
    for (const p of placements) add(p.item, 1);
    for (const { item, count } of ringCoal(
      block,
      placements.map(() => 0),
    )) {
      add(item, count);
    }
  }
  add(ItemId.Coal, district.plants * BOILER_COAL);
  return need;
}

/** The starting kit, the same for every player: as much of each item as the busiest builder uses. */
function kit(districts: readonly District[]): ItemStack[] {
  const most = new Map<number, number>();
  for (const district of districts) {
    for (const [item, count] of needs(district)) {
      most.set(item, Math.max(most.get(item) ?? 0, count));
    }
  }
  return [...most].map(([item, count]) => ({ item: item as RealItemId, count }));
}

function build(): BuiltScene {
  const districts = powerLayout();
  const sim = new Sim({
    seed: POWER_SEED,
    players: POWER_DISTRICTS,
    startingKit: kit(districts),
  });
  const counts: Record<string, number> = {};
  const boilers: { builder: Builder; block: Block; boiler: number }[] = [];
  districts.forEach((district, p) => {
    const builder = new Builder(sim, p);
    for (const block of district.blocks) {
      const stand = standFor(block);
      builder.walkTo(stand.x, stand.y);
      const placements = blockPlacements(block);
      const ids = builder.place(placements);
      for (const { item } of placements) {
        const name = entityForItem(item)?.name ?? String(item);
        counts[name] = (counts[name] ?? 0) + 1;
      }
      builder.insert(ringCoal(block, ids));
      if (block.kind === 'plant') {
        const boiler = ids[placements.findIndex((q) => q.item === ItemId.Boiler)]!;
        boilers.push({ builder, block, boiler });
      }
    }
  });
  // Fuel every boiler once everything stands, so none burns coal during the build.
  for (const { builder, block, boiler } of boilers) {
    const stand = standFor(block);
    builder.walkTo(stand.x, stand.y + 5);
    builder.insert([{ entity: boiler, item: ItemId.Coal, count: BOILER_COAL }]);
  }
  return { sim, setupTicks: sim.tick, entityCounts: counts, beltItems: 0 };
}

export const power: BenchScene = {
  name: 'power',
  description:
    'Four electric districts (one per starting ore patch, each its own network; two overloaded): boilers and steam engines, a pole on every 5×5 block, electric drills into chests on the ore, and rings of electric inserters passing coal between chests',
  targetMeanMs: 1,
  build,
};

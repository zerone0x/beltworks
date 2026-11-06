/**
 * The 1k-entity scene: exactly `FACTORY_1K_ENTITIES` entities in two
 * repeated patterns, all inside the flat starting area of a fixed seed.
 *
 * - **Smelting cells**, 12 per starting ore patch (48 in total), in a 16×12
 *   grid centered on the patch. Each cell is one row of
 *   `drill → belt → inserter → furnace → inserter → chest` (mirrored on the
 *   west half, so the drills sit on the middle of the patch): the drill mines
 *   onto a one-tile belt, an inserter feeds the furnace from it, and a second
 *   inserter moves what the furnace makes into the chest. Drills, furnaces
 *   and inserters are fuelled with coal (on the coal patch the furnaces burn
 *   what they get).
 * - **Belt blocks** (18) in the rest of the area: a closed two-row loop of
 *   12 belts per row carrying coal, with 3 or 4 **exchange units** below it.
 *   A unit is `loop → inserter → chest A → inserter → chest B → inserter →
 *   loop`, so coal circulates between the loop and the chests for as long as
 *   the scene runs. These inserters get no fuel: they refuel themselves from
 *   the coal they handle.
 *
 * The scene is built by four players (one per ore patch plus a quarter of
 * the belt blocks), since one 40-slot inventory can't carry all the items
 * and coal.
 */

import { entityForItem } from '../../../src/data/entities';
import { ItemId, type ItemStack, type RealItemId } from '../../../src/data/items';
import { Direction } from '../../../src/sim/entities/direction';
import { Sim } from '../../../src/sim/tick';
import { startingPatches } from '../../../src/sim/world/generate';
import { Builder, type Insertion, type Placement } from '../builder';
import type { BenchScene, BuiltScene } from '../scene';

export const FACTORY_1K_SEED = 0xbe_4c_01;
export const FACTORY_1K_ENTITIES = 1000;
/** One builder per starting ore patch. */
export const FACTORY_1K_BUILDERS = 4;

/** Smelting cells per ore patch: 2 per row (west and east half) × 6 rows. */
const CELLS_PER_PATCH = 12;
const CELL_ENTITIES = 6;
const BLOCKS = 18;
/** A loop row is this long, so a loop has twice as many belts. */
const LOOP_LENGTH = 12;
const LOOP_BELTS = 2 * LOOP_LENGTH;
/** Exchange unit columns of a belt block, relative to its left edge (each unit is 3 wide). */
const UNIT_COLUMNS = [0, 3, 6, 9] as const;
const UNIT_ENTITIES = 5;
/** A belt block is 12 tiles wide plus a 1-tile aisle, and 4 rows plus an aisle row. */
const BLOCK_W = LOOP_LENGTH + 1;
const BLOCK_H = 5;
/** Belt blocks stay within this many tiles of the spawn (the flat starting area is 44). */
const AREA_RADIUS = 43;
/** Every second loop belt gets two coal, one per lane. */
const COAL_PER_BELT_PAIR = 2;
/** Coal each exchange unit's first chest starts with. */
const UNIT_CHEST_COAL = 20;
const DRILL_COAL = 8;
const FURNACE_COAL = 4;
const CELL_INSERTER_COAL = 2;

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

const place = (
  item: number,
  x: number,
  y: number,
  dir: Direction = Direction.North,
): Placement => ({
  item,
  x,
  y,
  dir,
});

/** One work site: where the builder stands, and what it places from there. */
interface Site {
  standX: number;
  standY: number;
  placements: Placement[];
}

/**
 * The smelting cells around patch center `(cx, cy)` as four sites (each half
 * of the grid, top and bottom), so everything is well within build reach.
 */
function smeltingSites(cx: number, cy: number): Site[] {
  const west = (y: number): Placement[] => [
    // Mirrored, on row y + 1 (where the west-facing drill drops):
    // chest, inserter, furnace, inserter, belt, drill.
    place(ItemId.WoodenChest, cx - 8, y + 1),
    place(ItemId.BurnerInserter, cx - 7, y + 1, Direction.West),
    place(ItemId.StoneFurnace, cx - 6, y),
    place(ItemId.BurnerInserter, cx - 4, y + 1, Direction.West),
    place(ItemId.TransportBelt, cx - 3, y + 1, Direction.West),
    // Drops onto (cx - 3, y + 1), the belt.
    place(ItemId.BurnerMiningDrill, cx - 2, y, Direction.West),
  ];
  const east = (y: number): Placement[] => [
    // Drops onto (cx + 2, y), the belt.
    place(ItemId.BurnerMiningDrill, cx, y, Direction.East),
    place(ItemId.TransportBelt, cx + 2, y, Direction.East),
    place(ItemId.BurnerInserter, cx + 3, y, Direction.East),
    place(ItemId.StoneFurnace, cx + 4, y),
    place(ItemId.BurnerInserter, cx + 6, y, Direction.East),
    place(ItemId.WoodenChest, cx + 7, y),
  ];
  const rows = (first: number, half: (y: number) => Placement[]): Placement[] =>
    [0, 1, 2].flatMap((r) => half(cy - 6 + 2 * (first + r)));
  // Stand just north of the grid for its top half, just south for the bottom half.
  return [
    { standX: cx - 4, standY: cy - 7, placements: rows(0, west) },
    { standX: cx + 3, standY: cy - 7, placements: rows(0, east) },
    { standX: cx - 4, standY: cy + 6, placements: rows(3, west) },
    { standX: cx + 3, standY: cy + 6, placements: rows(3, east) },
  ];
}

/** The belts of the loop whose top-left belt is `(x, y)`: east along row y, west along row y + 1. */
function loopBelts(x: number, y: number): Placement[] {
  const belts: Placement[] = [];
  for (let i = 0; i < LOOP_LENGTH - 1; i++) {
    belts.push(place(ItemId.TransportBelt, x + i, y, Direction.East));
  }
  belts.push(place(ItemId.TransportBelt, x + LOOP_LENGTH - 1, y, Direction.South));
  for (let i = LOOP_LENGTH - 1; i > 0; i--) {
    belts.push(place(ItemId.TransportBelt, x + i, y + 1, Direction.West));
  }
  belts.push(place(ItemId.TransportBelt, x, y + 1, Direction.North));
  return belts;
}

/**
 * An exchange unit in columns `c..c + 2` below the loop of the block at
 * `(x, y)`: an inserter takes from the loop into chest A, one moves A into
 * chest B, and one puts B back onto the loop. Chest A comes first.
 */
function exchangeUnit(x: number, y: number, c: number): Placement[] {
  return [
    place(ItemId.WoodenChest, x + c, y + 3),
    place(ItemId.WoodenChest, x + c + 2, y + 3),
    place(ItemId.BurnerInserter, x + c, y + 2, Direction.South),
    place(ItemId.BurnerInserter, x + c + 1, y + 3, Direction.East),
    place(ItemId.BurnerInserter, x + c + 2, y + 2, Direction.North),
  ];
}

/**
 * Top-left tiles of the belt blocks: a 13×5 lattice over the starting area,
 * keeping the blocks that lie inside `AREA_RADIUS` and clear of the smelting
 * grids and the spawn, in serpentine order (row by row, alternating
 * direction) so the builders walk little.
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

export interface Factory1kLayout {
  patches: { x: number; y: number }[];
  blocks: { x: number; y: number; units: number }[];
}

/** The scene's layout, without building it (also used by the tests). */
export function factory1kLayout(): Factory1kLayout {
  const patches = startingPatches(FACTORY_1K_SEED).map(({ x, y }) => ({ x, y }));
  const reserved = [
    // The grids plus a margin for the builders, who stand just north and south of them.
    ...patches.map(({ x, y }) => ({ x0: x - 9, y0: y - 8, x1: x + 8, y1: y + 7 })),
    // Where the players spawn: they would be in the way of placements there.
    { x0: -2, y0: -2, x1: 1, y1: 1 },
  ];
  const origins = blockOrigins(reserved);
  if (origins.length < BLOCKS) {
    throw new Error(`only ${String(origins.length)} belt blocks fit, need ${String(BLOCKS)}`);
  }
  // Every block has 3 exchange units; the first ones get a fourth until the
  // scene has exactly FACTORY_1K_ENTITIES entities.
  const fixed =
    patches.length * CELLS_PER_PATCH * CELL_ENTITIES + BLOCKS * (LOOP_BELTS + 3 * UNIT_ENTITIES);
  const extra = (FACTORY_1K_ENTITIES - fixed) / UNIT_ENTITIES;
  if (!Number.isInteger(extra) || extra < 0 || extra > BLOCKS) {
    throw new Error(
      `can't reach ${String(FACTORY_1K_ENTITIES)} entities (fixed part: ${String(fixed)})`,
    );
  }
  const blocks = origins.slice(0, BLOCKS).map((o, i) => ({ ...o, units: i < extra ? 4 : 3 }));
  return { patches, blocks };
}

/** Builder `p`'s share of the belt blocks: a contiguous run of the serpentine order. */
function blockShare<T>(blocks: readonly T[], p: number): T[] {
  const per = Math.ceil(blocks.length / FACTORY_1K_BUILDERS);
  return blocks.slice(p * per, (p + 1) * per);
}

/** A belt block as one site: the builder stands in the middle of the aisle row below it. */
function blockSite(block: { x: number; y: number; units: number }): Site {
  const { x, y, units } = block;
  return {
    standX: x + LOOP_LENGTH / 2,
    standY: y + 4,
    placements: [
      ...loopBelts(x, y),
      ...UNIT_COLUMNS.slice(0, units).flatMap((c) => exchangeUnit(x, y, c)),
    ],
  };
}

/** The coal a site's placements get, given the placed ids (in placement order). */
function fuelling(placements: readonly Placement[], ids: readonly number[]): Insertion[] {
  const out: Insertion[] = [];
  let belt = 0;
  let unitChest = 0;
  const loop = placements.filter((p) => p.item === ItemId.TransportBelt).length === LOOP_BELTS;
  placements.forEach((p, i) => {
    const entity = ids[i]!;
    const coal = (count: number): void => {
      out.push({ entity, item: ItemId.Coal, count });
    };
    if (loop) {
      // A belt block: coal on every second loop belt and in every chest A.
      if (p.item === ItemId.TransportBelt && belt++ % 2 === 0) coal(COAL_PER_BELT_PAIR);
      if (p.item === ItemId.WoodenChest && unitChest++ % 2 === 0) coal(UNIT_CHEST_COAL);
    } else if (p.item === ItemId.BurnerMiningDrill) {
      coal(DRILL_COAL);
    } else if (p.item === ItemId.StoneFurnace) {
      coal(FURNACE_COAL);
    } else if (p.item === ItemId.BurnerInserter) {
      coal(CELL_INSERTER_COAL);
    }
  });
  return out;
}

/** Every builder's sites, in build order. */
function sites(layout: Factory1kLayout): Site[][] {
  return layout.patches.map(({ x, y }, p) => [
    ...smeltingSites(x, y),
    ...blockShare(layout.blocks, p).map(blockSite),
  ]);
}

/** What a builder needs for `builderSites`. */
function needs(builderSites: readonly Site[]): Map<number, number> {
  const need = new Map<number, number>();
  const add = (item: number, count: number): void => {
    need.set(item, (need.get(item) ?? 0) + count);
  };
  for (const { placements } of builderSites) {
    for (const p of placements) add(p.item, 1);
    const ids = placements.map(() => 0);
    for (const { item, count } of fuelling(placements, ids)) add(item, count);
  }
  return need;
}

/**
 * The starting kit, the same for every player: as much of each item as the
 * builder that needs the most of it uses.
 */
function kit(allSites: readonly Site[][]): ItemStack[] {
  const most = new Map<number, number>();
  for (const builderSites of allSites) {
    for (const [item, count] of needs(builderSites)) {
      most.set(item, Math.max(most.get(item) ?? 0, count));
    }
  }
  return [...most].map(([item, count]) => ({ item: item as RealItemId, count }));
}

function build(): BuiltScene {
  const layout = factory1kLayout();
  const allSites = sites(layout);
  const sim = new Sim({
    seed: FACTORY_1K_SEED,
    players: FACTORY_1K_BUILDERS,
    startingKit: kit(allSites),
  });
  const counts: Record<string, number> = {};
  let beltItems = 0;
  // One builder after the other; each ends standing on a tile nothing is built on.
  allSites.forEach((builderSites, p) => {
    const builder = new Builder(sim, p);
    for (const { standX, standY, placements } of builderSites) {
      builder.walkTo(standX, standY);
      const ids = builder.place(placements);
      for (const { item } of placements) {
        const name = entityForItem(item)?.name ?? String(item);
        counts[name] = (counts[name] ?? 0) + 1;
      }
      const coal = fuelling(placements, ids);
      builder.insert(coal);
      const belts = new Set(ids.filter((_, i) => placements[i]!.item === ItemId.TransportBelt));
      for (const { entity, count } of coal) if (belts.has(entity)) beltItems += count;
    }
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
    '1 000 entities: 48 drill → belt → inserter → furnace → inserter → chest cells on the 4 starting ore patches, and 18 belt loops with coal cycling through 56 inserter/chest exchange units',
  targetMeanMs: 1,
  build,
};

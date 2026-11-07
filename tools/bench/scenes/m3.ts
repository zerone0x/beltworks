/**
 * The M3 scene: production chains and research on a fixed seed. Ten
 * columns, each a steam plant (a boiler with two steam engines end to end)
 * above four **science cells**, every column its own chain of small
 * electric poles. A cell (14×17 tiles, top-left `(x, y)`; inserters named
 * by the way they drop):
 *
 * ```
 * y+0              copper chest (x+7)
 * y+2              long-handed inserter (x+7) ↓, pole (x+5)
 * y+3..5   chest → burner → gear machine → fast → red pack machine → electric → belt ↓
 * y+5..8                                          underground entrance (x+10) ↓ … exit ↓,
 *                                                  a pole over the hidden belt (x+10, y+6)
 * y+9                                              splitter (x+10..11) ↓
 * y+10                                   belt ← ← (x+9..10)   (x+11..12) → → belt
 * y+11                                 electric ↓ (x+9), pole (x+10), electric ↓ (x+12)
 * y+12..14                              lab (x+8..10)        lab (x+11..13)
 * y+15                                 electric ↑ (x+9), pole (x+10), electric ↑ (x+12)
 * y+16                                  chest (x+9)          chest (x+12)
 * ```
 *
 * The iron chest on the left holds iron plates and some coal, which the
 * burner inserter refuels from; the gear machine (assembling machine 1)
 * feeds a red pack machine, which gets copper plates over the long-handed
 * inserter and puts its packs onto a belt that runs through an underground
 * pair into a splitter, which shares them between two labs. The labs get
 * their green packs from chests below them and research logistics 2 (red +
 * green, 30 s a unit, so it can't finish within a run), with its
 * prerequisites researched from the start (`SimOptions.researched`). The
 * boilers are fuelled last, so nothing electric runs while the scene is
 * built. Every inserter carries one kind of item. All four inserter types,
 * assembling machines, labs, belts, undergrounds and splitters stay busy
 * for the whole run.
 *
 * The scene is built by ten players, one per column.
 */

import { entityForItem } from '../../../src/data/entities';
import { ItemId, type ItemStack, type RealItemId } from '../../../src/data/items';
import { RecipeId } from '../../../src/data/recipes';
import { TechId } from '../../../src/data/technologies';
import { isBuildable, isWalkable } from '../../../src/data/tiles';
import { Direction } from '../../../src/sim/entities/direction';
import { Sim } from '../../../src/sim/tick';
import { World } from '../../../src/sim/world/world';
import { Builder, type Insertion, type Placement } from '../builder';
import type { BenchScene, BuiltScene } from '../scene';

export const M3_SEED = 0xbe_4c_4b;
/** Columns, one builder each. */
export const M3_COLUMNS = 10;
/** Science cells per column. */
export const M3_CELLS_PER_COLUMN = 4;
/** Entities in a science cell and in a plant. */
export const M3_CELL_ENTITIES = 28;
export const M3_PLANT_ENTITIES = 5;
export const M3_ENTITIES =
  M3_COLUMNS * (M3_PLANT_ENTITIES + M3_CELLS_PER_COLUMN * M3_CELL_ENTITIES);
/** The technology the labs research. */
export const M3_RESEARCH = TechId.Logistics2;

const CELL_W = 14;
const CELL_H = 17;
/** Top row of the first cell of every column; the plant stands on the 13 rows above it. */
const CELLS_Y = -32;
const PLANT_H = 13;
const PLATES = 100;
const CHEST_COAL = 5;
const COPPER = 20;
const GREEN_PACKS = 10;
const BOILER_COAL = 50;

const { North, East, South, West } = Direction;

const place = (item: number, x: number, y: number, dir: Direction = North): Placement => ({
  item,
  x,
  y,
  dir,
});

/**
 * The left edge of column `c`: five columns west of the spawn and five east
 * of it, 15 tiles apart (a cell and a 1-tile aisle), leaving the spawn clear.
 */
export const columnX = (c: number): number => (c < 5 ? -77 + 15 * c : 2 + 15 * (c - 5));
const cellY = (k: number): number => CELLS_Y + k * CELL_H;

/** A plant above the column at `x`: engines facing north end to end, the boiler below them. */
function plantPlacements(x: number): Placement[] {
  const y = CELLS_Y - PLANT_H;
  return [
    place(ItemId.SteamEngine, x + 2, y),
    place(ItemId.SteamEngine, x + 2, y + 5),
    place(ItemId.Boiler, x + 3, y + 10),
    // Covers both engines, and wires to the next pole, which wires to the first cell's.
    place(ItemId.SmallElectricPole, x + 1, y + 6),
    place(ItemId.SmallElectricPole, x + 1, y + 11),
  ];
}

/** A science cell's upper part (machines, belts, the splitter), placed from its upper stand. */
function cellUpper(x: number, y: number): Placement[] {
  return [
    place(ItemId.IronChest, x, y + 4),
    place(ItemId.BurnerInserter, x + 1, y + 4, East),
    place(ItemId.AssemblingMachine1, x + 2, y + 3),
    place(ItemId.FastInserter, x + 5, y + 4, East),
    place(ItemId.AssemblingMachine1, x + 6, y + 3),
    place(ItemId.IronChest, x + 7, y),
    place(ItemId.LongHandedInserter, x + 7, y + 2, South),
    place(ItemId.ElectricInserter, x + 9, y + 4, East),
    place(ItemId.TransportBelt, x + 10, y + 4, South),
    // The entrance first: the second one, with the entrance behind it, becomes the exit.
    place(ItemId.UndergroundBelt, x + 10, y + 5, South),
    place(ItemId.UndergroundBelt, x + 10, y + 8, South),
    place(ItemId.Splitter, x + 10, y + 9, South),
    place(ItemId.TransportBelt, x + 10, y + 10, West),
    place(ItemId.TransportBelt, x + 9, y + 10, West),
    place(ItemId.TransportBelt, x + 11, y + 10, East),
    place(ItemId.TransportBelt, x + 12, y + 10, East),
    place(ItemId.SmallElectricPole, x + 5, y + 2),
    place(ItemId.SmallElectricPole, x + 10, y + 6),
  ];
}

/** A science cell's lower part (the labs), placed from its lower stand. */
function cellLower(x: number, y: number): Placement[] {
  return [
    place(ItemId.ElectricInserter, x + 9, y + 11, South),
    place(ItemId.ElectricInserter, x + 12, y + 11, South),
    place(ItemId.Lab, x + 8, y + 12),
    place(ItemId.Lab, x + 11, y + 12),
    place(ItemId.SmallElectricPole, x + 10, y + 11),
    place(ItemId.ElectricInserter, x + 9, y + 15, North),
    place(ItemId.ElectricInserter, x + 12, y + 15, North),
    place(ItemId.IronChest, x + 9, y + 16),
    place(ItemId.IronChest, x + 12, y + 16),
    place(ItemId.SmallElectricPole, x + 10, y + 15),
  ];
}

/** The ids of a cell's machines and chests, by position in {@link cellUpper} / {@link cellLower}. */
const UPPER = { plateChest: 0, gears: 2, red: 4, copperChest: 5 } as const;
const LOWER = { greenChests: [7, 8] } as const;

/** Where a column's builder stands: a free tile of the plant, and two of every cell. */
const plantStand = (x: number) => ({ x: x + 6, y: CELLS_Y - 6 });
const upperStand = (x: number, y: number) => ({ x: x + 6, y: y + 7 });
const lowerStand = (x: number, y: number) => ({ x: x + 6, y: y + 13 });

/** What each builder needs for its column (all columns are alike). */
function needs(): Map<number, number> {
  const need = new Map<number, number>();
  const add = (item: number, count: number): void => {
    need.set(item, (need.get(item) ?? 0) + count);
  };
  for (const p of plantPlacements(0)) add(p.item, 1);
  for (let k = 0; k < M3_CELLS_PER_COLUMN; k++) {
    for (const p of [...cellUpper(0, 0), ...cellLower(0, 0)]) add(p.item, 1);
    add(ItemId.IronPlate, PLATES);
    add(ItemId.Coal, CHEST_COAL);
    add(ItemId.CopperPlate, COPPER);
    add(ItemId.LogisticSciencePack, 2 * GREEN_PACKS);
  }
  add(ItemId.Coal, BOILER_COAL);
  return need;
}

/** Every tile the columns stand on, their aisles included, is buildable and free of trees (checked by the tests). */
export function m3AreaClear(): boolean {
  const world = new World(M3_SEED);
  for (let c = 0; c < M3_COLUMNS; c++) {
    const x0 = columnX(c);
    for (let y = CELLS_Y - PLANT_H; y < cellY(M3_CELLS_PER_COLUMN); y++) {
      for (let x = x0; x < x0 + CELL_W; x++) {
        if (!isBuildable(world.tileAt(x, y)) || world.treeAt(x, y)) return false;
      }
      if (!isWalkable(world.tileAt(x0 + CELL_W, y))) return false;
    }
  }
  return true;
}

function build(): BuiltScene {
  const kit: ItemStack[] = [...needs()].map(([item, count]) => ({
    item: item as RealItemId,
    count,
  }));
  const sim = new Sim({
    seed: M3_SEED,
    players: M3_COLUMNS,
    startingKit: kit,
    researched: [TechId.Automation, TechId.Logistics, TechId.LogisticSciencePack],
  });
  const counts: Record<string, number> = {};
  const placeAll = (builder: Builder, placements: Placement[]): number[] => {
    const ids = builder.place(placements);
    for (const { item } of placements) {
      const name = entityForItem(item)?.name ?? String(item);
      counts[name] = (counts[name] ?? 0) + 1;
    }
    return ids;
  };
  const plants: { builder: Builder; x: number; boiler: number }[] = [];
  for (let c = 0; c < M3_COLUMNS; c++) {
    const builder = new Builder(sim, c);
    const x = columnX(c);
    // From the spawn: along the row just north of it (inside the columns'
    // checked area), then up the column.
    const stand = plantStand(x);
    builder.walkTo(stand.x, -1);
    builder.walkTo(stand.x, stand.y);
    const plant = placeAll(builder, plantPlacements(x));
    plants.push({ builder, x, boiler: plant[2]! });
    for (let k = 0; k < M3_CELLS_PER_COLUMN; k++) {
      const y = cellY(k);
      const up = upperStand(x, y);
      builder.walkTo(up.x, up.y);
      const upper = placeAll(builder, cellUpper(x, y));
      builder.setRecipe(upper[UPPER.gears]!, RecipeId.IronGearWheel);
      builder.setRecipe(upper[UPPER.red]!, RecipeId.AutomationSciencePack);
      builder.insert([
        { entity: upper[UPPER.plateChest]!, item: ItemId.IronPlate, count: PLATES },
        { entity: upper[UPPER.plateChest]!, item: ItemId.Coal, count: CHEST_COAL },
        { entity: upper[UPPER.copperChest]!, item: ItemId.CopperPlate, count: COPPER },
      ]);
      const low = lowerStand(x, y);
      builder.walkTo(low.x, low.y);
      const lower = placeAll(builder, cellLower(x, y));
      builder.insert(
        LOWER.greenChests.map((i): Insertion => ({
          entity: lower[i]!,
          item: ItemId.LogisticSciencePack,
          count: GREEN_PACKS,
        })),
      );
    }
  }
  plants[0]!.builder.setResearch(M3_RESEARCH);
  // Fuel every boiler once everything stands, all within a few ticks (after
  // every builder has walked back to its plant), so the whole scene starts
  // together.
  for (const { builder, x } of plants) {
    const stand = plantStand(x);
    builder.walkTo(stand.x, stand.y);
  }
  for (const { builder, boiler } of plants) {
    builder.insert([{ entity: boiler, item: ItemId.Coal, count: BOILER_COAL }]);
  }
  return { sim, setupTicks: sim.tick, entityCounts: counts, beltItems: 0 };
}

export const m3: BenchScene = {
  name: 'm3',
  description:
    'Science cells on steam power (ten columns of four): plates into gears into red packs in assembling machines, fed by burner, fast, long-handed and electric inserters, onto belts through undergrounds and splitters into labs researching logistics 2',
  targetMeanMs: 1,
  build,
};

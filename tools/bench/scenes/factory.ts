/**
 * The large factory scenes, `10k` and `50k`: a whole factory on steam power
 * built from 16×15-tile **blocks** on a lattice around the spawn, by a crew
 * of players working in parallel (crew.ts), one player per block.
 *
 * Every block has a power plant on its west side (a boiler feeding one or
 * two steam engines, x 0–2) with a column of small poles at x 3, and poles
 * on its aisle row (the bottom row, y 14, which the players walk and stand
 * on), so neighbouring blocks wire up into large networks, each with its own
 * generation. The rest (x 4–15, y 0–13) is one of:
 *
 * - **Assembly** (`A`): two closed belt loops, one along the top and one
 *   along the bottom edge, between two rows of four assembling machines.
 *   The top loop carries gears into assembling machines 1 making automation
 *   science packs (fed by a fast and a long-handed inserter each; copper
 *   plates come from a chest, the packs go into another), the bottom one
 *   transport belts into assembling machines 2 making logistic science packs
 *   (electric inserters from a chest; a long-handed inserter puts the packs
 *   onto the loop). Burner inserters serve the chests.
 * - **Buffer** (`B`, 4 of every 5 other blocks): six stacked belt loops
 *   carrying copper cable, the outer two through an underground pair and two
 *   joined by a splitter, with rows of electric and fast inserters passing
 *   cable between neighbouring loops both ways. This is where most of the
 *   belt items are.
 * - **Labs** (`L`): two pack loops (automation and logistic science packs)
 *   feeding two rows of four labs through fast and long-handed inserters.
 *   The labs research logistics-2 (200 units × 30 s), which takes longer
 *   than a run.
 * - **Smelting** (`M`), on blocks over ore: electric mining drills drop onto
 *   a belt that burner inserters take into stone furnaces, which other
 *   burner inserters empty into chests; burner mining drills drop into
 *   chests.
 *
 * Belt tiers rotate from block to block (yellow, red, blue, with matching
 * undergrounds and splitters). Blocks are left out where they would cover
 * water or a tree or can't be walked to; the rest are taken nearest the
 * spawn first until the scene has its entity count.
 *
 * Building: every player walks from the spawn to its block, places it from
 * a few spots inside it, stocks its chests, sets the assemblers' recipes and
 * fills the loops by hand (timed rounds of `Insert`, see `FILL`). Once every
 * block stands, all players fuel their boilers (and the
 * smelting blocks' burner entities) in the same few ticks, so the factory
 * starts at once and none of it burns fuel or uses up its loops during the
 * build. Player 0 starts the research on the first tick (the labs only work
 * once powered).
 */

import { entityForItem } from '../../../src/data/entities';
import { ItemId, itemPrototype, type ItemStack, type RealItemId } from '../../../src/data/items';
import { RecipeId } from '../../../src/data/recipes';
import { TechId } from '../../../src/data/technologies';
import { isBuildable } from '../../../src/data/tiles';
import { beltTable } from '../../../src/sim/belts/belts';
import { Direction } from '../../../src/sim/entities/direction';
import { inBuildReach } from '../../../src/sim/entities/placement';
import { footprintSize } from '../../../src/sim/entities/store';
import { tileCenter } from '../../../src/sim/fixed';
import { PLAYER_SPEED } from '../../../src/sim/player';
import { DEFAULT_FORCE } from '../../../src/sim/research/unlocks';
import { Sim } from '../../../src/sim/tick';
import { World } from '../../../src/sim/world/world';
import type { Insertion, Placement } from '../builder';
import { CrewMember, Router, runCrew, type Task, type Tile } from '../crew';
import { sceneActivity } from '../measure';
import type { BenchScene, BuiltScene, WorkCounters } from '../scene';

const { North, East, South, West } = Direction;

/** Block size in tiles, including the aisle row at the bottom. */
export const BLOCK_W = 16;
export const BLOCK_H = 15;
const AISLE = BLOCK_H - 1;
/** Lattice origin: block (0, 0) has its top-left tile here (the spawn is inside it). */
const LATTICE_X = -8;
const LATTICE_Y = -7;
/** Assembling machine / lab columns (each 3 wide). */
const COLUMNS = [4, 7, 10, 13] as const;
/** Loops run along x 4–15. */
const LOOP_X = 4;
const LOOP_LENGTH = 12;
/** Underground pairs in loops: entrance and exit columns (4 tiles under the ground in between). */
const UNDER_A = 5;
const UNDER_B = 10;
/**
 * How loops are filled: two items (one per lane) on the middle of a belt
 * every `interval` ticks, `rounds` times, per tier. Yellow and red belts
 * move one item spacing (64) in that time, so 4 rounds pack the stretch to
 * the next belt; blue ones move 72, so 3 rounds fit. A full loop would jam
 * (nothing could move or be dropped onto it), so one in every `FILL_SKIP` belts
 * (and the splitters and undergrounds) get nothing: each leaves a hole of 3–4 item
 * spots that circulates with the loop, where inserters can drop items
 * (they drop at one exact spot, so a hole of a single item spot rarely
 * lines up with it).
 */
const FILL = [
  { rounds: 4, interval: 8 },
  { rounds: 4, interval: 4 },
  { rounds: 3, interval: 3 },
] as const;
const FILL_SKIP = 24;

const BOILER_COAL = 40;
const BURNER_DRILL_COAL = 4;
const FURNACE_COAL = 3;
const BURNER_INSERTER_COAL = 1;
/** Copper plates and electric inserters in each supply chest of an assembly block (a run uses about 10). */
const SUPPLY = 12;
/** The research the labs work on (and what it needs researched first). */
export const LARGE_RESEARCH = TechId.Logistics2;
const RESEARCHED = [TechId.Automation, TechId.Logistics, TechId.LogisticSciencePack];

export type BlockKind = 'A' | 'B' | 'L' | 'M';

/** Belt tiers: plain belt and underground item of each. */
const TIERS = [
  { belt: ItemId.TransportBelt, under: ItemId.UndergroundBelt, splitter: ItemId.Splitter },
  {
    belt: ItemId.FastTransportBelt,
    under: ItemId.FastUndergroundBelt,
    splitter: ItemId.FastSplitter,
  },
  {
    belt: ItemId.ExpressTransportBelt,
    under: ItemId.ExpressUndergroundBelt,
    splitter: ItemId.ExpressSplitter,
  },
] as const;
/** Column of the splitter joining two buffer loops. */
const SPLITTER_X = 9;

/** A closed loop of belts and what to fill it with. */
interface Loop {
  /** Indices into the block's placements. */
  belts: number[];
  /** The belts the builder puts items on (see {@link FILL_SKIP}). */
  fill: number[];
  items: number[];
}

/** One block's plan, in block-local tiles (see {@link blockPlan}). */
interface BlockPlan {
  placements: Placement[];
  loops: Loop[];
  /** Placement indices of assembling machines and the recipe each gets. */
  recipes: { index: number; recipe: number }[];
  /** Fuel given once every block stands: placement index, coal. */
  fuel: { index: number; count: number }[];
  /** Items put into chests right after building: placement index, item, count. */
  stock: { index: number; item: number; count: number }[];
  /** Placement indices of the chests machines put what they make into. */
  outputs: number[];
  /**
   * Where the builder stands, in the order it uses them: tiles nothing is
   * built on, or built on from an earlier stand.
   */
  stands: Tile[];
}

const place = (item: number, x: number, y: number, dir: Direction = North): Placement => ({
  item,
  x,
  y,
  dir,
});

/**
 * Builds block plans in local coordinates: `add` appends placements and
 * returns their indices.
 */
class PlanBuilder {
  readonly placements: Placement[] = [];
  readonly loops: Loop[] = [];
  readonly recipes: { index: number; recipe: number }[] = [];
  readonly fuel: { index: number; count: number }[] = [];
  readonly stock: { index: number; item: number; count: number }[] = [];
  readonly outputs: number[] = [];

  add(item: number, x: number, y: number, dir: Direction = North): number {
    this.placements.push(place(item, x, y, dir));
    return this.placements.length - 1;
  }

  /**
   * A closed two-row loop at `(LOOP_X, y)`: east along row y, west along
   * row y + 1. With `under` set to `'top'` or `'bottom'`, that row goes
   * through an underground pair between columns UNDER_A and UNDER_B.
   */
  loop(y: number, tier: number, items: number[], under?: 'top' | 'bottom'): void {
    const { belt, under: ug } = TIERS[tier]!;
    const belts: number[] = [];
    const x0 = LOOP_X;
    const x1 = LOOP_X + LOOP_LENGTH - 1;
    const hidden = (x: number): boolean => x > UNDER_A && x < UNDER_B;
    for (let x = x0; x < x1; x++) {
      if (under === 'top' && hidden(x)) continue;
      const item = under === 'top' && (x === UNDER_A || x === UNDER_B) ? ug : belt;
      belts.push(this.add(item, x, y, East));
    }
    belts.push(this.add(belt, x1, y, South));
    for (let x = x1; x > x0; x--) {
      if (under === 'bottom' && hidden(x)) continue;
      const item = under === 'bottom' && (x === UNDER_A || x === UNDER_B) ? ug : belt;
      belts.push(this.add(item, x, y + 1, West));
    }
    belts.push(this.add(belt, x0, y + 1, North));
    this.addLoop(belts, belt, items);
  }

  /**
   * Two loops joined by a splitter: a clockwise loop on rows y, y + 1 and a
   * counter-clockwise one on rows y + 2, y + 3, so both middle rows run
   * west; a splitter facing west at column `SPLITTER_X` takes the place of
   * their belts there and shares items from both rows out to both.
   */
  splitLoops(y: number, tier: number, items: number[]): void {
    const { belt, splitter } = TIERS[tier]!;
    const x0 = LOOP_X;
    const x1 = LOOP_X + LOOP_LENGTH - 1;
    const belts: number[] = [];
    // Clockwise: east along row y, west along row y + 1.
    for (let x = x0; x < x1; x++) belts.push(this.add(belt, x, y, East));
    belts.push(this.add(belt, x1, y, South));
    for (let x = x1; x > x0; x--) {
      if (x !== SPLITTER_X) belts.push(this.add(belt, x, y + 1, West));
    }
    belts.push(this.add(belt, x0, y + 1, North));
    // Counter-clockwise: west along row y + 2, east along row y + 3.
    for (let x = x1; x > x0; x--) {
      if (x !== SPLITTER_X) belts.push(this.add(belt, x, y + 2, West));
    }
    belts.push(this.add(belt, x0, y + 2, South));
    for (let x = x0; x < x1; x++) belts.push(this.add(belt, x, y + 3, East));
    belts.push(this.add(belt, x1, y + 3, North));
    belts.push(this.add(splitter, SPLITTER_X, y + 1, West));
    this.addLoop(belts, belt, items);
  }

  private addLoop(belts: number[], belt: number, items: number[]): void {
    const plain = belts.filter((i) => this.placements[i]!.item === belt);
    const fill = plain.filter((_, k) => k % FILL_SKIP !== FILL_SKIP / 2);
    this.loops.push({ belts, fill, items });
  }

  /** The power plant on x 0–3 and the poles on the aisle row. */
  plant(engines: 1 | 2): void {
    if (engines === 2) this.add(ItemId.SteamEngine, 0, 0, North);
    this.add(ItemId.SteamEngine, 0, 5, North);
    const boiler = this.add(ItemId.Boiler, 1, 10, North);
    this.fuel.push({ index: boiler, count: BOILER_COAL });
    for (const y of [1, 7, 13]) this.add(ItemId.SmallElectricPole, 3, y);
    for (const x of [1, 7, 13]) this.add(ItemId.SmallElectricPole, x, AISLE);
  }

  done(stands: Tile[]): BlockPlan {
    return {
      placements: this.placements,
      loops: this.loops,
      recipes: this.recipes,
      fuel: this.fuel,
      stock: this.stock,
      outputs: this.outputs,
      stands,
    };
  }
}

/** The stands every block has: next to the plant, and two spots on its aisle row. */
const PLANT_STAND = { x: 3, y: 4 };
const AISLE_STANDS = [
  { x: 10, y: AISLE },
  { x: 4, y: AISLE },
];

function assemblyBlock(tier: number): BlockPlan {
  const b = new PlanBuilder();
  b.plant(2);
  // One ingredient per loop: an inserter takes whatever its machine uses, so
  // a loop with both ingredients would let it grab a third gear while the
  // machine waits for copper, and stall.
  b.loop(0, tier, [ItemId.IronGearWheel]);
  b.loop(12, tier, [ItemId.TransportBelt]);
  for (const a of COLUMNS) {
    // Top: assembling machine 1 on rows 3–5; a fast and a long-handed
    // inserter bring gears from the top loop.
    b.add(ItemId.SmallElectricPole, a, 2);
    b.add(ItemId.FastInserter, a + 1, 2, South);
    b.add(ItemId.LongHandedInserter, a + 2, 2, South);
    const am1 = b.add(ItemId.AssemblingMachine1, a, 3);
    b.recipes.push({ index: am1, recipe: RecipeId.AutomationSciencePack });
    // Middle (burner inserters): AM1 output into a chest, copper plates from
    // a chest into AM1, electric inserters from a chest into AM2.
    b.fuel.push({ index: b.add(ItemId.BurnerInserter, a, 6, South), count: BURNER_INSERTER_COAL });
    b.outputs.push(b.add(ItemId.WoodenChest, a, 7));
    b.fuel.push({
      index: b.add(ItemId.BurnerInserter, a + 1, 6, North),
      count: BURNER_INSERTER_COAL,
    });
    const copper = b.add(ItemId.WoodenChest, a + 1, 7);
    b.stock.push({ index: copper, item: ItemId.CopperPlate, count: SUPPLY });
    const inserters = b.add(ItemId.IronChest, a + 2, 6);
    b.stock.push({ index: inserters, item: ItemId.ElectricInserter, count: SUPPLY });
    b.fuel.push({
      index: b.add(ItemId.BurnerInserter, a + 2, 7, South),
      count: BURNER_INSERTER_COAL,
    });
    // Bottom: assembling machine 2 on rows 8–10; a fast inserter brings
    // transport belts from the bottom loop, a long-handed one puts the
    // packs it makes onto that loop.
    const am2 = b.add(ItemId.AssemblingMachine2, a, 8);
    b.recipes.push({ index: am2, recipe: RecipeId.LogisticSciencePack });
    b.add(ItemId.SmallElectricPole, a, 11);
    b.add(ItemId.FastInserter, a + 1, 11, North);
    b.add(ItemId.LongHandedInserter, a + 2, 11, South);
  }
  // The middle stand is on a burner inserter placed from the plant stand.
  return b.done([PLANT_STAND, { x: 11, y: 6 }, ...AISLE_STANDS]);
}

function bufferBlock(tier: number): BlockPlan {
  const b = new PlanBuilder();
  b.plant(1);
  const cable = [ItemId.CopperCable];
  // Six loops: the outer two go through an underground pair, the two above
  // the bottom one share a splitter.
  b.loop(0, tier, cable, 'top');
  b.loop(3, tier, cable);
  b.loop(5, tier, cable);
  b.splitLoops(8, tier, cable);
  b.loop(12, tier, cable, 'bottom');
  // Inserter rows between loops (rows 2 and 7), passing cable both ways.
  for (const y of [2, 7]) {
    b.add(ItemId.SmallElectricPole, 7, y);
    b.add(ItemId.SmallElectricPole, 13, y);
    b.add(ItemId.ElectricInserter, 5, y, South);
    b.add(ItemId.ElectricInserter, 8, y, North);
    b.add(ItemId.FastInserter, 11, y, South);
    b.add(ItemId.FastInserter, 14, y, North);
  }
  // The middle stand is on a belt placed from the plant stand.
  return b.done([PLANT_STAND, { x: 10, y: 6 }, ...AISLE_STANDS]);
}

function labBlock(tier: number): BlockPlan {
  const b = new PlanBuilder();
  b.plant(1);
  const packs = [ItemId.AutomationSciencePack, ItemId.LogisticSciencePack];
  b.loop(0, tier, packs);
  b.loop(12, tier, packs);
  for (const a of COLUMNS) {
    b.add(ItemId.SmallElectricPole, a, 2);
    b.add(ItemId.FastInserter, a + 1, 2, South);
    b.add(ItemId.LongHandedInserter, a + 2, 2, South);
    b.add(ItemId.Lab, a, 3);
    b.add(ItemId.Lab, a, 8);
    b.add(ItemId.SmallElectricPole, a, 11);
    b.add(ItemId.FastInserter, a + 1, 11, North);
    b.add(ItemId.LongHandedInserter, a + 2, 11, North);
  }
  return b.done([PLANT_STAND, { x: 10, y: 6 }, ...AISLE_STANDS]);
}

/** Electric drills (top-left x) and burner drills / furnaces (x) of a smelting block. */
const ELECTRIC_DRILLS = [4, 8, 12] as const;
const PAIRS = [4, 6, 8, 10, 12, 14] as const;

function smeltingBlock(tier: number): BlockPlan {
  const b = new PlanBuilder();
  b.plant(1);
  for (const x of ELECTRIC_DRILLS) b.add(ItemId.ElectricMiningDrill, x, 0, South);
  b.add(ItemId.SmallElectricPole, 7, 1);
  b.add(ItemId.SmallElectricPole, 11, 1);
  // The drills drop onto this belt (x 5, 9, 13); it ends at x 15.
  for (let x = LOOP_X; x < LOOP_X + LOOP_LENGTH; x++) b.add(TIERS[tier]!.belt, x, 3, East);
  for (const x of PAIRS) {
    b.fuel.push({ index: b.add(ItemId.BurnerInserter, x, 4, South), count: BURNER_INSERTER_COAL });
    b.fuel.push({ index: b.add(ItemId.StoneFurnace, x, 5), count: FURNACE_COAL });
    b.fuel.push({
      index: b.add(ItemId.BurnerInserter, x + 1, 7, South),
      count: BURNER_INSERTER_COAL,
    });
    b.outputs.push(b.add(ItemId.WoodenChest, x + 1, 8));
    // A burner drill facing north drops into the chest above it.
    b.outputs.push(b.add(ItemId.WoodenChest, x, 9));
    b.fuel.push({
      index: b.add(ItemId.BurnerMiningDrill, x, 10, North),
      count: BURNER_DRILL_COAL,
    });
  }
  return b.done([PLANT_STAND, { x: 7, y: 0 }, { x: 9, y: 12 }, ...AISLE_STANDS]);
}

function blockPlan(kind: BlockKind, tier: number): BlockPlan {
  switch (kind) {
    case 'A':
      return assemblyBlock(tier);
    case 'B':
      return bufferBlock(tier);
    case 'L':
      return labBlock(tier);
    case 'M':
      return smeltingBlock(tier);
  }
}

/** Whether a player standing anywhere within one tick's movement of `stand`'s center reaches the footprint. */
function reachesSafely(stand: Tile, x: number, y: number, w: number, h: number): boolean {
  const m = PLAYER_SPEED - 1;
  const cx = tileCenter(stand.x);
  const cy = tileCenter(stand.y);
  return [
    [-m, -m],
    [m, -m],
    [-m, m],
    [m, m],
  ].every(([dx, dy]) => inBuildReach(cx + dx!, cy + dy!, x, y, w, h));
}

/** One block of a layout: kind, tier, top-left tile and lattice cell. */
export interface Block {
  kind: BlockKind;
  tier: number;
  x: number;
  y: number;
  i: number;
  j: number;
}

/** An item delivery to a placed entity: placement index, item, count. */
interface Delivery {
  index: number;
  item: number;
  count: number;
}

/** A block's plan moved to world tiles, split by stand. */
interface WorldBlock {
  block: Block;
  plan: BlockPlan;
  placements: Placement[];
  /** Stands in world tiles. */
  stands: Tile[];
  /** Per stand: indices of the placements built from it. */
  sites: number[][];
  /** Per stand, once everything is placed: chest stock, recipes and loops handled from it. */
  stock: Delivery[][];
  recipes: { index: number; recipe: number }[][];
  loops: Loop[][];
  /** Per stand: fuel given from it once every block stands. */
  fuel: Delivery[][];
}

function toWorld(block: Block): WorldBlock {
  const plan = blockPlan(block.kind, block.tier);
  const placements = plan.placements.map((p) => ({ ...p, x: p.x + block.x, y: p.y + block.y }));
  const stands = plan.stands.map((s) => ({ x: s.x + block.x, y: s.y + block.y }));
  const footprint = (i: number): [number, number, number, number] => {
    const p = placements[i]!;
    const proto = entityForItem(p.item)!;
    const { w, h } = footprintSize(proto, proto.rotatable ? p.dir : North);
    return [p.x, p.y, w, h];
  };
  const standFor = (indices: number[], what: string): number => {
    const k = stands.findIndex((s) => indices.every((i) => reachesSafely(s, ...footprint(i))));
    if (k < 0) throw new Error(`block ${block.kind}: no stand reaches ${what}`);
    return k;
  };
  const perStand = <T>(): T[][] => stands.map(() => []);
  const sites = perStand<number>();
  const siteOf = placements.map((_, i) => {
    const k = standFor([i], `placement ${String(i)}`);
    sites[k]!.push(i);
    return k;
  });
  // A stand may be on an entity only if that was placed from an earlier stand.
  stands.forEach((s, k) => {
    placements.forEach((_, i) => {
      const [x, y, w, h] = footprint(i);
      if (s.x >= x && s.x < x + w && s.y >= y && s.y < y + h && siteOf[i]! >= k) {
        throw new Error(
          `block ${block.kind}: stand (${String(s.x)}, ${String(s.y)}) is built on from there or later`,
        );
      }
    });
  });
  const stock = perStand<Delivery>();
  for (const d of plan.stock) stock[standFor([d.index], 'a stocked chest')]!.push(d);
  const recipes = perStand<{ index: number; recipe: number }>();
  for (const r of plan.recipes) recipes[standFor([r.index], 'an assembling machine')]!.push(r);
  const loops = perStand<Loop>();
  plan.loops.forEach((l, k) => loops[standFor(l.belts, `loop ${String(k)}`)]!.push(l));
  const fuel = perStand<Delivery>();
  for (const f of plan.fuel) {
    fuel[standFor([f.index], 'a fuelled entity')]!.push({ ...f, item: ItemId.Coal });
  }
  return { block, plan, placements, stands, sites, stock, recipes, loops, fuel };
}

/** What a block needs: its entities, the loop fillings and fuel. */
function blockNeeds(wb: WorldBlock): Map<number, number> {
  const need = new Map<number, number>();
  const add = (item: number, count: number): void => {
    need.set(item, (need.get(item) ?? 0) + count);
  };
  for (const p of wb.placements) add(p.item, 1);
  const { rounds } = FILL[wb.block.tier]!;
  for (const loop of wb.plan.loops) {
    // Two per belt and round: one of each item, or two of the only one.
    const per = (2 * rounds * loop.fill.length) / loop.items.length;
    for (const item of loop.items) add(item, per);
  }
  for (const f of wb.plan.fuel) add(ItemId.Coal, f.count);
  for (const d of wb.plan.stock) add(d.item, d.count);
  return need;
}

export interface LargeSceneConfig {
  name: string;
  seed: number;
  /** Entities to aim for; the scene stops adding blocks at the closest total. */
  entities: number;
  /** Lab blocks (8 labs each); kept small so the research outlasts a run. */
  labBlocks: number;
  /** Fewest belt items there must be after the measured ticks. */
  minBeltItems: number;
  /** Lattice cells searched for blocks, per direction from the spawn block. */
  radius: number;
}

export interface LargeLayout {
  blocks: Block[];
  /** Entities the layout places. */
  entities: number;
}

/** Fraction (per mille) of the drills' tiles of a smelting block at `(x, y)` that have ore. */
function orePerMille(world: World, x: number, y: number): number {
  let ore = 0;
  let all = 0;
  const count = (tx: number, ty: number): void => {
    all++;
    if (world.resourceAt(tx, ty) !== 0) ore++;
  };
  for (const dx of ELECTRIC_DRILLS) {
    for (let ty = -1; ty <= 3; ty++)
      for (let tx = dx - 1; tx <= dx + 3; tx++) count(x + tx, y + ty);
  }
  for (const dx of PAIRS) {
    for (let ty = 10; ty <= 11; ty++) for (let tx = dx; tx <= dx + 1; tx++) count(x + tx, y + ty);
  }
  return Math.floor((ore * 1000) / all);
}

/** Smelting blocks need ore on at least this share (per mille) of their drills' tiles. */
const MIN_ORE = 400;

/** Whether every tile of the block at `(x, y)` can be built on and walked (no water, no tree). */
function blockClear(world: World, x: number, y: number): boolean {
  for (let ty = y; ty < y + BLOCK_H; ty++) {
    for (let tx = x; tx < x + BLOCK_W; tx++) {
      if (!isBuildable(world.tileAt(tx, ty)) || world.treeAt(tx, ty)) return false;
    }
  }
  return true;
}

/** Entities a block of `kind` places (the same for every tier). */
const ENTITIES_PER_BLOCK: Record<BlockKind, number> = {
  A: assemblyBlock(0).placements.length,
  B: bufferBlock(0).placements.length,
  L: labBlock(0).placements.length,
  M: smeltingBlock(0).placements.length,
};

/** The router from the spawn over the lattice area of `config`. */
function spawnRouter(world: World, config: LargeSceneConfig): Router {
  const r = config.radius;
  return new Router(
    world,
    { x: 0, y: 0 },
    LATTICE_X - r * BLOCK_W - 8,
    LATTICE_Y - r * BLOCK_H - 8,
    LATTICE_X + (r + 1) * BLOCK_W + 8,
    LATTICE_Y + (r + 1) * BLOCK_H + 8,
  );
}

/** The scene's blocks, without building them (also used by the tests). */
export function largeLayout(config: LargeSceneConfig): LargeLayout {
  const world = new World(config.seed);
  const router = spawnRouter(world, config);
  const r = config.radius;
  const cells: { i: number; j: number; x: number; y: number }[] = [];
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      cells.push({ i, j, x: LATTICE_X + i * BLOCK_W, y: LATTICE_Y + j * BLOCK_H });
    }
  }
  // Nearest the spawn first (block centers), ties in row-major order.
  const d2 = (c: { x: number; y: number }): number => {
    const cx = 2 * c.x + BLOCK_W;
    const cy = 2 * c.y + BLOCK_H;
    return cx * cx + cy * cy;
  };
  cells.sort((a, b) => d2(a) - d2(b) || a.j - b.j || a.i - b.i);
  const blocks: Block[] = [];
  let entities = 0;
  let general = 0;
  let labs = 0;
  for (const c of cells) {
    if (!blockClear(world, c.x, c.y)) continue;
    if (!router.reaches({ x: c.x + PLANT_STAND.x, y: c.y + PLANT_STAND.y })) continue;
    let kind: BlockKind;
    if (orePerMille(world, c.x, c.y) >= MIN_ORE) {
      kind = 'M';
    } else {
      // Lab blocks spread out among the first ones; the rest 4 buffers to 1 assembly block.
      const k = general++;
      if (labs < config.labBlocks && k % 12 === 6) {
        kind = 'L';
        labs++;
      } else {
        kind = k % 5 === 1 ? 'A' : 'B';
      }
    }
    const n = ENTITIES_PER_BLOCK[kind];
    if (entities + n / 2 > config.entities) break;
    blocks.push({ kind, tier: blocks.length % TIERS.length, ...c });
    entities += n;
  }
  if (Math.abs(entities - config.entities) > config.entities / 50) {
    throw new Error(`only ${String(entities)} entities fit, need about ${String(config.entities)}`);
  }
  if (labs < config.labBlocks) throw new Error(`only ${String(labs)} lab blocks fit`);
  return { blocks, entities };
}

/** The starting kit, the same for every player: as much of each item as the hungriest block needs. */
function kit(worldBlocks: readonly WorldBlock[]): ItemStack[] {
  const most = new Map<number, number>();
  for (const wb of worldBlocks) {
    for (const [item, count] of blockNeeds(wb)) {
      most.set(item, Math.max(most.get(item) ?? 0, count));
    }
  }
  const stacks = [...most].map(([item, count]) => ({ item: item as RealItemId, count }));
  const slots = stacks.reduce(
    (n, s) => n + Math.ceil(s.count / itemPrototype(s.item)!.stackSize),
    0,
  );
  if (slots > 40)
    throw new Error(
      `the starting kit needs ${String(slots)} inventory slots: ${JSON.stringify(stacks.map((s) => [itemPrototype(s.item)!.name, s.count]))}`,
    );
  return stacks;
}

/** The starting kit of a layout (throws if it doesn't fit an inventory). */
export function largeKit(layout: LargeLayout): ItemStack[] {
  return kit(layout.blocks.map(toWorld));
}

/** Items on every belt. */
export function countBeltItems(sim: Sim): number {
  let n = 0;
  for (const line of beltTable(sim.state.entities)?.lines() ?? []) {
    n += line.lanes[0].count + line.lanes[1].count;
  }
  return n;
}

/** The output chests (entity ids) of every simulation a large scene built. */
const OUTPUT_CHESTS = new WeakMap<Sim, readonly number[]>();

/** Items in the output chests: what the assembling machines, furnaces and drills made so far. */
function countMade(sim: Sim): number {
  let n = 0;
  for (const id of OUTPUT_CHESTS.get(sim) ?? []) {
    for (const s of sim.state.entities.contents(id)) n += s.count;
  }
  return n;
}

function probe(sim: Sim): WorkCounters {
  return {
    beltItems: countBeltItems(sim),
    madeItems: countMade(sim),
    researchUnits: sim.state.research.unitsDone(DEFAULT_FORCE, LARGE_RESEARCH),
  };
}

/** Share (0..1) of the entities of prototype `name` in state `state`. */
function share(
  states: Record<string, Record<string, number>>,
  name: string,
  state: string,
): number {
  const byState = states[name] ?? {};
  const all = Object.values(byState).reduce((a, b) => a + b, 0);
  return all === 0 ? 0 : (byState[state] ?? 0) / all;
}

function assertWork(
  config: LargeSceneConfig,
  before: WorkCounters,
  after: WorkCounters,
  sim: Sim,
): void {
  const fail = (what: string): never => {
    throw new Error(`scene ${config.name} did no real work: ${what}`);
  };
  if (after.madeItems! <= before.madeItems!) fail('nothing made reached an output chest');
  if (after.researchUnits! <= before.researchUnits!) fail('the labs finished no research unit');
  if (sim.state.research.currentOf(DEFAULT_FORCE) !== LARGE_RESEARCH) {
    fail('the research finished (the labs went idle)');
  }
  if (after.beltItems! < config.minBeltItems) {
    fail(
      `${String(after.beltItems)} items on belts, expected at least ${String(config.minBeltItems)}`,
    );
  }
  const activity = sceneActivity(sim);
  const { machineStates } = activity;
  if (activity.activeBeltLanes === 0) fail('no belt moves');
  for (const [name, min] of [
    ['assembling-machine-1', 0.5],
    ['assembling-machine-2', 0.5],
    ['lab', 0.5],
    ['steam-engine', 0.5],
  ] as const) {
    if (share(machineStates, name, 'Working') < min) {
      fail(`fewer than ${String(min * 100)}% of the ${name}s are working`);
    }
  }
  if (activity.powerSatisfaction.some((s) => s === 0)) fail('an electric network has no power');
}

function build(config: LargeSceneConfig): BuiltScene {
  const layout = largeLayout(config);
  const world = new World(config.seed);
  const router = spawnRouter(world, config);
  const worldBlocks = layout.blocks.map(toWorld);
  const sim = new Sim({
    seed: config.seed,
    players: worldBlocks.length,
    startingKit: kit(worldBlocks),
    researched: RESEARCHED,
  });
  const crew = worldBlocks.map((_, p) => new CrewMember(sim, p));
  const counts: Record<string, number> = {};
  const ids: number[][] = worldBlocks.map(() => []);
  const ends: Tile[] = worldBlocks.map(() => ({ x: 0, y: 0 }));

  // An L-shaped walk inside a block (all land).
  const within = (from: Tile, to: Tile): Tile[] => [{ x: to.x, y: from.y }, to];

  function* buildBlock(p: number): Task {
    const member = crew[p]!;
    const wb = worldBlocks[p]!;
    const placed: number[] = new Array<number>(wb.placements.length).fill(0);
    const deliveries = (list: readonly Delivery[]): Insertion[] =>
      list.map(({ index, item, count }) => ({ entity: placed[index]!, item, count }));
    if (p === 0) yield* member.setResearch(LARGE_RESEARCH);
    const path = router.route(wb.stands[0]!);
    if (!path) throw new Error(`block ${String(p)} can't be walked to`);
    yield* member.walk(path);
    let at = wb.stands[0]!;
    const goTo = function* (stand: Tile): Task {
      if (stand.x !== at.x || stand.y !== at.y) yield* member.walk(within(at, stand));
      at = stand;
    };
    // Place everything, stand by stand.
    for (let s = 0; s < wb.stands.length; s++) {
      const indices = wb.sites[s]!;
      if (indices.length === 0) continue;
      yield* goTo(wb.stands[s]!);
      const got = yield* member.place(indices.map((i) => wb.placements[i]!));
      indices.forEach((i, k) => (placed[i] = got[k]!));
    }
    for (const { item } of wb.placements) {
      const name = entityForItem(item)?.name ?? String(item);
      counts[name] = (counts[name] ?? 0) + 1;
    }
    // Then stock the chests, set the recipes and fill the loops.
    for (let s = 0; s < wb.stands.length; s++) {
      const stock = wb.stock[s]!;
      const recipes = wb.recipes[s]!;
      const loops = wb.loops[s]!;
      if (stock.length + recipes.length + loops.length === 0) continue;
      yield* goTo(wb.stands[s]!);
      yield* member.insert(deliveries(stock));
      for (const recipe of new Set(recipes.map((r) => r.recipe))) {
        const machines = recipes.filter((r) => r.recipe === recipe).map((r) => placed[r.index]!);
        yield* member.setRecipes(machines, recipe);
      }
      // All loops with the same items at once.
      const { rounds, interval } = FILL[wb.block.tier]!;
      for (const key of new Set(loops.map((l) => l.items.join()))) {
        const same = loops.filter((l) => l.items.join() === key);
        const belts = same.flatMap((l) => l.fill.map((i) => placed[i]!));
        yield* member.fillRounds(belts, same[0]!.items, rounds, interval);
      }
    }
    ids[p] = placed;
    ends[p] = at;
  }

  function* fuelBlock(p: number): Task {
    const member = crew[p]!;
    const wb = worldBlocks[p]!;
    let at = ends[p]!;
    for (let s = 0; s < wb.stands.length; s++) {
      const fuel = wb.fuel[s]!;
      if (fuel.length === 0) continue;
      const stand = wb.stands[s]!;
      if (stand.x !== at.x || stand.y !== at.y) yield* member.walk(within(at, stand));
      at = stand;
      yield* member.insert(
        fuel.map(({ index, item, count }) => ({ entity: ids[p]![index]!, item, count })),
      );
    }
  }

  runCrew(
    sim,
    worldBlocks.map((_, p) => buildBlock(p)),
  );
  runCrew(
    sim,
    worldBlocks.map((_, p) => fuelBlock(p)),
  );

  OUTPUT_CHESTS.set(
    sim,
    worldBlocks.flatMap((wb, p) => wb.plan.outputs.map((i) => ids[p]![i]!)),
  );
  const placed = sim.state.entities.count;
  if (placed !== layout.entities) {
    throw new Error(`scene has ${String(placed)} entities, expected ${String(layout.entities)}`);
  }
  return {
    sim,
    setupTicks: sim.tick,
    entityCounts: counts,
    beltItems: crew.reduce((n, m) => n + m.beltItems, 0),
  };
}

/** A large scene from its config. */
export function largeScene(
  config: LargeSceneConfig,
  description: string,
  targetMeanMs: number,
): BenchScene {
  return {
    name: config.name,
    description,
    targetMeanMs,
    heavy: true,
    defaults: { warmupTicks: 1_200, measuredTicks: 3_600, runs: 3, warmupRuns: 0 },
    build: () => build(config),
    probe,
    assertWork: (before, after, sim) => {
      assertWork(config, before, after, sim);
    },
  };
}

export const FACTORY_10K: LargeSceneConfig = {
  name: '10k',
  seed: 0xbe_4c_13,
  entities: 10_000,
  labBlocks: 3,
  minBeltItems: 45_000,
  radius: 12,
};

export const FACTORY_50K: LargeSceneConfig = {
  name: '50k',
  seed: 0xbe_4c_13,
  entities: 50_000,
  labBlocks: 4,
  minBeltItems: 240_000,
  radius: 24,
};

export const factory10k = largeScene(
  FACTORY_10K,
  'About 10 000 entities and 50 000 belt items: a steam-powered factory of 16×15 blocks (assembly lines making red and green science, belt loops carrying cable between inserters, labs researching, smelting on the ore), all belt tiers, undergrounds and splitters, built by a crew of players',
  8,
);

export const factory50k = largeScene(
  FACTORY_50K,
  'About 50 000 entities: the 10k factory five times over (same blocks and mix, more of them, further from the spawn)',
  16,
);

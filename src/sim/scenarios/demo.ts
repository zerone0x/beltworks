/**
 * The demo factory (#142, docs/DECISIONS.md, D72): a complete, automated
 * factory from ore to research, built on a fixed seed by a scripted player
 * through commands only (`Move`, `Place`, `SetRecipe`, `Insert`,
 * `SetResearch`), like the benchmark scenes. Nothing is pre-filled but a
 * little starting coal in the boilers and furnaces: every plate, gear,
 * circuit and science pack comes from ore mined on the spot.
 *
 * The flow reads from west to east, outwards from the middle of the starting
 * area (seed `DEMO_SEED`: iron ore north-west, copper south-west, coal
 * north-east, stone south-east):
 *
 * - **Mining**: five electric drills on the iron patch drop ore onto a belt
 *   running east along y = -15, two on the copper patch onto one along
 *   y = 8. A row of four drills on the coal patch feeds a belt along y = -15
 *   both ways: west to the furnaces, east to the power plant. One drill on
 *   stone fills a chest, which an inserter empties into a second one.
 * - **Smelting**: two columns of stone furnaces on the axis x = 0. Each
 *   furnace belt is fed from both sides, ore into one lane and coal into the
 *   other (side-loading), and electric inserters move both into the
 *   furnaces, which stand in groups of up to four around a row of poles.
 *   Iron: seven furnaces; copper: four. Electric inserters put the plates
 *   onto belts that side-load into the plate bus.
 * - **The bus**: a fast belt along y = 0 with iron plates on its north lane
 *   and copper on its south lane, running east into the assembly block. The
 *   copper column's coal crosses it underground.
 * - **Intermediates** (the assembly block, x 9..23): a second belt along
 *   y = 1 carries gears (south lane) and circuits (north lane). The row above
 *   the bus (gears, then three red science machines) and the row below it
 *   (copper cable into electronic circuits, electric inserters, transport
 *   belts) take from both belts, with an inserter from the near belt and a
 *   long-handed inserter from the far one.
 * - **Science**: the electric inserters and transport belts drop onto the
 *   two lanes of a belt that feeds three green science machines; their packs
 *   go onto an express belt. The red packs go up onto another, west, down
 *   under the bus and onto the green packs' belt's other lane.
 * - **Research**: three labs end the green machines' row, fed through two
 *   splitters. They research {@link DEMO_RESEARCH_CHAIN} one technology
 *   after the other, for about an hour of game time.
 * - **Power**: two boilers facing south with two steam engines each, east
 *   of the assembly block, fed by burner inserters through buffer chests
 *   from the coal belt. Small electric poles in straight lines carry the
 *   power everywhere ({@link DEMO_POLES}).
 *
 * The production is sized to the labs, which hold up to a stack of each
 * pack: they take what the science machines make for the whole chain, so
 * nothing backs up into the science belts while they research.
 */

import { ENTITIES, entityForItem } from '../../data/entities';
import { ItemId, itemPrototype, type ItemStack, type RealItemId } from '../../data/items';
import { RecipeId } from '../../data/recipes';
import { TechId } from '../../data/technologies';
import { isWalkable } from '../../data/tiles';
import { Direction } from '../entities/direction';
import { inBuildReach } from '../entities/placement';
import { forceOf } from '../research/unlocks';
import { footprintSize } from '../entities/store';
import { tileCenter } from '../fixed';
import { PLAYER_SPEED } from '../player';
import { STARTING_KIT } from '../../data/start';
import { Sim } from '../tick';
import { Builder } from './builder';
import { DEMO_SEED, DEMO_SPAWN } from './demoInfo';

export { DEMO_BOUNDS, DEMO_SEED, DEMO_SPAWN } from './demoInfo';

/** The technology the labs research first. */
export const DEMO_RESEARCH = TechId.Automation2;

/**
 * What the labs research, in order (D72): each one starts as the last one
 * completes ({@link continueDemoResearch}), so the labs keep working for
 * about an hour of game time, as long as the tech tree lasts.
 */
export const DEMO_RESEARCH_CHAIN: readonly number[] = [
  DEMO_RESEARCH,
  TechId.Logistics,
  TechId.FastInserter,
  TechId.Logistics2,
  TechId.Logistics3,
];

/**
 * The demo's player picking the next research: when the force researches
 * nothing (the last technology just completed), queues a `SetResearch` for
 * the first technology of {@link DEMO_RESEARCH_CHAIN} it can research now.
 * Call it after every tick of a demo game (the worker does, D72); it changes
 * the simulation only through that command, like the builder, and leaves a
 * research the player picked alone.
 */
export function continueDemoResearch(sim: Sim, playerId = 0): void {
  const { state } = sim;
  const force = forceOf(state, playerId);
  if (state.research.currentOf(force) !== TechId.None) return;
  const next = DEMO_RESEARCH_CHAIN.find((tech) => state.research.isAvailable(force, tech));
  if (next !== undefined)
    sim.enqueue({ type: 'SetResearch', playerId, tech: next, tick: sim.tick });
}

/** Researched from the start: everything the demo's recipes need, and automation 2's prerequisites. */
export const DEMO_RESEARCHED: readonly number[] = [
  TechId.Automation,
  TechId.Electronics,
  TechId.LogisticSciencePack,
];

/**
 * Ticks the factory runs on its own once built, before the game starts: long
 * enough for every furnace and machine to fill its input and fuel slots
 * from what the drills mine, and for the machines making intermediates to
 * fill their output slots (which take the first plates away from the
 * science), so the factory is running at its steady pace when the player
 * arrives.
 */
export const DEMO_WARMUP_TICKS = 10 * 60 * 60;

/** Coal each boiler gets to start the power plant (the coal drills take over from there). */
const BOILER_COAL = 5;
/**
 * Coal each furnace starts with: inserters fill a furnace's fuel slot from
 * the coal lane up to a stack, so the furnaces nearest the start of the belt
 * take all the coal at first; this keeps the others going meanwhile.
 */
const FURNACE_FUEL: ItemStack = { item: ItemId.Coal, count: 10 };

const { North, East, South, West } = Direction;

/** One entity of the layout, with its recipe for an assembling machine. */
export interface DemoEntity {
  readonly item: RealItemId;
  readonly x: number;
  readonly y: number;
  readonly dir: Direction;
  readonly recipe?: number;
  /** Items the builder puts in once it is placed (the boilers' first coal). */
  readonly fill?: ItemStack;
  /** A name for tests and tools (`iron-furnace-w0`, `red-1`, ...). */
  readonly tag?: string;
}

/** The demo factory, in build order (an underground entrance before its exit). */
export function demoLayout(): DemoEntity[] {
  const out: DemoEntity[] = [];
  const add = (
    item: RealItemId,
    x: number,
    y: number,
    dir: Direction = North,
    extra: Partial<Pick<DemoEntity, 'recipe' | 'fill' | 'tag'>> = {},
  ): void => {
    out.push({ item, x, y, dir, ...extra });
  };
  /** A straight run of belts from `(x0, y0)` to `(x1, y1)` (one axis), all facing `dir`. */
  const belts = (
    item: RealItemId,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    dir: Direction,
  ): void => {
    const dx = Math.sign(x1 - x0);
    const dy = Math.sign(y1 - y0);
    for (let x = x0, y = y0; ; x += dx, y += dy) {
      add(item, x, y, dir);
      if (x === x1 && y === y1) break;
    }
  };
  const belt = ItemId.TransportBelt;
  const fast = ItemId.FastTransportBelt;
  const express = ItemId.ExpressTransportBelt;

  // --- Iron: five drills on the iron patch onto a belt east along y = -15. ---
  for (const x of [-17, -14, -11, -8]) {
    add(ItemId.ElectricMiningDrill, x, -18, South, { tag: 'iron-drill' });
  }
  add(ItemId.ElectricMiningDrill, -8, -14, North, { tag: 'iron-drill' });
  belts(belt, -16, -15, -1, -15, East);

  // --- Coal: a row of four drills under a belt along y = -15. The two on the
  // west feed the iron furnaces' belt (west) and the copper furnaces' (down
  // x = 6, under the bus); the two on the east the power plant's (east). ---
  add(ItemId.ElectricMiningDrill, 8, -14, West, { tag: 'coal-drill' });
  add(ItemId.ElectricMiningDrill, 11, -14, North, { tag: 'coal-drill' });
  belts(belt, 12, -15, 1, -15, West);
  add(belt, 7, -13, West);
  belts(belt, 6, -13, 6, -2, South);
  add(ItemId.UndergroundBelt, 6, -1, South);
  add(ItemId.UndergroundBelt, 6, 1, South);
  belts(belt, 6, 2, 6, 7, South);
  belts(belt, 6, 8, 1, 8, West);
  for (const x of [14, 17]) {
    add(ItemId.ElectricMiningDrill, x, -14, North, { tag: 'plant-coal-drill' });
  }
  belts(belt, 15, -15, 21, -15, East);
  belts(belt, 22, -15, 22, -9, South);
  belts(belt, 22, -8, 31, -8, East);

  // --- The iron column: a furnace belt down x = 0 with seven furnaces, in a
  // group of four around a row of poles at y = -11 and one of three around
  // y = -3 (8 rows apart, so the two rows' wires never meet over a furnace). ---
  // Its first belt has nothing behind it, so ore and coal both side-load.
  belts(belt, 0, -16, 0, -2, South);
  /** A furnace west of the belt at `fy` (and one east with `east`), their inserters on row `iy`. */
  const furnacePair = (fy: number, iy: number, tag: string, east = true): void => {
    add(ItemId.ElectricInserter, -1, iy, West);
    add(ItemId.StoneFurnace, -3, fy, North, { tag: `${tag}-w`, fill: FURNACE_FUEL });
    add(ItemId.ElectricInserter, -4, iy, West);
    if (!east) return;
    add(ItemId.ElectricInserter, 1, iy, East);
    add(ItemId.StoneFurnace, 2, fy, North, { tag: `${tag}-e`, fill: FURNACE_FUEL });
    add(ItemId.ElectricInserter, 4, iy, East);
  };
  furnacePair(-13, -12, 'iron-furnace');
  furnacePair(-10, -10, 'iron-furnace');
  furnacePair(-5, -4, 'iron-furnace');
  furnacePair(-2, -2, 'iron-furnace', false);
  // Iron plates down both sides into the bus's north lane.
  belts(belt, -5, -12, -5, -1, South);
  belts(belt, 5, -12, 5, -1, South);

  // --- Copper: two drills onto a belt east along y = 8, and a furnace belt
  // down x = 0 with four furnaces around a row of poles at y = 12. ---
  for (const x of [-15, -12]) {
    add(ItemId.ElectricMiningDrill, x, 9, North, { tag: 'copper-drill' });
  }
  belts(belt, -14, 8, -1, 8, East);
  belts(belt, 0, 7, 0, 13, South);
  furnacePair(10, 11, 'copper-furnace');
  furnacePair(13, 13, 'copper-furnace');
  // Copper plates up both sides into the bus's south lane, under the ore and coal belts.
  for (const x of [-5, 5]) {
    belts(belt, x, 13, x, 10, North);
    add(ItemId.UndergroundBelt, x, 9, North);
    add(ItemId.UndergroundBelt, x, 7, North);
    belts(belt, x, 6, x, 1, North);
  }

  // --- The bus: iron plates on the north lane, copper on the south lane. ---
  belts(fast, -6, 0, 23, 0, East);

  // --- The assembly block: slots of 3×3 machines 4 tiles apart from x = 9;
  // the free column between two slots carries the poles. ---
  const X0 = 9;
  const slot = (k: number): number => X0 + 4 * k;
  // Gears and circuits: a belt along y = 1.
  belts(belt, X0, 1, slot(3) + 2, 1, East);
  // The upper row: gears, then three red science machines. Each machine's
  // inserters stand on the side of the poles that power it.
  add(ItemId.AssemblingMachine1, slot(0), -4, North, {
    recipe: RecipeId.IronGearWheel,
    tag: 'gears',
  });
  add(ItemId.FastInserter, slot(0) + 1, -1, North);
  add(ItemId.LongHandedInserter, slot(0) + 2, -1, South);
  for (const k of [1, 2, 3]) {
    const x = slot(k);
    const near = k === 2 ? x + 1 : x;
    add(ItemId.AssemblingMachine1, x, -4, North, {
      recipe: RecipeId.AutomationSciencePack,
      tag: `red-${String(k)}`,
    });
    add(ItemId.ElectricInserter, near, -1, North);
    add(ItemId.LongHandedInserter, near + 1, -1, North);
    add(ItemId.FastInserter, x + 1, -5, North);
  }
  // The lower row: copper cable into circuits, electric inserters, transport belts.
  add(ItemId.AssemblingMachine1, slot(0), 3, North, { recipe: RecipeId.CopperCable, tag: 'cable' });
  add(ItemId.LongHandedInserter, slot(0) + 1, 2, South);
  add(ItemId.FastInserter, slot(0) + 3, 3, East);
  add(ItemId.AssemblingMachine1, slot(1), 3, North, {
    recipe: RecipeId.ElectronicCircuit,
    tag: 'circuits',
  });
  add(ItemId.ElectricInserter, slot(1), 2, North);
  add(ItemId.LongHandedInserter, slot(1) + 1, 2, South);
  add(ItemId.AssemblingMachine1, slot(2), 3, North, {
    recipe: RecipeId.ElectricInserter,
    tag: 'inserters',
  });
  add(ItemId.ElectricInserter, slot(2) + 1, 2, South);
  add(ItemId.LongHandedInserter, slot(2) + 2, 2, South);
  add(ItemId.AssemblingMachine1, slot(3), 3, North, {
    recipe: RecipeId.TransportBelt,
    tag: 'belts',
  });
  add(ItemId.ElectricInserter, slot(3), 2, South);
  add(ItemId.LongHandedInserter, slot(3) + 1, 2, South);
  // Electric inserters and belts onto the two lanes of the green machines' belt.
  add(ItemId.ElectricInserter, slot(2) + 2, 6, South);
  add(belt, slot(2) + 2, 7, East);
  add(ItemId.ElectricInserter, slot(3), 6, South);
  add(belt, slot(3), 7, West);
  add(belt, slot(2) + 3, 7, South);
  // It ends short of the red packs' belt, so nothing side-loads onto it.
  belts(belt, slot(2) + 3, 8, X0 + 1, 8, West);
  // Three green science machines, their packs onto an express belt along y = 14.
  for (const k of [0, 1, 2]) {
    const x = slot(k);
    add(ItemId.ElectricInserter, x + 1, 9, South);
    add(ItemId.AssemblingMachine1, x, 10, North, {
      recipe: RecipeId.LogisticSciencePack,
      tag: `green-${String(k)}`,
    });
    add(ItemId.FastInserter, x + 1, 13, South);
  }

  // --- Research: the red packs go west and down under the bus, onto the north
  // lane of the green packs' belt. Three labs end the green machines' row; two
  // splitters share the packs out (a half, then two quarters), since a lab
  // takes all the packs it gets up to a stack. ---
  belts(express, slot(3) + 1, -6, X0, -6, West);
  belts(express, X0 - 1, -6, X0 - 1, -2, South);
  add(ItemId.ExpressUndergroundBelt, X0 - 1, -1, South);
  add(ItemId.ExpressUndergroundBelt, X0 - 1, 1, South);
  belts(express, X0 - 1, 2, X0 - 1, 13, South);
  belts(express, X0 - 2, 14, slot(3) - 2, 14, East);
  const lab = (k: number): number => slot(3 + k);
  add(ItemId.Splitter, lab(0) - 1, 14, East, { tag: 'science-splitter' });
  belts(express, lab(0), 14, lab(0) + 2, 14, East);
  belts(express, lab(0), 15, lab(1) - 2, 15, East);
  add(ItemId.Splitter, lab(1) - 1, 15, East, { tag: 'science-splitter' });
  belts(express, lab(1), 15, lab(1) + 2, 15, East);
  belts(express, lab(1), 16, lab(2) - 1, 16, East);
  belts(express, lab(2), 16, lab(2), 15, North);
  belts(express, lab(2), 14, lab(2) + 2, 14, East);
  add(ItemId.FastInserter, lab(0) + 1, 13, North);
  add(ItemId.LongHandedInserter, lab(1) + 1, 13, North);
  add(ItemId.FastInserter, lab(2) + 1, 13, North);
  for (const k of [0, 1, 2]) add(ItemId.Lab, lab(k), 10, North, { tag: `lab-${String(k)}` });

  // --- Stone: a drill into a chest, emptied into a second one. ---
  add(ItemId.ElectricMiningDrill, 14, 16, West, { tag: 'stone-drill' });
  add(ItemId.IronChest, 13, 17, North, { tag: 'stone-chest' });
  add(ItemId.ElectricInserter, 13, 18, South);
  add(ItemId.IronChest, 13, 19, North, { tag: 'stone-chest' });

  // --- Power, east of the labs and the assembly block: two boilers facing
  // south with two steam engines each, fed by burner inserters (which fuel
  // themselves) through buffer chests from the plant's coal belt. ---
  for (const x of [25, 29]) {
    add(ItemId.BurnerInserter, x + 1, -7, South);
    add(ItemId.IronChest, x + 1, -6, North, { tag: 'coal-chest' });
    add(ItemId.BurnerInserter, x + 1, -5, South);
    add(ItemId.Boiler, x + 1, -4, South, {
      fill: { item: ItemId.Coal, count: BOILER_COAL },
      tag: 'boiler',
    });
    add(ItemId.SteamEngine, x, -1, South);
    add(ItemId.SteamEngine, x, 4, South);
  }

  // --- Small electric poles. ---
  for (const [x, y] of DEMO_POLES) add(ItemId.SmallElectricPole, x, y);
  return out;
}

/**
 * Where the small electric poles stand. A small pole is wired to every pole
 * within 7 tiles, so the poles stand in straight lines (4 to 7 tiles apart)
 * at least 8 tiles from any other line, and a line meets another only where
 * they are joined end to end or in a T: every wire runs north-south or
 * east-west, and none crosses a machine (tests/sim/demo.test.ts checks both).
 */
export const DEMO_POLES: readonly (readonly [number, number])[] = [
  // The spine, west to east along y = -11: the iron drills south of the ore
  // belt, the first group of iron furnaces, the coal drills, and the tops of
  // the assembly block's three lines.
  [-21, -11],
  [-15, -11],
  [-9, -11],
  [-3, -11],
  [3, -11],
  [7, -11],
  [12, -11],
  [16, -11],
  [20, -11],
  [24, -11],
  [28, -11],
  // The west edge, up to a line along the iron drills north of the ore belt.
  [-21, -15],
  [-21, -19],
  [-15, -19],
  [-9, -19],
  // Down the west edge of the furnaces: the second group of iron furnaces
  // (y = -3), then the copper drills and furnaces (y = 12).
  [-9, -7],
  [-9, -3],
  [-3, -3],
  [3, -3],
  [-9, 2],
  [-9, 7],
  [-9, 12],
  [-15, 12],
  [-3, 12],
  [3, 12],
  // The assembly block: down the free columns x = 12 and 20 (8 apart).
  ...[12, 20].flatMap((x) => [-5, -1, 4, 9, 13].map((y) => [x, y] as const)),
  // The stone drill, south of x = 12.
  [12, 18],
  // The engines and the labs: down x = 28, between the two boilers' rows.
  [28, -5],
  [28, 0],
  [28, 5],
  [28, 11],
];

/** Everything the layout places, counted by item. */
export function layoutItems(layout: readonly DemoEntity[]): Map<number, number> {
  const need = new Map<number, number>();
  const add = (item: number, count: number): void => {
    need.set(item, (need.get(item) ?? 0) + count);
  };
  for (const e of layout) {
    add(e.item, 1);
    if (e.fill) add(e.fill.item, e.fill.count);
  }
  return need;
}

/** The demo player's inventory: the layout, then the usual starting kit to build on with. */
export function demoKit(layout: readonly DemoEntity[]): ItemStack[] {
  const need = layoutItems(layout);
  for (const { item, count } of STARTING_KIT) need.set(item, (need.get(item) ?? 0) + count);
  const kit: ItemStack[] = [];
  for (const [item, count] of need) {
    const stack = itemPrototype(item)?.stackSize ?? 1;
    // Whole stacks of at most `stackSize`, so the inventory takes them slot by slot.
    for (let left = count; left > 0; left -= stack) {
      kit.push({ item: item as RealItemId, count: Math.min(stack, left) });
    }
  }
  return kit;
}

function footprintOf(e: DemoEntity): { x: number; y: number; w: number; h: number } {
  const proto = entityForItem(e.item) ?? ENTITIES[1];
  return { x: e.x, y: e.y, ...footprintSize(proto, e.dir) };
}

const key = (x: number, y: number): string => `${String(x)},${String(y)}`;

/**
 * Builds the demo factory: a new game on {@link DEMO_SEED} where the player
 * walks around placing the layout, sets the recipes, fuels the boilers,
 * starts the research and walks to {@link DEMO_SPAWN}. Deterministic: the
 * same simulation (state hash) every time.
 */
export function buildDemo(warmup = DEMO_WARMUP_TICKS): Sim {
  const layout = demoLayout();
  const sim = new Sim({
    seed: DEMO_SEED,
    startingKit: demoKit(layout),
    researched: DEMO_RESEARCHED,
  });
  const builder = new Builder(sim);
  const world = sim.state.world;
  // The player never stands where something will go.
  const taken = new Set<string>();
  for (const e of layout) {
    const f = footprintOf(e);
    for (let y = f.y; y < f.y + f.h; y++)
      for (let x = f.x; x < f.x + f.w; x++) taken.add(key(x, y));
  }
  const reachable = (px: number, py: number, e: DemoEntity): boolean => {
    const f = footprintOf(e);
    return inBuildReach(px, py, f.x, f.y, f.w, f.h);
  };
  /**
   * Whether a player walking to tile `(tx, ty)` reaches `e` from there: from
   * anywhere a tick's movement away from the tile's center, since that is
   * where `walkTo` stops.
   */
  const reachableFrom = (tx: number, ty: number, e: DemoEntity): boolean => {
    const cx = tileCenter(tx);
    const cy = tileCenter(ty);
    const m = PLAYER_SPEED;
    return [-m, m].every((dx) => [-m, m].every((dy) => reachable(cx + dx, cy + dy, e)));
  };
  /** How many entities from `i` on a player standing on tile `(tx, ty)` reaches in a row. */
  const run = (tx: number, ty: number, i: number): number => {
    let n = 0;
    while (i + n < layout.length && reachableFrom(tx, ty, layout[i + n]!)) n++;
    return n;
  };
  const standFor = (i: number): { x: number; y: number } => {
    const f = footprintOf(layout[i]!);
    const cx = f.x + (f.w >> 1);
    const cy = f.y + (f.h >> 1);
    const { x: px, y: py } = builder.position;
    let best: { x: number; y: number; n: number; d: number } | null = null;
    for (let ty = cy - 9; ty <= cy + 9; ty++) {
      for (let tx = cx - 9; tx <= cx + 9; tx++) {
        if (taken.has(key(tx, ty)) || !isWalkable(world.tileAt(tx, ty))) continue;
        const n = run(tx, ty, i);
        if (n === 0) continue;
        const dx = tileCenter(tx) - px;
        const dy = tileCenter(ty) - py;
        const d = dx * dx + dy * dy;
        if (!best || n > best.n || (n === best.n && d < best.d)) best = { x: tx, y: ty, n, d };
      }
    }
    if (!best) throw new Error(`no place to stand to build ${JSON.stringify(layout[i])}`);
    return best;
  };

  const ids: number[] = [];
  for (let i = 0; i < layout.length;) {
    const { x: px, y: py } = builder.position;
    if (!reachable(px, py, layout[i]!)) {
      const stand = standFor(i);
      builder.walkTo(stand.x, stand.y);
    }
    const { x: qx, y: qy } = builder.position;
    let j = i;
    while (j < layout.length && reachable(qx, qy, layout[j]!)) j++;
    if (j === i) throw new Error(`the builder can't reach ${JSON.stringify(layout[i])}`);
    const batch = layout.slice(i, j);
    ids.push(...builder.place(batch.map(({ item, x, y, dir }) => ({ item, x, y, dir }))));
    // Recipes for the machines just placed (in reach: they were placed from here).
    batch.forEach((e, k) => {
      if (e.recipe !== undefined) builder.setRecipe(ids[i + k]!, e.recipe);
    });
    i = j;
  }
  // Fuel the boilers and furnaces last, so nothing runs while the factory is built.
  layout.forEach((e, i) => {
    if (!e.fill) return;
    const f = footprintOf(e);
    const { x: px, y: py } = builder.position;
    if (!inBuildReach(px, py, f.x, f.y, f.w, f.h)) {
      const stand = standFor(i);
      builder.walkTo(stand.x, stand.y);
    }
    builder.insert([{ entity: ids[i]!, item: e.fill.item, count: e.fill.count }]);
  });
  builder.walkTo(DEMO_SPAWN.x, DEMO_SPAWN.y);
  for (let t = 0; t < warmup; t++) sim.step();
  // The labs start on automation 2 as the player arrives: the research bar starts at 0.
  builder.setResearch(DEMO_RESEARCH);
  return sim;
}

/** The ids of the layout's tagged entities after {@link buildDemo}, by tag (several for a repeated tag). */
export function demoTagged(sim: Sim): Map<string, number[]> {
  const tagged = new Map<string, number[]>();
  for (const e of demoLayout()) {
    if (!e.tag) continue;
    const id = sim.state.entities.at(e.x, e.y);
    tagged.set(e.tag, [...(tagged.get(e.tag) ?? []), id]);
  }
  return tagged;
}

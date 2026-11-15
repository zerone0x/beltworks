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
 *   running east along y = -15, three on the copper patch onto one along
 *   y = 8. A row of four drills on the coal patch feeds a belt along y = -16
 *   both ways: west to the furnaces, east to the power plant. One drill on
 *   stone fills a chest, which an inserter empties into a second one.
 * - **Smelting**: two columns of stone furnaces on the axis x = 0. Each
 *   furnace belt is fed from both sides, ore into one lane and coal into the
 *   other (side-loading), and electric inserters move both into the
 *   furnaces, which stand in groups of up to four around a row of poles.
 *   Iron: eight furnaces; copper: four. Electric inserters put the plates
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
 * completes ({@link DemoResearch}). The tech tree lasts about an hour of
 * game time; the chain then ends on research speed, a repeatable technology
 * (D74) that goes on level after level, so the labs never run out of work.
 */
export const DEMO_RESEARCH_CHAIN: readonly number[] = [
  DEMO_RESEARCH,
  TechId.Logistics,
  TechId.FastInserter,
  TechId.Logistics2,
  TechId.Logistics3,
  TechId.ResearchSpeed,
];

/**
 * The demo's player picking the next research (D72): when the research it
 * picked completes, it sends a `SetResearch` for the first technology of
 * {@link DEMO_RESEARCH_CHAIN} the force can research now. Call
 * {@link DemoResearch.afterTick} after every tick of a demo game (the worker
 * does); it changes the simulation only through that command, like the
 * builder, and keeps no simulation state.
 *
 * It steps aside for good as soon as the player makes a research choice of
 * their own: any change of the current research it didn't make, a pick or a
 * stop (a click on the current research), is the player's, since a research
 * only ends by itself by completing. From then on the player picks, as in
 * any other game.
 */
export class DemoResearch {
  /** The research this player picked last (the current one, unless something changed it). */
  private expected: number;
  private aside = false;

  constructor(
    private readonly sim: Sim,
    private readonly playerId = 0,
  ) {
    this.expected = sim.state.research.currentOf(forceOf(sim.state, playerId));
  }

  /** Whether the player made a research choice of their own, and the chain stopped. */
  get stoppedByPlayer(): boolean {
    return this.aside;
  }

  /** Looks at the research after a tick, and picks the next one if the last one completed. */
  afterTick(): void {
    if (this.aside) return;
    const { state } = this.sim;
    const force = forceOf(state, this.playerId);
    const current = state.research.currentOf(force);
    if (current === this.expected && current !== TechId.None) return;
    const completed =
      current === TechId.None &&
      (this.expected === TechId.None || state.research.isResearched(force, this.expected));
    if (!completed) {
      // A pick or a stop this player didn't make: the player's own choice.
      this.aside = true;
      return;
    }
    const next = DEMO_RESEARCH_CHAIN.find((tech) => state.research.isAvailable(force, tech));
    this.expected = next ?? TechId.None;
    if (next !== undefined) {
      this.sim.enqueue({
        type: 'SetResearch',
        playerId: this.playerId,
        tech: next,
        tick: this.sim.tick,
      });
    }
  }
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
export const DEMO_WARMUP_TICKS = 14 * 60 * 60;

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

  // ===== NEW LAYOUT (WIP) =====
  // --- Iron: eight drills on both sides of an ore belt along y = -15, which
  // runs east, up x = -6 and along y = -24 to the top of the iron furnaces. ---
  for (const x of [-18, -15, -12, -9]) add(ItemId.ElectricMiningDrill, x, -18, South, { tag: 'iron-drill' });
  for (const x of [-19, -16, -13, -10]) add(ItemId.ElectricMiningDrill, x, -14, North, { tag: 'iron-drill' });
  belts(belt, -18, -15, -7, -15, East);
  belts(belt, -6, -15, -6, -23, North);
  belts(belt, -6, -24, -1, -24, East);
  // Coal for the iron furnaces: a drill, up x = 6 and west along y = -24.
  add(ItemId.ElectricMiningDrill, 8, -18, West, { tag: 'fuel-drill' });
  add(belt, 7, -17, West);
  belts(belt, 6, -17, 6, -23, North);
  belts(belt, 6, -24, 1, -24, West);
  // The iron column: a furnace belt down x = 0 with twelve furnaces.
  belts(belt, 0, -25, 0, -2, South);
  const furnacePair = (cx: number, fy: number, iy: number, tag: string): void => {
    add(ItemId.ElectricInserter, cx - 1, iy, West);
    add(ItemId.StoneFurnace, cx - 3, fy, North, { tag });
    add(ItemId.ElectricInserter, cx - 4, iy, West);
    add(ItemId.ElectricInserter, cx + 1, iy, East);
    add(ItemId.StoneFurnace, cx + 2, fy, North, { tag });
    add(ItemId.ElectricInserter, cx + 4, iy, East);
  };
  for (const [fy, iy] of [[-22, -21], [-18, -18], [-14, -13], [-10, -10], [-6, -5], [-2, -2]] as const) {
    furnacePair(0, fy, iy, 'iron-furnace');
  }
  belts(belt, -5, -21, -5, -1, South);
  belts(belt, 5, -21, 5, -1, South);

  // --- Copper (as D72). ---
  for (const x of [-18, -15, -12]) add(ItemId.ElectricMiningDrill, x, 9, North, { tag: 'copper-drill' });
  belts(belt, -17, 8, -1, 8, East);
  add(ItemId.ElectricMiningDrill, 8, -14, West, { tag: 'fuel-drill' });
  add(belt, 7, -13, West);
  belts(belt, 6, -13, 6, -2, South);
  add(ItemId.UndergroundBelt, 6, -1, South);
  add(ItemId.UndergroundBelt, 6, 1, South);
  belts(belt, 6, 2, 6, 7, South);
  belts(belt, 6, 8, 1, 8, West);
  belts(belt, 0, 7, 0, 14, South);
  furnacePair(0, 10, 11, 'copper-furnace');
  furnacePair(0, 14, 14, 'copper-furnace');
  for (const x of [-5, 5]) {
    belts(belt, x, 14, x, 10, North);
    add(ItemId.UndergroundBelt, x, 9, North);
    add(ItemId.UndergroundBelt, x, 7, North);
    belts(belt, x, 6, x, 1, North);
  }

  // --- The bus. ---
  belts(fast, -6, 0, 37, 0, East);

  // --- Red and green (the D72 assembly block). ---
  const X0 = 9;
  const slot = (k: number): number => X0 + 4 * k;
  belts(belt, X0, 1, slot(3), 1, East);
  add(ItemId.AssemblingMachine1, slot(0), -4, North, { recipe: RecipeId.IronGearWheel, tag: 'gears' });
  add(ItemId.FastInserter, slot(0) + 1, -1, North);
  add(ItemId.LongHandedInserter, slot(0) + 2, -1, South);
  add(ItemId.AssemblingMachine2, slot(1), -4, North, { recipe: RecipeId.AutomationSciencePack, tag: 'red' });
  add(ItemId.ElectricInserter, slot(1), -1, North);
  add(ItemId.LongHandedInserter, slot(1) + 1, -1, North);
  add(ItemId.FastInserter, slot(1) + 1, -5, North);
  add(ItemId.AssemblingMachine1, slot(2), -4, North, { recipe: RecipeId.AutomationSciencePack, tag: 'red' });
  add(ItemId.ElectricInserter, slot(2) + 1, -1, North);
  add(ItemId.LongHandedInserter, slot(2) + 2, -1, North);
  add(ItemId.FastInserter, slot(2) + 1, -5, North);
  add(ItemId.AssemblingMachine1, slot(0), 3, North, { recipe: RecipeId.CopperCable, tag: 'cable' });
  add(ItemId.LongHandedInserter, slot(0) + 1, 2, South);
  add(ItemId.FastInserter, slot(0) + 3, 5, East);
  add(ItemId.AssemblingMachine1, slot(1), 3, North, { recipe: RecipeId.ElectronicCircuit, tag: 'circuits' });
  add(ItemId.ElectricInserter, slot(1), 2, North);
  add(ItemId.LongHandedInserter, slot(1) + 1, 2, South);
  add(ItemId.AssemblingMachine1, slot(2), 3, North, { recipe: RecipeId.ElectricInserter, tag: 'inserters' });
  add(ItemId.ElectricInserter, slot(2) + 1, 2, South);
  add(ItemId.LongHandedInserter, slot(2) + 2, 2, South);
  add(ItemId.AssemblingMachine1, slot(3), 3, North, { recipe: RecipeId.TransportBelt, tag: 'belts' });
  add(ItemId.ElectricInserter, slot(3), 2, South);
  add(ItemId.LongHandedInserter, slot(3) + 1, 2, South);
  add(ItemId.ElectricInserter, slot(2) + 2, 6, South);
  add(belt, slot(2) + 2, 7, East);
  add(ItemId.ElectricInserter, slot(3), 6, South);
  add(belt, slot(3), 7, West);
  add(belt, slot(2) + 3, 7, South);
  belts(belt, slot(2) + 3, 8, X0 + 1, 8, West);
  for (const k of [0, 1]) {
    const x = slot(k);
    add(ItemId.ElectricInserter, x + 1, 9, South);
    add(ItemId.AssemblingMachine2, x, 10, North, { recipe: RecipeId.LogisticSciencePack, tag: 'green' });
    add(ItemId.FastInserter, x + 1, 13, South);
  }
  // Red packs west, down under the bus and onto the green packs' belt.
  belts(express, slot(2) + 1, -6, X0, -6, West);
  belts(express, X0 - 1, -6, X0 - 1, -2, South);
  add(ItemId.ExpressUndergroundBelt, X0 - 1, -1, South);
  add(ItemId.ExpressUndergroundBelt, X0 - 1, 1, South);
  belts(express, X0 - 1, 2, X0 - 1, 13, South);
  belts(express, slot(1) + 1, 14, X0 - 1, 14, West);
  belts(express, X0 - 2, 14, X0 - 2, 17, South);

  // --- Coal: six drills onto a belt along y = -16, split between the power
  // plant (north) and the military block (south). ---
  for (const x of [11, 14, 17]) add(ItemId.ElectricMiningDrill, x, -19, South, { tag: 'coal-drill' });
  for (const x of [11, 14, 17]) add(ItemId.ElectricMiningDrill, x, -15, North, { tag: 'coal-drill' });
  belts(belt, 12, -16, 20, -16, East);
  add(ItemId.Splitter, 21, -17, East);
  belts(belt, 22, -17, 22, -23, North);
  belts(belt, 22, -24, 32, -24, East);
  belts(belt, 22, -16, 22, -7, South);
  // --- Power: three boilers facing south with two steam engines each. ---
  for (const x of [23, 27, 31]) {
    add(ItemId.ElectricInserter, x + 1, -23, South);
    add(ItemId.Boiler, x + 1, -22, South, { fill: { item: ItemId.Coal, count: BOILER_COAL }, tag: 'boiler' });
    add(ItemId.SteamEngine, x, -19, South);
    add(ItemId.SteamEngine, x, -14, South);
  }

  // --- Military, upper row along the bus: grenades and steel. ---
  belts(belt, 22, -6, 36, -6, East);
  add(ItemId.UndergroundBelt, 37, -6, East);
  add(ItemId.UndergroundBelt, 39, -6, East);
  belts(belt, 40, -6, 40, 17, South);
  for (const x of [25, 29]) {
    add(ItemId.AssemblingMachine1, x, -4, North, { recipe: RecipeId.Grenade, tag: 'grenade' });
    add(ItemId.ElectricInserter, x, -1, North);
    add(ItemId.ElectricInserter, x + 1, -5, South);
    add(ItemId.LongHandedInserter, x + 2, -5, North);
  }
  belts(belt, 27, -7, 37, -7, East);
  belts(belt, 38, -7, 38, 6, South);
  add(ItemId.StoneFurnace, 33, -3, North, { tag: 'steel-furnace' });
  add(ItemId.ElectricInserter, 33, -1, North);
  add(ItemId.LongHandedInserter, 33, -4, South);
  add(ItemId.LongHandedInserter, 34, -1, South);
  add(ItemId.StoneFurnace, 36, -3, North, { tag: 'steel-furnace' });
  add(ItemId.ElectricInserter, 37, -1, North);
  add(ItemId.LongHandedInserter, 36, -4, South);
  add(ItemId.LongHandedInserter, 36, -1, South);
  belts(belt, 34, 1, 36, 1, East);
  // Lower row: firearm magazines into piercing rounds.
  add(ItemId.AssemblingMachine1, 31, 3, North, { recipe: RecipeId.FirearmMagazine, tag: 'firearm' });
  add(ItemId.LongHandedInserter, 32, 2, South);
  add(ItemId.ElectricInserter, 34, 4, East);
  add(ItemId.AssemblingMachine1, 35, 3, North, { recipe: RecipeId.PiercingRoundsMagazine, tag: 'piercing' });
  add(ItemId.LongHandedInserter, 37, 2, South);
  add(ItemId.ElectricInserter, 36, 2, South);
  add(ItemId.ElectricInserter, 35, 6, South);
  // Piercing rounds (south lane) and grenades (north lane) west to the military packs.
  belts(belt, 39, 7, 28, 7, West);
  for (const x of [31, 27]) {
    add(ItemId.ElectricInserter, x + 1, 8, South);
    add(x === 31 ? ItemId.AssemblingMachine2 : ItemId.AssemblingMachine1, x, 9, North, {
      recipe: RecipeId.MilitarySciencePack,
      tag: 'military',
    });
    add(ItemId.ElectricInserter, x + 2, 12, North);
    add(ItemId.LongHandedInserter, x + 1, 12, South);
  }
  belts(belt, 33, 13, 29, 13, West);
  add(ItemId.ElectricInserter, 34, 13, West);
  add(ItemId.AssemblingMachine1, 35, 12, North, { recipe: RecipeId.StoneWall, tag: 'walls' });
  add(ItemId.ElectricInserter, 35, 15, North);
  add(ItemId.ElectricInserter, 37, 15, North);
  // Military packs west and down x = 24 to the labs.
  belts(express, 32, 14, 25, 14, West);
  belts(express, 24, 14, 24, 16, South);
  add(ItemId.ExpressUndergroundBelt, 24, 17, South);
  add(ItemId.ExpressUndergroundBelt, 24, 19, South);
  belts(express, 24, 20, 24, 28, South);
  belts(express, 24, 29, 9, 29, West);
  belts(express, 8, 29, 8, 29, North);

  // --- Stone: five drills, bricks in four furnaces, then walls. ---
  for (const x of [11, 14, 17, 21]) add(ItemId.ElectricMiningDrill, x, 15, South, { tag: 'stone-drill' });
  add(ItemId.ElectricMiningDrill, 17, 11, East, { tag: 'stone-drill' });
  belts(belt, 20, 12, 20, 17, South);
  belts(belt, 12, 18, 26, 18, East);
  add(ItemId.UndergroundBelt, 27, 18, East);
  add(ItemId.UndergroundBelt, 29, 18, East);
  belts(belt, 30, 18, 32, 18, East);
  belts(belt, 33, 17, 33, 23, South);
  add(belt, 40, 18, West);
  add(ItemId.UndergroundBelt, 39, 18, West);
  add(ItemId.UndergroundBelt, 37, 18, West);
  belts(belt, 36, 18, 34, 18, West);
  furnacePair(33, 19, 20, 'brick-furnace');
  furnacePair(33, 23, 23, 'brick-furnace');
  belts(belt, 28, 23, 28, 17, North);
  belts(belt, 28, 16, 35, 16, East);
  belts(belt, 38, 23, 38, 17, North);
  belts(belt, 38, 16, 37, 16, West);

  // --- Research: four labs in two pairs, each pair flanking the two halves
  // of a splitter: red and green from above, military from below. ---
  add(ItemId.Splitter, 7, 18, South, { tag: 'science-splitter' });
  belts(express, 7, 19, -2, 19, West);
  add(express, -3, 19, South);
  add(express, 8, 19, South);
  add(ItemId.Splitter, 7, 28, North, { tag: 'science-splitter' });
  belts(express, 7, 27, -2, 27, West);
  add(express, -3, 27, North);
  add(express, 8, 27, North);
  for (const c of [-3, 7]) {
    add(ItemId.Splitter, c, 20, South, { tag: 'science-splitter' });
    belts(express, c, 21, c, 22, South);
    belts(express, c + 1, 21, c + 1, 22, South);
    add(ItemId.ElectricInserter, c - 1, 22, West);
    add(ItemId.ElectricInserter, c + 2, 22, East);
    add(ItemId.Lab, c - 4, 21, North, { tag: 'lab' });
    add(ItemId.Lab, c + 3, 21, North, { tag: 'lab' });
    add(ItemId.ElectricInserter, c - 3, 24, North);
    add(ItemId.ElectricInserter, c + 4, 24, North);
    add(ItemId.Splitter, c, 26, North, { tag: 'science-splitter' });
    belts(express, c, 25, c - 3, 25, West);
    belts(express, c + 1, 25, c + 4, 25, East);
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
 * east-west, and none crosses a machine. A wire hangs about a tile above the
 * ground, so nothing tall stands on the row above an east-west line or right
 * above a pole either (tests/sim/demo.test.ts checks all of it).
 */
export const DEMO_POLES: readonly (readonly [number, number])[] = [
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

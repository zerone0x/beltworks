import { describe, expect, it } from 'vitest';
import { ENTITIES, SAT_ONE, entityForItem, inserterReach } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { RecipeId } from '../../src/data/recipes';
import { ResourceId } from '../../src/data/resources';
import { TECHNOLOGIES, TechId } from '../../src/data/technologies';
import { DIRECTION_DX, DIRECTION_DY } from '../../src/sim/entities/direction';
import { footprintSize } from '../../src/sim/entities/store';
import { MachineState } from '../../src/sim/entities/machine';
import { powerGrid } from '../../src/sim/power/grid';
import { polesConnect, supplyRect } from '../../src/sim/power/geometry';
import { DEFAULT_FORCE } from '../../src/sim/research/unlocks';
import {
  DEMO_BOUNDS,
  DEMO_FINAL_RESEARCH,
  DEMO_ORE_PER_TILE,
  DEMO_POLES,
  DEMO_RESEARCH_CHAIN,
  DEMO_SEED,
  DEMO_SPAWN,
  DemoResearch,
  buildDemo,
  demoKit,
  demoLayout,
  demoTagged,
  enrichDemoOre,
  type DemoEntity,
} from '../../src/sim/scenarios/demo';
import { ProductionCounter } from '../../src/sim/scenarios/production';
import { Sim } from '../../src/sim/tick';
import { World } from '../../src/sim/world/world';
import { reload, stepTogether } from './saveRoundTrip';

const hex = (h: number): string => `0x${h.toString(16).padStart(8, '0')}`;
const pct = (share: number): string => `${(100 * share).toFixed(0)}%`;

const MINUTE = 60 * 60;
/**
 * The run the production checks play after the demo is built: an hour by
 * default (CI), in ten-minute windows. `DEMO_MINUTES=180 npx vitest run
 * tests/sim/demo.test.ts` plays three hours with the same checks (the long
 * probe, opt-in: about two minutes).
 */
const RUN_MINUTES = Number(process.env.DEMO_MINUTES ?? 60);
const WINDOW = 10 * MINUTE;
const WINDOWS = Math.max(1, Math.floor(RUN_MINUTES / 10));

/**
 * The research pace the factory is sized for (D77): units of research speed
 * per second, each a red, a green and a military pack. Two red machines (an
 * assembling machine 2 and a 1), two green ones (2s) and two military ones
 * (a 2 and a 1) make exactly 0.25 packs of each per second.
 */
const PACKS_PER_SECOND = 0.25;
/** Labs: four, each a unit per 15 s at research speed level 0. */
const LABS = 4;

/**
 * Least share of every window each tagged machine spends working
 * (`Working`), by tag, and how many of the tag may work less than 90% (the
 * rest work at least 90%). Each floor is the machine's expected share
 * (what the science needs of it, over what it can make) less a margin:
 * - the science machines, every furnace, the stone drills, the grenade
 *   machines and the boilers are what the line is sized on: 100% expected;
 * - the intermediates make more than the science needs, so they wait
 *   between crafts: gears 0.625 of a machine (62%), cable 0.375, circuits
 *   and electric inserters 0.25, transport belts 0.125, firearm magazines
 *   0.25 (31% while its output slot fills), piercing rounds 0.75, walls 0.25;
 * - ore and coal drills come in whole drills: 8 iron drills for 7.25 drills'
 *   worth of ore and 3 copper ones for 2.5, so the one at the head of each
 *   ore belt waits for room (about 50%); 5 coal drills for about 4.5 drills'
 *   worth (the power plant takes what the machines draw), so two of them
 *   work about 77%; the two fuel drills feed only the iron (54%) and copper
 *   (18%) furnaces' coal lanes.
 */
const BUSY: readonly (readonly [tag: string, floor: number, below90: number])[] = [
  ['iron-drill', 0.2, 1],
  ['copper-drill', 0.4, 1],
  ['coal-drill', 0.6, 2],
  ['fuel-drill', 0.12, 2],
  ['stone-drill', 0.9, 0],
  ['iron-furnace', 0.55, 1],
  ['copper-furnace', 0.9, 0],
  ['steel-furnace', 0.9, 0],
  ['brick-furnace', 0.9, 0],
  ['boiler', 0.9, 0],
  ['gears', 0.55, 1],
  ['cable', 0.33, 1],
  ['circuits', 0.2, 1],
  ['inserters', 0.2, 1],
  ['belts', 0.1, 1],
  ['firearm', 0.2, 1],
  ['piercing', 0.7, 1],
  ['walls', 0.2, 1],
  ['grenade', 0.9, 0],
  ['red', 0.9, 0],
  ['green', 0.9, 0],
  ['military', 0.9, 0],
];

/**
 * The labs' expected share at research speed level `levels`: they make
 * 15 / (1 + 0.1 levels) s per unit and get a unit's packs every
 * 1 / PACKS_PER_SECOND s between the four of them (D74: research speed makes
 * labs faster, so they wait a little longer for the next pack each level).
 */
const labShare = (levels: number): number =>
  (PACKS_PER_SECOND * TECHNOLOGIES[TechId.ResearchSpeed].ticksPerUnit) /
  60 /
  LABS /
  (1 + levels / 10);
/** Most the four labs' shares may differ in a window: the splitters share the packs out evenly. */
const LAB_SPREAD = 0.05;

/** Packs the science belts may gain or lose over the run, at most (they don't fill up or run dry). */
const PACKS_DRIFT = 30;

interface Window {
  /** Working ticks by entity id. */
  working: Map<number, number>;
  minSatisfaction: number;
  /** Ticks some lab had nothing to research. */
  noResearch: number;
  /** Research speed levels done at the window's end. */
  levels: number;
  /** Science packs on the science belts at the window's end. */
  packs: number;
  /** Each science pack made in the window. */
  made: number[];
  /** Units the drills mined in the window, by ore name. */
  mined: Record<string, number>;
}

interface Run {
  sim: Sim;
  windows: Window[];
  /** The tick (since the run started) each research speed level completed at. */
  levelsAt: number[];
  counts: ReturnType<ProductionCounter['read']>;
  /** Inserters that pick from a belt, and the windows each one moved in. */
  beltInserterMoves: Map<number, number>;
  /** Drills that ran out of ore (reported `Depleted`), with the tick it first happened. */
  depleted: Map<number, number>;
}

const DAY = 24 * 60 * 60;

/** The ore each drill of the layout mines, by tag, and its item's name. */
const DRILL_ORE: Readonly<Record<string, { resource: number; item: string }>> = {
  'iron-drill': { resource: ResourceId.IronOre, item: 'iron-ore' },
  'copper-drill': { resource: ResourceId.CopperOre, item: 'copper-ore' },
  'coal-drill': { resource: ResourceId.Coal, item: 'coal' },
  'fuel-drill': { resource: ResourceId.Coal, item: 'coal' },
  'stone-drill': { resource: ResourceId.Stone, item: 'stone' },
};

/**
 * The tiles drill `e` of the layout mines, worked out here rather than taken
 * from the scenario: an electric mining drill (3×3) mines the 5×5 tiles
 * centred on it.
 */
function drillArea(e: DemoEntity): { x: number; y: number }[] {
  expect(e.item, `drill at ${at(e.x, e.y)}`).toBe(ItemId.ElectricMiningDrill);
  const tiles: { x: number; y: number }[] = [];
  for (let y = e.y - 1; y <= e.y + 3; y++)
    for (let x = e.x - 1; x <= e.x + 3; x++) tiles.push({ x, y });
  return tiles;
}

/** The layout's drills: every entity that mines, each tagged with its ore. */
function layoutDrills(): DemoEntity[] {
  const drills = demoLayout().filter((e) => entityForItem(e.item)?.miningTicks !== undefined);
  for (const e of drills) expect(DRILL_ORE[e.tag ?? ''], `ore of ${at(e.x, e.y)}`).toBeDefined();
  return drills;
}

const PACK_NAMES = ['automation-science-pack', 'logistic-science-pack', 'military-science-pack'];

const SCIENCE_BELTS: number[] = [ItemId.ExpressTransportBelt, ItemId.ExpressUndergroundBelt];

function packsOnBelts(sim: Sim): number {
  let packs = 0;
  for (const e of demoLayout()) {
    if (!SCIENCE_BELTS.includes(e.item) && e.tag !== 'science-splitter') continue;
    for (const { count } of sim.state.entities.contents(sim.state.entities.at(e.x, e.y))) {
      packs += count;
    }
  }
  return packs;
}

const at = (x: number, y: number): string => `(${String(x)}, ${String(y)})`;

/** The tiles entity `e` of the layout covers. */
function footprint(e: DemoEntity): { x: number; y: number; w: number; h: number } {
  const proto = entityForItem(e.item) ?? ENTITIES[1];
  return { x: e.x, y: e.y, ...footprintSize(proto, e.dir) };
}

/** The tile inserter `e` of the layout picks up from. */
function pickupTile(e: DemoEntity): { x: number; y: number } {
  const reach = inserterReach(entityForItem(e.item)!);
  return { x: e.x - DIRECTION_DX[e.dir]! * reach, y: e.y - DIRECTION_DY[e.dir]! * reach };
}

const isInserter = (e: DemoEntity): boolean => entityForItem(e.item)?.swingTicks !== undefined;
const isBelt = (e: DemoEntity): boolean => entityForItem(e.item)?.beltSpeed !== undefined;

let built: Sim | null = null;
/** The demo as the player finds it (built once; tests take copies, save and load). */
function demo(): Sim {
  if (!built) {
    built = buildDemo();
    // A first network query compresses the power grid's union-find paths,
    // which the save writes (the hash doesn't see them): query once, so the
    // copy below saves to the same bytes as the original.
    built.hash();
  }
  return reload(built);
}

let cached: Run | null = null;
/**
 * The demo played for `RUN_MINUTES` with its research player, as the worker
 * runs it (once for every test that needs it).
 */
function run(): Run {
  if (cached) return cached;
  const sim = demo();
  const tagged = demoTagged(sim);
  const ids = [...tagged.values()].flat();
  const labs = tagged.get('lab')!;
  const beltTiles = new Set(
    demoLayout()
      .filter(isBelt)
      .map((e) => at(e.x, e.y)),
  );
  const beltInserters = demoLayout()
    .filter((e) => isInserter(e) && beltTiles.has(at(pickupTile(e).x, pickupTile(e).y)))
    .map((e) => sim.state.entities.at(e.x, e.y));
  const beltInserterMoves = new Map<number, number>(beltInserters.map((id) => [id, 0]));
  const counter = new ProductionCounter(sim);
  const grid = powerGrid(sim.state.entities)!;
  const player = new DemoResearch(sim);
  const levelsAt: number[] = [];
  const windows: Window[] = [];
  const fresh = (): Window => ({
    working: new Map(),
    minSatisfaction: Infinity,
    noResearch: 0,
    levels: 0,
    packs: 0,
    made: [],
    mined: {},
  });
  const depleted = new Map<number, number>();
  const windowCounter = new ProductionCounter(sim);
  let window = fresh();
  let moved = new Set<number>();
  const levels = (): number => sim.state.research.levelsDone(DEFAULT_FORCE, TechId.ResearchSpeed);
  const startLevels = levels();
  for (let t = 1; t <= WINDOWS * WINDOW; t++) {
    sim.step();
    player.afterTick();
    counter.observe();
    windowCounter.observe();
    for (const id of ids) {
      const status = sim.state.entities.status(id);
      if (status === MachineState.Working) {
        window.working.set(id, (window.working.get(id) ?? 0) + 1);
      } else if (status === MachineState.Depleted && !depleted.has(id)) {
        depleted.set(id, t);
      }
    }
    for (const id of labs) {
      if (sim.state.entities.status(id) === MachineState.NoResearch) window.noResearch++;
    }
    for (const id of beltInserters) {
      if (sim.state.entities.status(id) === MachineState.Working) moved.add(id);
    }
    for (const net of grid.networkIds()) {
      window.minSatisfaction = Math.min(window.minSatisfaction, grid.network(net)!.satisfaction);
    }
    if (levels() - startLevels > levelsAt.length) levelsAt.push(t);
    if (t % WINDOW === 0) {
      window.levels = levels();
      window.packs = packsOnBelts(sim);
      const counts = windowCounter.read();
      window.made = PACK_NAMES.map((pack) => counts.made[pack] ?? 0);
      window.mined = counts.mined;
      windowCounter.reset();
      windows.push(window);
      window = fresh();
      for (const id of moved) beltInserterMoves.set(id, beltInserterMoves.get(id)! + 1);
      moved = new Set();
    }
  }
  cached = { sim, windows, levelsAt, counts: counter.read(), beltInserterMoves, depleted };
  if (process.env.DEMO_MINUTES !== undefined) logWindows(cached);
  return cached;
}

/**
 * The long probe's table (vitest drops console.log): per window, the packs
 * made a second, the lowest lab share, the ore mined and the drills dry.
 */
function logWindows({ sim, windows, depleted }: Run): void {
  const labs = demoTagged(sim).get('lab')!;
  const ores = ['iron-ore', 'copper-ore', 'coal', 'stone'];
  const rows = [
    `| minutes | red/s | green/s | military/s | labs (lowest) | level | ${ores.join(' | ')} | drills dry |`,
    `|---|---|---|---|---|---|${ores.map(() => '---|').join('')}---|`,
  ];
  windows.forEach((w, i) => {
    const end = WINDOW * (i + 1);
    const dry = [...depleted.values()].filter((t) => t <= end).length;
    const low = Math.min(...labs.map((id) => (w.working.get(id) ?? 0) / WINDOW));
    rows.push(
      `| ${String(10 * i)}-${String(10 * i + 10)} | ${w.made.map((n) => (n / (WINDOW / 60)).toFixed(3)).join(' | ')} | ${pct(low)} | ${String(w.levels)} | ${ores.map((o) => String(w.mined[o] ?? 0)).join(' | ')} | ${String(dry)} |`,
    );
  });
  process.stderr.write(`${rows.join('\n')}\n`);
}

/** Plays `ticks` ticks of the demo with its research player, as the worker does. */
function playTicks(sim: Sim, player: DemoResearch, ticks: number): void {
  for (let t = 0; t < ticks; t++) {
    sim.step();
    player.afterTick();
  }
}

/** The player picks `tech` in the tech tree (0 stops researching), as the UI does. */
function pick(sim: Sim, tech: number): void {
  sim.enqueue({ type: 'SetResearch', playerId: 0, tech, tick: sim.tick });
}

// The first test that needs it builds the demo (about 4 s) and plays the hour (about 30 s).
describe('demo factory', { timeout: 600_000 }, () => {
  it('lays out every entity inside its bounds, without overlaps, with everything in the kit', () => {
    const layout = demoLayout();
    const taken = new Set<string>();
    for (const e of layout) {
      const f = footprint(e);
      for (let y = f.y; y < f.y + f.h; y++) {
        for (let x = f.x; x < f.x + f.w; x++) {
          expect(taken.has(at(x, y)), `overlap at ${at(x, y)}`).toBe(false);
          taken.add(at(x, y));
          expect(x >= DEMO_BOUNDS.x0 && x <= DEMO_BOUNDS.x1, `x of ${at(x, y)}`).toBe(true);
          expect(y >= DEMO_BOUNDS.y0 && y <= DEMO_BOUNDS.y1, `y of ${at(x, y)}`).toBe(true);
        }
      }
    }
    expect(taken.has(at(DEMO_SPAWN.x, DEMO_SPAWN.y))).toBe(false);
    const kit = new Map<number, number>();
    for (const { item, count } of demoKit(layout)) kit.set(item, (kit.get(item) ?? 0) + count);
    for (const e of layout) expect(kit.get(e.item) ?? 0).toBeGreaterThan(0);
  });

  it('pre-fills nothing but a little coal in the boilers', () => {
    // Every plate, gear, circuit and pack is made from mined ore (D72); the
    // builder only gives the boilers coal to start the power plant with.
    // Inserters cap what they put into furnaces (D75), so the furnaces
    // nearest the start of a furnace belt no longer take all the coal and
    // need no head start.
    const fills = demoLayout().filter((e) => e.fill);
    expect(fills.length).toBeGreaterThan(0);
    for (const e of fills) {
      expect(e.item, `what ${e.tag ?? at(e.x, e.y)} is`).toBe(ItemId.Boiler);
      expect(e.fill!.item).toBe(ItemId.Coal);
      expect(e.fill!.count).toBeLessThanOrEqual(5);
    }
  });

  it('wires its poles in straight lines that cross no machine, with nothing in front of a pole', () => {
    // Every pair of poles within reach of each other is wired (polesConnect),
    // so where the poles stand decides the wires. On camera, a wire should run
    // north-south or east-west, never over a machine, and never double up
    // along another wire. A wire hangs about a tile above the ground (the
    // pole's height), so it shows over the row above its tiles: no machine
    // stands there along an east-west wire. A pole's top covers the tile
    // north of it, so nothing at all stands there (#149). No exceptions.
    const layout = demoLayout();
    const pole = entityForItem(ItemId.SmallElectricPole)!;
    const machines = new Map<string, string>();
    const anything = new Map<string, string>();
    for (const e of layout) {
      const f = footprint(e);
      for (let y = f.y; y < f.y + f.h; y++) {
        for (let x = f.x; x < f.x + f.w; x++) {
          const name = e.tag ?? entityForItem(e.item)!.name;
          anything.set(at(x, y), name);
          if (f.w >= 2 && f.h >= 2) machines.set(at(x, y), name);
        }
      }
    }
    let wires = 0;
    for (const [ax, ay] of DEMO_POLES) {
      expect(anything.get(at(ax, ay - 1)), `something right behind the pole at ${at(ax, ay)}`).toBe(
        undefined,
      );
      const directions = new Set<string>();
      for (const [bx, by] of DEMO_POLES) {
        if ((ax === bx && ay === by) || !polesConnect(pole, ax, ay, pole, bx, by)) continue;
        wires++;
        const wire = `${at(ax, ay)}-${at(bx, by)}`;
        expect(ax === bx || ay === by, `diagonal wire ${wire}`).toBe(true);
        const dx = Math.sign(bx - ax);
        const dy = Math.sign(by - ay);
        const direction = `${String(dx)},${String(dy)}`;
        expect(directions.has(direction), `a second wire along ${wire}`).toBe(false);
        directions.add(direction);
        for (let x = ax + dx, y = ay + dy; x !== bx || y !== by; x += dx, y += dy) {
          expect(machines.get(at(x, y)), `wire ${wire} over the machine at ${at(x, y)}`).toBe(
            undefined,
          );
          if (dy !== 0) continue;
          expect(machines.get(at(x, y - 1)), `wire ${wire} in front of ${at(x, y - 1)}`).toBe(
            undefined,
          );
        }
      }
    }
    // A tree: one wire fewer than poles, and (below) one network.
    expect(wires / 2).toBe(DEMO_POLES.length - 1);
  });

  it('powers every electric entity from one network', () => {
    const sim = demo();
    const grid = powerGrid(sim.state.entities)!;
    expect(grid.networkCount).toBe(1);
    const pole = entityForItem(ItemId.SmallElectricPole)!;
    for (const e of demoLayout()) {
      const proto = entityForItem(e.item)!;
      if (proto.energySource !== 'electric' && e.item !== ItemId.SteamEngine) continue;
      const f = footprint(e);
      const covered = DEMO_POLES.some(([px, py]) => {
        const r = supplyRect(pole, px, py);
        return r.x0 < f.x + f.w && f.x <= r.x1 && r.y0 < f.y + f.h && f.y <= r.y1;
      });
      expect(covered, `${e.tag ?? proto.name} at ${at(e.x, e.y)} has a pole`).toBe(true);
      expect(grid.networkOf(sim.state.entities.at(e.x, e.y))).toBe(grid.networkIds()[0]);
    }
  });

  it('ends every belt on an inserter or another belt, so nothing gathers at a dead end', () => {
    // A belt whose last tile no inserter takes from would keep what reaches
    // it there for good, and gather more (the mall belt of #151). Every line
    // ends where an inserter picks up, or runs on into another belt (a
    // side-load, a splitter, an underground).
    const layout = demoLayout();
    const belts = new Set<string>();
    for (const e of layout.filter(isBelt)) {
      const f = footprint(e);
      for (let y = f.y; y < f.y + f.h; y++)
        for (let x = f.x; x < f.x + f.w; x++) belts.add(at(x, y));
    }
    const pickups = new Set(
      layout.filter(isInserter).map((e) => {
        const p = pickupTile(e);
        return at(p.x, p.y);
      }),
    );
    const deadEnds: string[] = [];
    for (const e of layout) {
      const proto = entityForItem(e.item);
      if (!proto?.beltSpeed || proto.splitter) continue;
      const isEntrance = (() => {
        if (!proto.undergroundMaxGap) return false;
        // An entrance is the one of a pair whose partner lies in front of it.
        const dx = DIRECTION_DX[e.dir]!;
        const dy = DIRECTION_DY[e.dir]!;
        for (let k = 1; k <= proto.undergroundMaxGap + 1; k++) {
          const other = layout.find((o) => o.x === e.x + dx * k && o.y === e.y + dy * k);
          if (other?.item === e.item && other.dir === e.dir) return true;
        }
        return false;
      })();
      if (isEntrance) continue;
      const front = at(e.x + DIRECTION_DX[e.dir]!, e.y + DIRECTION_DY[e.dir]!);
      if (belts.has(front) || pickups.has(at(e.x, e.y))) continue;
      deadEnds.push(`${entityForItem(e.item)!.name} at ${at(e.x, e.y)}`);
    }
    expect(deadEnds).toEqual([]);
  });

  it('is built through commands the same way every time (same state hash)', () => {
    const a = buildDemo();
    const b = buildDemo();
    expect(hex(b.hash())).toBe(hex(a.hash()));
    stepTogether(a, b, 300);
    // Built, the player stands by the factory, which researches research speed.
    const { players, research, entities } = a.state;
    expect(Math.floor(players.x[0]! / 256)).toBe(DEMO_SPAWN.x);
    expect(Math.floor(players.y[0]! / 256)).toBe(DEMO_SPAWN.y);
    expect(research.currentOf(DEFAULT_FORCE)).toBe(DEMO_FINAL_RESEARCH);
    expect(entities.count).toBe(demoLayout().length);
  });

  it('sets the ore under its drills, and nothing else, before the first tick', () => {
    // A fresh world of the demo's seed, as a new game gets it (D77).
    const generated = new World(DEMO_SEED);
    expect(new Sim({ seed: DEMO_SEED }).state.world.hashInto()).toBe(generated.hashInto());
    const world = new World(DEMO_SEED);
    enrichDemoOre(world, demoLayout());
    const mined = new Set(
      layoutDrills()
        .flatMap(drillArea)
        .map(({ x, y }) => at(x, y)),
    );
    let set = 0;
    let bare = 0;
    for (let y = DEMO_BOUNDS.y0 - 3; y <= DEMO_BOUNDS.y1 + 3; y++) {
      for (let x = DEMO_BOUNDS.x0 - 3; x <= DEMO_BOUNDS.x1 + 3; x++) {
        const r = generated.resourceAt(x, y);
        // No tile gains or loses a resource.
        expect(world.resourceAt(x, y), `resource at ${at(x, y)}`).toBe(r);
        expect(generated.amountAt(x, y)).toBeLessThan(DEMO_ORE_PER_TILE);
        if (mined.has(at(x, y)) && r !== ResourceId.None) {
          expect(world.amountAt(x, y), `ore at ${at(x, y)}`).toBe(DEMO_ORE_PER_TILE);
          set++;
        } else {
          expect(world.amountAt(x, y), `ore at ${at(x, y)}`).toBe(generated.amountAt(x, y));
          if (r !== ResourceId.None) bare++;
        }
      }
    }
    // Every drill's area, the drills at both ends of a row included (23 drills).
    expect(set).toBeGreaterThan(300);
    expect(bare, 'ore outside the drills keeps its amount').toBeGreaterThan(0);
  });

  it('puts every drill on its ore, every tile it mines holding a week of ore flat out', () => {
    const sim = demo();
    const { world } = sim.state;
    const generated = new World(DEMO_SEED);
    // Units a second the drills reaching a tile take from it at most: a drill
    // mines its ore tiles in turn, so each gets its share of the drill's pace.
    const draw = new Map<string, number>();
    let drills = 0;
    for (const e of layoutDrills()) {
      const tiles = drillArea(e);
      drills++;
      const ore = DRILL_ORE[e.tag!];
      const oreTiles = tiles.filter(({ x, y }) => {
        const r = world.resourceAt(x, y);
        expect([ResourceId.None, ore!.resource], `ore at ${at(x, y)}`).toContain(r);
        // Nothing mined a tile dry, and no tile gained ore.
        expect(r, `resource at ${at(x, y)}`).toBe(generated.resourceAt(x, y));
        return r === ore!.resource;
      });
      expect(oreTiles.length, `ore tiles under ${at(e.x, e.y)}`).toBeGreaterThanOrEqual(10);
      const pace = 60 / entityForItem(e.item)!.miningTicks!;
      for (const { x, y } of oreTiles) {
        draw.set(at(x, y), (draw.get(at(x, y)) ?? 0) + pace / oreTiles.length);
      }
    }
    expect(drills).toBe(23);
    let shortest = Infinity;
    for (const [tile, perSecond] of draw) {
      const [x, y] = tile.slice(1, -1).split(', ').map(Number) as [number, number];
      shortest = Math.min(shortest, world.amountAt(x, y) / perSecond);
    }
    expect(
      shortest / DAY,
      'days until the first tile runs dry, every drill flat out',
    ).toBeGreaterThan(7);
  });

  it('throws if the factory does not research its military branch in time', () => {
    // A minute is far too short (it takes about 11): the build stops there
    // instead of handing over a factory whose military line never starts.
    expect(() => buildDemo(0, MINUTE)).toThrow(/never researched its military branch/);
  });

  it('researches the military branch while it is built, and sets the military recipes', () => {
    const sim = demo();
    const { research, entities } = sim.state;
    for (const tech of DEMO_RESEARCH_CHAIN) {
      if (tech === DEMO_FINAL_RESEARCH) continue;
      expect(
        research.isResearched(DEFAULT_FORCE, tech),
        TECHNOLOGIES[tech as keyof typeof TECHNOLOGIES].name,
      ).toBe(true);
    }
    expect(DEMO_RESEARCH_CHAIN.at(-1)).toBe(DEMO_FINAL_RESEARCH);
    expect(research.currentOf(DEFAULT_FORCE)).toBe(TechId.ResearchSpeed);
    // Research speed costs all three packs (D77).
    expect(TECHNOLOGIES[TechId.ResearchSpeed].packs).toEqual([
      ItemId.AutomationSciencePack,
      ItemId.LogisticSciencePack,
      ItemId.MilitarySciencePack,
    ]);
    for (const e of demoLayout()) {
      if (e.recipe === undefined) continue;
      expect(entities.selectedRecipe(entities.at(e.x, e.y)), `recipe of ${e.tag ?? ''}`).toBe(
        e.recipe,
      );
    }
    expect(demoLayout().some((e) => e.recipe === RecipeId.MilitarySciencePack)).toBe(true);
  });

  it('keeps every machine at its share in every window, on enough power, never out of research', () => {
    const { sim, windows } = run();
    expect(windows).toHaveLength(WINDOWS);
    const tagged = demoTagged(sim);
    const ruled = new Set(BUSY.map(([tag]) => tag));
    for (const tag of tagged.keys()) {
      if (tag.endsWith('splitter') || tag === 'lab') continue;
      expect(ruled.has(tag), `a share rule for ${tag}`).toBe(true);
    }
    windows.forEach((w, i) => {
      const when = `minutes ${String(10 * i)}-${String(10 * i + 10)}`;
      expect(w.minSatisfaction, `power, ${when}`).toBe(SAT_ONE);
      expect(w.noResearch, `labs without research, ${when}`).toBe(0);
      for (const [tag, floor, below90] of BUSY) {
        const ids = tagged.get(tag)!;
        expect(ids.length, tag).toBeGreaterThan(0);
        const shares = ids.map((id) => (w.working.get(id) ?? 0) / WINDOW);
        const text = `${tag} ${shares.map(pct).join(', ')}, ${when}`;
        for (const share of shares) expect(share, text).toBeGreaterThanOrEqual(floor);
        expect(shares.filter((s) => s < 0.9).length, text).toBeLessThanOrEqual(below90);
      }
      // Labs: as busy as the packs let them be at this level, and evenly so.
      const labs = tagged.get('lab')!.map((id) => (w.working.get(id) ?? 0) / WINDOW);
      expect(labs).toHaveLength(LABS);
      const text = `labs ${labs.map(pct).join(', ')} at level ${String(w.levels)}, ${when}`;
      for (const share of labs)
        expect(share, text).toBeGreaterThanOrEqual(0.9 * labShare(w.levels));
      expect(Math.max(...labs) - Math.min(...labs), text).toBeLessThanOrEqual(LAB_SPREAD);
    });
  });

  it('uses every pack it makes: the three packs at the same rate, none piling up on the belts', () => {
    const { windows, counts } = run();
    const seconds = counts.ticks / 60;
    for (const pack of [
      'automation-science-pack',
      'logistic-science-pack',
      'military-science-pack',
    ]) {
      const made = counts.made[pack] ?? 0;
      const used = counts.consumed[pack] ?? 0;
      expect(made / seconds, `${pack} made per second`).toBeGreaterThanOrEqual(
        0.97 * PACKS_PER_SECOND,
      );
      expect(
        Math.abs(made - used),
        `${pack} made ${String(made)}, used ${String(used)}`,
      ).toBeLessThanOrEqual(PACKS_DRIFT);
    }
    const packs = windows.map((w) => w.packs);
    expect(
      Math.max(...packs) - Math.min(...packs),
      `packs on the belts ${packs.join(', ')}`,
    ).toBeLessThanOrEqual(PACKS_DRIFT);
  });

  it('keeps every belt moving: each inserter that takes from a belt swings in every window', () => {
    const { beltInserterMoves } = run();
    const idle = [...beltInserterMoves].filter(([, n]) => n < WINDOWS).map(([id]) => id);
    expect(idle, 'inserters that stood still on their belt for a whole window').toEqual([]);
  });

  it('runs no drill dry, and makes every pack at its pace in every window', () => {
    const { windows, depleted } = run();
    expect([...depleted.keys()], 'drills out of ore').toEqual([]);
    windows.forEach((w, i) => {
      const when = `minutes ${String(10 * i)}-${String(10 * i + 10)}`;
      PACK_NAMES.forEach((pack, k) => {
        expect(w.made[k]! / (WINDOW / 60), `${pack} a second, ${when}`).toBeGreaterThanOrEqual(
          0.97 * PACKS_PER_SECOND,
        );
      });
    });
  });

  it('has ore under each ore line for a week at the pace it mines', () => {
    const { sim, counts } = run();
    const seconds = counts.ticks / 60;
    // Each tile counted once, however many drills reach it.
    const left = new Map<string, Map<string, number>>();
    for (const e of layoutDrills()) {
      const ore = DRILL_ORE[e.tag!]!;
      const tiles = left.get(ore.item) ?? new Map<string, number>();
      left.set(ore.item, tiles);
      for (const { x, y } of drillArea(e)) {
        if (sim.state.world.resourceAt(x, y) === ore.resource) {
          tiles.set(at(x, y), sim.state.world.amountAt(x, y));
        }
      }
    }
    expect([...left.keys()].sort()).toEqual(['coal', 'copper-ore', 'iron-ore', 'stone']);
    for (const [item, tiles] of left) {
      const perSecond = (counts.mined[item] ?? 0) / seconds;
      expect(perSecond, `${item} mined a second`).toBeGreaterThan(0);
      let total = 0;
      for (const amount of tiles.values()) total += amount;
      expect(total / perSecond / DAY, `days of ${item} left`).toBeGreaterThan(7);
    }
  });

  it('completes research speed level after level, each taking longer', () => {
    const { levelsAt, sim } = run();
    expect(sim.state.research.currentOf(DEFAULT_FORCE)).toBe(TechId.ResearchSpeed);
    expect(levelsAt.length).toBeGreaterThanOrEqual(RUN_MINUTES >= 60 ? 2 : 1);
    for (let i = 2; i < levelsAt.length; i++) {
      expect(levelsAt[i]! - levelsAt[i - 1]!).toBeGreaterThan(levelsAt[i - 1]! - levelsAt[i - 2]!);
    }
  });

  it('carries nothing but science packs to the labs', () => {
    const { sim } = run();
    const packs: number[] = [
      ItemId.AutomationSciencePack,
      ItemId.LogisticSciencePack,
      ItemId.MilitarySciencePack,
    ];
    let carried = 0;
    for (const e of demoLayout()) {
      if (!SCIENCE_BELTS.includes(e.item) && e.tag !== 'science-splitter') continue;
      for (const { item, count } of sim.state.entities.contents(sim.state.entities.at(e.x, e.y))) {
        expect(packs, `item ${String(item)} on the science belt at ${at(e.x, e.y)}`).toContain(
          item,
        );
        carried += count;
      }
    }
    expect(carried).toBeGreaterThan(0);
  });

  it('lets the player stop the research, and the chain stays stopped', () => {
    // A click on the current research stops it (src/ui/techTree.ts).
    const sim = demo();
    const player = new DemoResearch(sim);
    playTicks(sim, player, 60);
    expect(player.stoppedByPlayer).toBe(false);
    pick(sim, TechId.None);
    playTicks(sim, player, MINUTE);
    expect(player.stoppedByPlayer).toBe(true);
    expect(sim.state.research.currentOf(DEFAULT_FORCE)).toBe(TechId.None);
    // Picking research speed again is the player's choice too: it stays the
    // player's, and the chain doesn't come back.
    pick(sim, TechId.ResearchSpeed);
    playTicks(sim, player, MINUTE);
    expect(sim.state.research.currentOf(DEFAULT_FORCE)).toBe(TechId.ResearchSpeed);
    expect(player.stoppedByPlayer).toBe(true);
  });

  it('saves and loads mid-run, then runs on identically', () => {
    const sim = demo();
    const player = new DemoResearch(sim);
    playTicks(sim, player, 600);
    const copy = reload(sim);
    stepTogether(sim, copy, 1200);
  });

  it('gives the player the starting kit on top of what the factory took', () => {
    const sim = demo();
    const inventory = sim.state.players.inventory(0);
    expect(inventory.count(ItemId.TransportBelt)).toBeGreaterThanOrEqual(10);
    expect(inventory.count(ItemId.ElectricMiningDrill)).toBeGreaterThanOrEqual(2);
  });
});

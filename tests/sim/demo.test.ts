import { describe, expect, it } from 'vitest';
import { ENTITIES, entityForItem } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { ResourceId } from '../../src/data/resources';
import { TECHNOLOGIES, TechId } from '../../src/data/technologies';
import { footprintSize } from '../../src/sim/entities/store';
import { MachineState } from '../../src/sim/entities/machine';
import { powerGrid } from '../../src/sim/power/grid';
import { polesConnect, supplyRect } from '../../src/sim/power/geometry';
import { DEFAULT_FORCE } from '../../src/sim/research/unlocks';
import {
  DEMO_BOUNDS,
  DEMO_POLES,
  DEMO_RESEARCH,
  DEMO_RESEARCH_CHAIN,
  DEMO_SPAWN,
  buildDemo,
  continueDemoResearch,
  demoKit,
  demoLayout,
  demoTagged,
  type DemoEntity,
} from '../../src/sim/scenarios/demo';
import { ProductionCounter } from '../../src/sim/scenarios/production';
import type { Sim } from '../../src/sim/tick';
import { reload, stepTogether } from './saveRoundTrip';

const hex = (h: number): string => `0x${h.toString(16).padStart(8, '0')}`;
const pct = (share: number): string => `${(100 * share).toFixed(0)}%`;

const MINUTE = 60 * 60;
/** The first window the production checks cover: two minutes of play after the demo starts. */
const FIRST = 2 * MINUTE;
/** Research units the labs finish within `FIRST`, at least. */
const UNITS = 30;
/** The long run: an hour of play after the demo starts, in five-minute windows. */
const WINDOW = 5 * MINUTE;
const WINDOWS = 12;

/**
 * Least share of the first two minutes each tagged machine spends working
 * (`Working`), by tag prefix: the drills feeding the furnaces, the iron
 * furnaces, the science machines and the labs run flat out; the machines
 * making intermediates wait between crafts; the copper furnaces make more
 * than the machines use, so some of them wait.
 */
const BUSY: readonly (readonly [prefix: string, share: number])[] = [
  ['iron-drill', 0.9],
  ['copper-drill', 0.9],
  ['coal-drill', 0.5],
  ['plant-coal-drill', 0.5],
  ['stone-drill', 0.9],
  ['iron-furnace', 0.9],
  ['copper-furnace', 0.3],
  ['boiler', 0.9],
  ['gears', 0.6],
  ['red-', 0.9],
  ['green-', 0.9],
  ['cable', 0.4],
  ['circuits', 0.3],
  ['inserters', 0.2],
  ['belts', 0.2],
  ['lab-', 0.9],
];

/**
 * Least share of every five-minute window of the long run the tagged
 * machines of each group spend working, by tag prefix (after the first
 * window, which `BUSY` covers), and how many of the group may work less: the
 * labs and the science machines never stop, and neither does anything
 * between the ore and them. The smelting is sized for the first minutes,
 * while the machines making intermediates fill their output slots (the
 * warm-up covers most of that); once those are full it makes more than the
 * machines use, so the last furnaces in line (one iron, two copper: the
 * copper plates of the east side join the bus after the west side's) and
 * the last drill on the iron belt wait for room, while the rest keep going.
 */
const BUSY_LONG: readonly (readonly [prefix: string, share: number, idle: number])[] = [
  ['lab-', 0.85, 0],
  ['red-', 0.9, 0],
  ['green-', 0.9, 0],
  ['gears', 0.5, 0],
  ['cable', 0.3, 0],
  ['circuits', 0.2, 0],
  ['inserters', 0.2, 0],
  ['belts', 0.1, 0],
  ['iron-furnace', 0.2, 1],
  ['copper-furnace', 0.2, 2],
  ['iron-drill', 0.2, 1],
  ['copper-drill', 0.2, 0],
  ['boiler', 0.9, 0],
];

/** Science packs on the science belts at any window's end, at most: they don't back up. */
const MOST_PACKS_ON_BELTS = 100;

interface Window {
  /** Working ticks by entity id. */
  working: Map<number, number>;
  minSatisfaction: number;
  /** Science packs on the science belts at the window's end. */
  packs: number;
}

interface Run {
  sim: Sim;
  /** The first `FIRST` ticks. */
  first: Window & { counts: ReturnType<ProductionCounter['read']>; units: number };
  /** The long run's windows, the first one included. */
  windows: Window[];
  /** The tick (since the demo started) each technology of the chain completed at. */
  completedAt: Map<number, number>;
}

const SCIENCE_BELTS: number[] = [ItemId.ExpressTransportBelt, ItemId.ExpressUndergroundBelt];

function packsOnBelts(sim: Sim): number {
  let packs = 0;
  for (const e of demoLayout()) {
    if (!SCIENCE_BELTS.includes(e.item)) continue;
    for (const { count } of sim.state.entities.contents(sim.state.entities.at(e.x, e.y))) {
      packs += count;
    }
  }
  return packs;
}

const unitsDone = (sim: Sim): number =>
  DEMO_RESEARCH_CHAIN.reduce((n, tech) => n + sim.state.research.unitsDone(DEFAULT_FORCE, tech), 0);

let cached: Run | null = null;
/**
 * The demo, built and run for an hour with its player picking the next
 * research as the worker does (once for every test that needs it).
 */
function run(): Run {
  if (cached) return cached;
  const sim = buildDemo();
  const ids = [...demoTagged(sim).values()].flat();
  const counter = new ProductionCounter(sim);
  const grid = powerGrid(sim.state.entities)!;
  const completedAt = new Map<number, number>();
  const windows: Window[] = [];
  const start = sim.tick;
  let first: Run['first'] | null = null;
  let window: Window = { working: new Map(), minSatisfaction: Infinity, packs: 0 };
  let firstWindow: Window = { working: new Map(), minSatisfaction: Infinity, packs: 0 };
  for (let t = 1; t <= WINDOWS * WINDOW; t++) {
    sim.step();
    continueDemoResearch(sim);
    if (t <= FIRST) counter.observe();
    for (const id of ids) {
      if (sim.state.entities.status(id) === MachineState.Working) {
        window.working.set(id, (window.working.get(id) ?? 0) + 1);
        if (t <= FIRST) firstWindow.working.set(id, (firstWindow.working.get(id) ?? 0) + 1);
      }
    }
    for (const net of grid.networkIds()) {
      const s = grid.network(net)!.satisfaction;
      window.minSatisfaction = Math.min(window.minSatisfaction, s);
      if (t <= FIRST) firstWindow.minSatisfaction = Math.min(firstWindow.minSatisfaction, s);
    }
    for (const tech of DEMO_RESEARCH_CHAIN) {
      if (!completedAt.has(tech) && sim.state.research.isResearched(DEFAULT_FORCE, tech)) {
        completedAt.set(tech, sim.tick - start);
      }
    }
    if (t === FIRST) {
      firstWindow.packs = packsOnBelts(sim);
      first = { ...firstWindow, counts: counter.read(), units: unitsDone(sim) };
      firstWindow = { working: new Map(), minSatisfaction: Infinity, packs: 0 };
    }
    if (t % WINDOW === 0) {
      window.packs = packsOnBelts(sim);
      windows.push(window);
      window = { working: new Map(), minSatisfaction: Infinity, packs: 0 };
    }
  }
  cached = { sim, first: first!, windows, completedAt };
  return cached;
}

const at = (x: number, y: number): string => `(${String(x)}, ${String(y)})`;

/** The tiles entity `e` of the layout covers. */
function footprint(e: DemoEntity): { x: number; y: number; w: number; h: number } {
  const proto = entityForItem(e.item) ?? ENTITIES[1];
  return { x: e.x, y: e.y, ...footprintSize(proto, e.dir) };
}

// The first test that needs it plays the hour (about 10 s).
describe('demo factory', { timeout: 60_000 }, () => {
  it('lays out every entity inside its bounds, without overlaps, with everything in the kit', () => {
    const layout = demoLayout();
    const taken = new Set<string>();
    for (const e of layout) {
      const f = footprint(e);
      for (let y = f.y; y < f.y + f.h; y++) {
        for (let x = f.x; x < f.x + f.w; x++) {
          expect(taken.has(at(x, y)), `overlap at ${at(x, y)}`).toBe(false);
          taken.add(at(x, y));
          expect(x >= DEMO_BOUNDS.x0 && x <= DEMO_BOUNDS.x1).toBe(true);
          expect(y >= DEMO_BOUNDS.y0 && y <= DEMO_BOUNDS.y1).toBe(true);
        }
      }
    }
    expect(taken.has(at(DEMO_SPAWN.x, DEMO_SPAWN.y))).toBe(false);
    const kit = new Map<number, number>();
    for (const { item, count } of demoKit(layout)) kit.set(item, (kit.get(item) ?? 0) + count);
    for (const e of layout) expect(kit.get(e.item) ?? 0).toBeGreaterThan(0);
  });

  it('pre-fills nothing but coal', () => {
    // Every plate, gear, circuit and pack is made from mined ore (D72); the
    // builder only gives the boilers and furnaces a little coal to start with.
    const fills = demoLayout().filter((e) => e.fill);
    expect(fills.length).toBeGreaterThan(0);
    for (const e of fills) {
      expect(e.fill!.item, `what ${e.tag ?? at(e.x, e.y)} starts with`).toBe(ItemId.Coal);
      expect(e.fill!.count).toBeLessThanOrEqual(10);
    }
  });

  it('wires its poles in straight lines that cross no machine', () => {
    // Every pair of poles within reach of each other is wired (polesConnect),
    // so where the poles stand decides the wires. On camera, a wire should run
    // north-south or east-west, never over a machine, and never double up
    // along another wire. A wire hangs about a tile above the ground (the
    // pole's height), so it shows over the row above its tiles: no machine
    // stands there along an east-west wire, nor right above a pole, whose top
    // would cover it. No exceptions.
    const layout = demoLayout();
    const pole = entityForItem(ItemId.SmallElectricPole)!;
    const machines = new Map<string, string>();
    for (const e of layout) {
      const f = footprint(e);
      if (f.w < 2 || f.h < 2) continue;
      for (let y = f.y; y < f.y + f.h; y++) {
        for (let x = f.x; x < f.x + f.w; x++) machines.set(at(x, y), e.tag ?? String(e.item));
      }
    }
    let wires = 0;
    for (const [ax, ay] of DEMO_POLES) {
      expect(machines.get(at(ax, ay - 1)), `a machine behind the pole at ${at(ax, ay)}`).toBe(
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
    expect(wires / 2).toBe(DEMO_POLES.length - 1);
  });

  it('powers every electric entity from one network', () => {
    const sim = buildDemo();
    const grid = powerGrid(sim.state.entities)!;
    expect(grid.networkCount).toBe(1);
    const pole = entityForItem(ItemId.SmallElectricPole)!;
    for (const e of demoLayout()) {
      const proto = entityForItem(e.item)!;
      if (proto.energySource !== 'electric') continue;
      const f = footprint(e);
      const covered = DEMO_POLES.some(([px, py]) => {
        const r = supplyRect(pole, px, py);
        return r.x0 < f.x + f.w && f.x <= r.x1 && r.y0 < f.y + f.h && f.y <= r.y1;
      });
      expect(covered, `${e.tag ?? proto.name} at ${at(e.x, e.y)} has a pole`).toBe(true);
      expect(grid.networkOf(sim.state.entities.at(e.x, e.y))).toBe(grid.networkIds()[0]);
    }
  });

  it('is built through commands the same way every time (same state hash)', () => {
    const a = buildDemo();
    const b = buildDemo();
    expect(hex(b.hash())).toBe(hex(a.hash()));
    stepTogether(a, b, 300);
    // Built, the player stands by the factory, which is researching automation 2 from 0.
    const { players, research, entities } = a.state;
    expect(Math.floor(players.x[0]! / 256)).toBe(DEMO_SPAWN.x);
    expect(Math.floor(players.y[0]! / 256)).toBe(DEMO_SPAWN.y);
    expect(research.currentOf(DEFAULT_FORCE)).toBe(DEMO_RESEARCH);
    expect(entities.count).toBe(demoLayout().length);
  });

  it('puts every drill on its ore', () => {
    const sim = buildDemo();
    const ore: Record<string, number> = {
      'iron-drill': ResourceId.IronOre,
      'copper-drill': ResourceId.CopperOre,
      'coal-drill': ResourceId.Coal,
      'plant-coal-drill': ResourceId.Coal,
      'stone-drill': ResourceId.Stone,
    };
    for (const [tag, ids] of demoTagged(sim)) {
      if (!(tag in ore)) continue;
      for (const id of ids) {
        const f = sim.state.entities.footprint(id);
        let tiles = 0;
        for (let y = f.y - 1; y <= f.y + 3; y++) {
          for (let x = f.x - 1; x <= f.x + 3; x++) {
            const r = sim.state.world.resourceAt(x, y);
            expect([ResourceId.None, ore[tag]]).toContain(r);
            if (r === ore[tag]) tiles++;
          }
        }
        expect(tiles, `${tag} ${String(id)}: ore tiles under it`).toBeGreaterThanOrEqual(10);
      }
    }
  });

  it('researches automation 2 from ore within two minutes, on enough power', () => {
    const { first, completedAt } = run();
    expect(TECHNOLOGIES[DEMO_RESEARCH].units).toBe(40);
    expect(completedAt.get(DEMO_RESEARCH)).toBeLessThanOrEqual(FIRST);
    expect(first.units).toBeGreaterThanOrEqual(UNITS);
    expect(first.minSatisfaction).toBe(1 << 16);
    const { mined, made, consumed } = first.counts;
    for (const ore of ['iron-ore', 'copper-ore', 'coal', 'stone']) {
      expect(mined[ore], ore).toBeGreaterThan(0);
    }
    for (const item of [
      'iron-plate',
      'copper-plate',
      'iron-gear-wheel',
      'copper-cable',
      'electronic-circuit',
      'electric-inserter',
      'transport-belt',
      'automation-science-pack',
      'logistic-science-pack',
    ]) {
      expect(made[item], item).toBeGreaterThan(0);
    }
    // Every unit of automation 2 took one red and one green pack; the
    // technologies after it may take red packs only.
    expect(consumed['automation-science-pack']).toBeGreaterThanOrEqual(UNITS);
    expect(consumed['logistic-science-pack']).toBeGreaterThanOrEqual(
      TECHNOLOGIES[DEMO_RESEARCH].units,
    );
    // The furnaces run on the mined coal: plates keep up with the ore they get.
    expect(made['iron-plate']).toBeGreaterThan(0.8 * mined['iron-ore']!);
  });

  it('goes on researching after automation 2, for an hour', () => {
    const { sim, completedAt } = run();
    const done = completedAt.get(DEMO_RESEARCH)!;
    // Each technology of the chain starts as the one before completes...
    const order = DEMO_RESEARCH_CHAIN.map((tech) => completedAt.get(tech) ?? Infinity);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // ...so the labs are still at it several minutes after automation 2,
    expect(completedAt.get(TechId.Logistics)).toBeLessThan(done + 5 * MINUTE);
    expect(completedAt.get(TechId.FastInserter)).toBeLessThan(done + 10 * MINUTE);
    // and an hour after the demo started, on the last technology of the tree.
    expect(completedAt.has(TechId.Logistics2)).toBe(true);
    expect(sim.state.research.currentOf(DEFAULT_FORCE)).toBe(TechId.Logistics3);
  });

  it('keeps the labs, the science and what feeds it busy for an hour, without backing up', () => {
    const { sim, windows } = run();
    expect(windows).toHaveLength(WINDOWS);
    const tagged = demoTagged(sim);
    windows.forEach((w, i) => {
      const when = `minutes ${String(5 * i)}-${String(5 * i + 5)}`;
      expect(w.minSatisfaction, `power, ${when}`).toBe(1 << 16);
      expect(w.packs, `packs on the science belts, ${when}`).toBeLessThanOrEqual(
        MOST_PACKS_ON_BELTS,
      );
      if (i === 0) return;
      for (const [prefix, least, idle] of BUSY_LONG) {
        const shares = [...tagged]
          .filter(([tag]) => tag.startsWith(prefix))
          .flatMap(([tag, ids]) =>
            ids.map((id) => `${tag} (${String(id)}) ${pct((w.working.get(id) ?? 0) / WINDOW)}`),
          );
        expect(shares.length, prefix).toBeGreaterThan(0);
        const below = [...tagged]
          .filter(([tag]) => tag.startsWith(prefix))
          .flatMap(([, ids]) => ids)
          .filter((id) => (w.working.get(id) ?? 0) / WINDOW < least);
        expect(
          below.length,
          `${prefix} below ${pct(least)}, ${when}: ${shares.join(', ')}`,
        ).toBeLessThanOrEqual(idle);
      }
    });
    // Stone: the drill fills a chest that an inserter empties into another;
    // after the hour (and the warm-up) there is room left.
    const stone = tagged
      .get('stone-chest')!
      .map((id) => sim.state.entities.contents(id).reduce((n, s) => n + s.count, 0));
    expect(stone.reduce((a, b) => a + b, 0)).toBeLessThan(2 * 32 * 50);
  });

  it('carries nothing but science packs to the labs', () => {
    const { sim } = run();
    const packs: number[] = [ItemId.AutomationSciencePack, ItemId.LogisticSciencePack];
    const science: number[] = [...SCIENCE_BELTS, ItemId.Splitter];
    let carried = 0;
    for (const e of demoLayout()) {
      if (!science.includes(e.item)) continue;
      for (const { item, count } of sim.state.entities.contents(sim.state.entities.at(e.x, e.y))) {
        expect(packs, `item ${String(item)} on the science belt at ${at(e.x, e.y)}`).toContain(
          item,
        );
        carried += count;
      }
    }
    expect(carried).toBeGreaterThan(0);
  });

  it('keeps every machine busy in the first two minutes', () => {
    const { sim, first } = run();
    for (const [tag, ids] of demoTagged(sim)) {
      if (tag.endsWith('chest') || tag.endsWith('splitter')) continue;
      const rule = BUSY.find(([prefix]) => tag.startsWith(prefix));
      expect(rule, `a busy rule for ${tag}`).toBeDefined();
      for (const id of ids) {
        const share = (first.working.get(id) ?? 0) / FIRST;
        expect(
          share,
          `${tag} (${String(id)}) works ${pct(share)} of the time`,
        ).toBeGreaterThanOrEqual(rule![1]);
      }
    }
  });

  it('saves and loads mid-run, then runs on identically', () => {
    const sim = buildDemo();
    for (let t = 0; t < 600; t++) sim.step();
    const copy = reload(sim);
    stepTogether(sim, copy, 600);
  });

  it('gives the player the starting kit on top of what the factory took', () => {
    const sim = buildDemo();
    const inventory = sim.state.players.inventory(0);
    expect(inventory.count(ItemId.TransportBelt)).toBeGreaterThanOrEqual(10);
    expect(inventory.count(ItemId.ElectricMiningDrill)).toBeGreaterThanOrEqual(2);
  });
});

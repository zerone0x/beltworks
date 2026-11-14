import { describe, expect, it } from 'vitest';
import { ENTITIES } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { ResourceId } from '../../src/data/resources';
import { TECHNOLOGIES } from '../../src/data/technologies';
import { MachineState } from '../../src/sim/entities/machine';
import { powerGrid } from '../../src/sim/power/grid';
import { DEFAULT_FORCE } from '../../src/sim/research/unlocks';
import {
  DEMO_BOUNDS,
  DEMO_RESEARCH,
  DEMO_SPAWN,
  buildDemo,
  demoKit,
  demoLayout,
  demoTagged,
} from '../../src/sim/scenarios/demo';
import { ProductionCounter } from '../../src/sim/scenarios/production';
import type { Sim } from '../../src/sim/tick';
import { reload, stepTogether } from './saveRoundTrip';

const hex = (h: number): string => `0x${h.toString(16).padStart(8, '0')}`;

/** The window the busy checks and counters cover: two minutes of play after the demo starts. */
const WINDOW = 2 * 60 * 60;
/** Research units of automation 2 (of 40) the labs finish within the window, at least. */
const UNITS = 15;

/**
 * Least share of the window each tagged machine spends working (`Working`),
 * by tag prefix: the furnaces, science machines and drills on ore that is
 * used up run flat out; machines making intermediates for a few consumers
 * wait between crafts; the labs take turns with the packs.
 */
const BUSY: readonly (readonly [prefix: string, share: number])[] = [
  ['iron-drill', 0.9],
  ['copper-drill', 0.3],
  ['coal-drill', 0.5],
  ['plant-coal-drill', 0.5],
  ['stone-drill', 0.9],
  ['iron-furnace', 0.9],
  ['copper-furnace', 0.9],
  ['boiler', 0.9],
  ['gears', 0.5],
  ['red-', 0.9],
  ['green-', 0.8],
  ['cable', 0.3],
  ['circuits', 0.2],
  ['inserters', 0.15],
  ['belts', 0.1],
  ['lab-', 0.4],
];

interface Run {
  sim: Sim;
  working: Map<number, number>;
  counts: ReturnType<ProductionCounter['read']>;
  minSatisfaction: number;
}

let cached: Run | null = null;
/** The demo, built and run for `WINDOW` ticks (once for every test that needs it). */
function run(): Run {
  if (cached) return cached;
  const sim = buildDemo();
  const ids = [...demoTagged(sim).values()].flat();
  const working = new Map<number, number>(ids.map((id) => [id, 0]));
  const counter = new ProductionCounter(sim);
  const grid = powerGrid(sim.state.entities)!;
  let minSatisfaction = Infinity;
  for (let t = 0; t < WINDOW; t++) {
    sim.step();
    counter.observe();
    for (const id of ids) {
      if (sim.state.entities.status(id) === MachineState.Working) {
        working.set(id, working.get(id)! + 1);
      }
    }
    for (const net of grid.networkIds()) {
      minSatisfaction = Math.min(minSatisfaction, grid.network(net)!.satisfaction);
    }
  }
  cached = { sim, working, counts: counter.read(), minSatisfaction };
  return cached;
}

describe('demo factory', () => {
  it('lays out every entity inside its bounds, without overlaps, with everything in the kit', () => {
    const layout = demoLayout();
    const taken = new Set<string>();
    for (const e of layout) {
      const proto = Object.values(ENTITIES).find((p) => p.item === e.item)!;
      const vertical = (e.dir & 1) === 0;
      const w = vertical ? proto.width : proto.height;
      const h = vertical ? proto.height : proto.width;
      for (let y = e.y; y < e.y + h; y++) {
        for (let x = e.x; x < e.x + w; x++) {
          expect(
            taken.has(`${String(x)},${String(y)}`),
            `overlap at (${String(x)}, ${String(y)})`,
          ).toBe(false);
          taken.add(`${String(x)},${String(y)}`);
          expect(x >= DEMO_BOUNDS.x0 && x <= DEMO_BOUNDS.x1).toBe(true);
          expect(y >= DEMO_BOUNDS.y0 && y <= DEMO_BOUNDS.y1).toBe(true);
        }
      }
    }
    expect(taken.has(`${String(DEMO_SPAWN.x)},${String(DEMO_SPAWN.y)}`)).toBe(false);
    const kit = new Map<number, number>();
    for (const { item, count } of demoKit(layout)) kit.set(item, (kit.get(item) ?? 0) + count);
    for (const e of layout) expect(kit.get(e.item) ?? 0).toBeGreaterThan(0);
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
    const { sim, counts, minSatisfaction } = run();
    expect(sim.state.research.unitsDone(DEFAULT_FORCE, DEMO_RESEARCH)).toBeGreaterThanOrEqual(
      UNITS,
    );
    expect(TECHNOLOGIES[DEMO_RESEARCH].units).toBe(40);
    expect(minSatisfaction).toBe(1 << 16);
    const { mined, made, consumed } = counts;
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
    // Every unit finished took one red and one green pack.
    expect(consumed['automation-science-pack']).toBeGreaterThanOrEqual(UNITS);
    expect(consumed['logistic-science-pack']).toBe(consumed['automation-science-pack']);
    // The furnaces run on the mined coal: plates keep up with the ore they get.
    expect(made['iron-plate']).toBeGreaterThan(0.8 * mined['iron-ore']!);
  });

  it('carries nothing but science packs to the labs', () => {
    const { sim } = run();
    const packs: number[] = [ItemId.AutomationSciencePack, ItemId.LogisticSciencePack];
    const science: number[] = [
      ItemId.ExpressTransportBelt,
      ItemId.ExpressUndergroundBelt,
      ItemId.Splitter,
    ];
    let carried = 0;
    for (const e of demoLayout()) {
      if (!science.includes(e.item)) continue;
      for (const { item, count } of sim.state.entities.contents(sim.state.entities.at(e.x, e.y))) {
        expect(
          packs,
          `item ${String(item)} on the science belt at (${String(e.x)}, ${String(e.y)})`,
        ).toContain(item);
        carried += count;
      }
    }
    expect(carried).toBeGreaterThan(0);
  });

  it('keeps every machine busy', () => {
    const { sim, working } = run();
    for (const [tag, ids] of demoTagged(sim)) {
      if (tag.endsWith('chest') || tag.endsWith('splitter')) continue;
      const rule = BUSY.find(([prefix]) => tag.startsWith(prefix));
      expect(rule, `a busy rule for ${tag}`).toBeDefined();
      for (const id of ids) {
        const share = working.get(id)! / WINDOW;
        expect(
          share,
          `${tag} (${String(id)}) works ${(100 * share).toFixed(0)}% of the time`,
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

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ItemId } from '../../src/data/items';
import { emptyActivity } from '../../src/sim/activity';
import { Direction } from '../../src/sim/entities/direction';
import { Sim } from '../../src/sim/tick';
import { Builder } from '../../tools/bench/builder';
import { measureScene, percentile, tickStats, type SceneResult } from '../../tools/bench/measure';
import {
  compareReports,
  comparisonMarkdown,
  reportMarkdown,
  type BenchReport,
} from '../../tools/bench/report';
import {
  FACTORY_1K_ENTITIES,
  factory1k,
  factory1kLayout,
  FACTORY_1K_BUILDERS,
} from '../../tools/bench/scenes/factory1k';
import { SCENES } from '../../tools/bench/scenes/index';
import { POWER_DISTRICTS, power, powerLayout } from '../../tools/bench/scenes/power';
import { powerGrid } from '../../src/sim/power/grid';

describe('tick statistics', () => {
  it('uses nearest-rank percentiles', () => {
    const sorted = Float64Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(sorted, 0.5)).toBe(50);
    expect(percentile(sorted, 0.99)).toBe(99);
    expect(percentile(sorted, 1)).toBe(100);
    expect(percentile([7], 0.99)).toBe(7);
    expect(percentile([], 0.5)).toBe(0);
  });

  it('summarizes unsorted durations', () => {
    const stats = tickStats([4, 1, 3, 2]);
    expect(stats).toEqual({ meanMs: 2.5, p50Ms: 2, p99Ms: 4, maxMs: 4, ticksPerSecond: 400 });
  });
});

function scene(name: string, meanMs: number, hash = '0x00000001'): SceneResult {
  return {
    name,
    description: '',
    entities: 1000,
    entityCounts: {},
    beltItems: 0,
    setupTicks: 0,
    warmupTicks: 600,
    measuredTicks: 3600,
    warmupRuns: 3,
    targetMeanMs: 1,
    meanMs,
    p50Ms: meanMs,
    p99Ms: 2 * meanMs,
    maxMs: 3 * meanMs,
    ticksPerSecond: 1000 / meanMs,
    runs: [],
    activity: { machineStates: {}, activeBeltLanes: 0, powerSatisfaction: [] },
    hash,
  };
}

function report(...scenes: SceneResult[]): BenchReport {
  return {
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    environment: { node: 'v22', platform: 'linux', arch: 'x64', cpu: 'test', cpus: 1 },
    scenes,
  };
}

describe('baseline comparison', () => {
  it('flags a mean tick time more than 20% over the baseline', () => {
    const baseline = report(scene('a', 1), scene('b', 1), scene('c', 1));
    const current = report(scene('a', 1.19), scene('b', 1.21), scene('c', 0.5), scene('new', 1));
    const comparison = compareReports(baseline, current);
    expect(comparison.regressions.map((s) => s.name)).toEqual(['b']);
    expect(comparison.scenes.find((s) => s.name === 'a')?.meanChange).toBeCloseTo(0.19);
    expect(comparison.scenes.find((s) => s.name === 'new')?.baseline).toBeUndefined();
    const md = comparisonMarkdown(comparison);
    expect(md).toContain('**regressed**');
    expect(md).toContain('no baseline');
    expect(md).toContain('[!WARNING]');
  });

  it('notes a different CPU than the baseline', () => {
    const other = {
      ...report(scene('a', 1)),
      environment: { ...report().environment, cpu: 'other' },
    };
    const comparison = compareReports(other, report(scene('a', 1)));
    expect(comparison.baselineCpu).toBe('other');
    expect(comparisonMarkdown(comparison)).toContain('differs from the baseline');
    expect(
      compareReports(report(scene('a', 1)), report(scene('a', 1))).baselineCpu,
    ).toBeUndefined();
  });

  it('honours a custom threshold', () => {
    const comparison = compareReports(report(scene('a', 1)), report(scene('a', 1.1)), 0.05);
    expect(comparison.regressions).toHaveLength(1);
  });

  it('notes when the scene ends in a different state', () => {
    const comparison = compareReports(
      report(scene('a', 1, '0x00000001')),
      report(scene('a', 1, '0x00000002')),
    );
    expect(comparison.regressions).toHaveLength(0);
    expect(comparison.scenes[0]?.stateChanged).toBe(true);
    expect(comparisonMarkdown(comparison)).toContain('update `tools/bench/baseline.json`');
  });

  it('renders the report as a Markdown table', () => {
    const md = reportMarkdown(report(scene('a', 0.5), scene('b', 2)));
    expect(md).toContain(
      '| a | 1000 | 0 | 0.5000 | 0.5000 | 1.0000 | 1.5000 | 2,000 | < 1 ms met |',
    );
    expect(md).toContain('< 1 ms **missed**');
    expect(md).toContain('600 warm-up + 3600 measured ticks per run');
  });

  it('has a committed baseline for every scene', () => {
    // The scenes CI runs on every PR, and the heavy ones it runs nightly.
    const names = (file: string): string[] =>
      (
        JSON.parse(
          readFileSync(new URL(`../../tools/bench/${file}`, import.meta.url), 'utf8'),
        ) as BenchReport
      ).scenes
        .map((s) => s.name)
        .sort();
    expect(names('baseline.json')).toEqual(
      SCENES.filter((s) => !s.heavy)
        .map((s) => s.name)
        .sort(),
    );
    expect(names('baseline-nightly.json')).toEqual(
      SCENES.filter((s) => s.heavy)
        .map((s) => s.name)
        .sort(),
    );
  });

  it('lists each scene’s run settings when they differ, with work and profiles', () => {
    const a = scene('a', 1);
    const b = {
      ...scene('b', 1),
      warmupTicks: 1200,
      work: { before: { beltItems: 10 }, after: { beltItems: 12 } },
      profile: {
        ticks: 10,
        meanMs: 1,
        stages: [{ name: 'belts', system: 'belts', meanMs: 0.75, share: 0.75 }],
      },
    };
    const md = reportMarkdown(report(a, b));
    expect(md).toContain('- `b`: 1200 warm-up + 3600 measured ticks per run');
    expect(md).toContain('- `b`: beltItems 10 → 12');
    expect(md).toContain('| belts | 0.7500 (75.0%) |');
  });

  it('lists the active entities per system, where the scenes counted them', () => {
    const systems = emptyActivity();
    systems.inserters = { entities: 1200, awake: 40.5, stepped: 460.2 };
    const a = { ...scene('a', 1), activity: { ...scene('a', 1).activity, systems } };
    const md = reportMarkdown(report(a, scene('old', 1)));
    expect(md).toContain('| System | a |');
    expect(md).toContain('| inserters | 1,200 / 40.5 / 460.2 |');
    expect(md).toContain('| power | 0 / 0 / 0 |');
    expect(reportMarkdown(report(scene('old', 1)))).not.toContain('Active entities per system');
  });
});

describe('builder', () => {
  it('walks the player to a tile center with Move commands', () => {
    const sim = new Sim({ seed: 1 });
    const builder = new Builder(sim);
    builder.walkTo(5, -3);
    const { x, y } = builder.position;
    expect(Math.abs(x - (5 * 256 + 128))).toBeLessThan(38);
    expect(Math.abs(y - (-3 * 256 + 128))).toBeLessThan(38);
    const at = sim.tick;
    sim.step();
    expect(builder.position).toEqual({ x, y });
    expect(at).toBeGreaterThan(0);
  });

  it('throws when a command is ignored', () => {
    const sim = new Sim({ seed: 1 });
    const builder = new Builder(sim);
    // Out of build reach.
    expect(() =>
      builder.place([{ item: ItemId.WoodenChest, x: 30, y: 0, dir: Direction.North }]),
    ).toThrow(/ignored/);
    const [chest] = builder.place([{ item: ItemId.WoodenChest, x: 2, y: 0, dir: Direction.North }]);
    // The starting kit has 10 coal.
    expect(() => builder.insert([{ entity: chest!, item: ItemId.Coal, count: 11 }])).toThrow(
      /too few/,
    );
  });
});

describe('1k scene', () => {
  it('builds exactly 1 000 entities through commands', () => {
    const built = factory1k.build();
    expect(built.sim.state.entities.count).toBe(FACTORY_1K_ENTITIES);
    expect(built.entityCounts).toEqual({
      'wooden-chest': 160,
      'burner-inserter': 264,
      'stone-furnace': 48,
      'transport-belt': 480,
      'burner-mining-drill': 48,
    });
    // Two coal on every second loop belt.
    expect(built.beltItems).toBe(18 * 24);
    // Every builder used what it carried for its own share; the kit is sized
    // for the busiest one, so the others only have leftovers.
    expect(built.sim.state.players.count).toBe(FACTORY_1K_BUILDERS);
  });

  it('is deterministic', () => {
    const a = factory1k.build();
    const b = factory1k.build();
    expect(a.setupTicks).toBe(b.setupTicks);
    expect(a.sim.hash()).toBe(b.sim.hash());
  });

  it('lays out the belt blocks clear of the smelting grids and the spawn', () => {
    const { patches, blocks } = factory1kLayout();
    expect(patches).toHaveLength(4);
    expect(blocks).toHaveLength(18);
    expect(blocks.reduce((n, b) => n + b.units, 0)).toBe(56);
    const apart = (b: { x: number; y: number }, x0: number, y0: number, x1: number, y1: number) =>
      b.x > x1 || b.x + 12 < x0 || b.y > y1 || b.y + 4 < y0;
    for (const b of blocks) {
      expect(apart(b, -2, -2, 1, 1)).toBe(true);
      for (const p of patches) {
        expect(apart(b, p.x - 9, p.y - 8, p.x + 8, p.y + 7)).toBe(true);
      }
    }
  });

  it('keeps its drills, furnaces, inserters and belts busy', () => {
    const result = measureScene(factory1k, {
      warmupTicks: 60,
      measuredTicks: 60,
      runs: 3,
      warmupRuns: 1,
    });
    expect(result.entities).toBe(FACTORY_1K_ENTITIES);
    expect(result.measuredTicks).toBe(60);
    expect(result.warmupRuns).toBe(1);
    // The reported run is the one with the median mean.
    expect(result.runs).toHaveLength(3);
    expect(result.runs.map((r) => r.meanMs).sort((a, b) => a - b)[1]).toBe(result.meanMs);
    const { machineStates, activeBeltLanes } = result.activity;
    expect(machineStates['burner-mining-drill']?.Working).toBeGreaterThanOrEqual(40);
    expect(machineStates['stone-furnace']?.Working).toBeGreaterThan(0);
    expect(machineStates['burner-inserter']?.Working).toBeGreaterThanOrEqual(100);
    // Every loop keeps at least one lane moving.
    expect(activeBeltLanes).toBeGreaterThanOrEqual(18);
    expect(result.meanMs).toBeGreaterThan(0);
    expect(result.hash).toMatch(/^0x[0-9a-f]{8}$/);
  });

  // The end state `npm run bench -- 1k` reports (and tools/bench/baseline.json
  // records), pinned so that a change to what the belts do, such as a lane
  // notification wrongly dropped as a duplicate (#73), fails the tests and
  // not only the bench job. About a second on its own.
  it('ends a default bench run in the recorded state', () => {
    const result = measureScene(factory1k, { runs: 1, warmupRuns: 0 });
    expect(result.warmupTicks + result.measuredTicks).toBe(600 + 3600);
    expect(result.hash).toBe('0x29b9bf06');
  }, 30_000);
});

describe('power scene', () => {
  it('builds four districts, each its own network, through commands', () => {
    const built = power.build();
    const { entities } = built.sim.state;
    expect(built.entityCounts).toEqual({
      'wooden-chest': 406,
      'electric-inserter': 383,
      'small-electric-pole': 131,
      'steam-engine': 10,
      boiler: 6,
      'electric-mining-drill': 23,
    });
    expect(entities.count).toBe(959);
    expect(built.sim.state.players.count).toBe(POWER_DISTRICTS);
    const grid = powerGrid(entities)!;
    expect(grid.networkCount).toBe(POWER_DISTRICTS);
    // Every electric entity is on one of them.
    expect(grid.networkIds().reduce((n, net) => n + grid.membersOf(net).length, 0)).toBe(
      grid.memberCount,
    );
    const districts = powerLayout();
    expect(districts.map((d) => d.plants)).toEqual([1, 2, 1, 2]);
    expect(districts.every((d) => d.blocks.some((b) => b.kind === 'drill'))).toBe(true);
  });

  it('is deterministic', () => {
    const a = power.build();
    const b = power.build();
    expect(a.setupTicks).toBe(b.setupTicks);
    expect(a.sim.hash()).toBe(b.sim.hash());
  });

  it('keeps its drills and inserters busy, two networks overloaded', () => {
    const result = measureScene(power, {
      warmupTicks: 60,
      measuredTicks: 60,
      runs: 1,
      warmupRuns: 0,
    });
    const { machineStates, powerSatisfaction } = result.activity;
    expect(machineStates['electric-mining-drill']?.Working).toBe(23);
    expect(machineStates['electric-inserter']?.Working).toBeGreaterThanOrEqual(350);
    expect(machineStates['steam-engine']?.Working).toBe(10);
    expect(powerSatisfaction).toHaveLength(4);
    expect(powerSatisfaction.filter((s) => s === 100)).toHaveLength(2);
    expect(powerSatisfaction.filter((s) => s < 60)).toHaveLength(2);
    // Per-system counters (#73): every electric entity (but the poles) is on
    // a network; the working inserters and drills are stepped every tick.
    const systems = result.activity.systems!;
    expect(systems.power.entities).toBe(383 + 23 + 10);
    expect(systems.drills).toEqual({ entities: 23, awake: 23, stepped: 23 });
    expect(systems.inserters.entities).toBe(383);
    expect(systems.inserters.stepped).toBeGreaterThanOrEqual(350);
    expect(systems.belts).toEqual({ entities: 0, awake: 0, stepped: 0 });
  });
});

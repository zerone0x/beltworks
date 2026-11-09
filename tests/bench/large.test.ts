import { describe, expect, it } from 'vitest';
import { ItemId } from '../../src/data/items';
import { Direction } from '../../src/sim/entities/direction';
import { Sim } from '../../src/sim/tick';
import { CrewMember, Router, runCrew, type Task } from '../../tools/bench/crew';
import { measureScene } from '../../tools/bench/measure';
import {
  checkSystems,
  profiledStep,
  profileResult,
  STAGES,
  SystemProfile,
} from '../../tools/bench/profile';
import {
  BLOCK_H,
  BLOCK_W,
  FACTORY_10K,
  FACTORY_50K,
  countBeltItems,
  factory10k,
  largeKit,
  largeLayout,
} from '../../tools/bench/scenes/factory';
import { factory1k } from '../../tools/bench/scenes/factory1k';
import { SCENES } from '../../tools/bench/scenes/index';

describe('profiler', () => {
  it('knows every system of the tick', () => {
    expect(() => checkSystems()).not.toThrow();
  });

  it('runs ticks exactly like Sim.step', () => {
    const a = factory1k.build().sim;
    const b = factory1k.build().sim;
    const profile = new SystemProfile();
    for (let i = 0; i < 300; i++) {
      a.step();
      profiledStep(b, profile);
    }
    expect(b.tick).toBe(a.tick);
    expect(b.hash()).toBe(a.hash());
    const result = profileResult(profile);
    expect(result.ticks).toBe(300);
    expect(result.stages.map((s) => s.name)).toEqual(STAGES.map((s) => s.name));
    expect(result.stages.reduce((n, s) => n + s.share, 0)).toBeCloseTo(1);
  });

  it('refuses ticks with queued commands', () => {
    const sim = new Sim({ seed: 1 });
    sim.enqueue({ type: 'Move', playerId: 0, dx: 1, dy: 0, tick: 0 });
    expect(() => profiledStep(sim, new SystemProfile())).toThrow(/commands are queued/);
  });
});

describe('crew', () => {
  it('builds with several players in the same ticks', () => {
    const sim = new Sim({ seed: 1, players: 2 });
    const a = new CrewMember(sim, 0);
    const b = new CrewMember(sim, 1);
    const placed: number[][] = [];
    function* task(member: CrewMember, x: number): Task {
      yield* member.walk([{ x, y: 0 }]);
      placed.push(
        yield* member.place([{ item: ItemId.WoodenChest, x, y: 2, dir: Direction.North }]),
      );
    }
    runCrew(sim, [task(a, 3), task(b, -3)]);
    expect(placed).toHaveLength(2);
    expect(sim.state.entities.count).toBe(2);
  });

  it('routes around water', () => {
    // A fake world: a wall of water at x = 2 with a gap at y = 5.
    const world = {
      isWalkable: (x: number, y: number) => x !== 2 || y === 5,
    } as unknown as ConstructorParameters<typeof Router>[0];
    const router = new Router(world, { x: 0, y: 0 }, -10, -10, 10, 10);
    const path = router.route({ x: 4, y: 0 })!;
    expect(path.at(-1)).toEqual({ x: 4, y: 0 });
    // Every leg is along one axis and crosses the wall at the gap only.
    let at = { x: 0, y: 0 };
    for (const p of path) {
      expect(p.x === at.x || p.y === at.y).toBe(true);
      if (p.y === at.y && Math.min(p.x, at.x) <= 2 && Math.max(p.x, at.x) >= 2) {
        expect(p.y).toBe(5);
      }
      at = p;
    }
  });
});

describe('large scenes', () => {
  it('are heavy and only run when asked for', () => {
    expect(SCENES.filter((s) => s.heavy).map((s) => s.name)).toEqual(['10k', '50k']);
  });

  it.each([
    [FACTORY_10K, 10_000],
    [FACTORY_50K, 50_000],
  ])('lay out about $1 entities in clear blocks', (config, target) => {
    const layout = largeLayout(config);
    expect(Math.abs(layout.entities - target)).toBeLessThanOrEqual(target / 50);
    const kinds = new Set(layout.blocks.map((b) => b.kind));
    expect([...kinds].sort()).toEqual(['A', 'B', 'L', 'M']);
    expect(layout.blocks.filter((b) => b.kind === 'L')).toHaveLength(config.labBlocks);
    expect(new Set(layout.blocks.map((b) => b.tier))).toEqual(new Set([0, 1, 2]));
    // Blocks sit on the lattice, one per cell.
    const cells = new Set(layout.blocks.map((b) => `${String(b.i)},${String(b.j)}`));
    expect(cells.size).toBe(layout.blocks.length);
    for (const b of layout.blocks) {
      expect(b.x).toBe(-8 + b.i * BLOCK_W);
      expect(b.y).toBe(-7 + b.j * BLOCK_H);
    }
    // One player per block, with a kit that fits a 40-slot inventory.
    expect(largeKit(layout).length).toBeGreaterThan(10);
  });

  it('builds the 10k scene through commands, with every belt tier, splitter and inserter type', () => {
    const built = factory10k.build();
    const { entityCounts, sim } = built;
    for (const name of [
      'transport-belt',
      'fast-transport-belt',
      'express-transport-belt',
      'underground-belt',
      'splitter',
      'fast-splitter',
      'express-splitter',
      'fast-underground-belt',
      'express-underground-belt',
      'burner-inserter',
      'electric-inserter',
      'fast-inserter',
      'long-handed-inserter',
      'burner-mining-drill',
      'electric-mining-drill',
      'stone-furnace',
      'assembling-machine-1',
      'assembling-machine-2',
      'lab',
      'boiler',
      'steam-engine',
      'small-electric-pole',
      'wooden-chest',
      'iron-chest',
    ]) {
      expect(entityCounts[name], name).toBeGreaterThan(0);
    }
    const total = Object.values(entityCounts).reduce((a, b) => a + b, 0);
    expect(sim.state.entities.count).toBe(total);
    expect(countBeltItems(sim)).toBeGreaterThan(48_000);
  }, 120_000);

  it('keeps the 10k scene working: machines, labs, ~50k items on belts', () => {
    // assertWork (factory.ts) throws unless the measured ticks made things,
    // finished research units and kept the belt items up; the profiled run
    // must end in the same state.
    const result = measureScene(factory10k, {
      warmupTicks: 600,
      measuredTicks: 1_800,
      runs: 1,
      warmupRuns: 0,
      profile: true,
    });
    const { work, activity, profile } = result;
    expect(work!.after.madeItems).toBeGreaterThan(work!.before.madeItems!);
    expect(work!.after.researchUnits).toBeGreaterThan(0);
    expect(work!.after.beltItems).toBeGreaterThanOrEqual(FACTORY_10K.minBeltItems);
    expect(activity.machineStates['assembling-machine-1']?.Working).toBeGreaterThan(0);
    expect(activity.activeBeltLanes).toBeGreaterThan(100);
    expect(activity.powerSatisfaction.every((s) => s === 100)).toBe(true);
    // Idle entities cost nothing (#73): most inserters wait asleep (some are
    // woken each tick by items moving past and look again), the power system
    // asks only producers and awake consumers, and the belts step the lanes
    // of the moving loops.
    const systems = activity.systems!;
    expect(systems.inserters.awake).toBeLessThan(systems.inserters.entities / 10);
    expect(systems.inserters.stepped).toBeLessThan(systems.inserters.entities);
    expect(systems.power.stepped).toBeLessThan(systems.power.entities / 2);
    expect(systems.belts.stepped).toBeGreaterThan(100);
    expect(systems.assemblers.stepped).toBeGreaterThan(0);
    expect(profile!.ticks).toBe(1_800);
    expect(profile!.stages.find((s) => s.name === 'belts')!.meanMs).toBeGreaterThan(0);
  }, 300_000);
});

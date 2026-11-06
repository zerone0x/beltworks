/**
 * Times a scene tick by tick. One run builds the scene from scratch, runs
 * `warmupTicks` untimed ticks (so the JIT settles and the scene reaches a
 * steady state), then times `measuredTicks` ticks one by one with
 * `performance.now()`.
 *
 * A 1k-entity tick takes microseconds, so a single run is at the mercy of one
 * GC pause or scheduler hiccup (run-to-run spread of ±25% was seen locally).
 * The scene is therefore run `runs` times (default `RUNS`), and the reported
 * statistics are those of the run with the median mean; every run's numbers
 * are kept in `runs` of the result.
 *
 * Before those, `warmupRuns` (default `WARMUP_RUNS`) whole runs are thrown
 * away: on a 2-core CI runner V8 keeps optimizing the simulation for the
 * first few runs (the first run measured up to 4× slower than the fifth), and
 * 600 warm-up ticks of a microsecond-scale scene are too short for that.
 */

import { beltTable } from '../../src/sim/belts/belts';
import { SAT_ONE } from '../../src/data/entities';
import { MachineState } from '../../src/sim/entities/machine';
import { powerGrid } from '../../src/sim/power/grid';
import type { Sim } from '../../src/sim/tick';
import type { BenchScene, BuiltScene } from './scene';

export const WARMUP_TICKS = 600;
export const MEASURED_TICKS = 3_600;
/** Independent runs per scene; the median one is reported. */
export const RUNS = 5;
/** Untimed runs per scene before the measured ones (JIT warm-up). */
export const WARMUP_RUNS = 3;

export interface TickStats {
  meanMs: number;
  p50Ms: number;
  p99Ms: number;
  maxMs: number;
  ticksPerSecond: number;
}

export interface SceneResult extends TickStats {
  name: string;
  description: string;
  entities: number;
  entityCounts: Record<string, number>;
  beltItems: number;
  setupTicks: number;
  warmupTicks: number;
  measuredTicks: number;
  /** Untimed whole runs before the measured ones. */
  warmupRuns: number;
  targetMeanMs: number;
  /** Every run's statistics, in run order (the reported ones are the median run's). */
  runs: TickStats[];
  /**
   * What the scene was doing after the last measured tick: entities per
   * prototype and machine state, and belt lanes on the active list. A scene
   * that went to sleep is cheap for the wrong reason; this makes it visible.
   */
  activity: SceneActivity;
  /** State hash after the last measured tick (hex), the same for every run: identifies the scene. */
  hash: string;
}

export interface SceneActivity {
  /** E.g. `{ 'burner-mining-drill': { Working: 45, Depleted: 3 } }`. */
  machineStates: Record<string, Record<string, number>>;
  activeBeltLanes: number;
  /**
   * Satisfaction of every electric network, in percent rounded down, in
   * network id order (empty without poles): overloaded networks run their
   * machines slower.
   */
  powerSatisfaction: number[];
}

const STATE_NAMES = new Map<number, string>(
  Object.entries(MachineState).map(([name, value]) => [value, name]),
);

/** Reads the scene's activity (see {@link SceneActivity}). Entity ids are never reused, so it scans ids upwards. */
export function sceneActivity(sim: Sim): SceneActivity {
  const { entities } = sim.state;
  const machineStates: Record<string, Record<string, number>> = {};
  for (let id = 1, found = 0; found < entities.count; id++) {
    const proto = entities.prototypeOf(id);
    if (!proto) continue;
    found++;
    const state = STATE_NAMES.get(entities.status(id)) ?? 'Unknown';
    const byState = (machineStates[proto.name] ??= {});
    byState[state] = (byState[state] ?? 0) + 1;
  }
  const grid = powerGrid(entities);
  const powerSatisfaction = (grid?.networkIds() ?? [])
    .sort((a, b) => a - b)
    .map((net) => Math.floor(((grid!.network(net)?.satisfaction ?? 0) * 100) / SAT_ONE));
  return {
    machineStates,
    activeBeltLanes: beltTable(entities)?.activeLanes ?? 0,
    powerSatisfaction,
  };
}

/** Nearest-rank percentile `q` (in (0, 1]) of `sorted`, which must be sorted ascending. */
export function percentile(sorted: ArrayLike<number>, q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length)));
  return sorted[rank - 1]!;
}

/** Summary statistics of per-tick durations in ms. */
export function tickStats(durations: ArrayLike<number>): TickStats {
  const sorted = Float64Array.from(durations).sort();
  let sum = 0;
  for (const d of sorted) sum += d;
  const meanMs = sorted.length === 0 ? 0 : sum / sorted.length;
  return {
    meanMs,
    p50Ms: percentile(sorted, 0.5),
    p99Ms: percentile(sorted, 0.99),
    maxMs: sorted.length === 0 ? 0 : sorted[sorted.length - 1]!,
    ticksPerSecond: meanMs > 0 ? 1000 / meanMs : 0,
  };
}

export interface MeasureOptions {
  warmupTicks?: number;
  measuredTicks?: number;
  runs?: number;
  warmupRuns?: number;
}

/** One run: build, warm up, time every measured tick. */
function runOnce(
  scene: BenchScene,
  warmupTicks: number,
  measuredTicks: number,
): { built: BuiltScene; stats: TickStats; activity: SceneActivity; hash: string } {
  const built = scene.build();
  const { sim } = built;
  for (let i = 0; i < warmupTicks; i++) sim.step();
  // Start the measured window with a clean heap where the runtime allows it
  // (`node --expose-gc`, as `npm run bench` does).
  (globalThis as { gc?: () => void }).gc?.();
  const durations = new Float64Array(measuredTicks);
  for (let i = 0; i < measuredTicks; i++) {
    const start = performance.now();
    sim.step();
    durations[i] = performance.now() - start;
  }
  return {
    built,
    stats: tickStats(durations),
    activity: sceneActivity(sim),
    hash: `0x${sim.hash().toString(16).padStart(8, '0')}`,
  };
}

/** Runs `scene` `runs` times and reports the run with the median mean tick time. */
export function measureScene(scene: BenchScene, options: MeasureOptions = {}): SceneResult {
  const warmupTicks = options.warmupTicks ?? WARMUP_TICKS;
  const measuredTicks = options.measuredTicks ?? MEASURED_TICKS;
  const count = options.runs ?? RUNS;
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError(`runs must be a positive integer, got ${String(count)}`);
  }
  const warmupRuns = options.warmupRuns ?? WARMUP_RUNS;
  for (let i = 0; i < warmupRuns; i++) runOnce(scene, warmupTicks, measuredTicks);
  const runs = Array.from({ length: count }, () => runOnce(scene, warmupTicks, measuredTicks));
  const hashes = new Set(runs.map((r) => r.hash));
  if (hashes.size !== 1) {
    throw new Error(
      `scene ${scene.name} is not deterministic: runs ended in ${[...hashes].join(', ')}`,
    );
  }
  const median = runs.slice().sort((a, b) => a.stats.meanMs - b.stats.meanMs)[(count - 1) >> 1]!;
  const { built } = median;
  return {
    name: scene.name,
    description: scene.description,
    entities: built.sim.state.entities.count,
    entityCounts: { ...built.entityCounts },
    beltItems: built.beltItems,
    setupTicks: built.setupTicks,
    warmupTicks,
    measuredTicks,
    warmupRuns,
    targetMeanMs: scene.targetMeanMs,
    ...median.stats,
    runs: runs.map((r) => r.stats),
    activity: median.activity,
    hash: median.hash,
  };
}

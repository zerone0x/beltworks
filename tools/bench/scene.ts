/**
 * Benchmark scenes: fixed, deterministic set-ups that the runner (run.ts)
 * times tick by tick. See docs/TOOLING.md ("Benchmarks") for how to add one.
 */

import type { Sim } from '../../src/sim/tick';

/** A scene, ready to be ticked. */
export interface BuiltScene {
  /** The simulation right after the scene was built (the builder has stopped). */
  readonly sim: Sim;
  /** Ticks it took to build the scene (walking, placing, fuelling). */
  readonly setupTicks: number;
  /** Placed entities per prototype name, e.g. `{ 'transport-belt': 720 }`. */
  readonly entityCounts: Readonly<Record<string, number>>;
  /** Items put onto belts while building. */
  readonly beltItems: number;
}

/** Counters a scene reads to show the measured ticks did real work (see `BenchScene.probe`). */
export type WorkCounters = Record<string, number>;

/** Run settings a scene can default to (command-line options override them). */
export interface SceneDefaults {
  warmupTicks?: number;
  measuredTicks?: number;
  runs?: number;
  warmupRuns?: number;
}

export interface BenchScene {
  /** Short id used on the command line, in reports and in the baseline (e.g. `1k`). */
  readonly name: string;
  /** One line on what the scene contains. */
  readonly description: string;
  /** Mean tick time the scene must stay under, in ms (docs/ARCHITECTURE.md, "Performance targets"). */
  readonly targetMeanMs: number;
  /** Builds the scene from a fresh simulation, through commands only (see builder.ts). */
  build(): BuiltScene;
  /**
   * Slow scenes (minutes per run) only run when asked for by name: not in a
   * plain `npm run bench`, and in CI nightly instead of on every PR.
   */
  readonly heavy?: boolean;
  /** Run settings for this scene where they differ from the global defaults (measure.ts). */
  readonly defaults?: SceneDefaults;
  /**
   * Reads counters (items on belts, items made, research units) after the
   * warm-up and after the measured ticks; both sets go into the report.
   */
  probe?(sim: Sim): WorkCounters;
  /** Throws unless the measured ticks did real work, given `probe` before and after them. */
  assertWork?(before: WorkCounters, after: WorkCounters, sim: Sim): void;
}

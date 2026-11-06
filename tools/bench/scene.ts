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

export interface BenchScene {
  /** Short id used on the command line, in reports and in the baseline (e.g. `1k`). */
  readonly name: string;
  /** One line on what the scene contains. */
  readonly description: string;
  /** Mean tick time the scene must stay under, in ms (docs/ARCHITECTURE.md, "Performance targets"). */
  readonly targetMeanMs: number;
  /** Builds the scene from a fresh simulation, through commands only (see builder.ts). */
  build(): BuiltScene;
}

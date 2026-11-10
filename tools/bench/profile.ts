/**
 * Per-system tick timings, for the benchmark only: `profiledStep` advances
 * the simulation by one tick exactly like `Sim.step()` (src/sim/tick.ts),
 * but runs the systems itself, one stage at a time, and adds each stage's
 * duration to a `SystemProfile`. The game never runs this code, so profiling
 * costs it nothing.
 *
 * Most stages are the systems of `SYSTEMS` as they are. Three are split
 * finer so the breakdown separates what the M4 work looks at: drills into
 * burner and electric drills, machines into furnaces, assembling machines
 * and labs, players into movement/hand-mining and hand-crafting. Those
 * stages repeat the calls of their system in the same order; the tests
 * (tests/bench) check that profiled ticks end in the same state hash as
 * `Sim.step()` and that `SYSTEMS` still has the systems this file expects,
 * so a change to the tick order fails there instead of skewing profiles.
 */

import { updateCrafting } from '../../src/sim/crafting/queue';
import { ASSEMBLER_TYPES, assemblerTable } from '../../src/sim/entities/assembler';
import { drillTable } from '../../src/sim/entities/drill';
import { electricDrillTable } from '../../src/sim/entities/electricDrill';
import { furnaceTable } from '../../src/sim/entities/furnace';
import { updatePlayers } from '../../src/sim/player';
import { labTable } from '../../src/sim/research/lab';
import { SYSTEMS, type Sim, type System } from '../../src/sim/tick';

/** One profiled stage: which system of `SYSTEMS` it belongs to, and what it runs. */
interface Stage {
  readonly name: string;
  readonly system: string;
  run(sim: Sim): void;
}

/** The names of `SYSTEMS`, in order, as this file knows them. */
export const PROFILED_SYSTEMS = [
  'commands',
  'power',
  'drills',
  'belts',
  'inserters',
  'machines',
  'players',
  'events',
] as const;

function system(name: string): System {
  const s = SYSTEMS.find((x) => x.name === name);
  if (!s) throw new Error(`profile: no system named ${name} in SYSTEMS`);
  return s;
}

/** A whole system as one stage (it gets no commands: profiled ticks run without queued commands). */
const whole = (name: string): Stage => {
  const s = system(name);
  return { name, system: name, run: (sim) => s.run(sim, []) };
};

/** Every stage, in tick order. */
export const STAGES: readonly Stage[] = [
  whole('commands'),
  whole('power'),
  {
    name: 'drills (burner)',
    system: 'drills',
    run: ({ state }) => drillTable(state.entities)?.update(state.entities, state.world),
  },
  {
    name: 'drills (electric)',
    system: 'drills',
    run: ({ state }) => electricDrillTable(state.entities)?.update(state.entities, state.world),
  },
  whole('belts'),
  whole('inserters'),
  {
    name: 'furnaces',
    system: 'machines',
    run: ({ state }) => furnaceTable(state.entities)?.update(state.entities),
  },
  {
    name: 'assemblers',
    system: 'machines',
    run: ({ state }) => {
      for (const type of ASSEMBLER_TYPES)
        assemblerTable(state.entities, type)?.update(state.entities);
    },
  },
  {
    name: 'labs',
    system: 'machines',
    run: ({ state }) => labTable(state.entities)?.update(state.entities),
  },
  {
    name: 'players',
    system: 'players',
    run: ({ state }) => updatePlayers(state.players, state.world, state.entities),
  },
  {
    name: 'crafting',
    system: 'players',
    run: ({ state }) => updateCrafting(state.crafting, state.players),
  },
  whole('events'),
];

/** Throws unless `SYSTEMS` is exactly the list of systems the stages were written for. */
export function checkSystems(): void {
  const names = SYSTEMS.map((s) => s.name).join(', ');
  if (names !== PROFILED_SYSTEMS.join(', ')) {
    throw new Error(
      `profile: SYSTEMS is now [${names}]; update tools/bench/profile.ts (was [${PROFILED_SYSTEMS.join(', ')}])`,
    );
  }
}

/** Accumulated stage durations over a number of ticks. */
export class SystemProfile {
  readonly totals = new Float64Array(STAGES.length);
  ticks = 0;
}

/**
 * Advances `sim` by one tick like `sim.step()`, timing every stage. Only for
 * ticks without queued commands (the measured ticks of a scene).
 */
export function profiledStep(sim: Sim, profile: SystemProfile): void {
  if (sim.pendingCommands !== 0) {
    throw new Error('profiledStep: commands are queued; profile only ticks without commands');
  }
  const { totals } = profile;
  let t0 = performance.now();
  for (let i = 0; i < STAGES.length; i++) {
    STAGES[i]!.run(sim);
    const t1 = performance.now();
    totals[i] = totals[i]! + (t1 - t0);
    t0 = t1;
  }
  sim.state.tick++;
  profile.ticks++;
}

/** One stage of a profile report: mean time per tick and share of the profiled tick. */
export interface StageTiming {
  name: string;
  system: string;
  meanMs: number;
  /** Share of the sum of all stages, in [0, 1]. */
  share: number;
}

export interface ProfileResult {
  /** Profiled ticks (after the same warm-up as the measured runs). */
  ticks: number;
  /** Mean of the summed stage times per tick, in ms (includes the timer overhead). */
  meanMs: number;
  stages: StageTiming[];
}

/** The per-tick means of `profile`. */
export function profileResult(profile: SystemProfile): ProfileResult {
  const n = Math.max(1, profile.ticks);
  let sum = 0;
  for (const t of profile.totals) sum += t;
  return {
    ticks: profile.ticks,
    meanMs: sum / n,
    stages: STAGES.map((s, i) => ({
      name: s.name,
      system: s.system,
      meanMs: profile.totals[i]! / n,
      share: sum > 0 ? profile.totals[i]! / sum : 0,
    })),
  };
}

import { describe, expect, it } from 'vitest';
import {
  DETERMINISM_PLAYERS,
  DETERMINISM_SEED,
  DETERMINISM_TICKS,
  buildDeterminismScript,
  runDeterminismScenario,
} from '../../src/sim/scenarios/determinism';
import { Sim } from '../../src/sim/tick';
import { DETERMINISM_EXPECTED_HASH } from './determinism.expected';

const hex = (h: number): string => `0x${h.toString(16).padStart(8, '0')}`;

/** Runs the scenario, recording the hash every `every` ticks. */
function hashTrace(every: number): number[] {
  const sim = new Sim({ seed: DETERMINISM_SEED, players: DETERMINISM_PLAYERS });
  for (const cmd of buildDeterminismScript()) {
    sim.enqueue(cmd);
  }
  const trace: number[] = [];
  for (let i = 0; i < DETERMINISM_TICKS; i++) {
    sim.step();
    if (sim.tick % every === 0) {
      trace.push(sim.hash());
    }
  }
  return trace;
}

describe('determinism', () => {
  it('produces the same hash when run twice', () => {
    const a = runDeterminismScenario();
    const b = runDeterminismScenario();
    expect(a.tick).toBe(DETERMINISM_TICKS);
    expect(a.commands).toBeGreaterThan(1000);
    expect(hex(b.hash)).toBe(hex(a.hash));
  });

  it('matches the expected hash shared with the Chromium test', () => {
    expect(hex(runDeterminismScenario().hash)).toBe(hex(DETERMINISM_EXPECTED_HASH));
  });

  it('produces identical intermediate hashes, and they keep changing', () => {
    const a = hashTrace(100);
    const b = hashTrace(100);
    expect(b).toEqual(a);
    expect(new Set(a).size).toBe(a.length);
  });

  it('is sensitive to the seed and to the commands', () => {
    const base = new Sim({ seed: DETERMINISM_SEED, players: DETERMINISM_PLAYERS });
    const otherSeed = new Sim({ seed: DETERMINISM_SEED + 1, players: DETERMINISM_PLAYERS });
    expect(otherSeed.hash()).not.toBe(base.hash());

    const script = buildDeterminismScript(2000);
    const plain = new Sim({ seed: DETERMINISM_SEED, players: DETERMINISM_PLAYERS });
    const withExtra = new Sim({ seed: DETERMINISM_SEED, players: DETERMINISM_PLAYERS });
    for (const cmd of script) {
      plain.enqueue(cmd);
      withExtra.enqueue(cmd);
    }
    // A mining target far outside the script's range, so it can't be a no-op.
    withExtra.enqueue({ tick: 1000, playerId: 1, type: 'MineStart', x: 12_345, y: 0 });
    withExtra.enqueue({ tick: 1999, playerId: 1, type: 'MineStart', x: 12_345, y: 0 });
    for (let i = 0; i < 2000; i++) {
      plain.step();
      withExtra.step();
    }
    expect(withExtra.hash()).not.toBe(plain.hash());
  });

  it('does not depend on the enqueue order across players and ticks', () => {
    const script = buildDeterminismScript(3000);
    const sorted = script.slice().sort((a, b) => a.tick - b.tick || a.playerId - b.playerId);
    const run = (commands: typeof script): number => {
      const sim = new Sim({ seed: DETERMINISM_SEED, players: DETERMINISM_PLAYERS });
      commands.forEach((c) => sim.enqueue(c));
      for (let i = 0; i < 3000; i++) {
        sim.step();
      }
      return sim.hash();
    };
    expect(run(sorted)).toBe(run(script));
  });
});

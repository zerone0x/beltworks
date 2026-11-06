/**
 * The scripted scenario behind the determinism test. It runs in Node (Vitest)
 * and in Chromium (Playwright, through the dev/test hook), and both compare
 * the resulting hash against the same expected value in
 * tests/sim/determinism.expected.ts.
 */

import type { Axis, Command } from '../commands';
import { Rng } from '../rng';
import { Sim } from '../tick';

export const DETERMINISM_SEED = 0x5eed_2026;
export const DETERMINISM_SCRIPT_SEED = 0xc0ffee;
export const DETERMINISM_TICKS = 10_000;
export const DETERMINISM_PLAYERS = 3;

const AXES: readonly Axis[] = [-1, 0, 1];

/**
 * Builds a pseudo-random but fixed command log covering every command type,
 * several players, several commands on the same tick, and commands for player
 * ids that don't exist. Commands are returned in a shuffled (but fixed) order
 * so the test also covers the queue's sorting.
 */
export function buildDeterminismScript(
  ticks: number = DETERMINISM_TICKS,
  scriptSeed: number = DETERMINISM_SCRIPT_SEED,
): Command[] {
  const rng = Rng.fromSeed(scriptSeed);
  const commands: Command[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    // About one command every 8 ticks, sometimes a burst on the same tick.
    if (rng.nextInt(8) !== 0) {
      continue;
    }
    const burst = 1 + rng.nextInt(3);
    for (let i = 0; i < burst; i++) {
      // Player id DETERMINISM_PLAYERS is out of range on purpose: it must be ignored.
      const playerId = rng.nextInt(DETERMINISM_PLAYERS + 1);
      const kind = rng.nextInt(10);
      if (kind < 6) {
        commands.push({
          tick,
          playerId,
          type: 'Move',
          dx: AXES[rng.nextInt(3)]!,
          dy: AXES[rng.nextInt(3)]!,
        });
      } else if (kind < 9) {
        commands.push({
          tick,
          playerId,
          type: 'MineStart',
          x: rng.nextInt(201) - 100,
          y: rng.nextInt(201) - 100,
        });
      } else {
        commands.push({ tick, playerId, type: 'MineStop' });
      }
    }
  }
  // Fixed Fisher-Yates shuffle: enqueue order across ticks/players must not matter.
  // Commands of the same player on the same tick keep their relative order.
  const shuffled = commands.slice();
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = rng.nextInt(i + 1);
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  return stableSamePlayerOrder(shuffled, commands);
}

/**
 * Restores the original relative order of commands that share a tick and a
 * player (that order is meaningful), keeping the shuffled order otherwise.
 */
function stableSamePlayerOrder(shuffled: Command[], original: Command[]): Command[] {
  const key = (c: Command): string => `${String(c.tick)}:${String(c.playerId)}`;
  const queues = new Map<string, Command[]>();
  for (const c of original) {
    const k = key(c);
    const q = queues.get(k);
    if (q) {
      q.push(c);
    } else {
      queues.set(k, [c]);
    }
  }
  return shuffled.map((c) => queues.get(key(c))!.shift()!);
}

export interface DeterminismResult {
  hash: number;
  tick: number;
  commands: number;
}

/** Runs the scenario from scratch and returns the final state hash. */
export function runDeterminismScenario(ticks: number = DETERMINISM_TICKS): DeterminismResult {
  const sim = new Sim({ seed: DETERMINISM_SEED, players: DETERMINISM_PLAYERS });
  const script = buildDeterminismScript(ticks);
  for (const cmd of script) {
    sim.enqueue(cmd);
  }
  for (let i = 0; i < ticks; i++) {
    sim.step();
  }
  return { hash: sim.hash(), tick: sim.tick, commands: script.length };
}

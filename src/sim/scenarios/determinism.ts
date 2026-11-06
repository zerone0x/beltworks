/**
 * The scripted scenario behind the determinism test. It runs in Node (Vitest)
 * and in Chromium (Playwright, through the dev/test hook), and both compare
 * the resulting hash against the same expected value in
 * tests/sim/determinism.expected.ts.
 *
 * The script has two phases:
 * 1. Scripted (ticks `[0, DETERMINISM_SCRIPTED_TICKS)`): every player walks
 *    from the spawn to one of the starting ore patches and hand-mines it,
 *    including a re-target, mining that waits until the player is in reach,
 *    and walking out of reach while mining.
 * 2. Random: a pseudo-random but fixed stream of every command type for the
 *    remaining ticks.
 */

import type { Axis, Command } from '../commands';
import { HALF_TILE, tileToFixed } from '../fixed';
import { PLAYER_DIAGONAL_SPEED, PLAYER_SPEED } from '../player';
import { Rng } from '../rng';
import { Sim } from '../tick';
import { startingPatches } from '../world/generate';

export const DETERMINISM_SEED = 0x5eed_2026;
export const DETERMINISM_SCRIPT_SEED = 0xc0ffee;
export const DETERMINISM_TICKS = 10_000;
export const DETERMINISM_PLAYERS = 3;
/** Length of the scripted walk-and-mine phase; random commands start after it. */
export const DETERMINISM_SCRIPTED_TICKS = 1_000;

const AXES: readonly Axis[] = [-1, 0, 1];

interface Walker {
  readonly playerId: number;
  tick: number;
  /** Position in subtiles. */
  x: number;
  y: number;
}

const sign = (v: number): Axis => (v > 0 ? 1 : v < 0 ? -1 : 0);

/**
 * Appends the `Move` commands that walk `w` close to `(toX, toY)` (subtiles):
 * diagonally first, then straight along each axis, then stop. Mirrors the
 * player system's integer movement exactly; the path must be free of water,
 * which holds around the spawn (it is flattened to grass).
 */
function walkTo(commands: Command[], w: Walker, toX: number, toY: number): void {
  const step = (dx: Axis, dy: Axis, speed: number, ticks: number): void => {
    if (ticks <= 0) return;
    commands.push({ tick: w.tick, playerId: w.playerId, type: 'Move', dx, dy });
    w.x += dx * speed * ticks;
    w.y += dy * speed * ticks;
    w.tick += ticks;
  };
  const diagonal = Math.min(
    Math.floor(Math.abs(toX - w.x) / PLAYER_DIAGONAL_SPEED),
    Math.floor(Math.abs(toY - w.y) / PLAYER_DIAGONAL_SPEED),
  );
  step(sign(toX - w.x), sign(toY - w.y), PLAYER_DIAGONAL_SPEED, diagonal);
  step(sign(toX - w.x), 0, PLAYER_SPEED, Math.floor(Math.abs(toX - w.x) / PLAYER_SPEED));
  step(0, sign(toY - w.y), PLAYER_SPEED, Math.floor(Math.abs(toY - w.y) / PLAYER_SPEED));
  commands.push({ tick: w.tick, playerId: w.playerId, type: 'Move', dx: 0, dy: 0 });
}

/** Phase 1: each player walks to a starting ore patch and mines it. */
function scriptedPhase(): Command[] {
  const commands: Command[] = [];
  const patches = startingPatches(DETERMINISM_SEED);
  for (let id = 0; id < DETERMINISM_PLAYERS; id++) {
    const patch = patches[id]!;
    const w: Walker = { playerId: id, tick: 5 * id, x: 0, y: 0 };
    if (id === 2) {
      // Start mining from the spawn, far out of reach: it waits until the player arrives.
      commands.push({ tick: w.tick, playerId: id, type: 'MineStart', x: patch.x, y: patch.y });
    }
    walkTo(commands, w, tileToFixed(patch.x) + HALF_TILE, tileToFixed(patch.y) + HALF_TILE);
    commands.push({ tick: w.tick, playerId: id, type: 'MineStart', x: patch.x, y: patch.y });
    w.tick += 300;
    // The neighbouring tile is ore too: starting patches are wider than that.
    commands.push({ tick: w.tick, playerId: id, type: 'MineStart', x: patch.x, y: patch.y + 1 });
    w.tick += 150;
    if (id === 1) {
      // Walk away while still mining: mining pauses once out of reach.
      commands.push({ tick: w.tick, playerId: id, type: 'Move', dx: sign(-patch.x), dy: 0 });
      w.tick += 60;
      commands.push({ tick: w.tick, playerId: id, type: 'Move', dx: 0, dy: 0 });
    }
    commands.push({ tick: w.tick, playerId: id, type: 'MineStop' });
  }
  return commands;
}

/**
 * Builds a fixed command log covering every command type: the scripted
 * walk-and-mine phase, then pseudo-random commands for several players,
 * several commands on the same tick, and commands for player ids that don't
 * exist. Commands are returned in a shuffled (but fixed) order so the test
 * also covers the queue's sorting.
 */
export function buildDeterminismScript(
  ticks: number = DETERMINISM_TICKS,
  scriptSeed: number = DETERMINISM_SCRIPT_SEED,
): Command[] {
  const rng = Rng.fromSeed(scriptSeed);
  const limit = Math.min(ticks, DETERMINISM_SCRIPTED_TICKS);
  const commands: Command[] = scriptedPhase().filter((c) => c.tick < limit);
  for (let tick = DETERMINISM_SCRIPTED_TICKS; tick < ticks; tick++) {
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
  /** Units of resources the players hold at the end (proof that mining happened). */
  itemsMined: number;
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
  let itemsMined = 0;
  for (const count of sim.state.players.invCounts) {
    itemsMined += count;
  }
  return { hash: sim.hash(), tick: sim.tick, commands: script.length, itemsMined };
}

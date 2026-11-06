/**
 * Simulation state: everything that is saved, hashed, and must evolve
 * identically on every machine. Only integers live here (typed arrays and
 * integer fields); see docs/ARCHITECTURE.md.
 */

import { FNV1A32_OFFSET_BASIS, fnv1a32 } from './hash';
import { PlayerTable } from './player';
import { Rng } from './rng';
import { World } from './world/world';

export interface SimState {
  /** Number of ticks completed; the next `step()` runs tick `tick`. */
  tick: number;
  readonly seed: number;
  readonly rng: Rng;
  readonly players: PlayerTable;
  /** The map, generated lazily from `seed`. */
  readonly world: World;
}

export interface SimOptions {
  /** World seed (coerced to uint32). */
  seed: number;
  /** Number of player slots (default 1). Commands for other player ids are ignored. */
  players?: number;
}

/**
 * Bump when the hashed layout changes, so stale expected hashes fail loudly
 * instead of matching by accident.
 */
export const STATE_HASH_VERSION = 3;

export function createSimState(options: SimOptions): SimState {
  const seed = options.seed >>> 0;
  return {
    tick: 0,
    seed,
    rng: Rng.fromSeed(seed),
    players: new PlayerTable(options.players ?? 1),
    world: new World(seed),
  };
}

/** Hashes the whole simulation state into a uint32. */
export function hashState(state: SimState): number {
  let h = FNV1A32_OFFSET_BASIS;
  const tickLo = state.tick % 0x1_0000_0000;
  const tickHi = (state.tick - tickLo) / 0x1_0000_0000;
  h = fnv1a32(Uint32Array.of(STATE_HASH_VERSION, tickLo, tickHi, state.seed), h);
  h = fnv1a32(state.rng.getState(), h);
  h = state.players.hashInto(h);
  h = state.world.hashInto(h);
  return h;
}

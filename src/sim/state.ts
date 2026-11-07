/**
 * Simulation state: everything that is saved, hashed, and must evolve
 * identically on every machine. Only integers live here (typed arrays and
 * integer fields); see docs/ARCHITECTURE.md.
 *
 * Every piece of it is saved (src/sim/save/save.ts): new state gets written
 * in the `save` hook next to the `hashInto` hook of whatever holds it (or is
 * rebuilt exactly in `load`), or the save round-trip tests fail.
 */

import type { ItemStack } from '../data/items';
import { STARTING_KIT } from '../data/start';
import { CraftingTable } from './crafting/queue';
import { Entities } from './entities/entities';
import { createEntityTables } from './entities/registry';
import type { EntityTypeTable } from './entities/table';
import { FNV1A32_OFFSET_BASIS, fnv1a32 } from './hash';
import { PlayerTable } from './player';
import { labTable } from './research/lab';
import { ResearchState } from './research/research';
import { DEFAULT_FORCE } from './research/unlocks';
import { Rng } from './rng';
import { World } from './world/world';

export interface SimState {
  /** Number of ticks completed; the next `step()` runs tick `tick`. */
  tick: number;
  readonly seed: number;
  readonly rng: Rng;
  readonly players: PlayerTable;
  /** Every player's hand-crafting queue (indexed like `players`). */
  readonly crafting: CraftingTable;
  /** The map, generated lazily from `seed`. */
  readonly world: World;
  /** Every placed entity, with the occupancy index and the per-type tables. */
  readonly entities: Entities;
  /** Every force's research: current research, progress, researched set. */
  readonly research: ResearchState;
}

export interface SimOptions {
  /** World seed (coerced to uint32). */
  seed: number;
  /** Number of player slots (default 1). Commands for other player ids are ignored. */
  players?: number;
  /** What every player starts with (default `STARTING_KIT` from src/data/start.ts). */
  startingKit?: readonly ItemStack[];
  /**
   * The per-type entity tables (default: a fresh `createEntityTables()`).
   * Tests use it to add fake tables, such as power producers.
   */
  entityTables?: readonly EntityTypeTable[];
  /**
   * Technologies every force has researched in the new game (default none).
   * For tests, benchmarks and dev builds' `?research=` (src/testHook.ts).
   */
  researched?: readonly number[];
}

/**
 * Bump when the hashed layout changes, so stale expected hashes fail loudly
 * instead of matching by accident.
 */
export const STATE_HASH_VERSION = 18;

export function createSimState(options: SimOptions): SimState {
  const seed = options.seed >>> 0;
  const players = new PlayerTable(options.players ?? 1);
  const kit = options.startingKit ?? STARTING_KIT;
  for (let id = 0; id < players.count; id++) {
    const inventory = players.inventory(id);
    for (const { item, count } of kit) {
      inventory.add(item, count);
    }
  }
  const research = new ResearchState();
  for (const tech of options.researched ?? []) research.markResearched(DEFAULT_FORCE, tech);
  const entities = new Entities(options.entityTables ?? createEntityTables());
  labTable(entities)?.attach(research);
  return {
    tick: 0,
    seed,
    rng: Rng.fromSeed(seed),
    players,
    crafting: new CraftingTable(players.count),
    world: new World(seed),
    entities,
    research,
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
  h = state.crafting.hashInto(h);
  h = state.world.hashInto(h);
  h = state.entities.hashInto(h);
  h = state.research.hashInto(h);
  return h;
}

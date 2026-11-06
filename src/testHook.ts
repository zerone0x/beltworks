/**
 * Test-only hook exposed as `window.__beltworks` in dev and test builds
 * (`vite` or `vite build --mode test`). main.ts loads this module through a
 * dynamic import behind a compile-time check, so production builds don't
 * contain it.
 */

import { runDeterminismScenario, type DeterminismResult } from './sim/scenarios/determinism';
import type { SimClient } from './worker/client';

export interface BeltworksTestHook {
  /** Runs the determinism scenario synchronously on the main thread. */
  runDeterminism(ticks?: number): DeterminismResult;
  /** Tick of the latest snapshot from the worker, or -1 before the first one. */
  latestTick(): number;
}

declare global {
  interface Window {
    __beltworks?: BeltworksTestHook;
  }
}

export function installTestHook(client: SimClient): void {
  window.__beltworks = {
    runDeterminism: (ticks) => runDeterminismScenario(ticks),
    latestTick: () => client.latestSnapshot?.tick ?? -1,
  };
}

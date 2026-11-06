/**
 * Messages between the main thread and the simulation worker.
 *
 * Main → worker: `init`, `commands`, `setViewport`.
 * Worker → main: `snapshot`, `stats`, `error`.
 *
 * Bulk data travels in ArrayBuffers that are transferred, not copied.
 */

import type { CommandInput } from '../sim/commands';

/** Target simulation rate. */
export const TICKS_PER_SECOND = 60;
/** At most this many ticks run per worker wake-up; any further backlog is dropped. */
export const MAX_CATCH_UP_TICKS = 5;
/** How often the worker reports `stats`, in ticks (twice a second at full speed). */
export const STATS_INTERVAL_TICKS = 30;

/** A rectangle in tile coordinates. */
export interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface InitMessage {
  type: 'init';
  /** World seed (uint32). Re-sending `init` restarts the simulation. */
  seed: number;
}

export interface CommandsMessage {
  type: 'commands';
  /** Commands without a tick: the worker schedules them on the next tick it runs. */
  commands: CommandInput[];
}

export interface SetViewportMessage {
  type: 'setViewport';
  viewport: Viewport;
}

export type MainToWorker = InitMessage | CommandsMessage | SetViewportMessage;

/**
 * Render state after the latest tick. Sent once per worker wake-up that ran at
 * least one tick (not once per tick): when the worker catches up several ticks
 * at once, only the newest state is useful to the renderer, and `ticksRun`
 * says how many ticks it covers.
 */
export interface SnapshotMessage {
  type: 'snapshot';
  /** Ticks completed when the snapshot was taken. */
  tick: number;
  /** Ticks run since the previous snapshot. */
  ticksRun: number;
  /** Last viewport received from the main thread, or `null` before the first one. */
  viewport: Viewport | null;
  /** Players as int32 records; see `PLAYER_STRIDE` in src/sim/snapshot.ts. */
  players: ArrayBuffer;
}

export interface StatsMessage {
  type: 'stats';
  /** Ticks completed. */
  tick: number;
  /** Mean wall time of one `step()` since the previous stats message, in ms. */
  tickMs: number;
  /** Ticks dropped (not run) since the previous stats message because the worker fell behind. */
  droppedTicks: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type WorkerToMain = SnapshotMessage | StatsMessage | ErrorMessage;

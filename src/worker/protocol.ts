/**
 * Messages between the main thread and the simulation worker.
 *
 * Main → worker: `init`, `commands`, `setViewport`.
 * Worker → main: `snapshot`, `stats`, `error`.
 *
 * Commands include the build commands `Place`, `Remove` and `Rotate`; like
 * every command they are validated for shape here and ignored by the
 * simulation when they don't apply.
 *
 * Bulk data travels in ArrayBuffers that are transferred, not copied.
 */

import type { CommandInput } from '../sim/commands';

/** The player controlled by this client: its commands carry this id, and its inventory is in snapshots. */
export const LOCAL_PLAYER_ID = 0;

/** Target simulation rate. */
export const TICKS_PER_SECOND = 60;
/** At most this many ticks run per worker wake-up; any further backlog is dropped. */
export const MAX_CATCH_UP_TICKS = 5;
/** How often the worker reports `stats`, in ticks (twice a second at full speed). */
export const STATS_INTERVAL_TICKS = 30;

/**
 * Viewports wider or taller than this many tiles are clamped by the worker, so
 * a bogus viewport can't make it generate an unbounded number of chunks. At
 * the minimum zoom (0.25×, 8 px per tile) this is still 8192 px.
 */
export const MAX_VIEWPORT_TILES = 1024;
/** Chunks kept around the viewport on each side, so panning reveals ready-made chunks. */
export const CHUNK_MARGIN = 1;
/**
 * At most this many chunks go into one snapshot (nearest to the viewport
 * center first); the rest follow in later snapshots. This spreads generation
 * and baking over several frames when the view jumps or zooms out.
 */
export const MAX_CHUNKS_PER_SNAPSHOT = 16;

/** A rectangle in tile coordinates. */
export interface Viewport {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An inclusive rectangle of chunk coordinates: `cx0 <= cx <= cx1`, `cy0 <= cy <= cy1`. */
export interface ChunkRect {
  cx0: number;
  cy0: number;
  cx1: number;
  cy1: number;
}

/** Whether chunk `(cx, cy)` lies inside `rect`. */
export function rectContains(rect: ChunkRect, cx: number, cy: number): boolean {
  return cx >= rect.cx0 && cx <= rect.cx1 && cy >= rect.cy0 && cy <= rect.cy1;
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
  /** Tiles visible on screen (int32 `x`, `y`; `w`, `h` in [0, MAX_VIEWPORT_TILES], larger values are clamped). */
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
  /** Inventory of `LOCAL_PLAYER_ID` as uint16 `[item, count]` pairs; see `encodeInventory`. */
  inventory: ArrayBuffer;
  /**
   * Every entity with its origin inside `chunkWindow`, as int32 records; see
   * `ENTITY_STRIDE` and `encodeEntities` in src/sim/snapshot.ts. Empty before
   * the first viewport.
   */
  entities: ArrayBuffer;
  /**
   * The chunks the main thread should keep cached: the viewport plus
   * `CHUNK_MARGIN` chunks on each side. Cached chunks outside it can be
   * dropped; the worker sends them again if they come back into view. `null`
   * before the first viewport.
   */
  chunkWindow: ChunkRect | null;
  /**
   * Chunks inside `chunkWindow` that the main thread doesn't have yet, or that
   * changed since they were last sent (see `encodeChunks` in
   * src/sim/snapshot.ts). `null` when there are none.
   */
  chunks: ArrayBuffer | null;
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

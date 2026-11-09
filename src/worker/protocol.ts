/**
 * Messages between the main thread and the simulation worker.
 *
 * Main → worker: `init`, `commands`, `setViewport`, `inspect`, `save`,
 * `setPaused`, and in dev and test builds `setTimeScale`.
 * Worker → main: `snapshot`, `stats`, `saved`, `loaded`, `error`.
 *
 * Commands include the build commands `Place`, `Remove` and `Rotate` and the
 * entity GUI's `Insert`, `Take` and `SetRecipe`, the crafting commands `Craft` and
 * `CancelCraft`, and the tech tree's `SetResearch`; like every command they are validated for shape here and
 * ignored by the simulation when they don't apply.
 *
 * Bulk data travels in ArrayBuffers that are transferred, not copied. The
 * int32 sections of a snapshot (`DELTA_SECTIONS`) go as deltas: whole, as a
 * patch on the previous one, or not at all when unchanged
 * (`SnapshotWireMessage`, src/worker/snapshotDelta.ts); `SimClient` turns
 * them back into whole sections (`SnapshotMessage`).
 */

import type { CommandInput } from '../sim/commands';
import type { SaveMeta } from '../sim/save/container';

/** The player controlled by this client: its commands carry this id, and its inventory is in snapshots. */
export const LOCAL_PLAYER_ID = 0;

/** Target simulation rate. */
export const TICKS_PER_SECOND = 60;
/** At most this many ticks run per worker wake-up; any further backlog is dropped. */
export const MAX_CATCH_UP_TICKS = 5;
/** How often the worker reports `stats`, in ticks (twice a second at full speed). */
export const STATS_INTERVAL_TICKS = 30;
/** The largest `setTimeScale` scale (dev and test builds only). */
export const MAX_TIME_SCALE = 16;

/**
 * Viewports wider or taller than this many tiles are clamped by the worker, so
 * a bogus viewport can't make it generate an unbounded number of chunks. At
 * the minimum zoom (0.125× in map mode, 4 px per tile) this is still 4096 px.
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
  /**
   * What the player starts with instead of the default starting kit. Only
   * dev and test builds send it (a `?kit=` URL parameter, see
   * src/testHook.ts), for end-to-end tests that need more than the kit has.
   */
  startingKit?: { item: number; count: number }[];
  /**
   * Technologies researched from the start. Only dev and test builds send
   * it (a `?research=` URL parameter, see src/testHook.ts).
   */
  researched?: number[];
  /**
   * A save to continue from (src/sim/save/save.ts; gzipped or not) instead
   * of a new game; the worker answers with `loaded`. If it can't be read,
   * the worker starts a new game from `seed` (and the kit) and says why.
   */
  save?: ArrayBuffer;
  /**
   * A render scene (src/worker/renderScene.ts), for the render profile: a
   * benchmark scene (tools/bench/scenes/), built through commands in place
   * of the new game (the seed and kit are then ignored), or a grid scene
   * whose entities, belts, inserters and power grid replace the
   * simulation's in every snapshot. Only dev and test builds send it (a
   * `?scene=` URL parameter, see src/testHook.ts) or accept it.
   */
  renderScene?: string;
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

export interface InspectMessage {
  type: 'inspect';
  /**
   * The entity whose GUI is open (a uint32 id), or 0 for none. Snapshots
   * carry its slots and state from then on (see `SnapshotMessage.entityDetail`).
   */
  entity: number;
}

/**
 * Dev and test builds only (the test hook's `setTimeScale`; production
 * builds reject it): run the simulation `scale` times faster than real time,
 * for end-to-end tests that wait on long processes (docs/DECISIONS.md, D42).
 * Ticks stay the same, there are just more of them per second.
 */
export interface SetTimeScaleMessage {
  type: 'setTimeScale';
  /** Ticks per 1/60 s of wall time: an integer in [1, MAX_TIME_SCALE]; 1 is normal speed. */
  scale: number;
}

/**
 * Asks for a save of the current state (after the latest tick, with the
 * commands queued for the next one). The worker serializes and gzips it and
 * answers with `saved` and the same `id`.
 */
export interface SaveRequestMessage {
  type: 'save';
  id: number;
}

/**
 * Pauses or resumes the simulation (the game menu is open in single-player).
 * Paused, the worker runs no ticks and sends no snapshots or stats; nothing
 * in the simulation changes, so pausing can't affect determinism. Commands
 * and saves are still handled: commands wait for the next tick, which runs
 * once resumed. Resuming starts from the current tick without catching up
 * on the time spent paused.
 */
export interface SetPausedMessage {
  type: 'setPaused';
  paused: boolean;
}

export type MainToWorker =
  | InitMessage
  | CommandsMessage
  | SetViewportMessage
  | InspectMessage
  | SetTimeScaleMessage
  | SaveRequestMessage
  | SetPausedMessage;

/**
 * Render state after the latest tick, as the main thread's consumers get it
 * (`SimClient.onSnapshot`): every section whole. Sent once per worker
 * wake-up that ran at least one tick (not once per tick): when the worker
 * catches up several ticks at once, only the newest state is useful to the
 * renderer, and `ticksRun` says how many ticks it covers.
 *
 * A section of `DELTA_SECTIONS` that didn't change since the previous
 * snapshot is the very same `ArrayBuffer` as in that snapshot, so a consumer
 * can skip it by identity (`buffer === last`). Buffers are never written to
 * once delivered: keeping one is safe.
 */
export interface SnapshotMessage {
  type: 'snapshot';
  /** Ticks completed when the snapshot was taken. */
  tick: number;
  /** Ticks run since the previous snapshot. */
  ticksRun: number;
  /**
   * `commands` messages received so far. Each one runs on the tick after it
   * arrives, so a snapshot counting the main thread's nth message shows what
   * those commands did (see `SimClient.commandBatchesSent`).
   */
  commandBatches: number;
  /** Last viewport received from the main thread, or `null` before the first one. */
  viewport: Viewport | null;
  /** Players as int32 records; see `PLAYER_STRIDE` in src/sim/snapshot.ts. */
  players: ArrayBuffer;
  /** Inventory of `LOCAL_PLAYER_ID` as uint16 `[item, count]` pairs; see `encodeInventory`. */
  inventory: ArrayBuffer;
  /** Crafting queue of `LOCAL_PLAYER_ID` as uint16s; see `encodeCraftQueue` in src/sim/snapshot.ts. */
  craftQueue: ArrayBuffer;
  /** Research of `LOCAL_PLAYER_ID`'s force as int32s; see `encodeResearch` in src/sim/snapshot.ts. */
  research: ArrayBuffer;
  /**
   * Every entity with its origin inside `chunkWindow`, as int32 records; see
   * `ENTITY_STRIDE` and `encodeEntities` in src/sim/snapshot.ts. Empty before
   * the first viewport.
   */
  entities: ArrayBuffer;
  /**
   * The belts with their tile inside `chunkWindow` and the items on them, as
   * int32s; see `encodeBelts` in src/sim/snapshot.ts.
   */
  belts: ArrayBuffer;
  /**
   * The inserters with their tile inside `chunkWindow`, with their arm and
   * hand, as int32s; see `encodeInserters` in src/sim/snapshot.ts.
   */
  inserters: ArrayBuffer;
  /**
   * The electric poles with their tile inside `chunkWindow`, the wires
   * between them and their networks, as int32s; see `encodePower` in
   * src/sim/snapshot.ts.
   */
  power: ArrayBuffer;
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
  /** The entity last asked for with `inspect`, or 0. */
  inspected: number;
  /**
   * GUI data of the `inspected` entity (see `encodeEntityDetail` in
   * src/sim/snapshot.ts); `null` when nothing is inspected or the entity no
   * longer exists.
   */
  entityDetail: ArrayBuffer | null;
  /**
   * The power panel's data when the `inspected` entity is an electric pole:
   * its whole network (see `encodeNetworkDetail` in src/sim/snapshot.ts);
   * `null` otherwise.
   */
  networkDetail: ArrayBuffer | null;
  /** The worker's time to encode this snapshot, ms (for `SnapshotMeter`). */
  encodeMs: number;
  /** Bytes of the buffers this snapshot transferred. */
  bytes: number;
  /** When the worker posted it (`sharedNow` in src/worker/snapshotMeter.ts). */
  sentAt: number;
}

/** The int32 snapshot sections the worker sends as deltas, in the order of `patched`'s bits. */
export const DELTA_SECTIONS = [
  'players',
  'research',
  'entities',
  'belts',
  'inserters',
  'power',
] as const;
export type DeltaSection = (typeof DELTA_SECTIONS)[number];

/**
 * A snapshot as the worker sends it: each of `DELTA_SECTIONS` is the whole
 * section, a patch on the one sent before (its bit in `patched` set), or
 * `null` when it didn't change (src/worker/snapshotDelta.ts). The main
 * thread must apply every one, in order.
 */
export type SnapshotWireMessage = Omit<SnapshotMessage, DeltaSection> & {
  [K in DeltaSection]: ArrayBuffer | null;
} & {
  /** Bit `i` set: section `DELTA_SECTIONS[i]` is a patch. */
  patched: number;
};

export interface StatsMessage {
  type: 'stats';
  /** Ticks completed. */
  tick: number;
  /** Mean wall time of one `step()` since the previous stats message, in ms. */
  tickMs: number;
  /** Ticks dropped (not run) since the previous stats message because the worker fell behind. */
  droppedTicks: number;
  /**
   * When the worker sent it (its `performance.now()`, ms): UPS is measured on
   * the worker's clock, so a busy main thread that reads two messages in a
   * row doesn't make the simulation look faster than it is.
   */
  at: number;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

/** The answer to `save`: the gzipped save (transferred), or why it failed. */
export interface SavedMessage {
  type: 'saved';
  id: number;
  data: ArrayBuffer | null;
  meta: SaveMeta | null;
  error: string | null;
}

/** The answer to an `init` with a save: what was loaded, or why it couldn't be (a new game runs instead). */
export interface LoadedMessage {
  type: 'loaded';
  meta: SaveMeta | null;
  error: string | null;
}

export type WorkerToMain =
  SnapshotWireMessage | StatsMessage | ErrorMessage | SavedMessage | LoadedMessage;

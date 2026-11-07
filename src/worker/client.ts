/**
 * Main-thread side of the worker protocol: starts the simulation worker,
 * forwards commands and the viewport, and exposes the latest snapshot and an
 * updates-per-second estimate.
 */

import type { CommandInput } from '../sim/commands';
import type { SaveMeta } from '../sim/save/container';
import type {
  LoadedMessage,
  MainToWorker,
  SnapshotMessage,
  StatsMessage,
  Viewport,
  WorkerToMain,
} from './protocol';
import { SnapshotMeter, sharedNow } from './snapshotMeter';

export interface SimStats {
  tick: number;
  tickMs: number;
  droppedTicks: number;
  /** Ticks per second measured between the last two `stats` messages. */
  ups: number;
}

/** A save made by the worker: the gzipped bytes and what they hold. */
export interface WorkerSave {
  data: Uint8Array;
  meta: SaveMeta;
}

export class SimClient {
  private readonly worker: Worker;
  private lastStats: { tick: number; at: number } | null = null;
  /** Whether `setPaused(true)` is in effect: `stats` still in flight from before the pause are ignored. */
  private paused = false;
  private nextSaveId = 1;
  private readonly saves = new Map<
    number,
    { resolve: (save: WorkerSave) => void; reject: (err: Error) => void }
  >();

  latestSnapshot: SnapshotMessage | null = null;
  /** What snapshots cost (the render profile reads it). */
  readonly meter = new SnapshotMeter();
  onStats: ((stats: SimStats) => void) | null = null;
  onSnapshot: ((snapshot: SnapshotMessage) => void) | null = null;
  /** The answer to a `save` given to the constructor: loaded, or why not (a new game runs). */
  onLoaded: ((msg: LoadedMessage) => void) | null = null;

  /**
   * `startingKit` replaces the default kit and `researched` technologies are
   * researched from the start; `renderScene` replaces the simulation's
   * entities in snapshots with a scripted scene (dev and test builds only,
   * see `InitMessage`). With `save`, the game continues from that save
   * instead (see `onLoaded`).
   */
  constructor(
    seed: number,
    startingKit?: { item: number; count: number }[],
    researched?: number[],
    save?: Uint8Array,
    renderScene?: string,
  ) {
    this.worker = new Worker(new URL('./sim.worker.ts', import.meta.url), {
      type: 'module',
      name: 'beltworks-sim',
    });
    this.worker.onmessage = (event: MessageEvent<WorkerToMain>) => {
      this.receive(event.data);
    };
    this.worker.onerror = (event) => {
      console.error('Simulation worker failed:', event.message);
    };
    const buffer = save?.slice().buffer;
    this.worker.postMessage(
      {
        type: 'init',
        seed: seed >>> 0,
        ...(startingKit && { startingKit }),
        ...(researched && { researched }),
        ...(buffer && { save: buffer }),
        ...(renderScene && { renderScene }),
      } satisfies MainToWorker,
      buffer ? [buffer] : [],
    );
  }

  /** Asks the worker for a save of the game as it is now (serialized and gzipped in the worker). */
  save(): Promise<WorkerSave> {
    const id = this.nextSaveId++;
    return new Promise((resolve, reject) => {
      this.saves.set(id, { resolve, reject });
      this.send({ type: 'save', id });
    });
  }

  sendCommands(commands: CommandInput[]): void {
    if (commands.length > 0) {
      this.send({ type: 'commands', commands });
    }
  }

  /** Asks for the GUI data of entity `entity` in every snapshot (0 to stop). */
  inspect(entity: number): void {
    this.send({ type: 'inspect', entity });
  }

  /** Dev and test builds only: runs the simulation `scale` times faster (see `SetTimeScaleMessage`). */
  setTimeScale(scale: number): void {
    this.send({ type: 'setTimeScale', scale });
  }

  /** Pauses (no ticks, snapshots or stats) or resumes the simulation; see `SetPausedMessage`. */
  setPaused(paused: boolean): void {
    // UPS is measured between two stats messages, not across a pause: the
    // first stats after resuming only sets the baseline. Stats sent just
    // before the pause can arrive after this; they are dropped while paused,
    // so they can't become a baseline that spans the pause.
    this.paused = paused;
    this.lastStats = null;
    this.send({ type: 'setPaused', paused });
  }

  setViewport(viewport: Viewport): void {
    this.send({ type: 'setViewport', viewport });
  }

  terminate(): void {
    this.worker.terminate();
  }

  private send(msg: MainToWorker): void {
    this.worker.postMessage(msg);
  }

  private receive(msg: WorkerToMain): void {
    switch (msg.type) {
      case 'snapshot': {
        const received = sharedNow();
        const start = performance.now();
        this.latestSnapshot = msg;
        this.onSnapshot?.(msg);
        const applyMs = performance.now() - start;
        this.meter.record(msg.encodeMs, msg.bytes, received - msg.sentAt, applyMs, msg.ticksRun);
        break;
      }
      case 'stats':
        if (!this.paused) this.onStats?.(this.measure(msg));
        break;
      case 'error':
        console.error('Simulation worker error:', msg.message);
        break;
      case 'saved': {
        const pending = this.saves.get(msg.id);
        this.saves.delete(msg.id);
        if (msg.data && msg.meta)
          pending?.resolve({ data: new Uint8Array(msg.data), meta: msg.meta });
        else pending?.reject(new Error(msg.error ?? 'the save failed'));
        break;
      }
      case 'loaded':
        this.onLoaded?.(msg);
        break;
    }
  }

  private measure(msg: StatsMessage): SimStats {
    // The worker's clock: when the messages were sent, not when they were read.
    const now = msg.at;
    let ups = 0;
    if (this.lastStats && now > this.lastStats.at) {
      ups = ((msg.tick - this.lastStats.tick) * 1000) / (now - this.lastStats.at);
    }
    this.lastStats = { tick: msg.tick, at: now };
    return { tick: msg.tick, tickMs: msg.tickMs, droppedTicks: msg.droppedTicks, ups };
  }
}

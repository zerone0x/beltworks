/**
 * Main-thread side of the worker protocol: starts the simulation worker,
 * forwards commands and the viewport, and exposes the latest snapshot and an
 * updates-per-second estimate.
 */

import type { ProductionCounts } from '../sim/scenarios/production';
import type { Activity } from '../sim/activity';
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
import { SnapshotDecoder } from './snapshotDelta';
import { SnapshotMeter, sharedNow } from './snapshotMeter';

export interface SimStats {
  tick: number;
  tickMs: number;
  droppedTicks: number;
  /** Ticks per second measured between the last two `stats` messages. */
  ups: number;
  /** Per system: entities, awake and stepped in the latest tick. */
  activity: Activity;
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
  private batchesSent = 0;
  private readonly saves = new Map<
    number,
    { resolve: (save: WorkerSave) => void; reject: (err: Error) => void }
  >();

  latestSnapshot: SnapshotMessage | null = null;
  /** What snapshots cost (the render profile reads it). */
  readonly meter = new SnapshotMeter();
  /** Rebuilds whole snapshot sections from the worker's deltas. */
  private readonly sections = new SnapshotDecoder();
  onStats: ((stats: SimStats) => void) | null = null;
  onSnapshot: ((snapshot: SnapshotMessage) => void) | null = null;
  /** The answer to a `save` given to the constructor: loaded, or why not (a new game runs). */
  onLoaded: ((msg: LoadedMessage) => void) | null = null;
  private crashListener: ((message: string) => void) | null = null;
  /** Whether a crash listener has been told about the crash. */
  private crashReported = false;

  /**
   * The simulation stopped for good (D61): a tick threw (`crashed`), or the
   * worker itself failed (it couldn't start, or an error escaped it). Called
   * once, with what went wrong — also when the crash happened before the
   * listener was set (e.g. while the renderer's code was still loading): it is
   * called right away then.
   */
  get onCrash(): ((message: string) => void) | null {
    return this.crashListener;
  }

  set onCrash(listener: ((message: string) => void) | null) {
    this.crashListener = listener;
    this.reportCrash();
  }
  /** Why the simulation stopped, once it has (see `onCrash`). */
  crashed: string | null = null;
  /** `stepForTest` calls waiting for their snapshot, in order. */
  private readonly steps: { target: number; resolve: (tick: number) => void }[] = [];
  /** `productionForTest` calls waiting for their answer, in order. */
  private readonly productions: ((counts: ProductionCounts) => void)[] = [];

  /**
   * `startingKit` replaces the default kit and `researched` technologies are
   * researched from the start; `renderScene` replaces the simulation's
   * entities in snapshots with a scripted scene (dev and test builds only,
   * see `InitMessage`). With `save`, the game continues from that save
   * instead (see `onLoaded`); with `demo`, the demo factory starts (D72).
   */
  constructor(
    seed: number,
    startingKit?: { item: number; count: number }[],
    researched?: number[],
    save?: Uint8Array,
    renderScene?: string,
    demo = false,
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
      this.crash(event.message || 'the simulation worker failed to run');
    };
    this.worker.onmessageerror = () => {
      this.crash('a message from the simulation worker could not be read');
    };
    const buffer = save?.slice().buffer;
    this.worker.postMessage(
      {
        type: 'init',
        seed: seed >>> 0,
        ...(startingKit && { startingKit }),
        ...(researched && { researched }),
        ...(buffer && { save: buffer }),
        ...(demo && { demo: true }),
        ...(renderScene && { renderScene }),
      } satisfies MainToWorker,
      buffer ? [buffer] : [],
    );
  }

  /** Asks the worker for a save of the game as it is now (serialized and gzipped in the worker). */
  save(): Promise<WorkerSave> {
    if (this.crashed !== null) return Promise.reject(new Error('the simulation stopped'));
    const id = this.nextSaveId++;
    return new Promise((resolve, reject) => {
      this.saves.set(id, { resolve, reject });
      this.send({ type: 'save', id });
    });
  }

  /**
   * `commands` messages sent so far: a snapshot whose `commandBatches` is at
   * least this shows what every command sent until now did.
   */
  get commandBatchesSent(): number {
    return this.batchesSent;
  }

  sendCommands(commands: CommandInput[]): void {
    if (commands.length > 0) {
      this.batchesSent++;
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

  /**
   * Dev and test builds only (the frame-stepped capture, D72): runs `ticks`
   * ticks now and resolves with the tick of their snapshot once it arrived
   * (and went to `onSnapshot`).
   */
  stepForTest(ticks: number): Promise<number> {
    const target = (this.latestSnapshot?.tick ?? 0) + ticks;
    return new Promise((resolve) => {
      this.steps.push({ target, resolve });
      this.send({ type: 'step', ticks });
    });
  }

  /** Dev and test builds only: the production counters since the last reset (see `ProductionRequestMessage`). */
  productionForTest(reset: boolean): Promise<ProductionCounts> {
    return new Promise((resolve) => {
      this.productions.push(resolve);
      this.send({ type: 'production', reset });
    });
  }

  /** Dev and test builds only: makes the simulation's next tick throw (see `CrashForTestMessage`). */
  crashForTest(): void {
    this.send({ type: 'crashForTest' });
  }

  private crash(message: string): void {
    if (this.crashed !== null) return;
    this.crashed = message;
    // Saves asked for before the crash will never be answered.
    for (const pending of this.saves.values()) pending.reject(new Error('the simulation stopped'));
    this.saves.clear();
    this.reportCrash();
  }

  /** Tells the crash listener about the crash, once, as soon as there are both. */
  private reportCrash(): void {
    if (this.crashed === null || this.crashListener === null || this.crashReported) return;
    this.crashReported = true;
    this.crashListener(this.crashed);
  }

  private send(msg: MainToWorker): void {
    this.worker.postMessage(msg);
  }

  private receive(msg: WorkerToMain): void {
    switch (msg.type) {
      case 'snapshot': {
        const received = sharedNow();
        const start = performance.now();
        // Every snapshot goes through the decoder, in order, even with no
        // handler: the next one's patches apply to these sections.
        const snapshot: SnapshotMessage = { ...msg, ...this.sections.decode(msg) };
        this.latestSnapshot = snapshot;
        this.onSnapshot?.(snapshot);
        while (this.steps.length > 0 && this.steps[0]!.target <= snapshot.tick) {
          this.steps.shift()!.resolve(snapshot.tick);
        }
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
      case 'crashed':
        this.crash(msg.message);
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
      case 'production':
        this.productions.shift()?.(msg.counts);
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
    return {
      tick: msg.tick,
      tickMs: msg.tickMs,
      droppedTicks: msg.droppedTicks,
      ups,
      activity: msg.activity,
    };
  }
}

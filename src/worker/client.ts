/**
 * Main-thread side of the worker protocol: starts the simulation worker,
 * forwards commands and the viewport, and exposes the latest snapshot and an
 * updates-per-second estimate.
 */

import type { CommandInput } from '../sim/commands';
import type {
  MainToWorker,
  SnapshotMessage,
  StatsMessage,
  Viewport,
  WorkerToMain,
} from './protocol';

export interface SimStats {
  tick: number;
  tickMs: number;
  droppedTicks: number;
  /** Ticks per second measured between the last two `stats` messages. */
  ups: number;
}

export class SimClient {
  private readonly worker: Worker;
  private lastStats: { tick: number; at: number } | null = null;

  latestSnapshot: SnapshotMessage | null = null;
  onStats: ((stats: SimStats) => void) | null = null;
  onSnapshot: ((snapshot: SnapshotMessage) => void) | null = null;

  /**
   * `startingKit` replaces the default kit and `researched` technologies are
   * researched from the start (dev and test builds only, see `InitMessage`).
   */
  constructor(
    seed: number,
    startingKit?: { item: number; count: number }[],
    researched?: number[],
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
    this.send({
      type: 'init',
      seed: seed >>> 0,
      ...(startingKit && { startingKit }),
      ...(researched && { researched }),
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
      case 'snapshot':
        this.latestSnapshot = msg;
        this.onSnapshot?.(msg);
        break;
      case 'stats':
        this.onStats?.(this.measure(msg));
        break;
      case 'error':
        console.error('Simulation worker error:', msg.message);
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

/**
 * Simulation worker: owns the `Sim`, runs it at a fixed 60 ticks/s, and sends
 * snapshots and stats to the main thread. See src/worker/protocol.ts.
 */

import { validateCommandInput } from '../sim/commands';
import { encodePlayers } from '../sim/snapshot';
import { Sim } from '../sim/tick';
import { FixedStepClock } from './loop';
import {
  MAX_CATCH_UP_TICKS,
  STATS_INTERVAL_TICKS,
  TICKS_PER_SECOND,
  type MainToWorker,
  type Viewport,
  type WorkerToMain,
} from './protocol';

const clock = new FixedStepClock(1000 / TICKS_PER_SECOND, MAX_CATCH_UP_TICKS);
let sim: Sim | null = null;
let viewport: Viewport | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

// Stats accumulated since the last `stats` message.
let statTicks = 0;
let statStepMs = 0;
let statDropped = 0;

function post(msg: WorkerToMain, transfer: Transferable[] = []): void {
  // The options form has the same meaning on Window and DedicatedWorkerGlobalScope,
  // so this type-checks against the DOM lib used by the rest of src/.
  self.postMessage(msg, { transfer });
}

function wake(): void {
  timer = null;
  if (!sim) {
    return;
  }
  const { ticks, dropped } = clock.advance(performance.now());
  statDropped += dropped;
  if (ticks > 0) {
    const start = performance.now();
    for (let i = 0; i < ticks; i++) {
      sim.step();
    }
    statStepMs += performance.now() - start;
    sendSnapshot(ticks);

    statTicks += ticks;
    if (statTicks >= STATS_INTERVAL_TICKS) {
      post({
        type: 'stats',
        tick: sim.tick,
        tickMs: statStepMs / statTicks,
        droppedTicks: statDropped,
      });
      statTicks = 0;
      statStepMs = 0;
      statDropped = 0;
    }
  }
  schedule();
}

function schedule(): void {
  if (timer === null) {
    timer = setTimeout(wake, clock.msUntilNextTick());
  }
}

function sendSnapshot(ticksRun: number): void {
  if (!sim) {
    return;
  }
  const players = encodePlayers(sim.state);
  post(
    {
      type: 'snapshot',
      tick: sim.tick,
      ticksRun,
      viewport,
      players: players.buffer,
    },
    [players.buffer],
  );
}

function handle(msg: MainToWorker): void {
  switch (msg.type) {
    case 'init':
      sim = new Sim({ seed: msg.seed });
      clock.reset();
      clock.advance(performance.now());
      statTicks = statStepMs = statDropped = 0;
      schedule();
      break;
    case 'commands':
      if (!sim) {
        throw new Error('commands received before init');
      }
      for (const input of msg.commands) {
        const error = validateCommandInput(input);
        if (error !== null) {
          throw new Error(`invalid command: ${error}`);
        }
        // Schedule on the next tick to run; ticks already run can't change.
        sim.enqueue({ ...input, tick: sim.tick });
      }
      break;
    case 'setViewport':
      viewport = { ...msg.viewport };
      break;
  }
}

self.onmessage = (event: MessageEvent<MainToWorker>) => {
  try {
    handle(event.data);
  } catch (err) {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

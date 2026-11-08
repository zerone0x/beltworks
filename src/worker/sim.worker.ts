/**
 * Simulation worker: owns the `Sim`, runs it at a fixed 60 ticks/s, and sends
 * snapshots and stats to the main thread. See src/worker/protocol.ts.
 */

import { MAX_STACK_SIZE, itemPrototype, type ItemStack, type RealItemId } from '../data/items';
import { technologyPrototype } from '../data/technologies';
import { gunzip, gzip } from '../save/compress';
import { validateCommandInput } from '../sim/commands';
import { loadSim, saveMetaOf, saveSim } from '../sim/save/save';
import {
  encodeBelts,
  encodeChunks,
  encodeCraftQueue,
  encodeEntities,
  encodeEntityDetail,
  encodeInserters,
  encodeInventory,
  encodeNetworkDetail,
  encodePlayers,
  encodePower,
  encodeResearch,
} from '../sim/snapshot';
import { Sim } from '../sim/tick';
import { ChunkStreamer, sanitizeViewport } from './chunkStream';
import { BENCH_SCENES, RenderScene, isGridScene, isRenderScene } from './renderScene';
import { FixedStepClock } from './loop';
import {
  LOCAL_PLAYER_ID,
  MAX_CATCH_UP_TICKS,
  MAX_TIME_SCALE,
  STATS_INTERVAL_TICKS,
  TICKS_PER_SECOND,
  type MainToWorker,
  type Viewport,
  type WorkerToMain,
} from './protocol';

const STEP_MS = 1000 / TICKS_PER_SECOND;
let clock = new FixedStepClock(STEP_MS, MAX_CATCH_UP_TICKS);
/**
 * Dev and test builds only (`setTimeScale`, docs/DECISIONS.md, D42): the
 * simulation runs this many ticks per 1/60 s of wall time. The loop keeps
 * its clock on a scaled time line (`scaledNow`) that runs at the scale since
 * the last change, so at 1 it is `performance.now()`.
 */
let timeScale = 1;
let scaledBase = 0;
let realBase = 0;
const scaledNow = (): number => scaledBase + (performance.now() - realBase) * timeScale;
let sim: Sim | null = null;
let streamer: ChunkStreamer | null = null;
let viewport: Viewport | null = null;
/** The entity whose GUI is open on the main thread, or 0. */
let inspected = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
/** Whether the main thread paused the game (`setPaused`): no ticks run, no wake-ups are scheduled. */
let paused = false;
/** Dev and test builds only: the scripted render scene sent instead of the simulation's entities. */
let scene: RenderScene | null = null;

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
  if (!sim || paused) {
    return;
  }
  const { ticks, dropped } = clock.advance(scaledNow());
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
        at: performance.now(),
      });
      statTicks = 0;
      statStepMs = 0;
      statDropped = 0;
    }
  }
  schedule();
}

function schedule(): void {
  if (timer === null && !paused) {
    // Sped up, wake at most once per normal step and run the ticks due in one
    // batch, so the main thread still gets one snapshot per 1/60 s.
    const ms = clock.msUntilNextTick() / timeScale;
    timer = setTimeout(wake, timeScale > 1 ? Math.max(ms, STEP_MS) : ms);
  }
}

function sendSnapshot(ticksRun: number): void {
  if (!sim || !streamer) {
    return;
  }
  const players = encodePlayers(sim.state);
  const inventory = encodeInventory(sim.state, LOCAL_PLAYER_ID);
  const craftQueue = encodeCraftQueue(sim.state, LOCAL_PLAYER_ID);
  const research = encodeResearch(sim.state, LOCAL_PLAYER_ID);
  const batch = streamer.collect();
  const chunks = batch && batch.chunks.length > 0 ? encodeChunks(batch.chunks) : null;
  const window = batch?.window ?? null;
  const entities = scene
    ? scene.encodeEntities(window, sim.tick)
    : encodeEntities(sim.state, window);
  const belts = scene ? scene.encodeBelts(window, sim.tick) : encodeBelts(sim.state, window);
  const inserters = scene
    ? scene.encodeInserters(window, sim.tick)
    : encodeInserters(sim.state, window);
  const power = scene ? scene.encodePower(window) : encodePower(sim.state, window);
  const detail = inspected !== 0 ? encodeEntityDetail(sim.state, LOCAL_PLAYER_ID, inspected) : null;
  const network = inspected !== 0 ? encodeNetworkDetail(sim.state, inspected) : null;
  const transfer: Transferable[] = [
    players.buffer,
    inventory.buffer,
    craftQueue.buffer,
    research.buffer,
    entities.buffer,
    belts.buffer,
    inserters.buffer,
    power.buffer,
  ];
  if (chunks) transfer.push(chunks);
  if (detail) transfer.push(detail.buffer);
  if (network) transfer.push(network.buffer);
  post(
    {
      type: 'snapshot',
      tick: sim.tick,
      ticksRun,
      viewport,
      players: players.buffer,
      inventory: inventory.buffer,
      craftQueue: craftQueue.buffer,
      research: research.buffer,
      entities: entities.buffer,
      belts: belts.buffer,
      inserters: inserters.buffer,
      power: power.buffer,
      chunkWindow: batch?.window ?? null,
      chunks,
      inspected,
      entityDetail: detail?.buffer ?? null,
      networkDetail: network?.buffer ?? null,
    },
    transfer,
  );
}

/** Runs `next` from now on, from its current tick. */
function start(next: Sim): void {
  sim = next;
  // A fresh streamer resends every chunk in the window, replacing the main
  // thread's copies from the previous world.
  streamer = new ChunkStreamer(next.state.world);
  if (viewport) {
    streamer.setViewport(viewport);
  }
  clock.reset();
  clock.advance(scaledNow());
  statTicks = statStepMs = statDropped = 0;
  inspected = 0;
  schedule();
}

async function handle(msg: MainToWorker): Promise<void> {
  switch (msg.type) {
    case 'init': {
      scene = null;
      const name = msg.renderScene;
      if (name !== undefined) {
        // Production builds never send it, and reject it (a compile-time check).
        if (!(import.meta.env.DEV || import.meta.env.MODE === 'test')) {
          throw new Error('render scenes are only available in dev and test builds');
        }
        if (!isRenderScene(name)) {
          throw new Error(`unknown render scene: ${String(name)}`);
        }
        if (!isGridScene(name) && BENCH_SCENES.includes(name)) {
          // A benchmark scene, built through commands like the benchmark does.
          const { SCENES } = await import('../../tools/bench/scenes/index');
          start(SCENES.find((s) => s.name === name)!.build().sim);
          return;
        }
        scene = new RenderScene(name);
      }
      const startingKit = validateKit(msg.startingKit);
      const researched = validateResearched(msg.researched);
      // Continue from a save; if it can't be read, start a new game and say why.
      let loaded: Sim | null = null;
      let loadError: string | null = null;
      if (msg.save) {
        try {
          loaded = loadSim(await gunzip(new Uint8Array(msg.save)));
        } catch (err) {
          loadError = err instanceof Error ? err.message : String(err);
        }
      }
      start(
        loaded ??
          new Sim({
            seed: msg.seed,
            ...(startingKit && { startingKit }),
            ...(researched && { researched }),
          }),
      );
      if (msg.save) {
        post({ type: 'loaded', meta: loaded && saveMetaOf(loaded), error: loadError });
      }
      break;
    }
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
    case 'inspect':
      if (!Number.isInteger(msg.entity) || msg.entity < 0 || msg.entity > 0xffff_ffff) {
        throw new Error(`invalid entity to inspect: ${String(msg.entity)}`);
      }
      inspected = msg.entity;
      break;
    case 'setTimeScale': {
      // Production builds never send it, and reject it (a compile-time check).
      if (!(import.meta.env.DEV || import.meta.env.MODE === 'test')) {
        throw new Error('setTimeScale is only available in dev and test builds');
      }
      if (!Number.isInteger(msg.scale) || msg.scale < 1 || msg.scale > MAX_TIME_SCALE) {
        throw new Error(`invalid time scale: ${String(msg.scale)}`);
      }
      scaledBase = scaledNow();
      realBase = performance.now();
      timeScale = msg.scale;
      // The catch-up cap scales too, so a sped-up batch isn't dropped as backlog.
      clock = new FixedStepClock(STEP_MS, MAX_CATCH_UP_TICKS * timeScale);
      clock.advance(scaledNow());
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (sim) schedule();
      break;
    }
    case 'setViewport':
      viewport = sanitizeViewport(msg.viewport);
      streamer?.setViewport(viewport);
      break;
    case 'save':
      saveGame(msg.id);
      break;
    case 'setPaused':
      if (typeof msg.paused !== 'boolean') {
        throw new Error(`invalid pause flag: ${String(msg.paused)}`);
      }
      setPaused(msg.paused);
      break;
  }
}

/**
 * Stops or restarts the tick loop. Pausing only stops running ticks (the
 * simulation itself is untouched, so determinism holds); resuming restarts
 * the clock, so the time spent paused is neither caught up nor counted as
 * dropped ticks.
 */
function setPaused(next: boolean): void {
  if (next === paused) return;
  paused = next;
  if (paused) {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    return;
  }
  clock.reset();
  clock.advance(scaledNow());
  if (sim) schedule();
}

/**
 * Serializes the simulation between two ticks (synchronously, so the save
 * is of one tick), then gzips it off the message queue and sends it.
 */
function saveGame(id: number): void {
  if (!sim) throw new Error('save requested before init');
  let bytes: Uint8Array;
  const meta = saveMetaOf(sim);
  try {
    bytes = saveSim(sim);
  } catch (err) {
    post({ type: 'saved', id, data: null, meta: null, error: String(err) });
    return;
  }
  gzip(bytes).then(
    (packed) => {
      const data = packed.buffer;
      post({ type: 'saved', id, data, meta, error: null }, [data]);
    },
    (err: unknown) => {
      post({ type: 'saved', id, data: null, meta: null, error: String(err) });
    },
  );
}

/** Checks an `init` message's starting kit: known items, counts in [1, 65535]. */
function validateKit(kit: unknown): ItemStack[] | undefined {
  if (kit === undefined) return undefined;
  if (!Array.isArray(kit)) throw new Error('invalid starting kit');
  return kit.map((s: unknown) => {
    const { item, count } = (s ?? {}) as { item?: unknown; count?: unknown };
    if (
      typeof item !== 'number' ||
      itemPrototype(item) === undefined ||
      typeof count !== 'number' ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > MAX_STACK_SIZE
    ) {
      throw new Error(`invalid starting kit entry: ${JSON.stringify(s)}`);
    }
    return { item: item as RealItemId, count };
  });
}

/** Checks an `init` message's researched technologies: known technology ids. */
function validateResearched(techs: unknown): number[] | undefined {
  if (techs === undefined) return undefined;
  if (!Array.isArray(techs)) throw new Error('invalid researched technologies');
  return techs.map((t: unknown) => {
    if (typeof t !== 'number' || technologyPrototype(t) === undefined) {
      throw new Error(`invalid researched technology: ${JSON.stringify(t)}`);
    }
    return t;
  });
}

/**
 * Messages are handled one at a time, in order: loading a save is
 * asynchronous (decompression), and so is building a benchmark render scene
 * (a dynamic import); commands sent meanwhile must reach the new game, not
 * the one before it.
 */
let inbox: Promise<void> = Promise.resolve();

self.onmessage = (event: MessageEvent<MainToWorker>) => {
  inbox = inbox
    .then(() => handle(event.data))
    .catch((err: unknown) => {
      post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
    });
};

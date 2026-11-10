/**
 * The GPU belt demo page (`demo/gpu/`, README.md): one million conveyor items
 * stepped by a WebGPU compute shader and drawn from the same storage buffers.
 *
 * URL parameters: `?n=` the item count (default 1 000 000, capped by the
 * device's limits), `?quads=` item quads per instance of the item draw
 * (default 64, 1 for one quad per instance), `?paused=1` don't step on its own
 * (the tests step through `window.__gpuDemo`).
 */

import { DEFAULT_QUADS_PER_INSTANCE, GpuBeltSim, fitView, maxItems } from './gpu';
import { GROUP_COUNT, buildNetwork } from './network';
import { Counter, ITEM_TYPES, initItems, type Items } from './sim';

/** Simulation ticks per second, as in the game. */
const TICKS_PER_SECOND = 60;
/** At most this many ticks per rendered frame: a slow device runs slower instead of stalling. */
const MAX_STEPS_PER_FRAME = 4;
/** How often the counters are read back, in milliseconds. */
const READBACK_MS = 500;
const DEFAULT_ITEMS = 1_000_000;

/** What the page exposes for the headless tests (`tests/gpu/`). */
export interface GpuDemoHook {
  /** Set once the GPU is set up and the first frame is drawn, or the start failed. */
  state: 'starting' | 'running' | 'failed';
  error: string | null;
  adapter: string;
  items: number;
  segments: number;
  frames: number;
  tick(): number;
  /** Steps `steps` ticks and waits until the GPU has done them. */
  step(steps: number): Promise<void>;
  /** The full item state (small item counts only), as plain arrays. */
  read(): Promise<{ belt: number[]; progress: number[]; itemType: number[] }>;
  counters(): Promise<{ tick: number; counters: number[] }>;
}

declare global {
  interface Window {
    __gpuDemo?: GpuDemoHook;
  }
}

const hud = document.getElementById('hud')!;
const message = document.getElementById('gpu-message')!;
const canvas = document.getElementById('gpu-canvas') as HTMLCanvasElement;

const hook: GpuDemoHook = {
  state: 'starting',
  error: null,
  adapter: '',
  items: 0,
  segments: 0,
  frames: 0,
  tick: () => 0,
  step: () => Promise.reject(new Error('not started')),
  read: () => Promise.reject(new Error('not started')),
  counters: () => Promise.reject(new Error('not started')),
};
window.__gpuDemo = hook;

function fail(text: string): void {
  hook.state = 'failed';
  hook.error = text;
  message.textContent = text;
  message.hidden = false;
  hud.hidden = true;
}

/** URL parameter `name` as a positive integer (`_` separators allowed), or `fallback`. */
function positiveInt(params: URLSearchParams, name: string, fallback: number): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const n = Number(raw.replace(/_/g, ''));
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

async function start(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const paused = params.get('paused') === '1';
  if (!('gpu' in navigator) || !navigator.gpu) {
    fail(
      'WebGPU is not available in this browser. This demo needs a browser with WebGPU ' +
        '(a recent Chrome, Edge or Safari, or Firefox with WebGPU enabled) on a secure page ' +
        '(https or localhost).',
    );
    return;
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) {
    fail('WebGPU is available, but no GPU adapter was found (it may be blocklisted or disabled).');
    return;
  }
  const info = adapter.info;
  hook.adapter = [info.vendor, info.architecture, info.description].filter(Boolean).join(' / ');
  const device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
    },
  });
  void device.lost.then((lost) => {
    if (lost.reason !== 'destroyed') fail(`The GPU device was lost: ${lost.message}`);
  });
  device.addEventListener('uncapturederror', (e) => {
    fail(`WebGPU error: ${e.error.message}`);
  });

  const requested = positiveInt(params, 'n', DEFAULT_ITEMS);
  const quads = Math.min(positiveInt(params, 'quads', DEFAULT_QUADS_PER_INSTANCE), 1024);
  const capacity = maxItems(device.limits);
  const n = Math.min(requested, capacity);
  const net = buildNetwork();
  const initial: Items = initItems(n, net);

  const context = canvas.getContext('webgpu');
  if (!context) {
    fail('Could not get a WebGPU canvas context.');
    return;
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  device.pushErrorScope('validation');
  const sim = new GpuBeltSim(device, format, net, initial, quads);
  const setupError = await device.popErrorScope();
  if (setupError) {
    fail(`Could not set up the GPU pipelines: ${setupError.message}`);
    return;
  }

  hook.items = n;
  hook.segments = net.count;
  hook.tick = () => sim.tick;
  hook.step = async (steps) => {
    sim.step(steps);
    await device.queue.onSubmittedWorkDone();
  };
  hook.read = async () => {
    const items = await sim.readItems();
    return {
      belt: Array.from(items.belt),
      progress: Array.from(items.progress),
      itemType: Array.from(items.itemType),
    };
  };
  hook.counters = async () => {
    for (;;) {
      const pending = sim.readCounters();
      if (pending) {
        const { tick, counters } = await pending;
        return { tick, counters: Array.from(counters) };
      }
      await new Promise((r) => setTimeout(r, 20));
    }
  };

  const clamped =
    n < requested ? ` (capped from ${formatCount(requested)} by the device's limits)` : '';
  let counters: Uint32Array | null = null;
  let countersTick = 0;
  let lastReadback = -Infinity;
  let last = performance.now();
  let pending = 0;
  let rateStart = last;
  let rateTicks = 0;
  let rateFrames = 0;
  let tps = 0;
  let fps = 0;

  const resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  };

  const drawHud = (): void => {
    const lines = [
      `Beltworks GPU demo: ${formatCount(n)} items${clamped} on ${String(net.count)} belt segments`,
      `adapter: ${hook.adapter || 'unknown'}`,
      `tick ${formatCount(sim.tick)}${paused ? ' (paused)' : ''}, ${tps.toFixed(0)} ticks/s, ${fps.toFixed(1)} fps`,
    ];
    if (counters) {
      const groups = ['trunk', 'branch A', 'branch B'].slice(0, GROUP_COUNT);
      lines.push(
        `at tick ${formatCount(countersTick)}: ` +
          groups.map((g, k) => `${g} ${formatCount(counters![Counter.groups + k]!)}`).join(', '),
        `types: ${Array.from({ length: ITEM_TYPES }, (_, k) => formatCount(counters![Counter.types + k]!)).join(' / ')}, ` +
          `checksum ${counters[Counter.checksum]!.toString(16).padStart(8, '0')}`,
      );
    }
    hud.textContent = lines.join('\n');
  };

  const frame = (now: number): void => {
    if (hook.state === 'failed') return;
    pending += Math.min(now - last, 250);
    last = now;
    const tickMs = 1000 / TICKS_PER_SECOND;
    let steps = Math.floor(pending / tickMs);
    pending -= steps * tickMs;
    if (steps > MAX_STEPS_PER_FRAME) {
      steps = MAX_STEPS_PER_FRAME;
      pending = 0;
    }
    if (!paused && steps > 0) {
      sim.step(steps);
      rateTicks += steps;
    }
    resize();
    const dpr = canvas.width / Math.max(1, canvas.clientWidth);
    const top = (hud.getBoundingClientRect().bottom + 8) * dpr;
    sim.render(
      context.getCurrentTexture().createView(),
      fitView(net, canvas.width, canvas.height, top),
    );
    hook.frames++;
    rateFrames++;
    if (hook.state === 'starting') hook.state = 'running';

    if (now - lastReadback >= READBACK_MS) {
      const read = sim.readCounters();
      if (read) {
        lastReadback = now;
        void read.then((r) => {
          counters = r.counters;
          countersTick = r.tick;
        });
      }
    }
    if (now - rateStart >= 1000) {
      tps = (rateTicks * 1000) / (now - rateStart);
      fps = (rateFrames * 1000) / (now - rateStart);
      rateStart = now;
      rateTicks = 0;
      rateFrames = 0;
    }
    drawHud();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

start().catch((e: unknown) => {
  fail(`The demo failed to start: ${e instanceof Error ? e.message : String(e)}`);
});

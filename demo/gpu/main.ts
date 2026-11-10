/**
 * The GPU belt demo page (`demo/gpu/`, README.md): one million conveyor items
 * stepped by a WebGPU compute shader and drawn from the same storage buffers.
 *
 * URL parameters: `?n=` the item count (default 1 000 000, capped by the
 * device's limits), `?quads=` item quads per instance of the item draw
 * (default 64, 1 for one quad per instance), `?paused=1` don't step on its own
 * (the tests step through `window.__gpuDemo`), `?capture=1` the deterministic
 * capture mode: no frame loop, `window.__step(k)` steps k ticks and draws one
 * frame (tools/gpu-demo/capture.mjs), `?timing=0` leave the measured step time
 * out of the overlay, so the same ticks give the same picture,
 * `?camera=film` (capture mode) the scripted film camera, a function of the
 * tick (`filmShot` in camera.ts), over `?filmticks=` ticks.
 *
 * Drag to pan, the wheel (or + and -) to zoom, 0 to see everything again, the
 * arrow keys to pan; a click places a belt on an empty tile or rotates the belt
 * on a tile (edit.ts).
 */

import {
  cameraView,
  clampCamera,
  filmEdits,
  filmShot,
  fitCamera,
  panBy,
  pixelToTile,
  tileToPixel,
  zoomAt,
  type Camera,
  type FilmShot,
  type Viewport,
} from './camera';
import { EditableNetwork, type EditResult } from './edit';
import { DEFAULT_QUADS_PER_INSTANCE, GpuBeltSim, maxItems, type StepTiming } from './gpu';
import { GROUP_COUNT, buildNetwork } from './network';
import { Counter, ITEM_TYPES, initItems, type Items } from './sim';

/** Simulation ticks per second, as in the game. */
const TICKS_PER_SECOND = 60;
/** At most this many ticks per rendered frame: a slow device runs slower instead of stalling. */
const MAX_STEPS_PER_FRAME = 4;
/** How often the counters are read back, in milliseconds. */
const READBACK_MS = 500;
const DEFAULT_ITEMS = 1_000_000;
/** The film's length in ticks when `?filmticks=` doesn't say (24 s at the game's 60 ticks/s). */
const DEFAULT_FILM_TICKS = 1440;
/** A pointer that moves more than this many CSS pixels while down pans instead of clicking. */
const DRAG_PIXELS = 4;

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
  /**
   * Waits for the GPU to go idle, then steps `steps` ticks without drawing and
   * says how long they took (the benchmark, tools/gpu-demo/bench.mjs).
   */
  timedStep(steps: number): Promise<StepTiming | null>;
  /** The full item state (small item counts only), as plain arrays. */
  read(): Promise<{ belt: number[]; progress: number[]; itemType: number[] }>;
  counters(): Promise<{ tick: number; counters: number[] }>;
  /**
   * A click on tile `(x, y)` (belt editing, edit.ts): places or rotates a
   * belt and writes the changed segments into the GPU's segment buffer. It
   * doesn't step or draw.
   */
  edit(x: number, y: number): EditResult;
  /** The network on the CPU side: `count` segments of 8 words. */
  network(): { count: number; segments: number[] };
  /** The GPU's segment buffer, read back. */
  readSegments(): Promise<number[]>;
  camera(): Camera;
  /** Moves the camera (not in film mode, where the script owns it). */
  setCamera(camera: Camera): void;
  /** The CSS pixel position, in the page, of the tile coordinate `(x, y)` at the current camera. */
  tileToClient(x: number, y: number): [number, number];
}

/** What `window.__step` resolves with (capture mode). */
export interface CaptureStep {
  /** The tick the frame shows: ticks stepped so far. */
  tick: number;
  /** Frames drawn so far, this one included. */
  frames: number;
  /** How long the k ticks took, or `null` for `__step(0)`. */
  timing: StepTiming | null;
  /** The camera the frame was drawn with. */
  camera: Camera;
}

declare global {
  interface Window {
    __gpuDemo?: GpuDemoHook;
    /**
     * Capture mode only (`?capture=1`): steps exactly `k` ticks, draws one
     * frame and resolves once the GPU has finished it. The same item count
     * and the same calls give the same frames.
     */
    __step?: (k: number) => Promise<CaptureStep>;
  }
}

const hud = document.getElementById('hud')!;
const message = document.getElementById('gpu-message')!;
const canvas = document.getElementById('gpu-canvas') as HTMLCanvasElement;
const caption = document.getElementById('caption')!;
const endCard = document.getElementById('end-card')!;
const clickMark = document.getElementById('click-mark')!;

const hook: GpuDemoHook = {
  state: 'starting',
  error: null,
  adapter: '',
  items: 0,
  segments: 0,
  frames: 0,
  tick: () => 0,
  step: () => Promise.reject(new Error('not started')),
  timedStep: () => Promise.reject(new Error('not started')),
  read: () => Promise.reject(new Error('not started')),
  counters: () => Promise.reject(new Error('not started')),
  edit: () => ({ kind: 'refused', reason: 'not started', changed: [] }),
  network: () => ({ count: 0, segments: [] }),
  readSegments: () => Promise.reject(new Error('not started')),
  camera: () => ({ x: 0, y: 0, zoom: 1 }),
  setCamera: () => {},
  tileToClient: () => [0, 0],
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

/**
 * Whether the adapter is a software one (SwiftShader and the like): the
 * overlay and the film's end card say so, so a CPU run isn't taken for a GPU.
 */
function isSoftware(info: GPUAdapterInfo, name: string): boolean {
  const fallback = (info as GPUAdapterInfo & { isFallbackAdapter?: boolean }).isFallbackAdapter;
  return fallback === true || /swiftshader|llvmpipe|lavapipe|warp|software/i.test(name);
}

async function start(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const capture = params.get('capture') === '1';
  const paused = capture || params.get('paused') === '1';
  const showTiming = params.get('timing') !== '0';
  const film = capture && params.get('camera') === 'film';
  const filmTicks = positiveInt(params, 'filmticks', DEFAULT_FILM_TICKS);
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
  const software = isSoftware(info, hook.adapter);
  const adapterText = software
    ? `${hook.adapter || 'unknown'} (software: WebGPU on the CPU, not a GPU)`
    : hook.adapter || 'unknown';
  // Timestamp queries time the step on the GPU itself; without them the overlay uses the wall clock.
  const timestampQuery = adapter.features.has('timestamp-query');
  const device = await adapter.requestDevice({
    ...(timestampQuery && { requiredFeatures: ['timestamp-query'] }),
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
  const net = new EditableNetwork(buildNetwork());
  const initial: Items = initItems(n, net);

  const context = canvas.getContext('webgpu');
  if (!context) {
    fail('Could not get a WebGPU canvas context.');
    return;
  }
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  device.pushErrorScope('validation');
  const sim = new GpuBeltSim(device, format, net, initial, quads, net.capacity);
  const setupError = await device.popErrorScope();
  if (setupError) {
    fail(`Could not set up the GPU pipelines: ${setupError.message}`);
    return;
  }

  hook.items = n;
  hook.segments = net.count;
  hook.tick = () => sim.tick;
  hook.step = async (steps) => {
    void sim.step(steps);
    await device.queue.onSubmittedWorkDone();
  };
  hook.timedStep = async (steps) => {
    await device.queue.onSubmittedWorkDone();
    return sim.step(steps, true);
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

  let camera: Camera = fitCamera(net);
  let lastEdit = '';
  const applyEdit = (x: number, y: number): EditResult => {
    const r = net.edit(x, y);
    if (r.changed.length > 0) sim.updateSegments(net, r.changed);
    const where = `(${String(x)}, ${String(y)})`;
    lastEdit =
      r.kind === 'refused'
        ? `can't edit ${where}: ${r.reason}`
        : `${r.kind} belt at ${where}, tick ${formatCount(sim.tick)}`;
    return r;
  };
  hook.edit = applyEdit;
  hook.network = () => ({ count: net.count, segments: Array.from(net.segments) });
  hook.readSegments = async () => Array.from(await sim.readSegments());
  hook.camera = () => camera;
  hook.setCamera = (c) => {
    if (!film) camera = clampCamera(net, c);
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
  let timing: StepTiming | null = null;
  let timingPending = false;
  let captureSteps = 0;

  const resize = (): void => {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  };

  const label = (source: StepTiming['source']): string =>
    source === 'gpu timestamps' ? 'GPU timestamps' : 'wall clock';
  const timingSource = label(sim.hasTimestamps ? 'gpu timestamps' : 'wall clock');
  const stepTime = (): string => {
    if (!showTiming) return `hidden (timing=0), timed by ${timingSource}`;
    if (!timing) return `measuring (${timingSource})...`;
    const ms = timing.msPerStep;
    return (
      `${ms.toFixed(ms < 10 ? 3 : 1)} ` +
      `(${label(timing.source)}, over ${formatCount(timing.steps)} ticks)`
    );
  };

  const drawHud = (): void => {
    const lines = [
      `Beltworks GPU demo: ${formatCount(n)} items${clamped} on ${String(net.count)} belt segments`,
      `adapter: ${adapterText}`,
      capture
        ? `tick ${formatCount(sim.tick)}, capture mode: ${formatCount(captureSteps)} ticks for this frame`
        : `tick ${formatCount(sim.tick)}${paused ? ' (paused)' : ''}, ${tps.toFixed(0)} ticks/s, ${fps.toFixed(1)} fps`,
      `simulation ms/step: ${stepTime()}`,
      `view ${camera.zoom.toFixed(1)}x` +
        (lastEdit
          ? `, last edit: ${lastEdit}`
          : film || capture
            ? ''
            : ': drag to pan, wheel to zoom, click to place or rotate a belt'),
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

  /** Device pixels per CSS pixel. */
  const dpr = (): number => canvas.width / Math.max(1, canvas.clientWidth);
  /** The canvas in device pixels, minus the rows under the overlay. */
  const viewport = (): Viewport => ({
    width: canvas.width,
    height: canvas.height,
    top: (hud.getBoundingClientRect().bottom + 8) * dpr(),
  });
  hook.tileToClient = (x, y) => {
    const [px, py] = tileToPixel(net, camera, viewport(), x, y);
    const rect = canvas.getBoundingClientRect();
    return [rect.left + px / dpr(), rect.top + py / dpr()];
  };

  const draw = (): void => {
    resize();
    sim.render(context.getCurrentTexture().createView(), cameraView(net, camera, viewport()));
    hook.frames++;
  };

  /** The film's overlays for `shot`: the caption, the clicked tile's ring and the end card. */
  const showFilm = (shot: FilmShot): void => {
    caption.textContent = shot.caption;
    caption.hidden = shot.caption === '';
    endCard.hidden = !shot.endCard;
    clickMark.hidden = shot.click === null;
    if (shot.click) {
      const vp = viewport();
      const [x0, y0] = tileToPixel(net, camera, vp, shot.click.x, shot.click.y);
      const [x1, y1] = tileToPixel(net, camera, vp, shot.click.x + 1, shot.click.y + 1);
      const d = dpr();
      Object.assign(clickMark.style, {
        left: `${String(x0 / d)}px`,
        top: `${String(y0 / d)}px`,
        width: `${String((x1 - x0) / d)}px`,
        height: `${String((y1 - y0) / d)}px`,
      });
    }
  };
  if (film) {
    document.getElementById('end-adapter')!.textContent = adapterText;
    document.getElementById('end-items')!.textContent =
      `${formatCount(n)} items on ${String(net.count)} belt segments`;
    const note = document.getElementById('end-software')!;
    note.hidden = !software;
    const name = /swiftshader/i.test(hook.adapter) ? 'SwiftShader' : 'a software adapter';
    note.textContent =
      `Recorded on ${name}: WebGPU running on the CPU, not a GPU. ` +
      'Captured frame by frame, not in real time: live, this machine draws one million ' +
      'items at a frame every few seconds.';
  }
  /** Film mode: the camera and overlays the script gives for the current tick. */
  const filmFrame = (): void => {
    if (!film) return;
    const shot = filmShot(net, sim.tick, filmTicks, formatCount(n));
    camera = shot.camera;
    showFilm(shot);
  };

  // Pan, zoom and click. The film's camera is scripted, so it takes no input.
  if (!film) {
    let down: { id: number; x: number; y: number; dragged: boolean } | null = null;
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = { id: e.pointerId, x: e.clientX, y: e.clientY, dragged: false };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!down || down.id !== e.pointerId) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (!down.dragged && Math.hypot(dx, dy) < DRAG_PIXELS) return;
      down.dragged = true;
      camera = panBy(net, camera, viewport(), dx * dpr(), dy * dpr());
      down.x = e.clientX;
      down.y = e.clientY;
    });
    canvas.addEventListener('pointerup', (e) => {
      if (!down || down.id !== e.pointerId) return;
      const click = !down.dragged;
      down = null;
      if (!click) return;
      const rect = canvas.getBoundingClientRect();
      const [tx, ty] = pixelToTile(
        net,
        camera,
        viewport(),
        (e.clientX - rect.left) * dpr(),
        (e.clientY - rect.top) * dpr(),
      );
      applyEdit(Math.floor(tx), Math.floor(ty));
      drawHud();
    });
    canvas.addEventListener('pointercancel', () => {
      down = null;
    });
    canvas.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const scale = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 800 : 1;
        camera = zoomAt(
          net,
          camera,
          viewport(),
          (e.clientX - rect.left) * dpr(),
          (e.clientY - rect.top) * dpr(),
          Math.exp(-e.deltaY * scale * 0.0015),
        );
      },
      { passive: false },
    );
    window.addEventListener('keydown', (e) => {
      const vp = viewport();
      const step = 60 * dpr();
      const center = (factor: number): Camera =>
        zoomAt(net, camera, vp, vp.width / 2, vp.top + (vp.height - vp.top) / 2, factor);
      const keys: Record<string, () => Camera> = {
        ArrowLeft: () => panBy(net, camera, vp, step, 0),
        ArrowRight: () => panBy(net, camera, vp, -step, 0),
        ArrowUp: () => panBy(net, camera, vp, 0, step),
        ArrowDown: () => panBy(net, camera, vp, 0, -step),
        '+': () => center(1.25),
        '=': () => center(1.25),
        '-': () => center(0.8),
        '0': () => fitCamera(net),
      };
      const move = keys[e.key];
      if (!move) return;
      e.preventDefault();
      camera = move();
    });
  }

  if (capture) {
    // No frame loop and no clock: each frame is exactly the ticks `__step` was asked for.
    const readCounters = async (): Promise<void> => {
      const r = await hook.counters();
      counters = Uint32Array.from(r.counters);
      countersTick = r.tick;
    };
    // The film's scripted clicks, applied when the tick reaches theirs, however `__step` gets there.
    const edits = film ? filmEdits(net, filmTicks) : [];
    let nextEdit = 0;
    let busy = false;
    const captureStep = async (k: number): Promise<CaptureStep> => {
      if (!Number.isSafeInteger(k) || k < 0) throw new Error(`__step: bad tick count ${String(k)}`);
      if (busy) throw new Error('__step: the previous step has not finished');
      if (hook.state === 'failed') throw new Error(hook.error ?? 'failed');
      busy = true;
      try {
        const target = sim.tick + k;
        let t: StepTiming | null = null;
        for (;;) {
          while (nextEdit < edits.length && edits[nextEdit]!.tick <= sim.tick) {
            applyEdit(edits[nextEdit]!.x, edits[nextEdit]!.y);
            nextEdit++;
          }
          if (sim.tick >= target) break;
          const stop = nextEdit < edits.length ? Math.min(target, edits[nextEdit]!.tick) : target;
          await device.queue.onSubmittedWorkDone();
          t = (await sim.step(stop - sim.tick, true)) ?? t;
        }
        if (t) timing = t;
        captureSteps = k;
        await readCounters();
        filmFrame();
        drawHud();
        draw();
        await device.queue.onSubmittedWorkDone();
        return { tick: sim.tick, frames: hook.frames, timing: t, camera };
      } finally {
        busy = false;
      }
    };
    await readCounters();
    filmFrame();
    drawHud();
    draw();
    await device.queue.onSubmittedWorkDone();
    window.__step = captureStep;
    if (hook.state === 'starting') hook.state = 'running';
    return;
  }

  let lastTiming = -Infinity;
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
      // Time one step submission now and then; the wall clock needs a wait for the GPU.
      const timed = !timingPending && now - lastTiming >= READBACK_MS;
      const result = sim.step(steps, timed);
      if (timed) {
        timingPending = true;
        lastTiming = now;
        void result.then((t) => {
          timingPending = false;
          if (t) timing = t;
        });
      }
      rateTicks += steps;
    }
    draw();
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

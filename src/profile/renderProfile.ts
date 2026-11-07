/**
 * Dev and test builds only: the scripted render profile (docs/TOOLING.md,
 * "Render profile"). It moves the camera through a fixed list of stages
 * (bare terrain and the `?scene=` factory at several zoom levels, standing
 * still and panning), waits at each until the terrain around the view is
 * baked and the worker has sent the scene, then records every rendered
 * frame for a while:
 *
 * - `interval`: the time between two frames (from one ticker run to the
 *   next). It includes whatever the GPU (or a software renderer) needs
 *   before the browser can start the next frame, so it is the frame time a
 *   player sees; at 60 Hz it can't go below ~16.7 ms.
 * - `work`: the main thread's time inside the frame (the game's ticker
 *   callbacks plus Pixi building and submitting the draw calls). It shows
 *   the JavaScript cost of rendering even where vsync caps `interval`.
 *
 * Each stage reports p50, p95, p99 and max of both, the mean frame rate,
 * the frames over 50 ms (hitches), and the terrain bakes that happened.
 */

import { UPDATE_PRIORITY, type Ticker } from 'pixi.js';
import { TILE_PX } from '../render/camera';
import type { GameView } from '../render/gameView';
import { chunkWindow } from '../worker/chunkStream';

/** One step of the profile: where the camera is, and how fast it pans (screen pixels per second). */
export interface ProfileStage {
  name: string;
  /** Camera center at the start, in tiles. */
  x: number;
  y: number;
  zoom: number;
  /** Panning speed in screen pixels per second (0: the camera stands still). */
  vx?: number;
  vy?: number;
  /**
   * Record from the moment the camera gets there, without waiting for the
   * terrain: the frames that bake it (a jump to a new place).
   */
  noWait?: boolean;
}

/** Bare terrain is profiled far south of the factory (which is centered on the spawn). */
const TERRAIN_Y = 200;

/**
 * The default stages. The `?scene=10k` benchmark factory spans about 176 ×
 * 165 tiles around the spawn (`grid-10k` 336 × 110), so at 0.25× it fills
 * the screen; the pans start inside its west half and head east.
 */
export const DEFAULT_STAGES: readonly ProfileStage[] = [
  { name: 'terrain 1x', x: 0, y: TERRAIN_Y, zoom: 1 },
  { name: 'terrain 0.5x', x: 0, y: TERRAIN_Y, zoom: 0.5 },
  { name: 'terrain 0.25x', x: 0, y: TERRAIN_Y, zoom: 0.25 },
  { name: 'factory 2x', x: 0, y: 0, zoom: 2 },
  { name: 'factory 1x', x: 0, y: 0, zoom: 1 },
  { name: 'factory 0.5x', x: 0, y: 0, zoom: 0.5 },
  { name: 'factory 0.25x', x: 0, y: 0, zoom: 0.25 },
  { name: 'pan factory 1x', x: -60, y: 0, zoom: 1, vx: 512 },
  { name: 'pan factory 0.5x', x: -60, y: 10, zoom: 0.5, vx: 512 },
  { name: 'pan terrain 1x', x: 0, y: TERRAIN_Y + 120, zoom: 1, vx: 512 },
  { name: 'jump terrain 1x', x: 400, y: TERRAIN_Y, zoom: 1, noWait: true },
];

export interface Percentiles {
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export interface StageResult {
  name: string;
  zoom: number;
  panning: boolean;
  frames: number;
  /** Mean frames per second over the stage. */
  fps: number;
  /** Time between frames, ms. */
  interval: Percentiles;
  /** Main-thread time inside a frame, ms. */
  work: Percentiles;
  /** Frames whose interval exceeded 50 ms. */
  hitches: number;
  /** Terrain textures baked during the stage. */
  bakes: number;
  /** What the view held at the end of the stage. */
  entities: number;
  belts: number;
  beltItems: number;
}

export interface ProfileReport {
  /** The WebGL renderer string, and whether it is a software renderer. */
  renderer: string;
  software: boolean;
  width: number;
  height: number;
  resolution: number;
  /** Terrain look and its texel cap. */
  terrain: 'rendered' | 'placeholder';
  maxTexels: number;
  stages: StageResult[];
}

export interface ProfileOptions {
  /** Stages to run (default `DEFAULT_STAGES`), or names of default stages. */
  stages?: readonly (ProfileStage | string)[];
  /** Recorded time per stage, ms (default 3000)... */
  durationMs?: number;
  /**
   * ...or longer, until at least this many frames were recorded (default 20;
   * software renderers can take seconds per frame), but at most 10 times
   * `durationMs`.
   */
  minFrames?: number;
  /** Frames rendered after the view is ready and before recording (default 30). */
  warmupFrames?: number;
  /** How long to wait for the terrain around a stage's view, ms (default 60 000). */
  readyTimeoutMs?: number;
}

/** p50, p95, p99, max and mean of `values` (zeros for none). */
export function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const mean = sorted.reduce((s, v) => s + v, 0) / sorted.length;
  return { p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted[sorted.length - 1]!, mean };
}

/** The report as a Markdown table. */
export function formatReport(report: ProfileReport): string {
  const f = (v: number) => v.toFixed(1);
  const lines = [
    `Renderer: ${report.renderer}${report.software ? ' (software)' : ''}, ${String(report.width)}×${String(report.height)} @${String(report.resolution)}x, terrain ${report.terrain} (≤ ${String(report.maxTexels)} texels/tile)`,
    '',
    '| Stage | fps | interval p50 / p95 / p99 / max (ms) | work p50 / p95 / p99 / max (ms) | >50 ms | bakes | entities / belts / items |',
    '|---|---:|---|---|---:|---:|---|',
  ];
  for (const s of report.stages) {
    lines.push(
      `| ${s.name} | ${f(s.fps)} | ${f(s.interval.p50)} / ${f(s.interval.p95)} / ${f(s.interval.p99)} / ${f(s.interval.max)} | ${f(s.work.p50)} / ${f(s.work.p95)} / ${f(s.work.p99)} / ${f(s.work.max)} | ${String(s.hitches)} | ${String(s.bakes)} | ${String(s.entities)} / ${String(s.belts)} / ${String(s.beltItems)} |`,
    );
  }
  return lines.join('\n');
}

const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });

/** Runs the profile on `view`, whose frames `ticker` drives. */
export async function runRenderProfile(
  view: GameView,
  ticker: Ticker,
  renderer: { name: string; software: boolean; width: number; height: number; resolution: number },
  options: ProfileOptions = {},
): Promise<ProfileReport> {
  const stages = (options.stages ?? DEFAULT_STAGES).map((s) => {
    if (typeof s !== 'string') return s;
    const stage = DEFAULT_STAGES.find((d) => d.name === s);
    if (!stage) throw new Error(`unknown profile stage "${s}"`);
    return stage;
  });
  const duration = options.durationMs ?? 3000;
  const minFrames = options.minFrames ?? 20;
  const warmup = options.warmupFrames ?? 30;
  const readyTimeout = options.readyTimeoutMs ?? 60_000;

  // Frame timing: the first ticker callback of a frame starts it, the last
  // (after Pixi's render, at LOW priority) ends it.
  let frameStart = 0;
  let lastStart = 0;
  let recording: { intervals: number[]; work: number[] } | null = null;
  let pan: { x: number; y: number; vx: number; vy: number; zoom: number; t0: number } | null = null;
  const start = () => {
    const now = performance.now();
    if (recording && lastStart > 0) recording.intervals.push(now - lastStart);
    lastStart = now;
    frameStart = now;
    if (pan) {
      const t = (now - pan.t0) / 1000;
      view.camera.set(pan.x + (pan.vx * t) / pan.zoom, pan.y + (pan.vy * t) / pan.zoom, pan.zoom);
    }
  };
  const end = () => {
    if (recording) recording.work.push(performance.now() - frameStart);
  };
  ticker.add(start, null, UPDATE_PRIORITY.INTERACTION + 1);
  ticker.add(end, null, UPDATE_PRIORITY.UTILITY - 1);

  const ready = (): boolean => {
    const expected = chunkWindow(view.camera.visibleTiles());
    const actual = view.terrain.chunkWindow;
    return (
      view.artSettled &&
      actual !== null &&
      expected.cx0 === actual.cx0 &&
      expected.cy0 === actual.cy0 &&
      expected.cx1 === actual.cx1 &&
      expected.cy1 === actual.cy1 &&
      view.terrain.isComplete()
    );
  };

  const results: StageResult[] = [];
  try {
    for (const stage of stages) {
      pan = null;
      view.following = false;
      view.camera.set(stage.x * TILE_PX, stage.y * TILE_PX, stage.zoom);
      const waitStart = performance.now();
      while (!stage.noWait && !ready() && performance.now() - waitStart < readyTimeout) {
        await nextFrame();
      }
      for (let i = 0; !stage.noWait && i < warmup; i++) await nextFrame();
      const panning = (stage.vx ?? 0) !== 0 || (stage.vy ?? 0) !== 0;
      const bakesBefore = view.terrain.bakeCount;
      lastStart = 0;
      recording = { intervals: [], work: [] };
      if (panning) {
        pan = {
          x: stage.x * TILE_PX,
          y: stage.y * TILE_PX,
          vx: stage.vx ?? 0,
          vy: stage.vy ?? 0,
          zoom: stage.zoom,
          t0: performance.now(),
        };
      }
      const t0 = performance.now();
      const done = () => {
        const t = performance.now() - t0;
        return t >= 10 * duration || (t >= duration && recording!.intervals.length >= minFrames);
      };
      while (!done()) await nextFrame();
      const elapsed = performance.now() - t0;
      const { intervals, work } = recording;
      recording = null;
      pan = null;
      const belts = view.belts.data;
      results.push({
        name: stage.name,
        zoom: stage.zoom,
        panning,
        frames: intervals.length,
        fps: (intervals.length * 1000) / elapsed,
        interval: percentiles(intervals),
        work: percentiles(work),
        hitches: intervals.filter((v) => v > 50).length,
        bakes: view.terrain.bakeCount - bakesBefore,
        entities: view.entityIndex.entities.length,
        belts: belts.length,
        beltItems: belts.reduce((n, b) => n + b.items.length, 0),
      });
    }
  } finally {
    ticker.remove(start, null);
    ticker.remove(end, null);
  }
  return {
    renderer: renderer.name,
    software: renderer.software,
    width: renderer.width,
    height: renderer.height,
    resolution: renderer.resolution,
    terrain: view.terrain.rendered ? 'rendered' : 'placeholder',
    maxTexels: view.terrain.maxTexels,
    stages: results,
  };
}

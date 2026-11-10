/**
 * The demo's camera: a center in tile coordinates and a zoom relative to the
 * view that fits the whole network (`fitView`). Pan and zoom by mouse, wheel
 * and keys in the page; in capture mode with `?camera=film` it follows
 * `filmShot`, a pure function of the tick, so the same ticks always give the
 * same picture (README.md, "Camera and the film").
 */

import type { ViewTransform } from './gpu';
import { DIRS, SegmentField, field, type Network } from './network';

export interface Camera {
  /** The tile coordinate shown at the center of the free area (below the overlay). */
  readonly x: number;
  readonly y: number;
  /** 1 fits the whole network; 2 shows half as many tiles across. */
  readonly zoom: number;
}

export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 32;

/** The pixel area the camera draws into: the canvas, minus the first `top` rows (the overlay). */
export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly top: number;
}

/** The camera that shows the whole network, as `fitView` does. */
export function fitCamera(net: Network): Camera {
  return { x: net.width / 2, y: net.height / 2, zoom: 1 };
}

/** `camera` with the zoom in [MIN_ZOOM, MAX_ZOOM] and the center on the grid. */
export function clampCamera(net: Network, camera: Camera): Camera {
  return {
    x: Math.min(Math.max(camera.x, 0), net.width),
    y: Math.min(Math.max(camera.y, 0), net.height),
    zoom: Math.min(Math.max(camera.zoom, MIN_ZOOM), MAX_ZOOM),
  };
}

/** Pixels per tile at `camera`. */
export function tilePixels(net: Network, camera: Camera, vp: Viewport): number {
  const free = Math.max(1, vp.height - vp.top);
  return Math.min(vp.width / net.width, free / net.height) * camera.zoom;
}

/** The pixel position of the tile coordinate `(x, y)`. */
export function tileToPixel(
  net: Network,
  camera: Camera,
  vp: Viewport,
  x: number,
  y: number,
): [number, number] {
  const tile = tilePixels(net, camera, vp);
  const free = Math.max(1, vp.height - vp.top);
  return [vp.width / 2 + (x - camera.x) * tile, vp.top + free / 2 + (y - camera.y) * tile];
}

/** The tile coordinate at pixel `(px, py)`: the inverse of `tileToPixel`. */
export function pixelToTile(
  net: Network,
  camera: Camera,
  vp: Viewport,
  px: number,
  py: number,
): [number, number] {
  const tile = tilePixels(net, camera, vp);
  const free = Math.max(1, vp.height - vp.top);
  return [camera.x + (px - vp.width / 2) / tile, camera.y + (py - vp.top - free / 2) / tile];
}

/**
 * The render transform for `camera` (see `View` in shaders.ts). At the fit
 * camera it equals `fitView`. Items are a twelfth of a tile, at least 1.5
 * pixels and at most 6 pixels across, so a close view still shows single items.
 */
export function cameraView(net: Network, camera: Camera, vp: Viewport): ViewTransform {
  const tile = tilePixels(net, camera, vp);
  const [ox, oy] = tileToPixel(net, camera, vp, 0, 0);
  const halfPx = Math.min(3, Math.max(0.75, tile / 24));
  return {
    scale: [(2 * tile) / vp.width, (-2 * tile) / vp.height],
    offset: [(2 * ox) / vp.width - 1, 1 - (2 * oy) / vp.height],
    half: [(2 * halfPx) / vp.width, (2 * halfPx) / vp.height],
  };
}

/** Zooms by `factor` about pixel `(px, py)`: the tile under it stays under it. */
export function zoomAt(
  net: Network,
  camera: Camera,
  vp: Viewport,
  px: number,
  py: number,
  factor: number,
): Camera {
  const [tx, ty] = pixelToTile(net, camera, vp, px, py);
  const zoom = Math.min(Math.max(camera.zoom * factor, MIN_ZOOM), MAX_ZOOM);
  const tile = tilePixels(net, { ...camera, zoom }, vp);
  const free = Math.max(1, vp.height - vp.top);
  return clampCamera(net, {
    x: tx - (px - vp.width / 2) / tile,
    y: ty - (py - vp.top - free / 2) / tile,
    zoom,
  });
}

/** Moves the camera by `(dx, dy)` pixels: the picture follows the pointer. */
export function panBy(net: Network, camera: Camera, vp: Viewport, dx: number, dy: number): Camera {
  const tile = tilePixels(net, camera, vp);
  return clampCamera(net, { x: camera.x - dx / tile, y: camera.y - dy / tile, zoom: camera.zoom });
}

/** The splitter's input segment: the one segment whose two successors differ, or -1. */
export function splitterSegment(net: Network): number {
  for (let s = 0; s < net.count; s++) {
    if (field(net, s, SegmentField.next0) !== field(net, s, SegmentField.next1)) return s;
  }
  return -1;
}

/** Where the film looks when it zooms in: the edge between the splitter and its outputs. */
export function splitterPoint(net: Network): [number, number] {
  const s = Math.max(0, splitterSegment(net));
  const [dx, dy] = DIRS[field(net, s, SegmentField.outDir)]!;
  return [field(net, s, SegmentField.x) + 0.5 + dx * 0.5, field(net, s, SegmentField.y) + 0.5 + dy];
}

/** One scripted belt click in the film: on `tick`, the tile `(x, y)` is edited. */
export interface FilmEdit {
  readonly tick: number;
  readonly x: number;
  readonly y: number;
}

/** What the film shows at one tick. */
export interface FilmShot {
  readonly camera: Camera;
  /** The caption under the picture, or '' for none. */
  readonly caption: string;
  /** Whether the end card covers the picture. */
  readonly endCard: boolean;
  /** The tile a scripted click marks, or null. */
  readonly click: { readonly x: number; readonly y: number } | null;
}

/** How deep the film zooms into the splitter. */
export const FILM_ZOOM = 6;

/** The film's phases, as fractions of its length in ticks. */
const PHASES = {
  wide: 0.14,
  zoomIn: 0.34,
  close: 0.6,
  zoomOut: 0.78,
  wideAgain: 0.87,
} as const;

const smoothstep = (t: number): number => {
  const u = Math.min(Math.max(t, 0), 1);
  return u * u * (3 - 2 * u);
};

/**
 * Between `a` and `b` at `t` in [0, 1]: the zoom on a log scale so it looks
 * steady, and the center moving in step with the view's width (1 / zoom), so
 * the place zoomed into stays in view all the way rather than drifting out.
 */
function between(a: Camera, b: Camera, t: number): Camera {
  const s = smoothstep(t);
  const zoom = Math.exp(Math.log(a.zoom) + (Math.log(b.zoom) - Math.log(a.zoom)) * s);
  const w = a.zoom === b.zoom ? 1 - s : (1 / zoom - 1 / b.zoom) / (1 / a.zoom - 1 / b.zoom);
  return { x: b.x + (a.x - b.x) * w, y: b.y + (a.y - b.y) * w, zoom };
}

/**
 * The tile the film rotates while it is close in: the first tile of the
 * splitter's straight output after the splitter's own output tile.
 */
export function filmEditTile(net: Network): [number, number] {
  const s = Math.max(0, splitterSegment(net));
  const [dx, dy] = DIRS[field(net, s, SegmentField.outDir)]!;
  return [field(net, s, SegmentField.x) + 2 * dx, field(net, s, SegmentField.y) + 2 * dy];
}

/**
 * The scripted clicks of a film `total` ticks long: three rotations of the
 * same belt while the camera is close (a right turn into nothing, so items
 * back up, then a left turn, then straight again, so they flow on).
 */
export function filmEdits(net: Network, total: number): FilmEdit[] {
  const [x, y] = filmEditTile(net);
  const span = PHASES.close - PHASES.zoomIn;
  return [0.2, 0.55, 0.8].map((f) => ({
    tick: Math.round(total * (PHASES.zoomIn + span * f)),
    x,
    y,
  }));
}

/**
 * The film at `tick` of `total` ticks: the whole factory, a zoom into the
 * splitter (where it rotates one belt and back), out again, and the end card.
 * A pure function of its arguments, so captures are repeatable and resumable.
 * `items` and `segments` only go into the captions.
 */
export function filmShot(net: Network, tick: number, total: number, items: string): FilmShot {
  const t = total > 0 ? tick / total : 0;
  const wide = fitCamera(net);
  const [sx, sy] = splitterPoint(net);
  // A little right of and below the splitter: both outputs and the edited belt are in view.
  const close: Camera = { x: sx + 3, y: sy + 1.5, zoom: FILM_ZOOM };
  const edits = filmEdits(net, total);
  const clickTicks = Math.max(4, Math.round(total * 0.02));
  const recent = edits.find((e) => tick >= e.tick && tick < e.tick + clickTicks);
  const click = recent ? { x: recent.x, y: recent.y } : null;
  if (t < PHASES.wide) {
    return {
      camera: wide,
      caption: `${items} items on ${String(net.count)} belt segments, all on the GPU`,
      endCard: false,
      click,
    };
  }
  if (t < PHASES.zoomIn) {
    const u = (t - PHASES.wide) / (PHASES.zoomIn - PHASES.wide);
    return { camera: between(wide, close, u), caption: 'Into the splitter', endCard: false, click };
  }
  if (t < PHASES.close) {
    const caption =
      edits[0] && tick < edits[0].tick
        ? 'The splitter: each item takes one output by a hash of its index and the tick'
        : 'Click a belt to rotate it: the network buffer is rewritten on the GPU, the items keep going';
    return { camera: close, caption, endCard: false, click };
  }
  if (t < PHASES.zoomOut) {
    const u = (t - PHASES.close) / (PHASES.zoomOut - PHASES.close);
    return { camera: between(close, wide, u), caption: 'And back out', endCard: false, click };
  }
  return {
    camera: wide,
    caption: t < PHASES.wideAgain ? `${items} items, stepped and drawn every frame` : '',
    endCard: t >= PHASES.wideAgain,
    click,
  };
}

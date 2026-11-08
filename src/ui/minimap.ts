/**
 * The minimap (plain DOM, D39, D53): a square canvas in the bottom-right
 * corner, toggled by the `minimap` key binding (`M` by default), showing
 * the map's colours (src/render/mapStore.ts: the terrain, ore, trees,
 * entity footprints and belts the main thread has seen) around the camera at one tile per CSS pixel, the rectangle on screen and
 * the local player. A click moves the camera there; dragging keeps the map
 * still under the pointer and moves the camera with it.
 *
 * Drawing is incremental. The chunks around the view live in a backing
 * canvas (`REGION_CHUNKS`² chunks at a pixel per tile); a chunk is copied
 * into it (`putImageData`, 4 KiB) only when its colours changed, and the
 * whole region only when the view moves out of it. Each frame then copies
 * the part on screen into the visible canvas and draws the two markers, and
 * only when something on it moved.
 */

import { TILE_PX, type Point } from '../render/camera';
import type { MapStore } from '../render/mapStore';
import { CHUNK_SHIFT, CHUNK_SIZE } from '../sim/world/chunk';
import { chunkKey } from '../sim/world/world';
import { actionFor } from './keybindings';

/** Edge length of the minimap in CSS pixels, and in tiles (one tile per pixel). */
export const MINIMAP_TILES = 200;
/** Edge of the backing region in chunks: the minimap plus at least a chunk around it. */
export const REGION_CHUNKS = Math.ceil(MINIMAP_TILES / CHUNK_SIZE) + 3;

const UNEXPLORED = '#15181c';
const VIEW_COLOR = 'rgba(255, 255, 255, 0.9)';
const PLAYER_COLOR = '#f2b134';
const PLAYER_OUTLINE = '#1a1206';

/** What the minimap shows: positions in tiles (fractional). */
export interface MinimapState {
  /** The camera's center. */
  center: Point;
  /** The tiles on screen: size of the camera's view, in tiles. */
  viewW: number;
  viewH: number;
  /** The local player, or `null` before the first snapshot. */
  player: Point | null;
}

/**
 * The top-left chunk of the backing region for a minimap centered on
 * `center` (tiles): the region's middle chunk holds the center.
 */
export function regionFor(center: Point): Point {
  const half = REGION_CHUNKS >> 1;
  return {
    x: Math.floor(center.x / CHUNK_SIZE) - half,
    y: Math.floor(center.y / CHUNK_SIZE) - half,
  };
}

/** Whether the minimap's tiles around `center` lie inside the region starting at chunk `region`. */
export function regionCovers(region: Point, center: Point): boolean {
  const half = MINIMAP_TILES / 2;
  const x0 = region.x * CHUNK_SIZE;
  const y0 = region.y * CHUNK_SIZE;
  const size = REGION_CHUNKS * CHUNK_SIZE;
  return (
    center.x - half >= x0 &&
    center.y - half >= y0 &&
    center.x + half <= x0 + size &&
    center.y + half <= y0 + size
  );
}

/** The tile under minimap pixel `(px, py)` (CSS pixels from its top-left) for a minimap centered on `center`. */
export function minimapTile(center: Point, px: number, py: number): Point {
  return { x: center.x + px - MINIMAP_TILES / 2, y: center.y + py - MINIMAP_TILES / 2 };
}

export class Minimap {
  /** The frame in the corner; hidden while the minimap is off. */
  readonly element: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  /** The chunks around the view at a pixel per tile. */
  private readonly back: HTMLCanvasElement;
  private readonly backCtx: CanvasRenderingContext2D;
  private region: Point | null = null;
  /** Per chunk key in the region: the version of its colours in `back` (absent: not drawn). */
  private readonly drawn = new Map<number, number>();
  private storeVersion = -1;
  /** What the visible canvas shows, so an unchanged frame draws nothing. */
  private shown = '';
  /** While dragging: the center the map stays at, so it doesn't move under the pointer. */
  private dragCenter: Point | null = null;
  private dragId: number | null = null;
  private latest: MinimapState | null = null;
  private resolution = 1;
  /**
   * The UI scale (src/ui/uiScale.ts), which magnifies the element around its
   * bottom-right corner; set by main.ts. The canvas draws at device pixels ×
   * this, so tiles stay crisp at any scale.
   */
  uiScale = 1;
  /** Chunks copied into the backing canvas so far (tests, the render profile). */
  chunkDraws = 0;

  /**
   * @param onMove Called with the tile (fractional) the camera should center on
   *   after a click or drag on the minimap.
   */
  constructor(
    parent: HTMLElement,
    private readonly store: MapStore,
    private readonly onMove: (tile: Point) => void,
  ) {
    const el = document.createElement('div');
    el.id = 'minimap';
    el.hidden = true;
    el.setAttribute('aria-label', 'Minimap');
    Object.assign(el.style, {
      position: 'fixed',
      right: '8px',
      bottom: '8px',
      width: `${String(MINIMAP_TILES)}px`,
      height: `${String(MINIMAP_TILES)}px`,
      border: '1px solid rgba(232, 226, 208, 0.35)',
      borderRadius: '4px',
      background: UNEXPLORED,
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.5)',
      overflow: 'hidden',
      zIndex: '20',
    } satisfies Partial<CSSStyleDeclaration>);
    const canvas = document.createElement('canvas');
    Object.assign(canvas.style, {
      display: 'block',
      width: '100%',
      height: '100%',
      cursor: 'crosshair',
      touchAction: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    el.append(canvas);
    parent.append(el);
    this.element = el;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.back = document.createElement('canvas');
    this.back.width = REGION_CHUNKS * CHUNK_SIZE;
    this.back.height = REGION_CHUNKS * CHUNK_SIZE;
    this.backCtx = this.back.getContext('2d')!;

    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
    window.addEventListener('keydown', (e) => {
      if (actionFor(e.code) === 'minimap' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this.toggle();
      }
    });
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  toggle(): void {
    this.setOpen(!this.isOpen);
  }

  setOpen(open: boolean): void {
    this.element.hidden = !open;
    if (!open) this.dragCenter = null;
    // Redraw everything on the next update.
    this.shown = '';
  }

  /** The center the minimap is drawn around now (tiles), or `null` before the first update. */
  get center(): Point | null {
    return this.dragCenter ?? this.latest?.center ?? null;
  }

  /** Brings the minimap up to date with `state`; call once per frame (does nothing while it is off). */
  update(state: MinimapState): void {
    this.latest = state;
    if (!this.isOpen) return;
    // The UI scale magnifies the element (a CSS transform): draw at that many more pixels.
    const resolution = Math.max(1, Math.round((window.devicePixelRatio || 1) * this.uiScale));
    if (resolution !== this.resolution || this.canvas.width !== MINIMAP_TILES * resolution) {
      this.resolution = resolution;
      this.canvas.width = MINIMAP_TILES * resolution;
      this.canvas.height = MINIMAP_TILES * resolution;
      this.shown = '';
    }
    const center = this.dragCenter ?? state.center;
    let changed = false;
    if (!this.region || !regionCovers(this.region, center)) {
      this.region = regionFor(center);
      this.drawn.clear();
      this.backCtx.fillStyle = UNEXPLORED;
      this.backCtx.fillRect(0, 0, this.back.width, this.back.height);
      this.storeVersion = -1;
    }
    if (this.storeVersion !== this.store.version) {
      this.storeVersion = this.store.version;
      changed = this.drawRegion(this.region);
    }
    // Quantize to device pixels: nothing to redraw until something moves by one.
    const q = (v: number) => Math.round(v * resolution);
    const p = state.player;
    const key = [
      q(center.x),
      q(center.y),
      q(state.center.x),
      q(state.center.y),
      q(state.viewW),
      q(state.viewH),
      p ? `${String(q(p.x))},${String(q(p.y))}` : '-',
      this.region.x,
      this.region.y,
    ].join(',');
    if (!changed && key === this.shown) return;
    this.shown = key;
    this.compose(center, state);
  }

  /** Copies the region's chunks whose colours changed into the backing canvas; whether any did. */
  private drawRegion(region: Point): boolean {
    let changed = false;
    for (let j = 0; j < REGION_CHUNKS; j++) {
      for (let i = 0; i < REGION_CHUNKS; i++) {
        const cx = region.x + i;
        const cy = region.y + j;
        const key = chunkKey(cx, cy);
        const chunk = this.store.get(cx, cy);
        const version = chunk && chunk.version > 0 ? chunk.version : 0;
        const had = this.drawn.get(key);
        if (version === 0) {
          if (had !== undefined) {
            // Dropped from the store: unexplored again.
            this.backCtx.fillStyle = UNEXPLORED;
            this.backCtx.fillRect(i * CHUNK_SIZE, j * CHUNK_SIZE, CHUNK_SIZE, CHUNK_SIZE);
            this.drawn.delete(key);
            changed = true;
          }
          continue;
        }
        if (had === version) continue;
        const px = chunk!.pixels;
        const image = new ImageData(
          new Uint8ClampedArray(px.buffer, px.byteOffset, px.byteLength),
          CHUNK_SIZE,
          CHUNK_SIZE,
        );
        this.backCtx.putImageData(image, i * CHUNK_SIZE, j * CHUNK_SIZE);
        this.drawn.set(key, version);
        this.chunkDraws++;
        changed = true;
      }
    }
    return changed;
  }

  /** Draws the visible canvas: the map around `center`, the view's rectangle and the player. */
  private compose(center: Point, state: MinimapState): void {
    const ctx = this.ctx;
    const r = this.resolution;
    const region = this.region!;
    const half = MINIMAP_TILES / 2;
    ctx.setTransform(r, 0, 0, r, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = UNEXPLORED;
    ctx.fillRect(0, 0, MINIMAP_TILES, MINIMAP_TILES);
    // Whole source pixels, so tiles stay crisp; the view moves by whole tiles on the map.
    const sx = Math.round(center.x - half - (region.x << CHUNK_SHIFT));
    const sy = Math.round(center.y - half - (region.y << CHUNK_SHIFT));
    ctx.drawImage(
      this.back,
      sx,
      sy,
      MINIMAP_TILES,
      MINIMAP_TILES,
      0,
      0,
      MINIMAP_TILES,
      MINIMAP_TILES,
    );
    // Map pixel of a tile position.
    const ox = (region.x << CHUNK_SHIFT) + sx;
    const oy = (region.y << CHUNK_SHIFT) + sy;
    const vx = state.center.x - state.viewW / 2 - ox;
    const vy = state.center.y - state.viewH / 2 - oy;
    ctx.strokeStyle = VIEW_COLOR;
    ctx.lineWidth = 1;
    ctx.strokeRect(
      Math.round(vx) + 0.5,
      Math.round(vy) + 0.5,
      Math.max(2, Math.round(state.viewW) - 1),
      Math.max(2, Math.round(state.viewH) - 1),
    );
    const p = state.player;
    if (p) {
      // Pinned to the edge when the player is off the map.
      const margin = 4;
      const x = Math.min(MINIMAP_TILES - margin, Math.max(margin, p.x - ox));
      const y = Math.min(MINIMAP_TILES - margin, Math.max(margin, p.y - oy));
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = PLAYER_COLOR;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = PLAYER_OUTLINE;
      ctx.stroke();
    }
  }

  private local(e: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) * MINIMAP_TILES) / rect.width,
      y: ((e.clientY - rect.top) * MINIMAP_TILES) / rect.height,
    };
  }

  /** The tile under the pointer (fractional), on the map as drawn now. */
  private tileAt(e: PointerEvent): Point | null {
    const center = this.center;
    if (!center) return null;
    const p = this.local(e);
    // Drawn from whole source pixels (see `compose`).
    const rounded = { x: Math.round(center.x), y: Math.round(center.y) };
    return minimapTile(rounded, p.x, p.y);
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.dragId !== null) return;
    e.preventDefault();
    const tile = this.tileAt(e);
    if (!tile) return;
    this.dragCenter = this.center;
    this.dragId = e.pointerId;
    this.canvas.setPointerCapture(e.pointerId);
    this.onMove(tile);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if (e.pointerId !== this.dragId) return;
    const tile = this.tileAt(e);
    if (tile) this.onMove(tile);
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.pointerId !== this.dragId) return;
    this.dragId = null;
    this.dragCenter = null;
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
  };
}

/** The minimap state for a camera at world pixels `(x, y)` showing `width` × `height` CSS pixels at `zoom`. */
export function minimapState(
  camera: { x: number; y: number; zoom: number; width: number; height: number },
  player: Point | null,
): MinimapState {
  const tilePx = TILE_PX * camera.zoom;
  return {
    center: { x: camera.x / TILE_PX, y: camera.y / TILE_PX },
    viewW: camera.width / tilePx,
    viewH: camera.height / tilePx,
    player: player && { x: player.x / TILE_PX, y: player.y / TILE_PX },
  };
}

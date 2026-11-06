/**
 * The 2D camera: which part of the world is on screen, and at what zoom.
 *
 * Camera math lives in the render layer only; the simulation never sees it.
 * World coordinates here are floats in "world pixels" (one tile is `TILE_PX`
 * world pixels at zoom 1), screen coordinates are CSS pixels relative to the
 * canvas' top-left corner.
 */

import type { Viewport } from '../worker/protocol';

/** Size of one tile in world pixels (and in screen pixels at zoom 1). */
export const TILE_PX = 32;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 4;

export interface Point {
  x: number;
  y: number;
}

export const clampZoom = (zoom: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));

export class Camera {
  /** World position shown at the center of the screen. */
  x = 0;
  y = 0;
  /** Screen pixels per world pixel, in [MIN_ZOOM, MAX_ZOOM]. */
  zoom = 1;
  /** Screen size in CSS pixels. */
  width = 0;
  height = 0;

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
  }

  /** Centers the view on world position `(x, y)` at the given zoom (clamped). */
  set(x: number, y: number, zoom: number = this.zoom): void {
    this.x = x;
    this.y = y;
    this.zoom = clampZoom(zoom);
  }

  screenToWorld(sx: number, sy: number): Point {
    return {
      x: this.x + (sx - this.width / 2) / this.zoom,
      y: this.y + (sy - this.height / 2) / this.zoom,
    };
  }

  worldToScreen(wx: number, wy: number): Point {
    return {
      x: (wx - this.x) * this.zoom + this.width / 2,
      y: (wy - this.y) * this.zoom + this.height / 2,
    };
  }

  /** Moves the view so the world follows a drag of `(dx, dy)` screen pixels. */
  dragBy(dx: number, dy: number): void {
    this.x -= dx / this.zoom;
    this.y -= dy / this.zoom;
  }

  /** Moves the view itself by `(dx, dy)` screen pixels (e.g. arrow keys). */
  panBy(dx: number, dy: number): void {
    this.x += dx / this.zoom;
    this.y += dy / this.zoom;
  }

  /**
   * Multiplies the zoom by `factor` (clamped to [MIN_ZOOM, MAX_ZOOM]) while
   * keeping the world point under screen position `(sx, sy)` fixed, so zooming
   * goes towards the cursor.
   */
  zoomAt(factor: number, sx: number, sy: number): void {
    const before = this.screenToWorld(sx, sy);
    this.zoom = clampZoom(this.zoom * factor);
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  /** Tile under screen position `(sx, sy)`. */
  tileAt(sx: number, sy: number): Point {
    const w = this.screenToWorld(sx, sy);
    return { x: Math.floor(w.x / TILE_PX), y: Math.floor(w.y / TILE_PX) };
  }

  /** The smallest whole-tile rectangle covering the screen. */
  visibleTiles(): Viewport {
    const topLeft = this.screenToWorld(0, 0);
    const bottomRight = this.screenToWorld(this.width, this.height);
    const x0 = Math.floor(topLeft.x / TILE_PX);
    const y0 = Math.floor(topLeft.y / TILE_PX);
    const x1 = Math.ceil(bottomRight.x / TILE_PX);
    const y1 = Math.ceil(bottomRight.y / TILE_PX);
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }
}

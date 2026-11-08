/**
 * Camera controls: drag with the middle mouse button or hold the arrow keys
 * to pan, scroll the mouse wheel to zoom towards the cursor (or towards the
 * screen center while the camera follows the player). Also tracks the
 * pointer position for the tile readout.
 */

import { actionFor, type Action } from '../ui/keybindings';
import type { Camera, Point } from './camera';

/** Arrow-key pan speed, in screen pixels per second (constant at every zoom). */
export const KEY_PAN_SPEED = 900;
/** Zoom exponent per wheel pixel: a 100 px mouse-wheel notch zooms by e^0.15 ≈ 1.16×. */
const WHEEL_ZOOM_PER_PIXEL = 0.0015;
/** Pixels per wheel delta unit for `WheelEvent.deltaMode` line (1) and page (2). */
const LINE_PX = 33;
const PAGE_PX = 800;
const MIDDLE_BUTTON = 1;

/** Pan direction per action; the keys (arrows by default) are rebindable (src/ui/keybindings.ts). */
const PAN_ACTIONS: Readonly<Partial<Record<Action, readonly [number, number]>>> = {
  panLeft: [-1, 0],
  panRight: [1, 0],
  panUp: [0, -1],
  panDown: [0, 1],
};

function panFor(code: string): readonly [number, number] | undefined {
  const action = actionFor(code);
  return action === null ? undefined : PAN_ACTIONS[action];
}

export class CameraInput {
  /** Pointer position over the canvas in CSS pixels, or `null` when it is outside. */
  pointer: Point | null = null;
  /** Called whenever the player pans the view by hand (arrow keys or drag). */
  onPan: (() => void) | null = null;
  /** Zoom around the screen center instead of the cursor (set while following the player). */
  zoomAroundCenter = false;
  private readonly held = new Set<string>();
  private drag: { id: number; x: number; y: number } | null = null;
  private readonly controller = new AbortController();

  constructor(
    private readonly camera: Camera,
    private readonly element: HTMLElement,
  ) {
    const opts = { signal: this.controller.signal };
    element.addEventListener('pointerdown', this.onPointerDown, opts);
    element.addEventListener('pointermove', this.onPointerMove, opts);
    element.addEventListener('pointerup', this.onPointerUp, opts);
    element.addEventListener('pointercancel', this.onPointerUp, opts);
    element.addEventListener('pointerleave', this.onPointerLeave, opts);
    // Stop the browser's middle-click autoscroll and context menu on the canvas.
    element.addEventListener('mousedown', preventMiddle, opts);
    element.addEventListener('auxclick', preventMiddle, opts);
    element.addEventListener('wheel', this.onWheel, { ...opts, passive: false });
    window.addEventListener('keydown', this.onKeyDown, opts);
    window.addEventListener('keyup', this.onKeyUp, opts);
    window.addEventListener('blur', this.onBlur, opts);
  }

  /** Applies held pan keys (the arrows by default) for a frame that took `dtMs` milliseconds. */
  update(dtMs: number): void {
    let dx = 0;
    let dy = 0;
    for (const key of this.held) {
      const dir = panFor(key);
      if (dir) {
        dx += dir[0];
        dy += dir[1];
      }
    }
    if (dx === 0 && dy === 0) {
      return;
    }
    // Cap the step so a long stall (e.g. a background tab) doesn't jump the view.
    const step = (KEY_PAN_SPEED * Math.min(dtMs, 100)) / 1000;
    const norm = dx !== 0 && dy !== 0 ? Math.SQRT1_2 : 1;
    this.camera.panBy(dx * step * norm, dy * step * norm);
    this.onPan?.();
  }

  destroy(): void {
    this.controller.abort();
  }

  private local(e: MouseEvent): Point {
    const rect = this.element.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.pointer = this.local(e);
    if (e.button !== MIDDLE_BUTTON || this.drag) {
      return;
    }
    e.preventDefault();
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
    this.element.setPointerCapture(e.pointerId);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    this.pointer = this.local(e);
    if (this.drag?.id !== e.pointerId) {
      return;
    }
    this.camera.dragBy(e.clientX - this.drag.x, e.clientY - this.drag.y);
    this.onPan?.();
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (this.drag?.id === e.pointerId) {
      this.drag = null;
      if (this.element.hasPointerCapture(e.pointerId)) {
        this.element.releasePointerCapture(e.pointerId);
      }
    }
  };

  private readonly onPointerLeave = (): void => {
    if (!this.drag) {
      this.pointer = null;
    }
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? PAGE_PX : 1;
    const p = this.local(e);
    this.pointer = p;
    const factor = Math.exp(-e.deltaY * unit * WHEEL_ZOOM_PER_PIXEL);
    if (this.zoomAroundCenter) {
      this.camera.zoomAt(factor, this.camera.width / 2, this.camera.height / 2);
    } else {
      this.camera.zoomAt(factor, p.x, p.y);
    }
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (panFor(e.code) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this.held.add(e.code);
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.held.clear();
  };
}

function preventMiddle(e: MouseEvent): void {
  if (e.button === MIDDLE_BUTTON) {
    e.preventDefault();
  }
}

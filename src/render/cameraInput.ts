/**
 * Camera controls: drag with the middle mouse button or hold the arrow keys
 * to pan; zoom with the mouse wheel, a trackpad pinch (ctrl+wheel, or
 * Safari's gesture events) or the zoom keys (`=` and `-` by default, and the
 * numpad's `+` and `-`). The wheel and a pinch zoom towards the cursor (or
 * towards the screen center while the camera follows the player), the keys
 * towards the screen center. Also tracks the pointer position for the tile
 * readout.
 *
 * The wheel is read over the canvas only, so scrolling a UI panel never
 * zooms. Its deltas differ a lot between platforms (D65): Chromium and
 * Firefox on Windows and Linux report about 100 pixels (or 3 lines) per
 * mouse-wheel notch, but macOS reports a notch as 4.000244140625 pixels, and
 * a pinch as ctrl+wheel of about `100 × ln(scale)` pixels, so one rate for
 * every delta made both nearly do nothing (#119). `wheelZoomFactor` turns
 * each kind into a zoom factor of its own.
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
/** One mouse-wheel notch on macOS (Chrome and Safari), in pixels; a fast spin sends a multiple. */
export const MAC_NOTCH_PX = 4.000244140625;
/** One mouse-wheel notch elsewhere, in pixels: what a macOS notch counts as. */
const NOTCH_PX = 100;
/**
 * Zoom exponent per pixel of a pinch (ctrl+wheel): browsers send about
 * `-100 × ln(scale)` for a pinch by `scale`, so the map follows the fingers.
 */
const PINCH_ZOOM_PER_PIXEL = 0.01;
/** The most pixels one ctrl+wheel event counts: a ctrl+notch (100 px) zooms by e^0.25 ≈ 1.28×. */
const MAX_PINCH_PX = 25;
/** Zoom factor of one press of a zoom key. */
export const KEY_ZOOM_STEP = 1.25;
/** Held this long (ms), a zoom key goes on zooming at `KEY_ZOOM_PER_SECOND`. */
const KEY_ZOOM_HOLD_MS = 250;
/** Zoom factor per second while a zoom key is held. */
const KEY_ZOOM_PER_SECOND = 3;
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

/**
 * Zoom direction of key `code`: 1 zooms in, -1 out, 0 not a zoom key. The
 * zoom actions' keys (`=` and `-` by default) and, unless an action is
 * bound to them, the numpad's `+` and `-`.
 */
export function zoomStepFor(code: string): -1 | 0 | 1 {
  const action = actionFor(code);
  if (action === 'zoomIn') return 1;
  if (action === 'zoomOut') return -1;
  if (action !== null) return 0;
  if (code === 'NumpadAdd') return 1;
  if (code === 'NumpadSubtract') return -1;
  return 0;
}

/**
 * The zoom factor for one wheel event (above 1 zooms in): a pinch
 * (`ctrlKey`) follows the fingers, capped per event so a ctrl+notch of a
 * mouse wheel is one step; a wheel notch zooms by about 1.16× however the
 * platform reports it, and a trackpad scroll zooms with the distance.
 */
export function wheelZoomFactor(e: Pick<WheelEvent, 'deltaY' | 'deltaMode' | 'ctrlKey'>): number {
  let px =
    e.deltaMode === 1 ? e.deltaY * LINE_PX : e.deltaMode === 2 ? e.deltaY * PAGE_PX : e.deltaY;
  if (e.deltaMode === 0 && px !== 0 && Number.isInteger(px / MAC_NOTCH_PX)) {
    px = (px / MAC_NOTCH_PX) * NOTCH_PX;
  }
  if (e.ctrlKey) {
    const capped = Math.max(-MAX_PINCH_PX, Math.min(MAX_PINCH_PX, px));
    return Math.exp(-capped * PINCH_ZOOM_PER_PIXEL);
  }
  return Math.exp(-px * WHEEL_ZOOM_PER_PIXEL);
}

/** Safari's trackpad pinch (`GestureEvent`, WebKit only): the scale since the gesture started. */
interface GestureLike extends UIEvent {
  readonly scale: number;
  readonly clientX: number;
  readonly clientY: number;
}

export class CameraInput {
  /** Pointer position over the canvas in CSS pixels, or `null` when it is outside. */
  pointer: Point | null = null;
  /** Called whenever the player pans the view by hand (arrow keys or drag). */
  onPan: (() => void) | null = null;
  /** Zoom around the screen center instead of the cursor (set while following the player). */
  zoomAroundCenter = false;
  private readonly held = new Set<string>();
  /** Zoom keys held, with when each was pressed (`performance.now()` ms). */
  private readonly zoomHeld = new Map<string, number>();
  /** Safari: the pinch's scale so far, while one is under way, else `null`. */
  private gestureScale: number | null = null;
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
    // Safari sends a trackpad pinch as gesture events, not ctrl+wheel; without
    // `preventDefault` it zooms the page instead.
    const gesture = { ...opts, passive: false };
    element.addEventListener('gesturestart', this.onGestureStart, gesture);
    element.addEventListener('gesturechange', this.onGestureChange, gesture);
    element.addEventListener('gestureend', this.onGestureEnd, gesture);
    window.addEventListener('keydown', this.onKeyDown, opts);
    window.addEventListener('keyup', this.onKeyUp, opts);
    window.addEventListener('blur', this.onBlur, opts);
  }

  /**
   * Applies held pan keys (the arrows by default) and zoom keys for a frame
   * that took `dtMs` milliseconds.
   */
  update(dtMs: number): void {
    // Cap the step so a long stall (e.g. a background tab) doesn't jump the view.
    const dt = Math.min(dtMs, 100);
    this.updateZoomKeys(dt);
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
    const step = (KEY_PAN_SPEED * dt) / 1000;
    const norm = dx !== 0 && dy !== 0 ? Math.SQRT1_2 : 1;
    this.camera.panBy(dx * step * norm, dy * step * norm);
    this.onPan?.();
  }

  /** Zooms by `factor` around the screen center (the zoom keys). */
  private zoomCenter(factor: number): void {
    this.camera.zoomAt(factor, this.camera.width / 2, this.camera.height / 2);
  }

  /** Zooms by `factor` towards screen point `p`, or the center while following the player. */
  private zoomToward(factor: number, p: Point): void {
    if (this.zoomAroundCenter) this.zoomCenter(factor);
    else this.camera.zoomAt(factor, p.x, p.y);
  }

  private updateZoomKeys(dt: number): void {
    if (this.zoomHeld.size === 0) return;
    const now = performance.now();
    let dir = 0;
    for (const [code, since] of this.zoomHeld) {
      if (now - since >= KEY_ZOOM_HOLD_MS) dir += zoomStepFor(code);
    }
    if (dir !== 0) this.zoomCenter(KEY_ZOOM_PER_SECOND ** ((Math.sign(dir) * dt) / 1000));
  }

  destroy(): void {
    this.controller.abort();
  }

  private local(e: Pick<MouseEvent, 'clientX' | 'clientY'>): Point {
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
    const p = this.local(e);
    this.pointer = p;
    // Safari during its own pinch gesture: the gesture events zoom.
    if (this.gestureScale !== null && e.ctrlKey) return;
    this.zoomToward(wheelZoomFactor(e), p);
  };

  private readonly onGestureStart = (e: Event): void => {
    e.preventDefault();
    this.gestureScale = (e as GestureLike).scale || 1;
  };

  private readonly onGestureChange = (e: Event): void => {
    e.preventDefault();
    const g = e as GestureLike;
    if (!(g.scale > 0)) return;
    const last = this.gestureScale ?? 1;
    this.gestureScale = g.scale;
    this.zoomToward(g.scale / last, this.local(g));
  };

  private readonly onGestureEnd = (e: Event): void => {
    e.preventDefault();
    this.gestureScale = null;
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (panFor(e.code)) {
      e.preventDefault();
      this.held.add(e.code);
      return;
    }
    // Shift is allowed: `+` is shift+`=` on most layouts.
    const zoom = zoomStepFor(e.code);
    if (zoom === 0) return;
    e.preventDefault();
    if (e.repeat || this.zoomHeld.has(e.code)) return;
    this.zoomHeld.set(e.code, performance.now());
    this.zoomCenter(zoom > 0 ? KEY_ZOOM_STEP : 1 / KEY_ZOOM_STEP);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
    this.zoomHeld.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.held.clear();
    this.zoomHeld.clear();
  };
}

function preventMiddle(e: MouseEvent): void {
  if (e.button === MIDDLE_BUTTON) {
    e.preventDefault();
  }
}

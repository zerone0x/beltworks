import { describe, expect, it } from 'vitest';
import { Camera, MAX_ZOOM, MIN_ZOOM, TILE_PX } from '../../src/render/camera';
import { MAC_NOTCH_PX, wheelZoomFactor } from '../../src/render/cameraInput';

function camera(width = 800, height = 600): Camera {
  const c = new Camera();
  c.resize(width, height);
  return c;
}

describe('Camera', () => {
  it('maps the screen center to the camera position, and round-trips', () => {
    const c = camera();
    c.set(100, -50, 2);
    expect(c.screenToWorld(400, 300)).toEqual({ x: 100, y: -50 });
    const w = c.screenToWorld(123, 456);
    const s = c.worldToScreen(w.x, w.y);
    expect(s.x).toBeCloseTo(123);
    expect(s.y).toBeCloseTo(456);
  });

  it('zooms towards the cursor, keeping the world point under it fixed', () => {
    const c = camera();
    c.set(40, 70, 1);
    const before = c.screenToWorld(650, 120);
    c.zoomAt(1.7, 650, 120);
    expect(c.zoom).toBeCloseTo(1.7);
    const after = c.screenToWorld(650, 120);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it(`clamps the zoom to [${String(MIN_ZOOM)}, ${String(MAX_ZOOM)}]`, () => {
    const c = camera();
    for (let i = 0; i < 50; i++) c.zoomAt(1.5, 10, 10);
    expect(c.zoom).toBe(MAX_ZOOM);
    for (let i = 0; i < 50; i++) c.zoomAt(0.5, 10, 10);
    expect(c.zoom).toBe(MIN_ZOOM);
    c.set(0, 0, 100);
    expect(c.zoom).toBe(MAX_ZOOM);
  });

  it('keeps the cursor point fixed even when the zoom hits a limit', () => {
    const c = camera();
    c.set(0, 0, 3.5);
    const before = c.screenToWorld(700, 500);
    c.zoomAt(10, 700, 500);
    expect(c.zoom).toBe(MAX_ZOOM);
    const after = c.screenToWorld(700, 500);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });

  it('drags the world with the cursor and pans in screen pixels at any zoom', () => {
    const c = camera();
    c.set(0, 0, 2);
    const grabbed = c.screenToWorld(300, 300);
    c.dragBy(50, -20);
    const now = c.screenToWorld(350, 280);
    expect(now.x).toBeCloseTo(grabbed.x);
    expect(now.y).toBeCloseTo(grabbed.y);

    c.set(0, 0, 0.5);
    c.panBy(100, 0);
    expect(c.x).toBe(200);
  });

  it('reports the tile under a screen position, flooring negative coordinates', () => {
    const c = camera();
    c.set(0, 0, 1);
    expect(c.tileAt(400, 300)).toEqual({ x: 0, y: 0 });
    expect(c.tileAt(399, 299)).toEqual({ x: -1, y: -1 });
    expect(c.tileAt(400 + TILE_PX, 300 + 2 * TILE_PX)).toEqual({ x: 1, y: 2 });
  });

  it('covers the whole screen with whole tiles', () => {
    const c = camera(800, 600);
    c.set(0, 0, 1);
    expect(c.visibleTiles()).toEqual({ x: -13, y: -10, w: 26, h: 20 });
    // The left edge on a tile boundary: no partial tile there.
    c.set(16, 0, 1);
    expect(c.visibleTiles()).toEqual({ x: -12, y: -10, w: 25, h: 20 });
    c.set(0, 0, MIN_ZOOM);
    const v = c.visibleTiles();
    expect(v.w * TILE_PX * MIN_ZOOM).toBeGreaterThanOrEqual(800);
    expect(v.h * TILE_PX * MIN_ZOOM).toBeGreaterThanOrEqual(600);
  });
});

describe('wheelZoomFactor (#119)', () => {
  const wheel = (deltaY: number, deltaMode = 0, ctrlKey = false) =>
    wheelZoomFactor({ deltaY, deltaMode, ctrlKey });
  const NOTCH = Math.exp(0.15);

  it('zooms one step per mouse-wheel notch however the platform reports it', () => {
    expect(wheel(-100)).toBeCloseTo(NOTCH); // Chromium on Windows and Linux
    expect(wheel(-3, 1)).toBeCloseTo(Math.exp(0.1485)); // Firefox: 3 lines
    expect(wheel(-MAC_NOTCH_PX)).toBeCloseTo(NOTCH); // macOS, one notch
    expect(wheel(3 * MAC_NOTCH_PX)).toBeCloseTo(NOTCH ** -3); // macOS, a fast spin
    expect(wheel(0)).toBe(1);
  });

  it('zooms with the distance of a trackpad scroll', () => {
    expect(wheel(-4)).toBeCloseTo(Math.exp(0.006));
    expect(wheel(10)).toBeLessThan(1);
  });

  it('follows the fingers in a pinch (ctrl+wheel), a ctrl+notch zooming by one step', () => {
    // Browsers send about -100 × ln(scale): a pinch to twice the size zooms twice as far in.
    let factor = 1;
    for (let i = 0; i < 10; i++) factor *= wheel(-10 * Math.log(2), 0, true);
    expect(factor).toBeCloseTo(2);
    expect(wheel(-100, 0, true)).toBeCloseTo(Math.exp(0.25));
    expect(wheel(-MAC_NOTCH_PX, 0, true)).toBeCloseTo(Math.exp(0.25));
    expect(wheel(100, 0, true)).toBeCloseTo(Math.exp(-0.25));
  });
});

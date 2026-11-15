import { describe, expect, it } from 'vitest';
import { TILE_PX } from '../../src/render/camera';
import { MAP_ZOOM } from '../../src/render/mapLayer';
import { DEMO_BOUNDS } from '../../src/sim/scenarios/demoInfo';
import { DEMO_ZOOM_MAX, DEMO_ZOOM_MIN, demoFraming } from '../../src/ui/demo';

/** The tiles a `width`×`height` CSS-pixel screen shows around the framing's center. */
function view(width: number, height: number): { x0: number; y0: number; x1: number; y1: number } {
  const f = demoFraming(width, height);
  const halfW = width / 2 / f.zoom / TILE_PX;
  const halfH = height / 2 / f.zoom / TILE_PX;
  return { x0: f.x - halfW, y0: f.y - halfH, x1: f.x + halfW, y1: f.y + halfH };
}

describe('demo framing (D72, D77)', () => {
  it('stays out of map mode and not too close', () => {
    expect(DEMO_ZOOM_MIN).toBeGreaterThanOrEqual(MAP_ZOOM);
    for (const [w, h] of [
      [320, 240],
      [600, 800],
      [1920, 1080],
      [7680, 4320],
    ] as const) {
      const { zoom } = demoFraming(w, h);
      expect(zoom).toBeGreaterThanOrEqual(DEMO_ZOOM_MIN);
      expect(zoom).toBeLessThanOrEqual(DEMO_ZOOM_MAX);
    }
  });

  it('shows the whole factory in common windows, narrow ones included', () => {
    for (const [w, h] of [
      [600, 800],
      [640, 900],
      [700, 700],
      [800, 600],
      [1024, 768],
      [1280, 720],
      [1366, 768],
      [1920, 1080],
    ] as const) {
      const v = view(w, h);
      const size = `${String(w)}×${String(h)}`;
      expect(v.x0, size).toBeLessThanOrEqual(DEMO_BOUNDS.x0);
      expect(v.x1, size).toBeGreaterThanOrEqual(DEMO_BOUNDS.x1 + 1);
      expect(v.y0, size).toBeLessThanOrEqual(DEMO_BOUNDS.y0);
      expect(v.y1, size).toBeGreaterThanOrEqual(DEMO_BOUNDS.y1 + 1);
    }
  });
});

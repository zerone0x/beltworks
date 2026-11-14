/**
 * The demo factory's camera (D72): where the view starts so the whole
 * factory is on screen, as large as fits.
 */

import { DEMO_BOUNDS } from '../sim/scenarios/demoInfo';
import { TILE_PX } from '../render/camera';

/** The zoom range the framing keeps to: medium zooms, out of map mode and not too close. */
export const DEMO_ZOOM_MIN = 0.3;
export const DEMO_ZOOM_MAX = 1;

/**
 * The camera for a `width`×`height` CSS-pixel screen: `DEMO_BOUNDS` (in
 * tiles) as large as fits, within [`DEMO_ZOOM_MIN`, `DEMO_ZOOM_MAX`], with a
 * margin of two tiles, and two more at the bottom, where the hotbar is.
 */
export function demoFraming(
  width: number,
  height: number,
  bounds: { x0: number; y0: number; x1: number; y1: number } = DEMO_BOUNDS,
): { x: number; y: number; zoom: number } {
  const margin = 2;
  const hotbar = 2;
  const w = (bounds.x1 - bounds.x0 + 1 + 2 * margin) * TILE_PX;
  const h = (bounds.y1 - bounds.y0 + 1 + 2 * margin + hotbar) * TILE_PX;
  const fit = Math.min(width / w, height / h);
  return {
    x: (bounds.x0 + bounds.x1 + 1) / 2,
    y: (bounds.y0 + bounds.y1 + 1 + hotbar) / 2,
    zoom: Math.min(DEMO_ZOOM_MAX, Math.max(DEMO_ZOOM_MIN, fit)),
  };
}

/**
 * Render snapshot encoding: copies the state the renderer needs into fresh
 * typed arrays whose buffers can be transferred to the main thread.
 */

import type { SimState } from './state';

/** Int32 fields per player in {@link encodePlayers}. */
export const PLAYER_STRIDE = 5;
/** Field offsets within one player record. */
export const PlayerField = {
  x: 0,
  y: 1,
  mining: 2,
  mineX: 3,
  mineY: 4,
} as const;

/**
 * Encodes every player as `PLAYER_STRIDE` int32s:
 * `[x, y, mining, mineX, mineY]` (positions in subtiles, mine target in tiles).
 */
export function encodePlayers(state: SimState): Int32Array<ArrayBuffer> {
  const p = state.players;
  const out = new Int32Array(p.count * PLAYER_STRIDE);
  for (let i = 0, o = 0; i < p.count; i++, o += PLAYER_STRIDE) {
    out[o + PlayerField.x] = p.x[i]!;
    out[o + PlayerField.y] = p.y[i]!;
    out[o + PlayerField.mining] = p.mining[i]!;
    out[o + PlayerField.mineX] = p.mineX[i]!;
    out[o + PlayerField.mineY] = p.mineY[i]!;
  }
  return out;
}

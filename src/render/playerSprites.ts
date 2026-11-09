/**
 * Which sprite the player character shows (docs/ART.md, "Player"; D67): a
 * pose (standing idle, walking, hand-mining), one of 8 facings and a frame,
 * from its snapshot record and walk clock.
 *
 * - Walking (a non-zero walking intent): the run cycle, facing the way the
 *   player walks, on its walk clock (simulation ticks spent walking,
 *   `PlayerTrack.walkTicks`), so it stops dead with the player and doesn't
 *   run while a belt carries a player who stands still.
 * - Hand-mining a tile in reach: the pickaxe swing, facing the tile, one
 *   swing per unit mined, timed off the mining progress so the pick strikes
 *   as the unit comes out.
 * - Otherwise idle, facing the way it last faced.
 *
 * Pure functions; the player layer (playerLayer.ts) draws the result.
 */

import { HAND_MINING_TICKS } from '../sim/player';
import { TICKS_PER_SECOND } from '../worker/protocol';
import { frameAt } from './sprites';

/** The player's sprite models in the `player` atlas, by pose. */
export const PLAYER_MODELS = {
  idle: 'player',
  walk: 'player:walk',
  mine: 'player:mine',
} as const;

export type PlayerPoseName = keyof typeof PLAYER_MODELS;

/** Facings: 0 north, then clockwise in eighths of a turn (1 north-east, 2 east, ..., 7 north-west). */
export const PLAYER_FACINGS = 8;
/** Facing south, towards the camera: how a player starts. */
export const FACING_SOUTH = 4;

/**
 * The facing nearest to the direction `(dx, dy)` (screen axes: +x east, +y
 * south), or `null` for no direction.
 */
export function facingOf(dx: number, dy: number): number | null {
  if (dx === 0 && dy === 0) return null;
  const turns = Math.atan2(dx, -dy) / ((2 * Math.PI) / PLAYER_FACINGS);
  return ((Math.round(turns) % PLAYER_FACINGS) + PLAYER_FACINGS) % PLAYER_FACINGS;
}

/** What a player's sprite needs from its snapshot record and walk clock. */
export interface PlayerState {
  /** Walking intent per axis (-1, 0, +1). */
  moveX: number;
  moveY: number;
  /** Hand-mining a tile in reach right now. */
  mining: boolean;
  /** From the player to the center of the tile it mines (any unit). */
  mineDx: number;
  mineDy: number;
  /** Ticks into the current unit. */
  mineProgress: number;
  /** Ticks spent walking (`PlayerTrack.walkTicks`). */
  walkTicks: number;
}

export interface PlayerPose {
  pose: PlayerPoseName;
  /** 0..7, see `PLAYER_FACINGS`. */
  facing: number;
  frame: number;
}

/** Frame counts and rates of the walk and mine animations (from the atlas). */
export interface PlayerAnimations {
  walk: { frames: number; fps: number };
  mine: { frames: number; fps: number };
}

/** The pose, facing and frame of a player in `state` that last faced `facing`. */
export function playerPose(state: PlayerState, facing: number, anim: PlayerAnimations): PlayerPose {
  const walkFacing = facingOf(state.moveX, state.moveY);
  if (walkFacing !== null) {
    const seconds = state.walkTicks / TICKS_PER_SECOND;
    return {
      pose: 'walk',
      facing: walkFacing,
      frame: frameAt(anim.walk.frames, anim.walk.fps, seconds),
    };
  }
  if (state.mining) {
    // One swing per unit: the last frames (the strike) land as the unit comes out.
    const swing = anim.mine.frames / anim.mine.fps;
    const phase = (state.mineProgress % HAND_MINING_TICKS) / HAND_MINING_TICKS;
    return {
      pose: 'mine',
      facing: facingOf(state.mineDx, state.mineDy) ?? facing,
      frame: frameAt(anim.mine.frames, anim.mine.fps, phase * swing),
    };
  }
  return { pose: 'idle', facing, frame: 0 };
}

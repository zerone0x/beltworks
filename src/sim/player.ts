/**
 * Players: struct-of-arrays state for every player character.
 *
 * M0 scope: commands set a movement intent and a mining target, and the
 * player system integrates movement at a constant integer speed. Collision
 * with terrain, hand-mining progress, and the inventory need the world and
 * arrive with the player feature.
 */

import type { Axis } from './commands';
import { fnv1a32 } from './hash';

/** Straight-line speed, in subtiles (1/256 tile) per tick: about 8.9 tiles/s. */
export const PLAYER_SPEED = 38;
/** Per-axis speed when moving diagonally: round(PLAYER_SPEED / sqrt(2)). */
export const PLAYER_DIAGONAL_SPEED = 27;

export class PlayerTable {
  readonly count: number;
  /** Position in subtiles. */
  readonly x: Int32Array;
  readonly y: Int32Array;
  /** Movement intent per axis: -1, 0 or +1. */
  readonly moveX: Int8Array;
  readonly moveY: Int8Array;
  /** 1 while hand-mining the tile at (mineX, mineY), else 0. */
  readonly mining: Uint8Array;
  readonly mineX: Int32Array;
  readonly mineY: Int32Array;

  constructor(count: number) {
    if (!Number.isInteger(count) || count < 1 || count > 0x1_0000) {
      throw new RangeError(`player count must be an integer in [1, 65536], got ${String(count)}`);
    }
    this.count = count;
    this.x = new Int32Array(count);
    this.y = new Int32Array(count);
    this.moveX = new Int8Array(count);
    this.moveY = new Int8Array(count);
    this.mining = new Uint8Array(count);
    this.mineX = new Int32Array(count);
    this.mineY = new Int32Array(count);
  }

  has(id: number): boolean {
    return id >= 0 && id < this.count;
  }

  setMove(id: number, dx: Axis, dy: Axis): void {
    this.moveX[id] = dx;
    this.moveY[id] = dy;
  }

  startMining(id: number, tileX: number, tileY: number): void {
    this.mining[id] = 1;
    this.mineX[id] = tileX;
    this.mineY[id] = tileY;
  }

  stopMining(id: number): void {
    this.mining[id] = 0;
    this.mineX[id] = 0;
    this.mineY[id] = 0;
  }

  /** Folds every field into a running FNV-1a hash, in a fixed order. */
  hashInto(h: number): number {
    h = fnv1a32(Uint32Array.of(this.count), h);
    for (const column of [
      this.x,
      this.y,
      this.moveX,
      this.moveY,
      this.mining,
      this.mineX,
      this.mineY,
    ]) {
      h = fnv1a32(column, h);
    }
    return h;
  }
}

/** Player system: moves every player one tick along its movement intent. */
export function updatePlayers(players: PlayerTable): void {
  const { x, y, moveX, moveY } = players;
  for (let i = 0; i < players.count; i++) {
    const dx = moveX[i]!;
    const dy = moveY[i]!;
    if (dx === 0 && dy === 0) {
      continue;
    }
    const speed = dx !== 0 && dy !== 0 ? PLAYER_DIAGONAL_SPEED : PLAYER_SPEED;
    // Int32Array stores wrap on overflow; ±8 million tiles is far beyond any map.
    x[i] = x[i]! + dx * speed;
    y[i] = y[i]! + dy * speed;
  }
}

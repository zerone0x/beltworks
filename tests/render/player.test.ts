import { describe, expect, it } from 'vitest';
import { moveAxes } from '../../src/render/playerInput';
import {
  FACING_SOUTH,
  facingOf,
  playerPose,
  type PlayerState,
} from '../../src/render/playerSprites';
import { PlayerTrack, SNAP_DISTANCE } from '../../src/render/playerTrack';
import { HAND_MINING_TICKS } from '../../src/sim/player';
import { PLAYER_STRIDE, PlayerField } from '../../src/sim/snapshot';

const TICK_MS = 1000 / 60;

/** Player records with the given positions (subtiles) and walking intents, nothing else set. */
function records(...players: ([number, number] | [number, number, number, number])[]): Int32Array {
  const out = new Int32Array(players.length * PLAYER_STRIDE);
  players.forEach(([x, y, mx = 0, my = 0], i) => {
    out[i * PLAYER_STRIDE + PlayerField.x] = x;
    out[i * PLAYER_STRIDE + PlayerField.y] = y;
    out[i * PLAYER_STRIDE + PlayerField.moveX] = mx;
    out[i * PLAYER_STRIDE + PlayerField.moveY] = my;
  });
  return out;
}

describe('PlayerTrack', () => {
  it('knows nothing before the first snapshot, then starts at its position', () => {
    const track = new PlayerTrack();
    expect(track.count).toBe(0);
    expect(track.sample(0, 0)).toBeNull();
    track.push(records([100, -50]), 1, 1000);
    expect(track.count).toBe(1);
    expect(track.sample(0, 1000)).toEqual({ x: 100, y: -50 });
    expect(track.sample(1, 1000)).toBeNull();
  });

  it('glides to each new position over the ticks the snapshot covers', () => {
    const track = new PlayerTrack();
    track.push(records([0, 0]), 1, 1000);
    track.push(records([38, 0]), 1, 1000);
    expect(track.sample(0, 1000)).toEqual({ x: 0, y: 0 });
    expect(track.sample(0, 1000 + TICK_MS / 2)!.x).toBeCloseTo(19, 6);
    expect(track.sample(0, 1000 + TICK_MS + 0.01)).toEqual({ x: 38, y: 0 });
    // It rests at the target until the next snapshot.
    expect(track.sample(0, 2000)).toEqual({ x: 38, y: 0 });
    // A snapshot that covers 2 ticks glides twice as long.
    track.push(records([38, 76]), 2, 3000);
    expect(track.sample(0, 3000 + TICK_MS)!.y).toBeCloseTo(38, 6);
  });

  it('continues from where the player is drawn when a snapshot arrives early', () => {
    const track = new PlayerTrack();
    track.push(records([0, 0]), 1, 0);
    track.push(records([100, 0]), 1, 0);
    // Halfway there, the next position arrives: no jump back or forward.
    const mid = TICK_MS / 2;
    track.push(records([200, 0]), 1, mid);
    expect(track.sample(0, mid)!.x).toBeCloseTo(50, 6);
    expect(track.sample(0, mid + TICK_MS + 0.01)).toEqual({ x: 200, y: 0 });
  });

  it('snaps instead of gliding across large jumps', () => {
    const track = new PlayerTrack();
    track.push(records([0, 0]), 1, 0);
    track.push(records([SNAP_DISTANCE + 1, 0]), 1, 100);
    expect(track.sample(0, 100)).toEqual({ x: SNAP_DISTANCE + 1, y: 0 });
  });
});

describe('PlayerTrack walk clock', () => {
  it('counts the ticks spent walking, gliding between snapshots', () => {
    const track = new PlayerTrack();
    track.push(records([0, 0]), 1, 0);
    expect(track.walking(0)).toBe(false);
    expect(track.walkTicks(0, 0)).toBe(0);
    track.push(records([38, 0, 1, 0]), 1, 100);
    expect(track.walking(0)).toBe(true);
    expect(track.walkTicks(0, 100)).toBe(0);
    expect(track.walkTicks(0, 100 + TICK_MS / 2)).toBeCloseTo(0.5, 6);
    expect(track.walkTicks(0, 100 + TICK_MS + 0.01)).toBe(1);
    // A snapshot covering 3 ticks of walking adds 3.
    track.push(records([152, 0, 1, 0]), 3, 200);
    expect(track.walkTicks(0, 200 + 3 * TICK_MS + 0.01)).toBe(4);
  });

  it('stops when the player stops walking, also while something else moves it', () => {
    const track = new PlayerTrack();
    track.push(records([0, 0, 0, 1]), 2, 0);
    track.push(records([0, 76, 0, 1]), 2, 100);
    const walked = track.walkTicks(0, 1000);
    expect(walked).toBe(4);
    // Carried (by a belt, say) without walking: the position moves, the clock doesn't.
    track.push(records([50, 76]), 5, 1000);
    track.push(records([100, 76]), 5, 2000);
    expect(track.sample(0, 3000)).toEqual({ x: 100, y: 76 });
    expect(track.walkTicks(0, 3000)).toBe(walked);
  });

  it('never loses ticks to a snapshot that arrives early', () => {
    const track = new PlayerTrack();
    track.push(records([0, 0, 1, 0]), 1, 0);
    track.push(records([38, 0, 1, 0]), 2, 0);
    // Halfway through the 2 ticks, the next one arrives: the clock glides on from 1.5 to 4 (1 + 2 + 1).
    track.push(records([76, 0, 1, 0]), 1, TICK_MS);
    expect(track.walkTicks(0, TICK_MS)).toBeCloseTo(1.5, 6);
    expect(track.walkTicks(0, 10_000)).toBe(4);
  });
});

describe('player sprite pose', () => {
  const ANIM = { walk: { frames: 8, fps: 30 }, mine: { frames: 8, fps: 16 } };
  const state = (over: Partial<PlayerState> = {}): PlayerState => ({
    moveX: 0,
    moveY: 0,
    mining: false,
    mineDx: 0,
    mineDy: 0,
    mineProgress: 0,
    walkTicks: 0,
    ...over,
  });

  it('maps directions to 8 facings, clockwise from north', () => {
    expect(facingOf(0, 0)).toBeNull();
    const dirs: [number, number][] = [
      [0, -1],
      [1, -1],
      [1, 0],
      [1, 1],
      [0, 1],
      [-1, 1],
      [-1, 0],
      [-1, -1],
    ];
    dirs.forEach(([dx, dy], facing) => expect(facingOf(dx, dy)).toBe(facing));
    // In between, the nearest one.
    expect(facingOf(100, -10)).toBe(2);
    expect(facingOf(-30, -100)).toBe(0);
  });

  it('stands idle facing the way it last faced', () => {
    expect(playerPose(state(), FACING_SOUTH, ANIM)).toEqual({ pose: 'idle', facing: 4, frame: 0 });
    expect(playerPose(state(), 6, ANIM)).toEqual({ pose: 'idle', facing: 6, frame: 0 });
  });

  it('walks the way it walks, a frame every 2 ticks of walking', () => {
    expect(playerPose(state({ moveX: 1, moveY: -1 }), 4, ANIM)).toEqual({
      pose: 'walk',
      facing: 1,
      frame: 0,
    });
    const frame = (ticks: number) =>
      playerPose(state({ moveX: -1, walkTicks: ticks }), 4, ANIM).frame;
    expect([0, 1.9, 2, 5, 15.9, 16, 17].map(frame)).toEqual([0, 0, 1, 2, 7, 0, 0]);
  });

  it('mines facing the tile, one swing per unit that strikes as it comes out', () => {
    const mine = (progress: number) =>
      playerPose(
        state({ mining: true, mineDx: -200, mineDy: 220, mineProgress: progress }),
        0,
        ANIM,
      );
    expect(mine(0)).toEqual({ pose: 'mine', facing: 5, frame: 0 });
    expect(mine(HAND_MINING_TICKS - 1).frame).toBe(7);
    expect(mine(HAND_MINING_TICKS / 2).frame).toBe(4);
    // A tree takes several swings.
    expect(mine(HAND_MINING_TICKS + 1).frame).toBe(0);
    // Walking wins over mining.
    expect(playerPose(state({ mining: true, moveY: 1 }), 0, ANIM).pose).toBe('walk');
  });
});

describe('moveAxes', () => {
  it('maps WASD (by key code) to a direction, cancelling opposite keys', () => {
    expect(moveAxes([])).toEqual([0, 0]);
    expect(moveAxes(['KeyW'])).toEqual([0, -1]);
    expect(moveAxes(['KeyD', 'KeyS'])).toEqual([1, 1]);
    expect(moveAxes(['KeyA', 'KeyW'])).toEqual([-1, -1]);
    expect(moveAxes(['KeyA', 'KeyD'])).toEqual([0, 0]);
    expect(moveAxes(['KeyA', 'KeyD', 'KeyW'])).toEqual([0, -1]);
    expect(moveAxes(['ArrowUp', 'KeyQ'])).toEqual([0, 0]);
  });
});

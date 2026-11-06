import { describe, expect, it } from 'vitest';
import { moveAxes } from '../../src/render/playerInput';
import { PlayerTrack, SNAP_DISTANCE } from '../../src/render/playerTrack';
import { PLAYER_STRIDE, PlayerField } from '../../src/sim/snapshot';

const TICK_MS = 1000 / 60;

/** Player records with the given positions (subtiles) and nothing else set. */
function records(...positions: [number, number][]): Int32Array {
  const out = new Int32Array(positions.length * PLAYER_STRIDE);
  positions.forEach(([x, y], i) => {
    out[i * PLAYER_STRIDE + PlayerField.x] = x;
    out[i * PLAYER_STRIDE + PlayerField.y] = y;
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

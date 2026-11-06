import { describe, expect, it } from 'vitest';
import type { Command } from '../../src/sim/commands';
import { PLAYER_DIAGONAL_SPEED, PLAYER_SPEED } from '../../src/sim/player';
import { PLAYER_STRIDE, PlayerField, encodePlayers } from '../../src/sim/snapshot';
import { SYSTEMS, Sim } from '../../src/sim/tick';
import { startingPatches } from '../../src/sim/world/generate';

const move = (tick: number, playerId: number, dx: -1 | 0 | 1, dy: -1 | 0 | 1): Command => ({
  tick,
  playerId,
  type: 'Move',
  dx,
  dy,
});

describe('Sim', () => {
  it('runs the systems in the documented order', () => {
    expect(SYSTEMS.map((s) => s.name)).toEqual([
      'commands',
      'power',
      'drills',
      'belts',
      'inserters',
      'machines',
      'players',
      'events',
    ]);
  });

  it('advances exactly one tick per step', () => {
    const sim = new Sim({ seed: 1 });
    expect(sim.tick).toBe(0);
    sim.step();
    sim.step();
    expect(sim.tick).toBe(2);
  });

  it('applies commands on their tick, not before', () => {
    const sim = new Sim({ seed: 1 });
    sim.enqueue(move(2, 0, 1, 0));
    sim.step(); // tick 0
    sim.step(); // tick 1
    expect(sim.state.players.x[0]).toBe(0);
    expect(sim.pendingCommands).toBe(1);
    sim.step(); // tick 2: command applied, then the player moves
    expect(sim.state.players.x[0]).toBe(PLAYER_SPEED);
    expect(sim.pendingCommands).toBe(0);
    sim.step();
    expect(sim.state.players.x[0]).toBe(2 * PLAYER_SPEED);
  });

  it('applies same-tick commands by player id, then insertion order', () => {
    const sim = new Sim({ seed: 1, players: 2 });
    // Player 1's commands are enqueued first but must still apply after player 0's;
    // for player 0, the later Move wins.
    sim.enqueue(move(0, 1, 0, 1));
    sim.enqueue(move(0, 0, 1, 0));
    sim.enqueue(move(0, 0, -1, 0));
    sim.enqueue({ tick: 0, playerId: 1, type: 'MineStart', x: 3, y: -4 });
    sim.enqueue({ tick: 0, playerId: 1, type: 'MineStop' });
    sim.step();
    const p = sim.state.players;
    expect([p.x[0], p.y[0]]).toEqual([-PLAYER_SPEED, 0]);
    expect([p.x[1], p.y[1]]).toEqual([0, PLAYER_SPEED]);
    expect(p.mining[1]).toBe(0);
  });

  it('moves diagonally at the reduced per-axis speed', () => {
    const sim = new Sim({ seed: 1 });
    sim.enqueue(move(0, 0, -1, 1));
    sim.step();
    expect([sim.state.players.x[0], sim.state.players.y[0]]).toEqual([
      -PLAYER_DIAGONAL_SPEED,
      PLAYER_DIAGONAL_SPEED,
    ]);
    // Integer approximation of PLAYER_SPEED / sqrt(2).
    expect(Math.abs(2 * PLAYER_DIAGONAL_SPEED ** 2 - PLAYER_SPEED ** 2)).toBeLessThan(
      2 * PLAYER_DIAGONAL_SPEED,
    );
  });

  it('records and clears the mining target', () => {
    const sim = new Sim({ seed: 1 });
    sim.enqueue({ tick: 0, playerId: 0, type: 'MineStart', x: -7, y: 12 });
    sim.step();
    const p = sim.state.players;
    expect([p.mining[0], p.mineX[0], p.mineY[0]]).toEqual([1, -7, 12]);
    sim.enqueue({ tick: 1, playerId: 0, type: 'MineStop' });
    sim.step();
    expect(p.mining[0]).toBe(0);
  });

  it('ignores commands for unknown players', () => {
    const a = new Sim({ seed: 1 });
    const b = new Sim({ seed: 1 });
    b.enqueue(move(0, 5, 1, 1));
    a.step();
    b.step();
    expect(b.hash()).toBe(a.hash());
  });

  it('rejects late and malformed commands', () => {
    const sim = new Sim({ seed: 1 });
    sim.step();
    expect(() => sim.enqueue(move(0, 0, 1, 0))).toThrow(RangeError);
    expect(() => sim.enqueue(move(1.5, 0, 1, 0))).toThrow(TypeError);
    expect(() => sim.enqueue({ ...move(1, 0, 1, 0), dx: 2 } as unknown as Command)).toThrow(
      TypeError,
    );
    expect(() => sim.enqueue({ tick: 1, playerId: 0, type: 'MineStart', x: 0.5, y: 0 })).toThrow(
      TypeError,
    );
    expect(() => sim.enqueue({ tick: 1, playerId: -1, type: 'MineStop' })).toThrow(TypeError);
  });

  it('keeps all state in integer typed arrays', () => {
    const sim = new Sim({ seed: 1 });
    for (const column of Object.values(sim.state.players)) {
      if (ArrayBuffer.isView(column)) {
        expect(column).not.toBeInstanceOf(Float32Array);
        expect(column).not.toBeInstanceOf(Float64Array);
      }
    }
  });

  it('owns a world generated from its seed and includes it in the hash', () => {
    const sim = new Sim({ seed: 7 });
    expect(sim.state.world.seed).toBe(7);
    // Generating chunks (e.g. for rendering) is not a state change.
    const h0 = sim.hash();
    sim.state.world.getChunk(3, -2);
    expect(sim.hash()).toBe(h0);
    // Modifying the world is.
    const { x, y } = startingPatches(7)[0]!;
    expect(sim.state.world.mine(x, y, 1)).toBe(1);
    expect(sim.hash()).not.toBe(h0);
  });
});

describe('encodePlayers', () => {
  it('copies player state into a transferable record array', () => {
    const sim = new Sim({ seed: 1, players: 2 });
    sim.enqueue(move(0, 1, 1, 0));
    sim.enqueue({ tick: 0, playerId: 1, type: 'MineStart', x: 2, y: 3 });
    sim.step();
    const out = encodePlayers(sim.state);
    expect(out.length).toBe(2 * PLAYER_STRIDE);
    const o = PLAYER_STRIDE;
    expect(out[o + PlayerField.x]).toBe(PLAYER_SPEED);
    expect(out[o + PlayerField.y]).toBe(0);
    expect(out[o + PlayerField.mining]).toBe(1);
    expect([out[o + PlayerField.mineX], out[o + PlayerField.mineY]]).toEqual([2, 3]);
    // In reach of (2, 3) from (38/256, 0)? No: the target is about 3.5 tiles away.
    expect(out[o + PlayerField.mineProgress]).toBe(0);
    // A copy: later steps don't change it.
    sim.step();
    expect(out[o + PlayerField.x]).toBe(PLAYER_SPEED);
    expect(sim.state.players.x[1]).toBe(2 * PLAYER_SPEED);
  });
});

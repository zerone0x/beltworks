import { describe, expect, it } from 'vitest';
import {
  CommandQueue,
  validateCommand,
  validateCommandInput,
  type Command,
} from '../../src/sim/commands';

const stop = (tick: number, playerId: number): Command => ({ tick, playerId, type: 'MineStop' });

describe('validateCommandInput', () => {
  it('accepts valid commands', () => {
    expect(validateCommandInput({ playerId: 0, type: 'Move', dx: -1, dy: 1 })).toBeNull();
    expect(
      validateCommandInput({ playerId: 3, type: 'MineStart', x: -5, y: 2 ** 31 - 1 }),
    ).toBeNull();
    expect(validateCommandInput({ playerId: 0xffff, type: 'MineStop' })).toBeNull();
    expect(
      validateCommandInput({ playerId: 0, type: 'Place', item: 5, x: -3, y: 7, dir: 3 }),
    ).toBeNull();
    // Item ids that place nothing are well-formed; the simulation ignores them.
    expect(
      validateCommandInput({ playerId: 0, type: 'Place', item: 0xffff, x: 0, y: 0, dir: 0 }),
    ).toBeNull();
    expect(validateCommandInput({ playerId: 0, type: 'Remove', x: -1, y: 0 })).toBeNull();
    expect(validateCommandInput({ playerId: 0, type: 'Rotate', x: 0, y: -(2 ** 31) })).toBeNull();
    expect(
      validateCommandInput({ playerId: 0, type: 'Insert', entity: 2 ** 32 - 1, item: 3, count: 1 }),
    ).toBeNull();
    expect(
      validateCommandInput({ playerId: 0, type: 'Take', entity: 7, slot: 2, count: 0xffff }),
    ).toBeNull();
  });

  it.each([
    null,
    'Move',
    { playerId: 0, type: 'Teleport' },
    { playerId: 0.5, type: 'MineStop' },
    { playerId: 0x1_0000, type: 'MineStop' },
    { type: 'MineStop' },
    { playerId: 0, type: 'Move', dx: 0.5, dy: 0 },
    { playerId: 0, type: 'Move', dx: 2, dy: 0 },
    { playerId: 0, type: 'Move', dx: 0 },
    { playerId: 0, type: 'MineStart', x: 1.25, y: 0 },
    { playerId: 0, type: 'MineStart', x: 2 ** 31, y: 0 },
    { playerId: 0, type: 'MineStart', x: '1', y: 0 },
    { playerId: 0, type: 'Place', item: 5, x: 0, y: 0 },
    { playerId: 0, type: 'Place', item: 5, x: 0, y: 0, dir: 4 },
    { playerId: 0, type: 'Place', item: 5, x: 0, y: 0, dir: 1.5 },
    { playerId: 0, type: 'Place', item: 0x1_0000, x: 0, y: 0, dir: 0 },
    { playerId: 0, type: 'Place', item: 2.5, x: 0, y: 0, dir: 0 },
    { playerId: 0, type: 'Place', x: 0, y: 0, dir: 0 },
    { playerId: 0, type: 'Remove', x: 0 },
    { playerId: 0, type: 'Rotate', x: 0, y: 0.5 },
    { playerId: 0, type: 'Insert', entity: 1, item: 3, count: 0 },
    { playerId: 0, type: 'Insert', entity: 1, item: 3, count: 0x1_0000 },
    { playerId: 0, type: 'Insert', entity: -1, item: 3, count: 1 },
    { playerId: 0, type: 'Insert', entity: 2 ** 32, item: 3, count: 1 },
    { playerId: 0, type: 'Insert', entity: 1, count: 1 },
    { playerId: 0, type: 'Take', entity: 1, slot: 0.5, count: 1 },
    { playerId: 0, type: 'Take', entity: 1, slot: 0 },
  ])('rejects %j', (input) => {
    expect(validateCommandInput(input)).not.toBeNull();
  });
});

describe('validateCommand', () => {
  it('checks the tick', () => {
    expect(validateCommand(stop(0, 0))).toBeNull();
    expect(validateCommand(stop(-1, 0))).not.toBeNull();
    expect(validateCommand(stop(1.5, 0))).not.toBeNull();
    expect(validateCommand(stop(2 ** 53, 0))).not.toBeNull();
    expect(validateCommand({ playerId: 0, type: 'MineStop' })).not.toBeNull();
  });
});

describe('CommandQueue', () => {
  it('returns commands by tick, then player id, then insertion order', () => {
    const q = new CommandQueue();
    const a = stop(2, 1);
    const b = stop(1, 1);
    const c = stop(1, 0);
    const d = stop(1, 1);
    const e = stop(0, 9);
    [a, b, c, d, e].forEach((cmd) => q.push(cmd));
    expect(q.size).toBe(5);
    expect(q.takeUpTo(0)).toEqual([e]);
    const tick1 = q.takeUpTo(1);
    expect(tick1[0]).toBe(c);
    expect(tick1[1]).toBe(b);
    expect(tick1[2]).toBe(d);
    expect(q.takeUpTo(1)).toEqual([]);
    expect(q.takeUpTo(5)).toEqual([a]);
    expect(q.size).toBe(0);
  });

  it('stays ordered across compaction', () => {
    const q = new CommandQueue();
    for (let t = 0; t < 500; t++) {
      q.push(stop(t, t % 3));
    }
    let taken = 0;
    for (let t = 0; t < 400; t++) {
      taken += q.takeUpTo(t).length;
      q.push(stop(t + 500, 0)); // keeps feeding in at the end
      q.push(stop(t + 200, 7)); // and in the middle
    }
    // 400 initial commands, plus the 200 middle ones that came due (ticks 200..399).
    expect(taken).toBe(600);
    let last = { tick: -1, playerId: -1 };
    const rest = q.takeUpTo(Number.MAX_SAFE_INTEGER);
    expect(rest.length).toBe(1300 - 600);
    for (const cmd of rest) {
      expect(
        cmd.tick > last.tick || (cmd.tick === last.tick && cmd.playerId >= last.playerId),
      ).toBe(true);
      last = cmd;
    }
  });
});

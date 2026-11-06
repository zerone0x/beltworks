import { describe, expect, it } from 'vitest';
import { ItemId } from '../../src/data/items';
import { ARM_LENGTH, armTip, swingFraction } from '../../src/render/inserterLayer';
import { BuildResult, placeEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { INSERTER_SWING_TICKS } from '../../src/sim/entities/inserter';
import { tileCenter } from '../../src/sim/fixed';
import { decodeInserters, encodeInserters } from '../../src/sim/snapshot';
import { Sim } from '../../src/sim/tick';

const { North, East, South, West } = Direction;

const close = (p: { x: number; y: number }, x: number, y: number) => {
  expect(p.x).toBeCloseTo(x, 9);
  expect(p.y).toBeCloseTo(y, 9);
};

describe('armTip', () => {
  it('points at the pickup tile at 0 and at the drop tile at 1', () => {
    const L = ARM_LENGTH;
    close(armTip(North, 0), 0, L);
    close(armTip(North, 1), 0, -L);
    close(armTip(East, 0), -L, 0);
    close(armTip(East, 1), L, 0);
    close(armTip(South, 1), 0, L);
    close(armTip(West, 1), -L, 0);
  });

  it('swings clockwise on screen, and clamps', () => {
    // North-facing: from the south through the west to the north.
    close(armTip(North, 0.5), -ARM_LENGTH, 0);
    close(armTip(East, 0.5), 0, -ARM_LENGTH);
    close(armTip(North, 2), 0, -ARM_LENGTH);
    close(armTip(North, -1), 0, ARM_LENGTH);
  });
});

describe('swingFraction', () => {
  const at = (arm: number, swing: number, span = INSERTER_SWING_TICKS) => ({
    x: 0,
    y: 0,
    dir: 0,
    arm,
    held: 0,
    swing,
    span,
  });

  it('draws the arm between its last two positions', () => {
    expect(swingFraction(at(18, 1), 1)).toBeCloseTo(0.5, 9);
    expect(swingFraction(at(18, 1), 0)).toBeCloseTo(17 / INSERTER_SWING_TICKS, 9);
    expect(swingFraction(at(18, -1), 0.5)).toBeCloseTo(18.5 / INSERTER_SWING_TICKS, 9);
    expect(swingFraction(at(36, 0), 0)).toBe(1);
    expect(swingFraction(at(0, -1), 1)).toBe(0);
  });

  it('measures the arm against its own span (electric arms in 1/65536 ticks)', () => {
    const span = 26 * 65_536;
    expect(swingFraction(at(13 * 65_536, 32_768, span), 1)).toBeCloseTo(0.5, 9);
    expect(swingFraction(at(13 * 65_536, 32_768, span), 0)).toBeCloseTo(12.5 / 26, 9);
    expect(swingFraction(at(5, 1, 0), 0)).toBe(0);
  });
});

describe('encodeInserters', () => {
  it('encodes the inserters in range with their arm, hand and swing', () => {
    const sim = new Sim({
      seed: 1,
      startingKit: [
        { item: ItemId.BurnerInserter, count: 3 },
        { item: ItemId.WoodenChest, count: 2 },
        { item: ItemId.Coal, count: 5 },
      ],
    });
    const { state } = sim;
    state.players.x[0] = tileCenter(0);
    state.players.y[0] = tileCenter(0);
    const place = (item: number, x: number, y: number, dir: Direction) =>
      expect(placeEntity(state, 0, item, x, y, dir)).toBe(BuildResult.Ok);
    place(ItemId.WoodenChest, 2, 0, North);
    place(ItemId.BurnerInserter, 3, 0, East);
    place(ItemId.WoodenChest, 4, 0, North);
    place(ItemId.BurnerInserter, -2, -2, South);
    const { entities } = state;
    entities.insert(entities.at(2, 0), ItemId.IronPlate, 1);
    entities.insert(entities.at(3, 0), ItemId.Coal, 1);
    for (let i = 0; i < 5; i++) sim.step();
    const range = { cx0: -1, cy0: -1, cx1: 0, cy1: 0 };
    const all = decodeInserters(encodeInserters(state, range).buffer);
    // In chunk order, like the entity records.
    expect(all).toEqual([
      // Without fuel: not moving.
      { x: -2, y: -2, dir: South, arm: 0, held: 0, swing: 0, span: 36 },
      { x: 3, y: 0, dir: East, arm: 5, held: ItemId.IronPlate, swing: 1, span: 36 },
    ]);
    const only = { cx0: 0, cy0: 0, cx1: 0, cy1: 0 };
    const some = decodeInserters(encodeInserters(state, only).buffer);
    expect(some.map((i) => [i.x, i.y])).toEqual([[3, 0]]);
    expect(decodeInserters(encodeInserters(state, null).buffer)).toEqual([]);
  });
});

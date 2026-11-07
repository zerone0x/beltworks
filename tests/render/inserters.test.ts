import { describe, expect, it } from 'vitest';
import { ENTITIES, EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { ghostInserterTiles } from '../../src/render/entityLayer';
import {
  ARM_LENGTH,
  InserterLayer,
  armColor,
  armLength,
  armTip,
  swingFraction,
} from '../../src/render/inserterLayer';
import { BuildResult, placeEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { INSERTER_SWING_TICKS } from '../../src/sim/entities/inserter';
import { tileCenter } from '../../src/sim/fixed';
import { decodeInserters, encodeInserters } from '../../src/sim/snapshot';
import { Sim } from '../../src/sim/tick';

const { North, East, South, West } = Direction;
const BURNER = EntityTypeId.BurnerInserter;

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

describe('arm length and color', () => {
  it('reaches into the neighbouring tile, or the one beyond for the long-handed inserter', () => {
    expect(armLength(EntityTypeId.BurnerInserter)).toBeCloseTo(ARM_LENGTH, 9);
    expect(armLength(EntityTypeId.ElectricInserter)).toBeCloseTo(ARM_LENGTH, 9);
    expect(armLength(EntityTypeId.FastInserter)).toBeCloseTo(ARM_LENGTH, 9);
    expect(armLength(EntityTypeId.LongHandedInserter)).toBeCloseTo(1 + ARM_LENGTH, 9);
    close(armTip(East, 1, armLength(EntityTypeId.LongHandedInserter)), 1.8, 0);
  });

  it('gives fast and long-handed arms colors of their own', () => {
    const colors = new Set(
      [BURNER, EntityTypeId.FastInserter, EntityTypeId.LongHandedInserter].map(armColor),
    );
    expect(colors.size).toBe(3);
    expect(armColor(EntityTypeId.ElectricInserter)).toBe(armColor(BURNER));
  });
});

describe('ghostInserterTiles', () => {
  const ghost = (type: keyof typeof ENTITIES, x: number, y: number, dir: Direction) => ({
    proto: ENTITIES[type],
    x,
    y,
    dir,
    valid: true,
  });

  it('marks the pickup and drop tiles of an inserter ghost, by its reach', () => {
    expect(ghostInserterTiles(ghost(EntityTypeId.FastInserter, 3, 0, East))).toEqual({
      pickup: { x: 2, y: 0 },
      drop: { x: 4, y: 0 },
    });
    expect(ghostInserterTiles(ghost(EntityTypeId.LongHandedInserter, 3, 0, East))).toEqual({
      pickup: { x: 1, y: 0 },
      drop: { x: 5, y: 0 },
    });
    expect(ghostInserterTiles(ghost(EntityTypeId.LongHandedInserter, 0, 0, North))).toEqual({
      pickup: { x: 0, y: 2 },
      drop: { x: 0, y: -2 },
    });
    expect(ghostInserterTiles(ghost(EntityTypeId.IronChest, 0, 0, North))).toBeNull();
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
    type: EntityTypeId.BurnerInserter,
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

describe('InserterLayer.apply', () => {
  /** An `encodeInserters` buffer of burner inserters `[x, arm, held, swing]` facing east on row 0. */
  const buffer = (...list: [number, number, number, number][]) => {
    const out = [list.length];
    for (const [x, arm, held, swing] of list) out.push(x, 0, East, arm, held, swing, 36, BURNER);
    return Int32Array.from(out).buffer;
  };

  it('updates the same inserters in place and rebuilds when they change', () => {
    const layer = new InserterLayer();
    layer.apply(buffer([1, 0, 0, 0], [2, 10, ItemId.Coal, 1]), 0);
    const [a, b] = layer.data;
    expect(b).toMatchObject({ x: 2, arm: 10, held: ItemId.Coal, swing: 1 });
    // Arms and hands moved: the same objects, updated.
    layer.apply(buffer([1, 1, 0, 1], [2, 11, ItemId.Coal, 1]), 16);
    expect(layer.data[0]).toBe(a);
    expect(layer.data[1]).toBe(b);
    expect(b).toMatchObject({ arm: 11 });
    expect(layer.poses(2, 0)?.held).toBe(ItemId.Coal);
    // One of them turned: new records.
    layer.apply(buffer([1, 1, 0, 1], [3, 11, 0, 0]), 32);
    expect(layer.data[1]).not.toBe(b);
    expect(layer.poses(2, 0)).toBeNull();
    expect(layer.poses(3, 0)?.held).toBe(0);
    // The same buffer again (an unchanged snapshot section): nothing to read.
    const same = buffer([1, 2, 0, 1]);
    layer.apply(same, 48);
    const records = layer.data;
    layer.apply(same, 64);
    expect(layer.data).toBe(records);
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
      { x: -2, y: -2, dir: South, arm: 0, held: 0, swing: 0, span: 36, type: BURNER },
      {
        x: 3,
        y: 0,
        dir: East,
        arm: 5,
        held: ItemId.IronPlate,
        swing: 1,
        span: 36,
        type: BURNER,
      },
    ]);
    const only = { cx0: 0, cy0: 0, cx1: 0, cy1: 0 };
    const some = decodeInserters(encodeInserters(state, only).buffer);
    expect(some.map((i) => [i.x, i.y])).toEqual([[3, 0]]);
    expect(decodeInserters(encodeInserters(state, null).buffer)).toEqual([]);
  });
});

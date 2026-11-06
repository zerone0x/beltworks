import { describe, expect, it } from 'vitest';
import { ItemId } from '../../src/data/items';
import { beltPoint, laneLateral, progressOf } from '../../src/render/beltPath';
import { BeltShape, beltTable } from '../../src/sim/belts/belts';
import { BeltLane } from '../../src/sim/belts/line';
import { BuildResult, placeEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { tileCenter } from '../../src/sim/fixed';
import { decodeBelts, encodeBelts } from '../../src/sim/snapshot';
import { Sim } from '../../src/sim/tick';

const { North, East, South, West } = Direction;

const close = (p: { x: number; y: number }, x: number, y: number) => {
  expect(p.x).toBeCloseTo(x, 9);
  expect(p.y).toBeCloseTo(y, 9);
};

describe('beltPoint', () => {
  it('runs from the input edge to the output edge of a straight belt', () => {
    close(beltPoint(North, BeltShape.Straight, 0, 0), 0.5, 1);
    close(beltPoint(North, BeltShape.Straight, 0, 1), 0.5, 0);
    close(beltPoint(East, BeltShape.Straight, 0, 0), 0, 0.5);
    close(beltPoint(East, BeltShape.Straight, 0, 1), 1, 0.5);
    close(beltPoint(South, BeltShape.Straight, 0, 1), 0.5, 1);
    close(beltPoint(West, BeltShape.Straight, 0, 1), 0, 0.5);
    // The left lane of an east-facing belt is its north half.
    close(beltPoint(East, BeltShape.Straight, laneLateral(BeltLane.Left), 0.5), 0.5, 0.25);
    close(beltPoint(East, BeltShape.Straight, laneLateral(BeltLane.Right), 0.5), 0.5, 0.75);
  });

  it('goes around the corner on curves, keeping each lane on its side', () => {
    // North-facing, fed from the west: in at the west edge, out at the top.
    close(beltPoint(North, BeltShape.CurveFromLeft, 0, 0), 0, 0.5);
    close(beltPoint(North, BeltShape.CurveFromLeft, 0, 1), 0.5, 0);
    // The left lane is the inner one.
    close(beltPoint(North, BeltShape.CurveFromLeft, -0.25, 0), 0, 0.25);
    close(beltPoint(North, BeltShape.CurveFromLeft, -0.25, 1), 0.25, 0);
    // Fed from the east, the right lane is inner.
    close(beltPoint(North, BeltShape.CurveFromRight, 0, 0), 1, 0.5);
    close(beltPoint(North, BeltShape.CurveFromRight, 0.25, 1), 0.75, 0);
    // South-facing, fed from the west (its right): in at the west edge, out at the bottom.
    close(beltPoint(South, BeltShape.CurveFromRight, 0, 0), 0, 0.5);
    close(beltPoint(South, BeltShape.CurveFromRight, 0, 1), 0.5, 1);
    // Ends line up with straight belts.
    close(
      beltPoint(East, BeltShape.CurveFromLeft, 0.25, 1),
      beltPoint(East, BeltShape.Straight, 0.25, 1).x,
      beltPoint(East, BeltShape.Straight, 0.25, 1).y,
    );
  });

  it('maps offsets from the end edge to progress', () => {
    expect(progressOf(0, 256)).toBe(1);
    expect(progressOf(256, 256)).toBe(0);
    expect(progressOf(64, 256)).toBe(0.75);
    expect(progressOf(300, 256)).toBe(0);
  });
});

describe('encodeBelts', () => {
  it('encodes the belts in range with their shape and items', () => {
    const sim = new Sim({ seed: 1, startingKit: [{ item: ItemId.TransportBelt, count: 10 }] });
    sim.state.players.x[0] = tileCenter(0);
    sim.state.players.y[0] = tileCenter(0);
    const place = (x: number, y: number, dir: Direction) =>
      expect(placeEntity(sim.state, 0, ItemId.TransportBelt, x, y, dir)).toBe(BuildResult.Ok);
    place(2, 0, East);
    place(3, 0, South);
    place(-2, -2, North);
    const corner = sim.state.entities.at(3, 0);
    expect(sim.state.entities.insert(corner, ItemId.Coal, 1)).toBe(1);
    sim.step();
    const all = decodeBelts(encodeBelts(sim.state, { cx0: -1, cy0: -1, cx1: 0, cy1: 0 }).buffer);
    expect(all).toHaveLength(3);
    expect(all.find((b) => b.x === 3)).toEqual({
      x: 3,
      y: 0,
      dir: South,
      shape: BeltShape.CurveFromRight,
      items: [{ lane: BeltLane.Right, offset: 120, moved: 8, item: ItemId.Coal }],
    });
    expect(all.find((b) => b.x === 2)).toMatchObject({
      dir: East,
      shape: BeltShape.Straight,
      items: [],
    });
    // Only chunk (0, 0): the belt at (-2, -2) is left out.
    const some = decodeBelts(encodeBelts(sim.state, { cx0: 0, cy0: 0, cx1: 0, cy1: 0 }).buffer);
    expect(some.map((b) => [b.x, b.y])).toEqual([
      [2, 0],
      [3, 0],
    ]);
    expect(decodeBelts(encodeBelts(sim.state, null).buffer)).toEqual([]);
    expect(beltTable(sim.state.entities)!.lineCount).toBe(2);
  });
});

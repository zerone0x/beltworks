import { describe, expect, it } from 'vitest';
import { BELT_ITEM_SPACING, ENTITIES, EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { ResourceId } from '../../src/data/resources';
import { BELT_SPEED, BeltShape, BeltTable, beltTable } from '../../src/sim/belts/belts';
import { Lane } from '../../src/sim/belts/lane';
import { BELT_LENGTH, BeltLane } from '../../src/sim/belts/line';
import { BuildResult, placeEntity, removeEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { DRILL_MINING_TICKS, drillDropTile, drillTable } from '../../src/sim/entities/drill';
import { MachineState } from '../../src/sim/entities/machine';
import { Entities } from '../../src/sim/entities/entities';
import { tileCenter } from '../../src/sim/fixed';
import { Rng } from '../../src/sim/rng';
import { Sim } from '../../src/sim/tick';
import { CHUNK_MASK, CHUNK_SHIFT, tileIndex } from '../../src/sim/world/chunk';

const { North, East, South, West } = Direction;
const { Left, Right } = BeltLane;
const BELT = ENTITIES[EntityTypeId.TransportBelt];
const IRON = ItemId.IronPlate;
const COAL = ItemId.Coal;

/** Bare entities with only the belt table. */
function world() {
  const table = new BeltTable();
  const entities = new Entities([table]);
  const place = (x: number, y: number, dir: Direction) => entities.add(BELT, x, y, dir);
  /** Places a straight run of `n` belts from `(x, y)` in direction `dir`; returns their ids. */
  const run = (x: number, y: number, dir: Direction, n: number) => {
    const ids: number[] = [];
    const dx = [0, 1, 0, -1][dir]!;
    const dy = [-1, 0, 1, 0][dir]!;
    for (let i = 0; i < n; i++) ids.push(place(x + i * dx, y + i * dy, dir));
    return ids;
  };
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) table.update();
  };
  const lineOf = (belt: number) => table.line(table.beltLine(belt))!;
  /** Positions (distance from the line end) of the items on a lane. */
  const positions = (belt: number, lane: number) => {
    const l = lineOf(belt).lanes[lane as BeltLane];
    const out: number[] = [];
    let d = 0;
    for (let i = 0; i < l.count; i++) out.push((d += l.gap(i)));
    return out;
  };
  return { table, entities, place, run, step, lineOf, positions };
}

/** Every gap behind the first item is at least the spacing, and the totals add up. */
function checkLanes(table: BeltTable): void {
  for (const line of table.lines()) {
    for (const lane of line.lanes) {
      let sum = 0;
      for (let i = 0; i < lane.count; i++) {
        const g = lane.gap(i);
        expect(g).toBeGreaterThanOrEqual(i === 0 ? 0 : BELT_ITEM_SPACING);
        sum += g;
      }
      expect(lane.total).toBe(sum);
    }
  }
}

describe('belt numbers', () => {
  it('live in src/data', () => {
    expect(BELT.beltSpeed).toBe(8);
    expect(BELT_SPEED).toBe(8);
    expect(BELT_ITEM_SPACING).toBe(64);
    expect(BELT_LENGTH).toBe(256);
  });
});

describe('Lane', () => {
  it('stores gaps, keeps the spacing, and moves only the first movable gap', () => {
    const lane = new Lane(64);
    expect(lane.insert(100, IRON)).toBe(true);
    expect(lane.insert(140, IRON)).toBe(false); // 40 behind the first
    expect(lane.insert(164, COAL)).toBe(true);
    expect(lane.insert(40, COAL)).toBe(false); // 60 in front of the first
    expect(lane.insert(36, COAL)).toBe(true);
    expect(Array.from(lane.gaps())).toEqual([36, 64, 64]);
    expect(Array.from(lane.items())).toEqual([COAL, IRON, COAL]);
    expect(lane.total).toBe(164);
    // The whole lane moves until the first item reaches the end.
    for (let i = 0; i < 4; i++) lane.move(8);
    expect(Array.from(lane.gaps())).toEqual([4, 64, 64]);
    expect(lane.move(8)).toBe(4);
    expect(Array.from(lane.gaps())).toEqual([0, 64, 64]);
    // Packed: nothing moves any more.
    expect(lane.move(8)).toBe(0);
    // Taking the middle item lets the last one close up, 8 per step.
    expect(lane.removeAt(1)).toBe(IRON);
    expect(Array.from(lane.gaps())).toEqual([0, 128]);
    expect(lane.move(8)).toBe(8);
    expect(Array.from(lane.gaps())).toEqual([0, 120]);
    expect(lane.find(100, 130)).toBe(1);
    expect(lane.find(0, 0)).toBe(0);
    expect(lane.find(1, 119)).toBe(-1);
  });

  it('carries leftover movement past an item that just stopped', () => {
    const lane = new Lane(64);
    lane.insert(3, IRON);
    lane.insert(100, IRON);
    // The first item moves 3 and stops; the second moves the full 8.
    expect(lane.move(8)).toBe(8);
    expect(Array.from(lane.gaps())).toEqual([0, 92]);
  });

  it('grows its ring buffer and keeps order through pops and pushes', () => {
    const lane = new Lane(64);
    for (let i = 0; i < 100; i++) lane.pushBack(i === 0 ? 0 : 64, (i % 5) + 1);
    for (let i = 0; i < 30; i++) expect(lane.removeAt(0)).toBe((i % 5) + 1);
    for (let i = 100; i < 150; i++) lane.pushBack(64, (i % 5) + 1);
    expect(lane.count).toBe(120);
    expect(Array.from(lane.items())).toEqual(
      Array.from({ length: 120 }, (_, i) => ((i + 30) % 5) + 1),
    );
  });
});

describe('transport lines', () => {
  it('merge consecutive belts facing the same way into one line', () => {
    const w = world();
    const ids = w.run(0, 0, East, 5);
    expect(w.table.lineCount).toBe(1);
    const line = w.lineOf(ids[0]!);
    // Index 0 is the belt at the end of the line.
    expect(line.belts).toEqual(ids.slice().reverse());
    expect(line.length).toBe(5 * 256);
    expect(w.table.beltOffset(ids[4]!)).toBe(0);
    expect(w.table.beltOffset(ids[0]!)).toBe(4 * 256);
    // Placed from the far end too.
    const back = world();
    const rev = [4, 3, 2, 1, 0].map((x) => back.place(x, 0, East));
    expect(back.table.lineCount).toBe(1);
    expect(back.lineOf(rev[0]!).belts).toEqual(rev);
  });

  it('do not connect belts facing each other, and stop items at the end', () => {
    const w = world();
    const a = w.place(0, 0, East);
    const b = w.place(1, 0, West);
    expect(w.table.lineCount).toBe(2);
    expect(w.lineOf(a).out).toBeNull();
    expect(w.table.insert(a, IRON, 1)).toBe(1);
    w.step(200);
    // The item waits at the end of its belt, which doesn't hand it on.
    expect(w.table.peekEnd(w.table.beltLine(a), Right)).toBe(IRON);
    expect(w.table.itemsOn(b)).toEqual([]);
  });

  it('go through curves: a belt fed only from one side turns', () => {
    const w = world();
    // East along y = 0, then the corner (2, 0) turns south.
    const a = w.place(0, 0, East);
    const b = w.place(1, 0, East);
    const corner = w.place(2, 0, South);
    const c = w.place(2, 1, South);
    expect(w.table.lineCount).toBe(1);
    expect(w.lineOf(a).belts).toEqual([c, corner, b, a]);
    // East-bound, then a right turn: the input is on the south-facing corner's right.
    expect(w.table.shape(corner)).toBe(BeltShape.CurveFromRight);
    expect(w.table.shape(b)).toBe(BeltShape.Straight);
    // A curve the other way.
    const v = world();
    v.place(0, 0, West);
    const k = v.place(-1, 0, South);
    expect(v.table.shape(k)).toBe(BeltShape.CurveFromLeft);
    expect(v.table.lineCount).toBe(1);
    // A belt behind the corner makes it straight: the side belt then side-loads it.
    w.place(2, -1, South);
    expect(w.table.shape(corner)).toBe(BeltShape.Straight);
    expect(w.table.lineCount).toBe(2);
    expect(w.lineOf(b).out).toBe(w.lineOf(c));
    // Items keep their lane around the curve and stop at the end.
    const u = world();
    const ids = [u.place(0, 0, East), u.place(1, 0, South), u.place(1, 1, South)];
    u.table.insertAt(u.table.beltLine(ids[0]!), Left, 3 * 256, IRON);
    u.table.insertAt(u.table.beltLine(ids[0]!), Right, 3 * 256, COAL);
    u.step(3 * 32 + 1);
    expect(u.table.itemsOn(ids[2]!)).toEqual([
      { lane: Left, offset: 0, moved: 0, item: IRON },
      { lane: Right, offset: 0, moved: 0, item: COAL },
    ]);
  });

  it('side-load onto the near lane only, from both lanes, taking turns', () => {
    // The main line runs east along y = 0. A feeder pointing north comes from
    // y = 1, the main belt's right side; one pointing south from y = -1, its left.
    for (const [side, expected] of [
      [North, Right],
      [South, Left],
    ] as const) {
      const w = world();
      const main = w.run(0, 0, East, 4);
      const feeder = w.place(2, side === North ? 1 : -1, side);
      expect(w.table.lineCount).toBe(2);
      const feederLine = w.lineOf(feeder);
      expect(feederLine.out).toBe(w.lineOf(main[0]!));
      expect(feederLine.outLane).toBe(expected);
      // The middle of belt (2, 0), which is index 1 of the main line.
      expect(feederLine.outPos).toBe(256 + 128);
      // Two items on each lane of the feeder.
      const fl = w.table.beltLine(feeder);
      for (const lane of [Left, Right]) {
        w.table.insertAt(fl, lane, 0, lane === Left ? IRON : COAL);
        w.table.insertAt(fl, lane, 128, lane === Left ? IRON : COAL);
      }
      w.step(400);
      const ml = w.lineOf(main[0]!);
      expect(ml.lanes[1 - expected]!.count).toBe(0);
      expect(Array.from(ml.lanes[expected].items())).toEqual([IRON, COAL, IRON, COAL]);
      expect(w.positions(main[0]!, expected)).toEqual([0, 64, 128, 192]);
      checkLanes(w.table);
    }
  });

  it('carry exactly 7.5 items/s per lane and 15/s per belt at steady state', () => {
    const w = world();
    // Through a curve: 6 east, the corner, 3 south.
    w.run(0, 0, East, 6);
    w.run(6, 0, South, 4);
    expect(w.table.lineCount).toBe(1);
    const line = w.lineOf(w.entities.at(6, 3));
    const counts = [0, 0];
    const tick = (count: boolean) => {
      w.step();
      for (const lane of [Left, Right]) {
        if (w.table.peekEnd(line.id, lane) !== 0) {
          expect(w.table.takeAt(line.id, lane, 0, 0)).toBe(IRON);
          if (count) counts[lane]!++;
        }
        w.table.insertAt(line.id, lane, line.length, IRON);
      }
      checkLanes(w.table);
    };
    for (let i = 0; i < 600; i++) tick(false);
    for (let i = 0; i < 600; i++) tick(true);
    // 600 ticks = 10 s.
    expect(counts).toEqual([75, 75]);
    expect(counts[0]! + counts[1]!).toBe(150);
  });

  it('hand items on around a loop, and a full loop keeps moving', () => {
    const w = world();
    // A 2×2 loop: (0,0) E, (1,0) S, (1,1) W, (0,1) N.
    const ids = [
      w.place(0, 0, East),
      w.place(1, 0, South),
      w.place(1, 1, West),
      w.place(0, 1, North),
    ];
    expect(w.table.lineCount).toBe(1);
    const line = w.lineOf(ids[0]!);
    // Cut at the smallest id: it is the end, and the end feeds the line's own start.
    expect(line.belts[0]).toBe(ids[0]);
    expect(line.out).toBe(line);
    expect(line.outLane).toBe(-1);
    expect(line.outPos).toBe(line.length);
    for (let pos = 0; pos < line.length; pos += 64) {
      expect(w.table.insertAt(line.id, Left, pos, pos === 0 ? COAL : IRON)).toBe(true);
    }
    expect(w.table.insertAt(line.id, Left, 32, IRON)).toBe(false);
    // 16 items, packed all the way round; after 4 tiles' worth of ticks they are back.
    w.step(128);
    expect(line.lanes[Left].item(0)).toBe(COAL);
    w.step(8);
    expect(line.lanes[Left].item(15)).toBe(COAL);
    checkLanes(w.table);
    expect(w.table.activeLanes).toBe(1);
  });

  it('keep item order and positions when lines merge and split', () => {
    const w = world();
    const a = w.run(0, 0, East, 3);
    const b = w.run(4, 0, East, 3);
    expect(w.table.lineCount).toBe(2);
    const put = (belt: number, lane: number, offset: number, item: number) =>
      w.table.insertAt(w.table.beltLine(belt), lane, w.table.beltOffset(belt) + offset, item);
    put(a[0]!, Left, 200, IRON);
    put(a[1]!, Left, 10, COAL);
    put(a[2]!, Right, 0, IRON);
    put(b[0]!, Right, 100, COAL);
    put(b[2]!, Left, 64, IRON);
    const snapshot = () =>
      [...a, ...b].map((id) => w.table.itemsOn(id).map((i) => ({ ...i, moved: 0 })));
    const before = snapshot();
    // The gap belt joins them into one line.
    const gap = w.place(3, 0, East);
    expect(w.table.lineCount).toBe(1);
    expect(snapshot()).toEqual(before);
    expect(w.table.itemsOn(gap)).toEqual([]);
    const merged = w.lineOf(a[0]!);
    expect(Array.from(merged.lanes[Left].items())).toEqual([IRON, COAL, IRON]);
    // Removing it splits them again.
    expect(w.entities.remove(gap)).toBe(true);
    expect(w.table.lineCount).toBe(2);
    expect(snapshot()).toEqual(before);
    checkLanes(w.table);
  });

  it('relink neighbours when a belt rotates', () => {
    const w = world();
    const a = w.place(0, 0, East);
    const b = w.place(1, 0, North);
    // (1, 0) faces north with its only input from the left: a curve.
    expect(w.table.lineCount).toBe(1);
    expect(w.table.shape(b)).toBe(BeltShape.CurveFromLeft);
    w.table.insert(a, IRON, 1);
    w.entities.setDirection(b, South);
    expect(w.table.shape(b)).toBe(BeltShape.CurveFromRight);
    expect(w.table.lineCount).toBe(1);
    // Facing back into `a`: two lines, the item stays on `a`.
    w.entities.setDirection(b, West);
    expect(w.table.lineCount).toBe(2);
    expect(w.lineOf(a).out).toBeNull();
    expect(w.table.itemsOn(a)).toMatchObject([{ lane: Right, offset: 128, item: IRON }]);
    w.entities.setDirection(b, North);
    expect(w.table.lineCount).toBe(1);
    w.step(100);
    expect(w.table.itemsOn(b)).toMatchObject([{ lane: Right, offset: 0, item: IRON }]);
  });

  it('push items closer than the spacing back when lines join', () => {
    const w = world();
    // `a` dead-ends against `b`, which faces back at it. `a` has two items
    // packed at its end, `b` one at its start edge (both lanes keep their
    // place on their belt through a rotation).
    const a = w.place(0, 0, East);
    const b = w.place(1, 0, West);
    w.table.insertAt(w.table.beltLine(a), Left, 0, IRON);
    w.table.insertAt(w.table.beltLine(a), Left, 64, IRON);
    w.table.insertAt(w.table.beltLine(b), Left, 256, COAL);
    // Turned east, `b` continues `a`: its coal (now at 256) and `a`'s first
    // iron (also at 256) collide, so the iron moves back behind the coal.
    w.entities.setDirection(b, East);
    expect(w.table.lineCount).toBe(1);
    checkLanes(w.table);
    expect(w.positions(a, Left)).toEqual([256, 320, 384]);
    expect(Array.from(w.lineOf(a).lanes[Left].items())).toEqual([COAL, IRON, IRON]);
    // Packed: an item behind them would need 448, past the end of the 512-long line.
    expect(w.lineOf(a).lanes[Left].total).toBeLessThanOrEqual(w.lineOf(a).length);
  });

  it('put generic inserts on the middle of the belt, right lane first', () => {
    const w = world();
    const [a] = w.run(0, 0, North, 2);
    expect(w.table.insertable(a!, IRON)).toBe(2);
    expect(w.table.insertable(a!, 999)).toBe(0);
    expect(w.entities.insert(a!, IRON, 1)).toBe(1);
    expect(w.table.itemsOn(a!)).toMatchObject([{ lane: Right, offset: 128 }]);
    expect(w.entities.insert(a!, COAL, 5)).toBe(1);
    expect(w.table.itemsOn(a!)).toMatchObject([
      { lane: Left, offset: 128, item: COAL },
      { lane: Right, offset: 128, item: IRON },
    ]);
    expect(w.entities.insertable(a!, IRON)).toBe(0);
    expect(w.entities.insert(a!, IRON, 1)).toBe(0);
    expect(w.table.contents(a!)).toEqual([
      { item: COAL, count: 1 },
      { item: IRON, count: 1 },
    ]);
  });

  it('take and peek by position range', () => {
    const w = world();
    const [a] = w.run(0, 0, East, 2);
    const line = w.table.beltLine(a!);
    w.table.insertAt(line, Left, 100, IRON);
    w.table.insertAt(line, Left, 300, COAL);
    expect(w.table.insertAt(line, Left, 600, COAL)).toBe(false); // off the line
    expect(w.table.insertAt(line, 2, 0, COAL)).toBe(false);
    expect(w.table.insertAt(999, Left, 0, COAL)).toBe(false);
    expect(w.table.peekAt(line, Left, 256, 511)).toBe(COAL);
    expect(w.table.peekEnd(line, Left)).toBe(0);
    expect(w.table.takeAt(line, Left, 0, 255)).toBe(IRON);
    expect(w.table.takeAt(line, Left, 0, 255)).toBe(0);
    expect(w.table.takeAt(line, Right, 0, 511)).toBe(0);
    w.step(300 / 8);
    expect(w.table.peekEnd(line, Left)).toBe(COAL);
  });

  it('put lanes that cannot move to sleep and wake them when something changes', () => {
    const w = world();
    const [a] = w.run(0, 0, East, 2);
    const line = w.table.beltLine(a!);
    expect(w.table.activeLanes).toBe(0);
    for (let pos = 0; pos <= 512; pos += 64) w.table.insertAt(line, Left, pos, IRON);
    w.table.insertAt(line, Right, 300, IRON);
    expect(w.table.activeLanes).toBe(2);
    expect(w.table.laneAwake(line, Left)).toBe(true);
    // The left lane is packed from the end: it sleeps after one step. The
    // right one sleeps once its item reached the end.
    w.step();
    expect(w.table.laneAwake(line, Left)).toBe(false);
    w.step(300 / 8 + 1);
    expect(w.table.activeLanes).toBe(0);
    // Taking an item wakes the lane; it sleeps again once it closed up.
    expect(w.table.takeAt(line, Left, 0, 0)).toBe(IRON);
    expect(w.table.laneAwake(line, Left)).toBe(true);
    w.step(9);
    expect(w.table.activeLanes).toBe(0);
    // A lane fed by a stuck side-loader wakes it when it has room again.
    const feeder = w.place(1, 1, North);
    const fl = w.table.beltLine(feeder);
    w.table.insertAt(fl, Left, 0, COAL);
    w.step(2);
    expect(w.table.laneAwake(fl, Left)).toBe(false);
    w.table.takeAt(line, Left, 0, 255);
    w.table.takeAt(line, Left, 0, 255);
    w.table.takeAt(line, Left, 0, 255);
    w.table.takeAt(line, Left, 0, 255);
    expect(w.table.laneAwake(fl, Left)).toBe(false);
    // Everything behind moves up; the side-load point at 128 frees up eventually.
    expect(w.table.takeAt(line, Left, 0, 0)).toBe(0);
    w.step(100);
    expect(w.table.itemsOn(feeder)).toEqual([]);
  });

  it('notify watched belts of a line while its lanes change near them, and not while they sleep', () => {
    const w = world();
    const [a, b] = w.run(0, 0, East, 2);
    const woken: number[] = [];
    const table = w.table as BeltTable & { wake?: (id: number) => void };
    table.wake = (id) => woken.push(id);
    // Belt a watches belt b, which spans [0, 256) from the end, and b watches
    // a, which spans [256, 512) (stand-ins for drills or inserters).
    w.entities.wake.watch(a!, b!);
    w.entities.wake.watch(b!, a!);
    // An item put on at the start of the line is within reach of a only.
    w.table.insertAt(w.table.beltLine(a!), Left, 512, IRON);
    expect(woken).toEqual([b]);
    woken.length = 0;
    // Every tick the item moves 8 (64 ticks take it to the end). Each belt is
    // notified while the stretch it moved over, from its new position back to
    // its old one, comes within the item spacing (64) of the belt: b from the
    // tick it gets to 320, a until it has left 192 behind.
    w.step(64);
    const ticksNear = (watcher: number) => woken.filter((id) => id === watcher).length;
    expect(ticksNear(a!)).toBe(64 - (512 - 320) / 8 + 1);
    expect(ticksNear(b!)).toBe((512 - 192) / 8 + 1);
    woken.length = 0;
    w.step(10);
    expect(woken).toEqual([]);
    // Unsubscribed belts are dropped from the line's list.
    w.entities.wake.unwatchAll(a!);
    w.entities.wake.unwatchAll(b!);
    w.table.takeAt(w.table.beltLine(a!), Left, 0, 0);
    expect(woken).toEqual([]);
    expect(w.lineOf(a!).watched).toEqual([]);
  });

  it('step a 1 000-belt line in O(1) per lane', () => {
    const time = (n: number): number => {
      const w = world();
      for (let i = 0; i < n; i++) w.place(-i, 0, East);
      const line = w.lineOf(w.entities.at(0, 0));
      expect(line.belts.length).toBe(n);
      // Both lanes packed the whole way.
      for (const lane of [Left, Right]) {
        for (let pos = 0; pos <= line.length; pos += 64)
          line.lanes[lane].pushBack(pos === 0 ? 0 : 64, IRON);
        w.table.takeAt(line.id, lane, 0, 0);
      }
      let ms = 0;
      for (let t = 0; t < 2000; t++) {
        const start = performance.now();
        w.table.update();
        ms += performance.now() - start;
        // Keep it flowing: take from the end of each lane, refill at the start.
        for (const lane of [Left, Right]) {
          if (w.table.peekEnd(line.id, lane)) w.table.takeAt(line.id, lane, 0, 0);
          const l = line.lanes[lane];
          if (line.length - l.total >= BELT_ITEM_SPACING) l.pushBack(line.length - l.total, IRON);
        }
      }
      expect(w.table.activeLanes).toBe(2);
      return ms;
    };
    time(10);
    time(1000);
    const small = Math.min(time(10), time(10));
    const large = Math.min(time(1000), time(1000));
    // Both take well under a millisecond for all 2 000 ticks. A step that walked
    // the 4 000 items of each lane would take 10 ms or more; allow timer noise.
    expect(large).toBeLessThan(small * 10 + 5);
  });
});

describe('belts in the simulation', () => {
  function setup() {
    const sim = new Sim({
      seed: 1,
      startingKit: [
        { item: ItemId.TransportBelt, count: 10 },
        { item: COAL, count: 10 },
      ],
    });
    sim.state.players.x[0] = tileCenter(0);
    sim.state.players.y[0] = tileCenter(0);
    const { state } = sim;
    const place = (x: number, y: number, dir: Direction) =>
      expect(placeEntity(state, 0, ItemId.TransportBelt, x, y, dir)).toBe(BuildResult.Ok);
    return {
      sim,
      state,
      place,
      table: beltTable(state.entities)!,
      inv: state.players.inventory(0),
    };
  }

  it('moves items in the belt system and refunds them with a removed belt', () => {
    const { sim, state, place, table, inv } = setup();
    place(2, 0, South);
    place(2, 1, South);
    const top = state.entities.at(2, 0);
    const bottom = state.entities.at(2, 1);
    expect(state.entities.insert(top, COAL, 2)).toBe(2);
    inv.remove(COAL, 2);
    for (let i = 0; i < 17; i++) sim.step();
    // 136 subtiles: from the middle of the top belt onto the bottom one.
    expect(table.itemsOn(top)).toEqual([]);
    expect(table.itemsOn(bottom).map((i) => i.offset)).toEqual([
      256 - BELT_SPEED,
      256 - BELT_SPEED,
    ]);
    // Removing the bottom belt refunds it and its two coal.
    expect(removeEntity(state, 0, 2, 1)).toBe(BuildResult.Ok);
    expect(inv.count(COAL)).toBe(10);
    expect(inv.count(ItemId.TransportBelt)).toBe(9);
    expect(table.lineCount).toBe(1);
  });

  it('refuses to remove a belt whose items do not fit', () => {
    const { state, place, inv } = setup();
    place(2, 0, East);
    const belt = state.entities.at(2, 0);
    state.entities.insert(belt, ItemId.IronOre, 1);
    inv.add(ItemId.Stone, inv.spaceFor(ItemId.Stone));
    expect(removeEntity(state, 0, 2, 0)).toBe(BuildResult.InventoryFull);
    expect(state.entities.at(2, 0)).toBe(belt);
  });

  it('is deterministic and hashed', () => {
    const a = setup();
    const b = setup();
    for (const s of [a, b]) {
      s.place(1, 2, East);
      s.place(2, 2, East);
      s.state.entities.insert(s.state.entities.at(1, 2), COAL, 1);
    }
    expect(b.sim.hash()).toBe(a.sim.hash());
    a.sim.step();
    expect(b.sim.hash()).not.toBe(a.sim.hash());
    b.sim.step();
    expect(b.sim.hash()).toBe(a.sim.hash());
  });
});

describe('random building', () => {
  it('keeps every item, the spacing, and consistent lines through random edits', () => {
    const w = world();
    const rng = Rng.fromSeed(1234);
    let inserted = 0;
    let refunded = 0;
    const onMap = () => {
      let n = 0;
      for (const line of w.table.lines()) n += line.lanes[0].count + line.lanes[1].count;
      return n;
    };
    for (let round = 0; round < 1500; round++) {
      const x = rng.nextInt(7);
      const y = rng.nextInt(7);
      const id = w.entities.at(x, y);
      const action = rng.nextInt(10);
      if (id === 0) {
        if (action < 6) w.place(x, y, rng.nextInt(4) as Direction);
      } else if (action < 2) {
        for (const s of w.entities.contents(id)) refunded += s.count;
        w.entities.remove(id);
      } else if (action < 4) {
        w.entities.setDirection(id, rng.nextInt(4) as Direction);
      } else if (action < 7) {
        inserted += w.entities.insert(id, action === 4 ? IRON : COAL, 2);
      } else {
        const line = w.table.beltLine(id);
        const from = w.table.beltOffset(id);
        if (w.table.takeAt(line, rng.nextInt(2), from, from + 255) !== 0) refunded++;
      }
      w.step(rng.nextInt(20));
      checkLanes(w.table);
      expect(onMap() + refunded).toBe(inserted);
      // Every belt is on exactly one line, at its index.
      let belts = 0;
      for (const line of w.table.lines()) {
        line.belts.forEach((b, k) => {
          expect(w.table.beltLine(b)).toBe(line.id);
          expect(w.table.beltIndex(b)).toBe(k);
        });
        belts += line.belts.length;
        if (line.out) expect(line.out.dead).toBe(false);
        for (const f of line.feeders) expect(f.out).toBe(line);
      }
      expect(belts).toBe(w.table.count);
    }
    expect(inserted).toBeGreaterThan(50);
  });
});

describe('drills dropping onto belts', () => {
  /**
   * A drill on (2..3, 0..1) facing east over iron ore, so it drops onto
   * (4, 0), where a belt line runs south for `belts` tiles.
   */
  function setup(belts: number) {
    const sim = new Sim({
      seed: 1,
      startingKit: [
        { item: ItemId.BurnerMiningDrill, count: 1 },
        { item: ItemId.TransportBelt, count: 10 },
        { item: COAL, count: 50 },
      ],
    });
    const { state } = sim;
    state.players.x[0] = tileCenter(0);
    state.players.y[0] = tileCenter(0);
    for (let y = -1; y <= 2; y++) {
      for (let x = 1; x <= 4; x++) {
        const chunk = state.world.getChunk(x >> CHUNK_SHIFT, y >> CHUNK_SHIFT);
        const i = tileIndex(x & CHUNK_MASK, y & CHUNK_MASK);
        const ore = x >= 2 && x <= 3 && y >= 0 && y <= 1;
        chunk.resource[i] = ore ? ResourceId.IronOre : ResourceId.None;
        chunk.amount[i] = ore ? 100 : 0;
      }
    }
    expect(placeEntity(state, 0, ItemId.BurnerMiningDrill, 2, 0, East)).toBe(BuildResult.Ok);
    for (let y = 0; y < belts; y++) {
      expect(placeEntity(state, 0, ItemId.TransportBelt, 4, y, South)).toBe(BuildResult.Ok);
    }
    const { entities } = state;
    const drill = entities.at(2, 0);
    const belt = entities.at(4, 0);
    const table = beltTable(entities)!;
    expect(drillDropTile(2, 0, East)).toEqual({ x: 4, y: 0 });
    entities.insert(drill, COAL, 5);
    const line = table.line(table.beltLine(belt))!;
    const onLine = () => line.lanes[0].count + line.lanes[1].count;
    const step = (n: number) => {
      for (let i = 0; i < n; i++) sim.step();
    };
    return { sim, entities, drill, belt, table, line, onLine, step };
  }

  it('puts one unit on the belt every 240 ticks, on the right lane while it has room', () => {
    const d = setup(4);
    for (let unit = 1; unit <= 5; unit++) {
      d.step(DRILL_MINING_TICKS - 1);
      expect(d.onLine()).toBe(unit - 1);
      d.step(1);
      expect(d.onLine()).toBe(unit);
      expect(d.entities.status(d.drill)).toBe(MachineState.Working);
    }
    // Each one landed on the middle of the right lane and ran down the line.
    expect(d.line.lanes[BeltLane.Left].count).toBe(0);
    expect(Array.from(d.line.lanes[BeltLane.Right].items())).toEqual(Array(5).fill(ItemId.IronOre));
    expect(d.line.lanes[BeltLane.Right].gap(0)).toBe(0);
  });

  it('saturate a belt end to end: more drills than it carries deliver exactly 15 items/s', () => {
    // 80 drills along an 84-belt line running east on y = 0: 40 on the north
    // side facing south, 40 on the south side facing north, each pair over two
    // belts. Together they mine 80 / 240 = 1/3 unit per tick, a third more than
    // the belt's 2 × 8 / 64 = 1/4 per tick, so the belt fills up and the drills
    // take turns.
    const DRILLS_PER_SIDE = 40;
    const LENGTH = 2 * DRILLS_PER_SIDE + 4;
    const sim = new Sim({ seed: 1 });
    const { state } = sim;
    const { entities } = state;
    const drillProto = ENTITIES[EntityTypeId.BurnerMiningDrill];
    for (let x = 0; x < LENGTH; x++) entities.add(BELT, x, 0, East);
    const drills: number[] = [];
    for (let k = 0; k < DRILLS_PER_SIDE; k++) {
      const x = 2 * k;
      for (const [y, dir] of [
        [-2, South],
        [1, North],
      ] as const) {
        for (let ty = y; ty < y + 2; ty++) {
          for (let tx = x; tx < x + 2; tx++) {
            const chunk = state.world.getChunk(tx >> CHUNK_SHIFT, ty >> CHUNK_SHIFT);
            const i = tileIndex(tx & CHUNK_MASK, ty & CHUNK_MASK);
            chunk.resource[i] = ResourceId.IronOre;
            chunk.amount[i] = 1_000_000;
          }
        }
        const drop = drillDropTile(x, y, dir);
        expect(drop.y).toBe(0);
        const drill = entities.add(drillProto, x, y, dir);
        expect(entities.insert(drill, COAL, 50)).toBe(50);
        drills.push(drill);
      }
    }
    const table = beltTable(entities)!;
    expect(table.lineCount).toBe(1);
    const line = table.line(table.beltLine(entities.at(0, 0)))!;
    expect(line.length).toBe(LENGTH * BELT_LENGTH);

    // Every tick, whatever reached the end of the line is taken off it.
    const counts = [0, 0];
    const tick = (count: boolean) => {
      sim.step();
      for (const lane of [Left, Right]) {
        if (table.peekEnd(line.id, lane) !== 0) {
          expect(table.takeAt(line.id, lane, 0, 0)).toBe(ItemId.IronOre);
          if (count) counts[lane]!++;
        }
      }
    };
    // Long enough for the line to fill from the far end: 84 belts at 32 ticks each.
    for (let i = 0; i < 3_600; i++) tick(false);
    for (let i = 0; i < 600; i++) tick(true);
    // 600 ticks = 10 s: 7.5 items/s per lane, 15 per belt.
    expect(counts).toEqual([75, 75]);
    // The belt, not the drills, is the limit: some of them wait for room.
    const blocked = drills.filter((d) => entities.status(d) === MachineState.OutputFull);
    expect(blocked.length).toBeGreaterThan(0);
    checkLanes(table);
  });

  it('waits on a full belt and wakes once the lane moves and frees the drop point', () => {
    // A single belt: items stop at its end.
    const d = setup(1);
    // Room for three on each lane at the middle of the belt (0, 64, 128 from its end).
    d.step(6 * DRILL_MINING_TICKS);
    expect(d.onLine()).toBe(6);
    d.step(DRILL_MINING_TICKS);
    expect(d.entities.status(d.drill)).toBe(MachineState.OutputFull);
    expect(d.entities.wake.watchersOf(d.belt)).toEqual([d.drill]);
    // Everything sleeps: the drill and both lanes.
    d.step(100);
    expect(drillTable(d.entities)!.activeCount).toBe(0);
    expect(d.table.activeLanes).toBe(0);
    // Taking the item at the end of the right lane lets the lane close up by
    // 64; the drill is woken while it moves and drops as soon as there is room.
    expect(d.table.takeAt(d.line.id, BeltLane.Right, 0, 0)).toBe(ItemId.IronOre);
    d.step(64 / BELT_SPEED + 2);
    expect(d.onLine()).toBe(6);
    expect(d.entities.status(d.drill)).toBe(MachineState.Working);
    expect(d.entities.wake.watchersOf(d.belt)).toEqual([]);
  });
});

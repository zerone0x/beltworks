/**
 * A splitter half never holds its first item back for an item of the other
 * half that can't go in front of it (#139): the half makes way (D58) only
 * while the other one's item can take the slot in front, else its own item
 * goes on, so an output with room never waits on a blocked one, and no lane
 * sleeps with work left.
 */
import { describe, expect, it } from 'vitest';
import { BELT_ITEM_SPACING } from '../../src/data/entities';
import { type BeltTable, beltTable } from '../../src/sim/belts/belts';
import { BeltLane, type LineLane, type TransportLine } from '../../src/sim/belts/line';
import { Direction } from '../../src/sim/entities/direction';
import { buildDemo } from '../../src/sim/scenarios/demo';
import {
  COAL,
  IRON,
  TIERS,
  checkAsleep,
  checkCross,
  checkLanes,
  checkNoMissedWake,
  world,
} from './beltChecks';

const { East } = Direction;
const LANES = [BeltLane.Left, BeltLane.Right] as const;
const YELLOW = TIERS[0];
const FAST = TIERS[1];
const EXPRESS = TIERS[2];

/** The belt table's private waking, to start a hand-made state awake. */
const wake = (table: BeltTable, lane: LineLane) =>
  (table as unknown as { wakeLane(l: LineLane): void }).wakeLane(lane);

/** Fills lane `lane` of `line` with `n` items `BELT_ITEM_SPACING` apart from its end. */
function pack(table: BeltTable, line: TransportLine, lane: BeltLane, n: number, from = 0) {
  for (let k = 0; k < n; k++) {
    expect(table.insertAt(line.id, lane, from + k * BELT_ITEM_SPACING, IRON)).toBe(true);
  }
}

/**
 * A yellow splitter facing east whose half 0 holds one item the other half
 * sent across (marked), 64 from its end, with its own output packed; half 1
 * holds four of its own items, packed from 64, fed by a full yellow belt,
 * and its output, of tier `out`, has room for exactly one more item at its
 * start. `first` picks which half's lanes are woken (and so step) first.
 */
function stuckSplitter(out: (typeof TIERS)[number], first: 0 | 1) {
  const w = world();
  const sp = w.place(YELLOW.splitter, 0, 0, East);
  const [y0, y1] = w.table.halfLines(sp).map((h) => h.tileY) as [number, number];
  const feeder = w.run(YELLOW.belt, -4, y1, East, 4);
  const out0 = w.run(out.belt, 1, y0, East, 3);
  const out1 = w.run(out.belt, 1, y1, East, 3);
  // Lines are rebuilt as belts are placed: the halves' lines as they are now.
  const [h0, h1] = w.table.halfLines(sp);
  const o0 = w.lineOf(out0[0]!);
  const o1 = w.lineOf(out1[0]!);
  const f = w.lineOf(feeder[0]!);
  for (const lane of LANES) {
    pack(w.table, o0, lane, 13);
    pack(w.table, o1, lane, 12);
    // Straight into the halves' lanes, so that they are woken below, in order.
    for (let k = 1; k <= 4; k++)
      expect(h1.lanes[lane].insert(k * BELT_ITEM_SPACING, IRON)).toBe(true);
    pack(w.table, f, lane, f.length / BELT_ITEM_SPACING - 1, BELT_ITEM_SPACING);
    expect(h0.lanes[lane].insert(BELT_ITEM_SPACING, IRON, true)).toBe(true);
  }
  for (const lane of LANES) wake(w.table, (first === 0 ? h0 : h1).lanes[lane]);
  for (const lane of LANES) wake(w.table, (first === 0 ? h1 : h0).lanes[lane]);
  return { w, h0, h1, f, o0, o1 };
}

describe('splitter halves making way (#139)', () => {
  for (const [name, out] of [
    ['an express output (the slot in front is out of reach)', EXPRESS],
    ['a yellow output', YELLOW],
  ] as const) {
    for (const first of [0, 1] as const) {
      it(`fill the free slot on ${name}, half ${String(first)} stepping first`, () => {
        const { w, h0, h1, f, o0, o1 } = stuckSplitter(out, first);
        for (let t = 0; t < 120; t++) {
          w.step();
          checkLanes(w.table);
          checkCross(w.table);
          checkAsleep(w.table);
          checkNoMissedWake(w.table, `tick ${String(t)}`);
        }
        for (const lane of LANES) {
          // The output with room took one more item (the item that crossed
          // over or the half's own), the blocked one none, and nothing was lost.
          expect(o1.lanes[lane].count).toBe(13);
          expect(o0.lanes[lane].count).toBe(13);
          expect(h0.lanes[lane].count + h1.lanes[lane].count + f.lanes[lane].count).toBe(
            1 + 4 + 15 - 1,
          );
        }
        // Everything is asleep: nothing more can move.
        expect(w.table.activeLanes).toBe(0);
      });
    }
  }
});

/**
 * A fast splitter facing east, on lane 0 only. Half 0's first item (iron)
 * is one the other half sent across (marked), 48 from its end, then one of
 * its own 64 behind; its output, two express belts, holds eight items
 * packed from the end, with room for one more at its start, and stands
 * still. Half 1 holds two of its own items (coal) at 64 and 128, and its
 * output, a yellow belt, is full. `first` picks which half's lane is woken
 * (and so steps) first.
 */
function turnSplitter(first: 0 | 1) {
  const w = world();
  const sp = w.place(FAST.splitter, 0, 0, East);
  const [y0, y1] = w.table.halfLines(sp).map((h) => h.tileY) as [number, number];
  const out0 = w.run(EXPRESS.belt, 1, y0, East, 2);
  const out1 = w.run(YELLOW.belt, 1, y1, East, 1);
  const [h0, h1] = w.table.halfLines(sp);
  const o0 = w.lineOf(out0[0]!);
  const o1 = w.lineOf(out1[0]!);
  const lane = BeltLane.Left;
  for (let k = 0; k < 8; k++) expect(o0.lanes[lane].insert(k * BELT_ITEM_SPACING, IRON)).toBe(true);
  for (let k = 0; k < 5; k++) expect(o1.lanes[lane].insert(k * BELT_ITEM_SPACING, COAL)).toBe(true);
  expect(h0.lanes[lane].insert(48, IRON, true)).toBe(true);
  expect(h0.lanes[lane].insert(48 + BELT_ITEM_SPACING, IRON)).toBe(true);
  expect(h1.lanes[lane].insert(BELT_ITEM_SPACING, COAL)).toBe(true);
  expect(h1.lanes[lane].insert(2 * BELT_ITEM_SPACING, COAL)).toBe(true);
  const halves = first === 0 ? [h0, h1] : [h1, h0];
  for (const l of [...halves, o0, o1]) wake(w.table, l.lanes[lane]);
  return { w, o0 };
}

describe('a splitter half that did not make way (#139, D78)', () => {
  for (const first of [0, 1] as const) {
    it(`keeps its turn to make way, half ${String(first)} stepping first`, () => {
      const { w, o0 } = turnSplitter(first);
      // Half 1's first coal is offered across at once and can't go in front
      // of half 0's marked iron, which isn't making way for it (D58 makes
      // way with a half's own items only). It goes in behind. Half 1's other
      // coal then waits at half 1's end, as its output is full; half 0's own
      // iron waits at the end of its output, full by now and standing still.
      // From tick 48 the express output moves: half 0's own iron makes way
      // (it never did before, so no yield bit), and the coal goes across in
      // front of it. Setting the yield bit where the half wasn't making way
      // would let the iron go first and put the coal behind it.
      const taken: number[] = [];
      for (let t = 0; t < 120; t++) {
        w.step();
        checkLanes(w.table);
        checkCross(w.table);
        checkAsleep(w.table);
        checkNoMissedWake(w.table, `tick ${String(t)}`);
        if (t < 48) continue;
        const item = w.table.takeAt(o0.id, BeltLane.Left, 0, o0.speed - 1);
        if (item !== 0) taken.push(item);
      }
      expect(taken).toEqual([...Array<number>(9).fill(IRON), COAL, IRON, COAL]);
      expect(w.table.activeLanes).toBe(0);
    });
  }
});

/**
 * A yellow splitter facing east, on lane 0 only. Half 0 holds two of its
 * own items (iron) at 64 and 128 from its end; its output, one yellow belt,
 * holds four iron packed from its end, with room for one more at its start,
 * and stands still. Half 1 holds one of its own items (coal) 64 from its
 * end (where it stops, the spacing behind its output's last item), and
 * that output, a yellow belt, is full. `first` picks which half's
 * lane is woken (and so steps) first.
 */
function frontSplitter(first: 0 | 1) {
  const w = world();
  const sp = w.place(YELLOW.splitter, 0, 0, East);
  const [y0, y1] = w.table.halfLines(sp).map((h) => h.tileY) as [number, number];
  const out0 = w.run(YELLOW.belt, 1, y0, East, 1);
  const out1 = w.run(YELLOW.belt, 1, y1, East, 1);
  const [h0, h1] = w.table.halfLines(sp);
  const o0 = w.lineOf(out0[0]!);
  const o1 = w.lineOf(out1[0]!);
  const lane = BeltLane.Left;
  for (let k = 0; k < 4; k++) expect(o0.lanes[lane].insert(k * BELT_ITEM_SPACING, IRON)).toBe(true);
  expect(o0.length - o0.lanes[lane].total).toBe(BELT_ITEM_SPACING);
  for (let k = 0; k < 5; k++) expect(o1.lanes[lane].insert(k * BELT_ITEM_SPACING, COAL)).toBe(true);
  expect(h0.lanes[lane].insert(BELT_ITEM_SPACING, IRON)).toBe(true);
  expect(h0.lanes[lane].insert(2 * BELT_ITEM_SPACING, IRON)).toBe(true);
  expect(h1.lanes[lane].insert(BELT_ITEM_SPACING, COAL)).toBe(true);
  const halves = first === 0 ? [h0, h1] : [h1, h0];
  for (const l of [...halves, o0, o1]) wake(w.table, l.lanes[lane]);
  return { w, sp, h0, h1, o0 };
}

/** Whether splitter `sp`'s half `half` made way on lane `lane` already (the yield bit). */
function yielded(table: BeltTable, sp: number, half: 0 | 1, lane: BeltLane): boolean {
  const t = table as unknown as { nextCol: Uint32Array | number[]; row(sp: number): number };
  return (t.nextCol[t.row(sp)]! & (1 << (2 + 2 * half + lane))) !== 0;
}

describe('an item that can go in front once the other half has stepped (#139, D78)', () => {
  for (const first of [0, 1] as const) {
    it(`goes in front on the next tick, half ${String(first)} stepping first`, () => {
      const { w, sp, h0, h1, o0 } = frontSplitter(first);
      const lane = BeltLane.Left;
      // Half 1's coal can only go across to half 0's output, which has room
      // for one more item and stands still, and half 0's first iron makes
      // way for it. Where half 1 steps first, half 0 is yet to step, so the
      // coal would go in that much further back, behind the iron: it misses
      // the slot in front only for that, and goes in front on the next tick.
      // Treating the miss as if the slot were out of reach (the output
      // stands still) would give half 0 the yield bit, so its iron would go
      // first and take the output's last free slot.
      w.step();
      checkLanes(w.table);
      checkCross(w.table);
      if (first === 1) {
        // Missed on the first tick, and the iron didn't get its turn instead.
        expect(h0.lanes[lane].count).toBe(2);
        expect(h1.lanes[lane].count).toBe(1);
        expect(yielded(w.table, sp, 0, lane)).toBe(false);
      } else {
        // Half 0 has stepped: across in front of the iron at once (which
        // then goes next).
        expect(h0.lanes[lane].count).toBe(3);
        expect(h0.lanes[lane].item(0)).toBe(COAL);
        expect(h1.lanes[lane].count).toBe(0);
        expect(yielded(w.table, sp, 0, lane)).toBe(true);
      }
      for (let t = 1; t < 30; t++) {
        w.step();
        checkLanes(w.table);
        checkCross(w.table);
        checkAsleep(w.table);
        checkNoMissedWake(w.table, `tick ${String(t)}`);
      }
      // The coal took the output's last free slot, in front of half 0's iron.
      expect(Array.from(o0.lanes[lane].items())).toEqual([IRON, IRON, IRON, IRON, COAL]);
      expect(h1.lanes[lane].count).toBe(0);
      // Taking items off the output: the coal, then both of half 0's iron.
      const taken: number[] = [];
      for (let t = 0; t < 120; t++) {
        const item = w.table.takeAt(o0.id, lane, 0, o0.speed - 1);
        if (item !== 0) taken.push(item);
        w.step();
        checkLanes(w.table);
        checkCross(w.table);
        checkAsleep(w.table);
        checkNoMissedWake(w.table, `tick ${String(30 + t)}`);
      }
      expect(taken).toEqual([IRON, IRON, IRON, IRON, COAL, IRON, IRON]);
      expect(w.table.activeLanes).toBe(0);
    });
  }
});

/**
 * A yellow splitter facing east, on lane 0 only. Half 0 holds three of its
 * own items (iron) at 40, 128 and 200 from its end; its output, one fast
 * belt, holds four iron at 0, 64, 136 and 208 from its end, and one item is
 * taken off its end every seventh tick, so it moves in starts and stops.
 * Half 1 holds one of its own items (coal) 64 from its end, where it stops,
 * and its output, a yellow belt, is full. `first` picks which half's lane
 * is woken (and so steps) first.
 */
function stopGoSplitter(first: 0 | 1) {
  const w = world();
  const sp = w.place(YELLOW.splitter, 0, 0, East);
  const [y0, y1] = w.table.halfLines(sp).map((h) => h.tileY) as [number, number];
  const out0 = w.run(FAST.belt, 1, y0, East, 1);
  const out1 = w.run(YELLOW.belt, 1, y1, East, 1);
  const [h0, h1] = w.table.halfLines(sp);
  const o0 = w.lineOf(out0[0]!);
  const o1 = w.lineOf(out1[0]!);
  const lane = BeltLane.Left;
  for (const p of [0, 64, 136, 208]) expect(o0.lanes[lane].insert(p, IRON)).toBe(true);
  for (let k = 0; k < 5; k++) expect(o1.lanes[lane].insert(k * BELT_ITEM_SPACING, COAL)).toBe(true);
  for (const p of [40, 128, 200]) expect(h0.lanes[lane].insert(p, IRON)).toBe(true);
  expect(h1.lanes[lane].insert(BELT_ITEM_SPACING, COAL)).toBe(true);
  const halves = first === 0 ? [h0, h1] : [h1, h0];
  for (const l of [...halves, o0, o1]) wake(w.table, l.lanes[lane]);
  return { w, o0 };
}

describe('a crossing item held up while the output only just stopped (#139, D78)', () => {
  for (const first of [0, 1] as const) {
    it(`keeps its turn, half ${String(first)} stepping first`, () => {
      const { w, o0 } = stopGoSplitter(first);
      // Half 0's first iron makes way for half 1's coal, which can't go in
      // front of it yet. While the output moved this tick or the last, the
      // slot in front still comes closer, so the iron keeps making way and
      // the coal goes in front of it. Giving the iron its turn as soon as
      // the output stops for a tick would let the iron go first.
      const taken: number[] = [];
      for (let t = 0; t < 200; t++) {
        if (t % 7 === 0) {
          const item = w.table.takeAt(o0.id, BeltLane.Left, 0, o0.speed - 1);
          if (item !== 0) taken.push(item);
        }
        w.step();
        checkLanes(w.table);
        checkCross(w.table);
        checkAsleep(w.table);
        checkNoMissedWake(w.table, `tick ${String(t)}`);
      }
      expect(taken).toEqual([...Array<number>(5).fill(IRON), COAL, IRON, IRON]);
      expect(w.table.activeLanes).toBe(0);
    });
  }
});

describe('the demo factory (#139)', () => {
  it('has no splitter half asleep with work left', { timeout: 120_000 }, () => {
    const sim = buildDemo();
    const table = beltTable(sim.state.entities)!;
    for (let t = 0; t < 600; t++) {
      checkAsleep(table);
      if (t % 10 === 0) checkNoMissedWake(table, `tick ${String(sim.tick)}`);
      sim.step();
    }
  });
});

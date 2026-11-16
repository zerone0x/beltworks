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

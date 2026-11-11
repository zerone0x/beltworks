/**
 * A splitter merging one full input and one sparse one (#78): the half in
 * front of the full input makes way for each sparse item instead of keeping
 * slots for them that could go out empty (docs/ARCHITECTURE.md, "Belts:
 * splitters"; tests/sim/splitters.test.ts covers two full inputs).
 */
import { describe, expect, it, vi } from 'vitest';
import { BELT_ITEM_SPACING } from '../../src/data/entities';
import { MERGE_SPACING } from '../../src/sim/belts/belts';
import { BeltLane, type TransportLine } from '../../src/sim/belts/line';
import { Direction } from '../../src/sim/entities/direction';
import {
  COAL,
  TIERS,
  checkAsleep,
  checkCross,
  checkLanes,
  checkNoMissedWake,
  feed,
  world,
} from './beltChecks';

const { East } = Direction;
const { Left } = BeltLane;
const LANES = [BeltLane.Left, BeltLane.Right] as const;

// Thousands of ticks per tier combination, with full checks every tick.
vi.setConfig({ testTimeout: 120_000 });

type Tier = (typeof TIERS)[number];

const WARMUP = 600;
const TICKS = 1800;

/** Items one lane of a belt of `speed` carries in `ticks` ticks at full rate. */
const perLane = (speed: number, ticks: number) => (ticks * speed) / BELT_ITEM_SPACING;

/**
 * A splitter of `tier` facing east on (2, 0)–(2, 1), with two-belt input
 * lines of `inputs` behind both halves (x = 0..1) and a two-belt output
 * line of `out` in front of the half of the full input (`full`) only, or,
 * with `cross`, in front of the half of the sparse one only (every item of
 * the full input then crosses over into that half).
 */
function rig(tier: Tier, inputs: Tier, out: Tier, full: 'inA' | 'inB', cross = false) {
  const w = world();
  w.place(tier.splitter, 2, 0, East);
  const a = w.run(inputs.belt, 0, 0, East, 2)[0]!;
  const b = w.run(inputs.belt, 0, 1, East, 2)[0]!;
  const sink = w.run(out.belt, 3, (full === 'inA') !== cross ? 0 : 1, East, 2)[0]!;
  const [inA, inB] = [w.lineOf(a), w.lineOf(b)];
  return {
    w,
    full: full === 'inA' ? inA : inB,
    sparse: full === 'inA' ? inB : inA,
    sink: w.lineOf(sink),
  };
}

/**
 * Runs `WARMUP + TICKS` ticks: the full input fed at full rate, the sparse
 * one getting an item on each lane at its start every `1 / rate` ticks (as
 * a belt carrying `rate` items per tick would bring them; one waits for
 * room if need be), the output emptied as fast as items arrive. With
 * `clumped`, each sparse item goes right behind the one before instead (if
 * the lane has room there), so they come in clumps at the input belt's
 * full rate. Every invariant is checked each tick, sleep at the end.
 * Counts per lane the items taken off the output and fed into each input
 * after the warm-up.
 */
function merge(
  w: ReturnType<typeof world>,
  full: TransportLine,
  sparse: TransportLine,
  sink: TransportLine,
  rate: number,
  clumped = false,
) {
  const taken = [0, 0];
  const fedFull = [0, 0];
  const fedSparse = [0, 0];
  const owed = [0, 0];
  for (let t = 0; t < WARMUP + TICKS; t++) {
    w.step();
    const counted = t >= WARMUP;
    for (const lane of LANES) {
      while (w.table.takeAt(sink.id, lane, 0, sink.speed - 1) !== 0) if (counted) taken[lane]!++;
      if (feed(w, full, lane) && counted) fedFull[lane]!++;
      if (Math.floor((t + 1) * rate) > Math.floor(t * rate)) owed[lane]!++;
      const put = () =>
        clumped
          ? feed(w, sparse, lane, COAL)
          : w.table.insertAt(sparse.id, lane, sparse.length, COAL);
      if (owed[lane]! > 0 && put()) {
        owed[lane]!--;
        if (counted) fedSparse[lane]!++;
      }
    }
    checkLanes(w.table);
    checkCross(w.table);
  }
  checkAsleep(w.table);
  checkNoMissedWake(w.table);
  return { taken, fedFull, fedSparse };
}

describe('merging a full and a sparse input through a splitter, every tier', () => {
  for (const s of TIERS) {
    it(`${s.splitter.name}: puts min(splitter, output, inputs) onto the output, all the sparse input carries up to half`, () => {
      const sp = s.belt.beltSpeed!;
      TIERS.forEach((i, ki) => {
        TIERS.forEach((o, ko) => {
          // The full input on either side (the halves step in list order).
          const full = (ki + ko) % 2 === 0 ? 'inA' : 'inB';
          for (const fraction of [1 / 4, 1 / 2]) {
            const name = `${s.splitter.name}, ${i.belt.name} in (${full} full, the other at ${String(fraction)}), ${o.belt.name} out`;
            const speed = i.belt.beltSpeed!;
            const r = rig(s, i, o, full);
            const rate = (fraction * speed) / BELT_ITEM_SPACING;
            const { taken, fedFull, fedSparse } = merge(r.w, r.full, r.sparse, r.sink, rate);
            // Per lane, in subtiles per tick: the sparse input gets all it
            // carries, or half when that is less; the full one the rest.
            const total = Math.min(sp, o.belt.beltSpeed!, speed + fraction * speed);
            const sparse = Math.min(fraction * speed, total / 2);
            for (const lane of LANES) {
              expect(Math.abs(taken[lane]! - perLane(total, TICKS)), name).toBeLessThanOrEqual(3);
              expect(taken[lane]!, name).toBeLessThanOrEqual(perLane(sp, TICKS) + 1);
              expect(Math.abs(fedSparse[lane]! - perLane(sparse, TICKS)), name).toBeLessThanOrEqual(
                3,
              );
              expect(
                Math.abs(fedFull[lane]! - perLane(total - sparse, TICKS)),
                name,
              ).toBeLessThanOrEqual(3);
            }
          }
        });
      });
    });
  }

  it('keeps no slots free for a sparse input, and keeps them again once it fills up', () => {
    const [s, i] = [TIERS[2], TIERS[1]];
    const { w, full, sparse, sink } = rig(s, i, s, 'inA');
    const [halfA] = w.table.halfLines(w.entities.at(2, 0));
    // An item every 16 ticks per lane: half A makes way for each one.
    merge(w, full, sparse, sink, 1 / 16);
    expect(halfA.lanes[Left].spacing).toBe(BELT_ITEM_SPACING);
    // Both full: a slot kept free behind each of A's own items, as before.
    for (let t = 0; t < 200; t++) {
      w.step();
      for (const lane of LANES) {
        while (w.table.takeAt(sink.id, lane, 0, sink.speed - 1) !== 0);
        feed(w, full, lane);
        feed(w, sparse, lane);
      }
    }
    expect(halfA.lanes[Left].spacing).toBe(MERGE_SPACING);
  });
});

/** Sparse fractions of its belt the crossover test runs, from a quarter to nine tenths. */
const CROSS_FRACTIONS = [0.25, 0.4, 0.45, 0.5, 0.6, 0.7, 0.9];

describe('a full input crossing over into the half of a sparse one, every tier (#78)', () => {
  for (const s of TIERS) {
    it(`${s.splitter.name}: puts min(splitter, output, inputs) onto the output, all the sparse input carries up to half`, () => {
      const sp = s.belt.beltSpeed!;
      TIERS.forEach((i, ki) => {
        TIERS.forEach((o, ko) => {
          const full = (ki + ko) % 2 === 0 ? 'inA' : 'inB';
          for (const fraction of CROSS_FRACTIONS) {
            const name = `${s.splitter.name}, ${i.belt.name} in (${full} full and crossing over, the other at ${String(fraction)}), ${o.belt.name} out`;
            const speed = i.belt.beltSpeed!;
            const r = rig(s, i, o, full, true);
            const rate = (fraction * speed) / BELT_ITEM_SPACING;
            const { taken, fedFull, fedSparse } = merge(r.w, r.full, r.sparse, r.sink, rate);
            const total = Math.min(sp, o.belt.beltSpeed!, speed + fraction * speed);
            const sparse = Math.min(fraction * speed, total / 2);
            for (const lane of LANES) {
              expect(Math.abs(taken[lane]! - perLane(total, TICKS)), name).toBeLessThanOrEqual(3);
              expect(taken[lane]!, name).toBeLessThanOrEqual(perLane(sp, TICKS) + 1);
              expect(Math.abs(fedSparse[lane]! - perLane(sparse, TICKS)), name).toBeLessThanOrEqual(
                3,
              );
              expect(
                Math.abs(fedFull[lane]! - perLane(total - sparse, TICKS)),
                name,
              ).toBeLessThanOrEqual(3);
            }
          }
        });
      });
    });
  }

  it("keeps no slots free in the sparse input's half, and keeps them again once it fills up", () => {
    const [s, i] = [TIERS[1], TIERS[2]];
    const { w, full, sparse, sink } = rig(s, i, s, 'inA', true);
    const [, halfB] = w.table.halfLines(w.entities.at(2, 0));
    // A quarter of an express belt on input B: half B's own items come too
    // far apart to need slots, so A's items fill the gaps between them.
    const { taken } = merge(w, full, sparse, sink, 1 / 16);
    expect(halfB.lanes[Left].spacing).toBe(BELT_ITEM_SPACING);
    for (const lane of LANES) expect(taken[lane]).toBeGreaterThanOrEqual(perLane(16, TICKS) - 3);
    // Both full: a slot kept free behind each of B's own items, as before.
    for (let t = 0; t < 200; t++) {
      w.step();
      for (const lane of LANES) {
        while (w.table.takeAt(sink.id, lane, 0, sink.speed - 1) !== 0);
        feed(w, full, lane);
        feed(w, sparse, lane);
      }
    }
    expect(halfB.lanes[Left].spacing).toBe(MERGE_SPACING);
  });
});

describe('a sparse input arriving in clumps (still open, #78)', () => {
  it('loses no more than it did before #78 was worked on (a regression guard, not a target)', () => {
    // Express splitter and output, fast inputs: input A full, input B
    // getting a third or half of a fast belt in clumps (each item right
    // behind the one before). The output gets less than min(splitter,
    // output, inputs) here, straight on and crossing over alike; the
    // numbers are what main measured before the work on #78 (items per
    // lane over the measured ticks), so a change can't make it worse.
    const [, f, e] = TIERS;
    const before = [
      { fraction: 1 / 3, cross: false, taken: 550 },
      { fraction: 1 / 3, cross: true, taken: 601 },
      { fraction: 1 / 2, cross: false, taken: 605 },
      { fraction: 1 / 2, cross: true, taken: 625 },
    ];
    for (const { fraction, cross, taken: was } of before) {
      const r = rig(e, f, e, 'inA', cross);
      const rate = (fraction * 16) / BELT_ITEM_SPACING;
      const { taken, fedSparse } = merge(r.w, r.full, r.sparse, r.sink, rate, true);
      const name = `${String(fraction)} of a fast belt in clumps, ${cross ? 'crossing over' : 'straight'}`;
      for (const lane of LANES) {
        expect(
          Math.abs(fedSparse[lane]! - perLane(fraction * 16, TICKS)),
          name,
        ).toBeLessThanOrEqual(3);
        expect(taken[lane]!, name).toBeGreaterThanOrEqual(was - 3);
        expect(taken[lane]!, name).toBeLessThanOrEqual(perLane(24, TICKS) + 1);
      }
    }
  });
});

describe('the splitter rate on a side another half merges into', () => {
  it('never lets items through faster than the splitter when a merging output blocks', () => {
    // A fast splitter: input A (yellow) full, its output (yellow) emptied
    // in bursts so it keeps blocking; input B (fast) fed at random, its
    // output (express) emptied as fast as items arrive. Each time A's
    // output blocks, A's items go across into half B, and the first one
    // used to go in at B's end before B stepped in that tick: B then handed
    // it on with a whole tick of movement, so items left B 3, 4, 3, 4...
    // ticks apart, above the splitter's one per 4 ticks.
    const [y, f, e] = TIERS;
    const w = world();
    w.place(f.splitter, 5, 0, East);
    w.place(y.belt, 4, 0, East);
    for (let x = 4; x >= 1; x--) w.place(f.belt, x, 1, East);
    for (let x = 6; x <= 8; x++) {
      w.place(y.belt, x, 0, East);
      w.place(e.belt, x, 1, East);
    }
    const [inA, inB, outA, outB] = [
      [4, 0],
      [1, 1],
      [6, 0],
      [6, 1],
    ].map(([x, row]) => w.lineOf(w.entities.at(x!, row!)));
    let seed = 363;
    const random = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
    const sp = f.belt.beltSpeed!;
    const arrived: number[][] = [[], []];
    for (let t = 0; t < 3000; t++) {
      for (const lane of LANES) {
        if (t % 283 < 216) while (w.table.takeAt(outA!.id, lane, 0, outA!.speed - 1) !== 0);
        while (w.table.takeAt(outB!.id, lane, 0, outB!.speed - 1) !== 0);
        feed(w, inA!, lane);
        if (random() < 0.3) feed(w, inB!, lane, COAL);
      }
      const before = LANES.map((lane) => outB!.lanes[lane].count);
      w.step();
      for (const lane of LANES) {
        for (let n = outB!.lanes[lane].count - before[lane]!; n > 0; n--) arrived[lane]!.push(t);
      }
      checkLanes(w.table);
      checkCross(w.table);
    }
    for (const lane of LANES) {
      const times = arrived[lane]!;
      expect(times.length).toBeGreaterThan(300);
      // Any k consecutive items take at least k * 4 ticks, less a tick (an
      // item may leave with part of a tick's movement left).
      for (let i = 0; i < times.length; i++) {
        for (let k = 2; k <= 16 && k <= i; k++) {
          const ticks = times[i]! - times[i - k]!;
          expect(
            ticks * sp,
            `lane ${String(lane)}: ${String(k)} items by t${String(times[i])}`,
          ).toBeGreaterThanOrEqual(k * BELT_ITEM_SPACING - sp);
        }
      }
    }
  });
});

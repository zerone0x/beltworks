import { describe, expect, it, vi } from 'vitest';
import { BELT_ITEM_SPACING, ENTITIES, EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { RECIPES, RecipeId } from '../../src/data/recipes';
import { TECHNOLOGIES, TechId } from '../../src/data/technologies';
import { MERGE_SPACING, beltTable } from '../../src/sim/belts/belts';
import { BeltLane, type TransportLine } from '../../src/sim/belts/line';
import { splitterHalfAt, splitterHalfTile } from '../../src/sim/belts/splitter';
import { BuildResult, placeEntity, removeEntity, rotateEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { tileCenter } from '../../src/sim/fixed';
import { Rng } from '../../src/sim/rng';
import { Sim } from '../../src/sim/tick';
import {
  COAL,
  IRON,
  TIERS,
  checkAsleep,
  checkCross,
  checkLanes,
  checkNoMissedWake,
  checkTopology,
  countSteps,
  feed,
  world,
  type World,
} from './beltChecks';

const { North, East, South, West } = Direction;
const { Left, Right } = BeltLane;
const LANES = [Left, Right] as const;

// The exact-rate and stress tests run thousands of ticks with full checks.
vi.setConfig({ testTimeout: 120_000 });

type Tier = (typeof TIERS)[number];

/**
 * A splitter of `tier` facing east on (2, 0)–(2, 1) (half 0 on y = 0),
 * with two-belt input lines behind each half (x = 0..1) and two-belt
 * output lines in front (x = 3..4), as asked for, of the belt tier `belts`.
 */
function rig(
  tier: Tier,
  parts: { inA?: boolean; inB?: boolean; outA?: boolean; outB?: boolean },
  belts: Tier = tier,
  outputs: Tier = belts,
) {
  const w = world();
  const splitter = w.place(tier.splitter, 2, 0, East);
  // Placed first, then looked up: placing a belt rebuilds the lines around it.
  const place = (x: number, y: number, on: boolean | undefined, t: Tier) =>
    on === false ? 0 : w.run(t.belt, x, y, East, 2)[0]!;
  const ids = [
    place(0, 0, parts.inA, belts),
    place(0, 1, parts.inB, belts),
    place(3, 0, parts.outA, outputs),
    place(3, 1, parts.outB, outputs),
  ];
  const [inA = null, inB = null, outA = null, outB = null] = ids.map((id) =>
    id === 0 ? null : w.lineOf(id),
  );
  const [halfA, halfB] = w.table.halfLines(splitter);
  return { w, splitter, inA, inB, outA, outB, halfA, halfB };
}

/**
 * Runs `warmup + ticks` ticks, feeding the `sources` at full rate and
 * emptying the `sinks` as fast as items arrive, with every invariant
 * checked each tick. Counts per sink and lane (after the warm-up), and per
 * source and lane, the items fed during the counted ticks.
 */
function run(
  w: World,
  sources: (TransportLine | null)[],
  sinks: (TransportLine | null)[],
  warmup: number,
  ticks: number,
) {
  const taken = sinks.map(() => [0, 0]);
  const fed = sources.map(() => [0, 0]);
  for (let t = 0; t < warmup + ticks; t++) {
    w.step();
    sinks.forEach((sink, k) => {
      if (!sink) return;
      for (const lane of LANES) {
        while (w.table.takeAt(sink.id, lane, 0, sink.speed - 1) !== 0) {
          if (t >= warmup) taken[k]![lane]!++;
        }
      }
    });
    sources.forEach((source, k) => {
      if (!source) return;
      for (const lane of LANES) if (feed(w, source, lane) && t >= warmup) fed[k]![lane]!++;
    });
    checkLanes(w.table);
    checkCross(w.table);
  }
  return { taken, fed };
}

/** Items one lane of a belt of `speed` carries in `ticks` ticks at full rate. */
const perLane = (speed: number, ticks: number) => (ticks * speed) / BELT_ITEM_SPACING;

describe('splitter data', () => {
  it('has a 2×1 splitter of each tier, with its recipe and research', () => {
    for (const [i, t] of TIERS.entries()) {
      expect([t.splitter.width, t.splitter.height, t.splitter.rotatable]).toEqual([2, 1, true]);
      expect(t.splitter.beltSpeed).toBe(t.belt.beltSpeed);
      expect(t.splitter.splitter).toBe(true);
      expect(t.splitter.color).toBe(t.belt.color);
      expect(i).toBeGreaterThanOrEqual(0);
    }
    expect(RECIPES[RecipeId.Splitter].inputs).toEqual([
      [ItemId.ElectronicCircuit, 5],
      [ItemId.IronPlate, 5],
      [ItemId.TransportBelt, 4],
    ]);
    expect(RECIPES[RecipeId.FastSplitter].inputs).toEqual([
      [ItemId.Splitter, 1],
      [ItemId.IronGearWheel, 10],
    ]);
    expect(RECIPES[RecipeId.ExpressSplitter].inputs).toEqual([
      [ItemId.FastSplitter, 1],
      [ItemId.IronGearWheel, 10],
      [ItemId.ElectronicCircuit, 10],
    ]);
    expect(TECHNOLOGIES[TechId.Logistics].unlocks).toContain(RecipeId.Splitter);
    expect(TECHNOLOGIES[TechId.Logistics2].unlocks).toContain(RecipeId.FastSplitter);
    expect(TECHNOLOGIES[TechId.Logistics3].unlocks).toContain(RecipeId.ExpressSplitter);
    expect(ENTITIES[EntityTypeId.Splitter].item).toBe(ItemId.Splitter);
  });

  it('puts half 0 on the left of the way items move, whichever way it faces', () => {
    // Top-left tile (5, 5); the footprint is 2×1 facing north or south, 1×2 east or west.
    expect(splitterHalfTile(5, 5, North, 0)).toEqual({ x: 5, y: 5 });
    expect(splitterHalfTile(5, 5, North, 1)).toEqual({ x: 6, y: 5 });
    expect(splitterHalfTile(5, 5, East, 0)).toEqual({ x: 5, y: 5 });
    expect(splitterHalfTile(5, 5, East, 1)).toEqual({ x: 5, y: 6 });
    expect(splitterHalfTile(5, 5, South, 0)).toEqual({ x: 6, y: 5 });
    expect(splitterHalfTile(5, 5, South, 1)).toEqual({ x: 5, y: 5 });
    expect(splitterHalfTile(5, 5, West, 0)).toEqual({ x: 5, y: 6 });
    expect(splitterHalfTile(5, 5, West, 1)).toEqual({ x: 5, y: 5 });
    expect(splitterHalfAt(5, 5, West, 5, 5)).toBe(1);
  });
});

describe('splitters', () => {
  it('connect only from behind and in front, as lines of their own', () => {
    const { w, splitter, inA, inB, outA, outB, halfA, halfB } = rig(TIERS[0], {});
    expect([inA!.out, inB!.out]).toEqual([halfA, halfB]);
    expect([halfA.out, halfB.out]).toEqual([outA, outB]);
    expect(w.table.beltLineAt(splitter, 2, 0)).toBe(halfA.id);
    expect(w.table.beltLineAt(splitter, 2, 1)).toBe(halfB.id);
    checkTopology(w);
    // A belt pointing into its side does nothing; one in front fed from behind isn't side-loaded.
    const side = w.place(TIERS[0].belt, 2, -1, South);
    expect(w.lineOf(side).out).toBeNull();
    checkTopology(w);
  });

  for (const tier of TIERS) {
    const { speed } = { speed: tier.belt.beltSpeed! };
    const name = tier.splitter.name;

    it(`${name}: splits one input 50/50 per lane, exactly`, () => {
      const { w, inA, outA, outB } = rig(tier, { inB: false });
      const ticks = 3600;
      const { taken, fed } = run(w, [inA], [outA, outB], 600, ticks);
      for (const lane of LANES) {
        // The input runs at full rate, and each output gets every other item.
        expect(Math.abs(fed[0]![lane]! - perLane(speed, ticks))).toBeLessThanOrEqual(1);
        expect(Math.abs(taken[0]![lane]! - taken[1]![lane]!)).toBeLessThanOrEqual(1);
        expect(
          Math.abs(taken[0]![lane]! + taken[1]![lane]! - perLane(speed, ticks)),
        ).toBeLessThanOrEqual(2);
      }
    });

    it(`${name}: carries ${String(tier.perSecond)} items/s per belt through both halves`, () => {
      const { w, inA, inB, outA, outB } = rig(tier, {});
      const ticks = 3600;
      const { taken } = run(w, [inA, inB], [outA, outB], 600, ticks);
      for (const k of [0, 1]) {
        const total = taken[k]![0]! + taken[k]![1]!;
        expect(
          Math.abs(total - (tier.perSecond * ticks) / 60),
          `output ${String(k)}`,
        ).toBeLessThanOrEqual(2);
      }
    });

    it(`${name}: merges two full inputs into one output at full rate, taking turns`, () => {
      for (const missing of ['outA', 'outB'] as const) {
        const { w, inA, inB, outA, outB } = rig(tier, { [missing]: false });
        const ticks = 3600;
        const out = missing === 'outA' ? outB : outA;
        const { taken, fed } = run(w, [inA, inB], [out], 600, ticks);
        for (const lane of LANES) {
          expect(Math.abs(taken[0]![lane]! - perLane(speed, ticks)), missing).toBeLessThanOrEqual(
            2,
          );
          // Both inputs get half each.
          expect(Math.abs(fed[0]![lane]! - fed[1]![lane]!), missing).toBeLessThanOrEqual(2);
        }
      }
    });

    it(`${name}: sends everything to the other output when one is blocked`, () => {
      for (const inputs of [1, 2]) {
        const { w, inA, inB, outA, outB } = rig(tier, {});
        // Nothing empties output B: it backs up, and then everything goes to A.
        run(w, [inA, inputs === 2 ? inB : null], [outA], 0, 600);
        const before = outB!.lanes[0].count + outB!.lanes[1].count;
        const ticks = 3600;
        const { taken, fed } = run(w, [inA, inputs === 2 ? inB : null], [outA], 0, ticks);
        expect(outB!.lanes[0].count + outB!.lanes[1].count).toBe(before);
        for (const lane of LANES) {
          expect(
            Math.abs(taken[0]![lane]! - perLane(speed, ticks)),
            `${String(inputs)} in`,
          ).toBeLessThanOrEqual(2);
          if (inputs === 2)
            expect(Math.abs(fed[0]![lane]! - fed[1]![lane]!)).toBeLessThanOrEqual(2);
        }
      }
    });
  }

  it('run at the slowest tier on the way through', () => {
    for (const s of TIERS) {
      for (const b of TIERS) {
        const { w, inA, inB, outA, outB } = rig(s, {}, b);
        const ticks = 1800;
        const { taken } = run(w, [inA, inB], [outA, outB], 600, ticks);
        const rate = Math.min(s.perSecond, b.perSecond);
        for (const k of [0, 1]) {
          const total = taken[k]![0]! + taken[k]![1]!;
          expect(
            Math.abs(total - (rate * ticks) / 60),
            `${s.splitter.name} with ${b.belt.name}`,
          ).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('hold a half open for the other one only while it merges', () => {
    const { w, inA, inB, outA, halfA, halfB } = rig(TIERS[0], { outB: false });
    run(w, [inA, inB], [outA], 0, 200);
    // Half B has nowhere straight on: half A leaves it every other slot.
    expect(halfA.lanes[Left].spacing).toBe(MERGE_SPACING);
    expect(halfB.lanes[Left].spacing).toBe(BELT_ITEM_SPACING);
    // Without B's input, B empties and A closes up again.
    run(w, [inA, null], [outA], 0, 200);
    expect(halfB.lanes[Left].count).toBe(0);
    expect(halfA.lanes[Left].spacing).toBe(BELT_ITEM_SPACING);
  });

  it('keep the alternation per lane, and in the hash', () => {
    const { w, splitter, halfA } = rig(TIERS[0], { inB: false });
    const h0 = w.table.hashInto(0);
    expect(w.table.splitterNext(splitter, Left)).toBe(0);
    w.table.insertAt(halfA.id, Left, 0, IRON);
    w.step();
    // The first left-lane item went straight on; the next one goes across.
    expect(w.table.splitterNext(splitter, Left)).toBe(1);
    expect(w.table.splitterNext(splitter, Right)).toBe(0);
    expect(w.table.hashInto(0)).not.toBe(h0);
  });

  it('keep their items through rebuilds and give them back when removed', () => {
    const { w, splitter, halfA, halfB } = rig(TIERS[1], {});
    w.table.insertAt(halfA.id, Left, 100, IRON);
    w.table.insertAt(halfB.id, Right, 200, COAL);
    w.place(TIERS[0].belt, 2, 2, North);
    const [a, b] = w.table.halfLines(splitter);
    expect(a.lanes[Left].items()).toEqual(Uint16Array.of(IRON));
    expect(a.lanes[Left].gaps()).toEqual(Int32Array.of(100));
    expect(b.lanes[Right].gaps()).toEqual(Int32Array.of(200));
    expect(w.entities.contents(splitter)).toEqual([
      { item: IRON, count: 1 },
      { item: COAL, count: 1 },
    ]);
    // Reversed, it stays on its tiles and keeps each item on its tile.
    w.entities.setDirection(splitter, w.entities.rotation(splitter));
    expect(w.entities.store.dir(splitter)).toBe(West);
    const [c, d] = w.table.halfLines(splitter);
    expect([c.tileX, c.tileY, d.tileX, d.tileY]).toEqual([2, 1, 2, 0]);
    expect(c.lanes[Right].items()).toEqual(Uint16Array.of(COAL));
    expect(d.lanes[Left].items()).toEqual(Uint16Array.of(IRON));
    checkTopology(w);
    expect(w.onMap()).toBe(2);
    w.entities.remove(splitter);
    expect(w.onMap()).toBe(0);
    checkTopology(w);
  });

  it('keep items on their tiles when turned across (from code)', () => {
    const w = world();
    // Facing east on (2, 0)–(2, 1), three items on each half's left lane.
    const sp = w.place(TIERS[0].splitter, 2, 0, East);
    const [a, b] = w.table.halfLines(sp);
    for (const pos of [0, 64, 128]) {
      w.table.insertAt(a.id, Left, pos, IRON);
      w.table.insertAt(b.id, Left, pos, COAL);
    }
    // Turned north it covers (2, 0)–(3, 0): (2, 0) stays its tile, (2, 1) is left.
    w.entities.setDirection(sp, North);
    const [c, d] = w.table.halfLines(sp);
    expect([c.tileX, c.tileY, d.tileX, d.tileY]).toEqual([2, 0, 3, 0]);
    // The tile kept keeps its items; the left tile's go onto the new one.
    expect(Array.from(c.lanes[Left].items())).toEqual([IRON, IRON, IRON]);
    expect(Array.from(d.lanes[Left].items())).toEqual([COAL, COAL, COAL]);
    for (const line of [c, d]) expect(line.lanes[Left].total).toBeLessThanOrEqual(line.length);
    checkLanes(w.table);
    checkTopology(w);
  });

  it('put a jammed loop through a splitter to sleep, with no steps per tick', () => {
    for (const tier of TIERS) {
      const w = world();
      // A splitter facing east on (1, 1)–(1, 2); each output curves round
      // into the input behind the same half.
      const sp = w.place(tier.splitter, 1, 1, East);
      const P = tier.belt;
      const loopA: [number, number, Direction][] = [
        [2, 1, North],
        [2, 0, West],
        [1, 0, West],
        [0, 0, South],
        [0, 1, East],
      ];
      const loopB: [number, number, Direction][] = [
        [2, 2, South],
        [2, 3, West],
        [1, 3, West],
        [0, 3, North],
        [0, 2, East],
      ];
      for (const [x, y, d] of [...loopA, ...loopB]) w.place(P, x, y, d);
      const [ha, hb] = w.table.halfLines(sp);
      expect(w.lineOf(w.entities.at(0, 1)).out).toBe(ha);
      expect(w.lineOf(w.entities.at(0, 2)).out).toBe(hb);
      expect(ha.out).toBe(w.lineOf(w.entities.at(2, 1)));
      // Overfilled everywhere: nothing can move.
      for (let r = 0; r < 3; r++) {
        for (const line of w.table.lines()) {
          for (const lane of LANES) {
            for (let pos = 0; pos <= line.length; pos += 64)
              w.table.insertAt(line.id, lane, pos, IRON);
          }
        }
        w.step(50);
      }
      const items = w.onMap();
      w.step(200);
      // (No spacing check across hand-overs: a ring of lines overfilled like
      // this keeps items pushed past a line's start, see "Rebuilds".)
      checkLanes(w.table);
      checkAsleep(w.table);
      expect(w.table.activeLanes, tier.splitter.name).toBe(0);
      expect(countSteps(w, 64).every((t) => t.calls === 0)).toBe(true);
      expect(w.onMap()).toBe(items);
      // Taking an item wakes it up; it circulates and jams again.
      expect(w.table.takeAt(ha.id, Left, 0, 255)).not.toBe(0);
      expect(w.table.activeLanes).toBeGreaterThan(0);
      w.step(400);
      checkAsleep(w.table);
      expect(countSteps(w, 10).every((t) => t.calls === 0 || t.idle < t.calls)).toBe(true);
    }
  });

  it('never keep lanes awake on a tick when nothing moves, in random loops through splitters', () => {
    let jammed = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const rng = Rng.fromSeed(seed);
      const w = world();
      const sp = w.place(TIERS[rng.nextInt(3)]!.splitter, 1, 1, East);
      const ring: [number, number, Direction][] = [
        [2, 1, North],
        [2, 0, West],
        [1, 0, West],
        [0, 0, South],
        [0, 1, East],
        [2, 2, South],
        [2, 3, West],
        [1, 3, West],
        [0, 3, North],
        [0, 2, East],
      ];
      const ids = ring.map(([x, y, d]) => w.place(TIERS[rng.nextInt(3)]!.belt, x, y, d));
      for (let r = 0; r < 200; r++) {
        const k = rng.nextInt(ids.length + 1);
        const id = k === ids.length ? sp : ids[k]!;
        const a = rng.nextInt(5);
        if (a === 0 && id !== sp) w.entities.setDirection(id, rng.nextInt(4) as Direction);
        else if (a === 1 && id !== sp) w.entities.setDirection(id, ring[k]![2]);
        else w.entities.insert(id, IRON, 2);
        w.step(rng.nextInt(10));
      }
      ids.forEach((id, k) => w.entities.setDirection(id, ring[k]![2]));
      const fill = 200 + rng.nextInt(300);
      for (let r = 0; r < fill; r++) {
        for (const id of [sp, ...ids]) w.entities.insert(id, IRON, 2);
        w.step();
      }
      w.step(600);
      // (No spacing check across hand-overs: a ring of lines overfilled like
      // this keeps items pushed past a line's start, see "Rebuilds".)
      checkLanes(w.table);
      checkAsleep(w.table);
      const ticks = countSteps(w, 64);
      for (const t of ticks)
        expect(t.calls === 0 || t.idle < t.calls, `seed ${String(seed)}`).toBe(true);
      if (ticks.every((t) => t.calls === 0)) jammed++;
    }
    expect(jammed).toBeGreaterThan(0);
  });
});

describe('merging through a splitter, every tier', () => {
  const ticks = 2400;
  /**
   * Two full input lines of `inputs` into a splitter of `tier`, with an
   * output line of `out` in front of one half only (`side`): items per lane
   * on the output, and fed into each input, over `ticks` ticks.
   */
  const merge = (tier: Tier, inputs: Tier, out: Tier, side: 'outA' | 'outB') => {
    const other = side === 'outA' ? 'outB' : 'outA';
    const r = rig(tier, { [other]: false }, inputs, out);
    const { taken, fed } = run(r.w, [r.inA, r.inB], [r[side]], 600, ticks);
    return { taken: taken[0]!, fed };
  };

  it('puts min(splitter, output, inputs) onto the output, half from each input', () => {
    for (const s of TIERS) {
      for (const i of TIERS) {
        for (const o of TIERS) {
          for (const side of ['outA', 'outB'] as const) {
            const name = `${s.splitter.name}, ${i.belt.name} in, ${o.belt.name} out (${side})`;
            const { taken, fed } = merge(s, i, o, side);
            const sp = s.belt.beltSpeed!;
            const rate = Math.min(sp, o.belt.beltSpeed!, 2 * i.belt.beltSpeed!);
            for (const lane of LANES) {
              expect(Math.abs(taken[lane]! - perLane(rate, ticks)), name).toBeLessThanOrEqual(3);
              // Never more than one belt of the splitter's tier onto one side.
              expect(taken[lane]!, name).toBeLessThanOrEqual(perLane(sp, ticks) + 1);
              // Each input gets half (or all it carries, when that fits).
              expect(Math.abs(fed[0]![lane]! - fed[1]![lane]!), name).toBeLessThanOrEqual(3);
            }
          }
        }
      }
    }
  });

  it('sends everything to the open output when the other is blocked, half from each input', () => {
    for (const s of TIERS) {
      for (const i of TIERS) {
        for (const o of TIERS) {
          const name = `${s.splitter.name}, ${i.belt.name} in, ${o.belt.name} out`;
          // Output B is never emptied: it backs up, then everything goes to A.
          const r = rig(s, {}, i, o);
          const { taken, fed } = run(r.w, [r.inA, r.inB], [r.outA], 1200, 1800);
          const sp = s.belt.beltSpeed!;
          const rate = Math.min(sp, o.belt.beltSpeed!, 2 * i.belt.beltSpeed!);
          for (const lane of LANES) {
            expect(Math.abs(taken[0]![lane]! - perLane(rate, 1800)), name).toBeLessThanOrEqual(3);
            expect(Math.abs(fed[0]![lane]! - fed[1]![lane]!), name).toBeLessThanOrEqual(3);
          }
        }
      }
    }
  });

  it('merges onto a curve and into another splitter', () => {
    for (const s of TIERS) {
      const sp = s.belt.beltSpeed!;
      // A curve: the belt in front of half A turns north.
      {
        const w = world();
        w.place(s.splitter, 2, 0, East);
        const a = w.run(s.belt, 0, 0, East, 2)[0]!;
        const b = w.run(s.belt, 0, 1, East, 2)[0]!;
        const c = w.run(s.belt, 3, 0, North, 3)[0]!;
        const [inA, inB, out] = [w.lineOf(a), w.lineOf(b), w.lineOf(c)];
        expect(w.table.shape(c)).not.toBe(0);
        const { taken, fed } = run(w, [inA, inB], [out], 600, ticks);
        for (const lane of LANES) {
          expect(
            Math.abs(taken[0]![lane]! - perLane(sp, ticks)),
            s.splitter.name,
          ).toBeLessThanOrEqual(3);
          expect(Math.abs(fed[0]![lane]! - fed[1]![lane]!)).toBeLessThanOrEqual(3);
        }
      }
      // Into the right half of a second splitter, which splits onto two belts.
      {
        const w = world();
        w.place(s.splitter, 2, 0, East);
        const second = w.place(s.splitter, 3, -1, East);
        const a = w.run(s.belt, 0, 0, East, 2)[0]!;
        const b = w.run(s.belt, 0, 1, East, 2)[0]!;
        const c = w.run(s.belt, 4, -1, East, 2)[0]!;
        const d = w.run(s.belt, 4, 0, East, 2)[0]!;
        const [inA, inB, outC, outD] = [a, b, c, d].map((id) => w.lineOf(id));
        expect(w.table.halfLines(w.entities.at(2, 0))[0].out).toBe(w.table.halfLines(second)[1]);
        const { taken, fed } = run(w, [inA!, inB!], [outC!, outD!], 600, ticks);
        for (const lane of LANES) {
          const total = taken[0]![lane]! + taken[1]![lane]!;
          expect(Math.abs(total - perLane(sp, ticks)), s.splitter.name).toBeLessThanOrEqual(3);
          expect(Math.abs(taken[0]![lane]! - taken[1]![lane]!)).toBeLessThanOrEqual(2);
          expect(Math.abs(fed[0]![lane]! - fed[1]![lane]!)).toBeLessThanOrEqual(3);
        }
      }
    }
  });
});

describe('random building with belts, undergrounds and splitters', () => {
  it('keeps every item, the spacing, pairs, lines and sleep consistent through random edits and flows', () => {
    // The spacing across hand-overs holds everywhere except in a ring of
    // lines a rebuild closed with more items than fit (`overfullRing`), which
    // the flows fill up now and then; that case is older than splitters.
    const protos = TIERS.flatMap((t) => [t.belt, t.underground, t.splitter]);
    let splitterRounds = 0;
    let merges = 0;
    for (const seed of [49, 4949, 494949]) {
      const w = world();
      const rng = Rng.fromSeed(seed);
      let inserted = 0;
      let refunded = 0;
      const free = (x: number, y: number) =>
        x >= 0 && x < 12 && y >= 0 && y < 5 && w.entities.at(x, y) === 0;
      for (let round = 0; round < 1500; round++) {
        const x = rng.nextInt(12);
        const y = rng.nextInt(5);
        const id = w.entities.at(x, y);
        const action = rng.nextInt(10);
        if (id === 0) {
          if (action < 6) {
            const dir = (
              rng.nextInt(3) === 0 ? rng.nextInt(4) : East + 2 * rng.nextInt(2)
            ) as Direction;
            const proto = protos[rng.nextInt(protos.length)]!;
            const wide = proto.splitter === true;
            const [ex, ey] = (dir & 1) === 1 ? [x, y + 1] : [x + 1, y];
            if (!wide || free(ex, ey)) w.place(proto, x, y, dir);
          }
        } else if (action < 2) {
          for (const s of w.entities.contents(id)) refunded += s.count;
          w.entities.remove(id);
        } else if (action < 4) {
          let dir = action === 2 ? w.entities.rotation(id) : (rng.nextInt(4) as Direction);
          if (w.table.isSplitter(id) && (dir & 1) !== (w.entities.store.dir(id) & 1)) {
            // Turned across, a splitter needs the other tile free.
            const { x: sx, y: sy } = w.entities.footprint(id);
            const [ex, ey] = (dir & 1) === 1 ? [sx, sy + 1] : [sx + 1, sy];
            if (!free(ex, ey)) dir = w.entities.rotation(id);
          }
          w.entities.setDirection(id, dir);
        } else if (action < 7) {
          inserted += w.entities.insert(id, action === 4 ? IRON : COAL, 2);
        } else {
          const line = w.table.beltLineAt(id, x, y);
          const from = w.table.beltOffset(id);
          if (w.table.takeAt(line, rng.nextInt(2), from, w.table.beltEnd(id)) !== 0) refunded++;
        }
        checkCross(w.table, { overfullRings: true });
        // No lane is asleep that could move (#79), after the edit and every tick.
        checkNoMissedWake(w.table, `seed ${String(seed)} round ${String(round)}`);
        // Flows: items fed at the start of lines nothing feeds and taken off the
        // end of lines that hand on nowhere, so splitters split and merge.
        const flowing = round % 3 !== 0;
        for (let n = rng.nextInt(20); n > 0; n--) {
          w.step();
          checkCross(w.table, { overfullRings: true });
          checkNoMissedWake(w.table, `seed ${String(seed)} round ${String(round)}`);
          if (!flowing) continue;
          for (const line of Array.from(w.table.lines())) {
            for (const lane of LANES) {
              if (line.feeders.length === 0 && line.splitter === 0 && rng.nextInt(2) === 0) {
                if (feed(w, line, lane, lane === Left ? IRON : COAL)) inserted++;
              }
              if (!line.out && rng.nextInt(3) === 0) {
                if (w.table.takeAt(line.id, lane, 0, line.speed - 1) !== 0) refunded++;
              }
            }
            if (line.splitter !== 0 && line.lanes.some((l) => l.spacing === MERGE_SPACING))
              merges++;
          }
        }
        checkLanes(w.table);
        checkAsleep(w.table);
        expect(w.onMap() + refunded, `seed ${String(seed)} round ${String(round)}`).toBe(inserted);
        checkTopology(w);
        let splitters = 0;
        for (const line of w.table.lines()) if (line.splitter !== 0 && line.out) splitters++;
        if (splitters > 0) splitterRounds++;
      }
      expect(inserted).toBeGreaterThan(100);
    }
    // Splitters with something in front stood through many of the rounds, and merged.
    expect(splitterRounds).toBeGreaterThan(500);
    expect(merges).toBeGreaterThan(500);
  });
});

describe('inserters and splitters', () => {
  it('pick up from one half and drop onto the other', () => {
    const sim = new Sim({
      seed: 1,
      startingKit: [
        { item: ItemId.BurnerInserter, count: 3 },
        { item: ItemId.WoodenChest, count: 2 },
        { item: ItemId.Splitter, count: 1 },
        { item: COAL, count: 20 },
        { item: IRON, count: 10 },
      ],
      researched: [TechId.Logistics],
    });
    const { state } = sim;
    state.players.x[0] = tileCenter(4);
    state.players.y[0] = tileCenter(0);
    const { entities } = state;
    const place = (item: number, x: number, y: number, dir: Direction) => {
      expect(placeEntity(state, 0, item, x, y, dir)).toBe(BuildResult.Ok);
      return entities.at(x, y);
    };
    // A splitter facing north on (0, 0)–(1, 0), with nothing in front or
    // behind: chest (0, 2) → inserter (0, 1) facing north drops onto the
    // left half; inserter (1, -1) facing north picks from the right half
    // into chest (1, -2). Items only cross over inside a splitter when
    // there is somewhere to go, so the right half stays empty: the second
    // inserter waits on it, and a hand drop onto it gets picked up.
    const source = place(ItemId.WoodenChest, 0, 2, North);
    const drop = place(ItemId.BurnerInserter, 0, 1, North);
    const sp = place(ItemId.Splitter, 0, 0, North);
    const pick = place(ItemId.BurnerInserter, 1, -1, North);
    const target = place(ItemId.WoodenChest, 1, -2, North);
    const table = beltTable(entities)!;
    expect(table.isSplitter(sp)).toBe(true);
    entities.insert(drop, COAL, 2);
    entities.insert(pick, COAL, 2);
    expect(entities.insert(source, IRON, 3)).toBe(3);
    for (let i = 0; i < 600; i++) sim.step();
    const [left, right] = table.halfLines(sp);
    expect(left.lanes[0].count + left.lanes[1].count).toBe(3);
    expect(right.lanes[0].count + right.lanes[1].count).toBe(0);
    expect(entities.contents(target)).toEqual([]);
    // Onto the right half by hand (the generic insert puts it on the left half first,
    // so take that one off first): the inserter there picks it up.
    expect(table.insertAt(right.id, Left, 128, IRON)).toBe(true);
    for (let i = 0; i < 300; i++) sim.step();
    expect(entities.contents(target)).toEqual([{ item: IRON, count: 1 }]);
    // Removing the splitter refunds what is on it.
    expect(removeEntity(state, 0, 0, 0)).toBe(BuildResult.Ok);
    expect(state.players.inventory(0).count(ItemId.Splitter)).toBe(1);
    expect(state.players.inventory(0).count(IRON)).toBeGreaterThanOrEqual(10 - 3 + 3);
  });

  it('reverse through the Rotate command', () => {
    const sim = new Sim({ seed: 1, startingKit: [{ item: ItemId.Splitter, count: 1 }] });
    const { state } = sim;
    state.players.x[0] = tileCenter(4);
    state.players.y[0] = tileCenter(0);
    expect(placeEntity(state, 0, ItemId.Splitter, 1, 1, East)).toBe(BuildResult.Ok);
    const id = state.entities.at(1, 1);
    expect(state.entities.at(1, 2)).toBe(id);
    expect(rotateEntity(state, 0, 1, 2)).toBe(BuildResult.Ok);
    expect(state.entities.store.dir(id)).toBe(West);
    expect([state.entities.at(1, 1), state.entities.at(1, 2)]).toEqual([id, id]);
  });
});

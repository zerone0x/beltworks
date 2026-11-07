import { describe, expect, it, vi } from 'vitest';
import {
  BELT_ITEM_SPACING,
  ENTITIES,
  EntityTypeId,
  type EntityPrototype,
} from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { RECIPES, RecipeId } from '../../src/data/recipes';
import { BeltTable, beltTable } from '../../src/sim/belts/belts';
import { Lane } from '../../src/sim/belts/lane';
import { BELT_LENGTH, BeltLane, type TransportLine } from '../../src/sim/belts/line';
import { UndergroundMode, findPartner } from '../../src/sim/belts/underground';
import { BuildResult, placeEntity, rotateEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { Entities } from '../../src/sim/entities/entities';
import { tileCenter } from '../../src/sim/fixed';
import { Rng } from '../../src/sim/rng';
import { Sim } from '../../src/sim/tick';

const { North, East, South, West } = Direction;
const { Left, Right } = BeltLane;
const IRON = ItemId.IronPlate;
const COAL = ItemId.Coal;
const {
  TransportBelt,
  FastTransportBelt,
  ExpressTransportBelt,
  UndergroundBelt,
  FastUndergroundBelt,
  ExpressUndergroundBelt,
} = EntityTypeId;

/** The transport belt and underground belt of each tier, slowest first. */
const TIERS = [
  { belt: ENTITIES[TransportBelt], underground: ENTITIES[UndergroundBelt], perSecond: 15 },
  { belt: ENTITIES[FastTransportBelt], underground: ENTITIES[FastUndergroundBelt], perSecond: 30 },
  {
    belt: ENTITIES[ExpressTransportBelt],
    underground: ENTITIES[ExpressUndergroundBelt],
    perSecond: 45,
  },
] as const;
const [YELLOW, RED, BLUE] = TIERS;

// The exact-rate and stress tests run thousands of ticks with full checks.
vi.setConfig({ testTimeout: 60_000 });

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];

/** Bare entities with only the belt table. */
function world() {
  const table = new BeltTable();
  const entities = new Entities([table]);
  const place = (proto: EntityPrototype, x: number, y: number, dir: Direction) =>
    entities.add(proto, x, y, dir);
  /** Places `n` belts of `proto` in a row from `(x, y)` in direction `dir`. */
  const run = (proto: EntityPrototype, x: number, y: number, dir: Direction, n: number) => {
    const ids: number[] = [];
    for (let i = 0; i < n; i++) ids.push(place(proto, x + i * DX[dir]!, y + i * DY[dir]!, dir));
    return ids;
  };
  const step = (n = 1) => {
    for (let i = 0; i < n; i++) table.update();
  };
  const lineOf = (belt: number) => table.line(table.beltLine(belt))!;
  const onMap = () => {
    let n = 0;
    for (const line of table.lines()) n += line.lanes[0].count + line.lanes[1].count;
    return n;
  };
  return { table, entities, place, run, step, lineOf, onMap };
}

type World = ReturnType<typeof world>;

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

/** A lane asleep with items on it can't move, close up, or hand an item on. */
function checkAsleep(table: BeltTable): void {
  for (const line of table.lines()) {
    for (const lane of line.lanes) {
      if (lane.active || lane.count === 0) continue;
      for (let i = 1; i < lane.count; i++)
        expect(lane.gap(i)).toBeLessThanOrEqual(BELT_ITEM_SPACING);
      const out = line.out;
      if (out && line.outLane < 0 && out.lanes[lane.index] !== lane) {
        // Onto another line's start: held the spacing behind its last item.
        const target = out.lanes[lane.index];
        const floor = target.count > 0 ? BELT_ITEM_SPACING - (out.length - target.total) : 0;
        expect(lane.gap(0)).toBeLessThanOrEqual(Math.max(0, floor));
        continue;
      }
      expect(lane.gap(0)).toBe(0);
      if (out && !(line.outOnly >= 0 && lane.index !== line.outOnly)) {
        const target = out.lanes[line.outLane < 0 ? lane.index : line.outLane]!;
        const slack = line.outLane >= 0 ? out.speed - 1 : 0;
        expect(target.fitNear(line.outPos, slack)).toBe(-1);
      }
    }
  }
}

/**
 * Distances across every hand-over onto another line's start, per line and
 * lane: from the lane's first item to its end, plus from the target's start
 * to its last item. The spacing rule says at least 64.
 */
function crossGaps(table: BeltTable): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of table.lines()) {
    const next = line.out;
    if (!next || line.outLane >= 0) continue;
    for (const lane of line.lanes) {
      const target = next.lanes[lane.index];
      if (lane.count === 0 || target.count === 0 || target === lane) continue;
      out.set(`${String(line.id)}:${String(lane.index)}`, lane.gap(0) + next.length - target.total);
    }
  }
  return out;
}

function checkCross(table: BeltTable): void {
  for (const [key, d] of crossGaps(table)) {
    expect(d, `across the boundary of ${key}`).toBeGreaterThanOrEqual(BELT_ITEM_SPACING);
  }
}

/** Lines, rows, pairs and hand-overs are consistent with each other and with the pairing rule. */
function checkTopology(w: World): void {
  const { table, entities } = w;
  let belts = 0;
  for (const line of table.lines()) {
    expect(line.belts[0]).not.toBe(0);
    line.belts.forEach((b, k) => {
      if (b === 0) {
        // Only under the ground: behind an exit (or another hidden tile).
        const exit = line.belts
          .slice(0, k)
          .reverse()
          .find((id) => id !== 0)!;
        expect(table.mode(exit)).toBe(UndergroundMode.Exit);
        return;
      }
      belts++;
      expect(table.beltLine(b)).toBe(line.id);
      expect(table.beltIndex(b)).toBe(k);
      expect(table.speed(b)).toBe(line.speed);
    });
    if (line.out) expect(line.out.dead).toBe(false);
    for (const f of line.feeders) expect(f.out).toBe(line);
  }
  expect(belts).toBe(table.count);
  // Partners are symmetric and follow the pairing rule.
  const lookup = (x: number, y: number) => {
    const id = entities.at(x, y);
    if (id === 0 || !table.isBelt(id) || table.mode(id) === UndergroundMode.None) return null;
    return { speed: table.speed(id), dir: entities.store.dir(id), mode: table.mode(id) };
  };
  for (const line of table.lines()) {
    for (const b of line.belts) {
      if (b === 0 || table.mode(b) === UndergroundMode.None) continue;
      const { x, y } = entities.footprint(b);
      const p = findPartner(
        lookup,
        x,
        y,
        entities.store.dir(b),
        table.mode(b),
        table.speed(b),
        entities.prototypeOf(b)!.undergroundMaxGap!,
      );
      const partner = table.partner(b);
      expect(partner).toBe(p ? entities.at(p.x, p.y) : 0);
      if (partner !== 0) expect(table.partner(partner)).toBe(b);
    }
  }
}

/**
 * Feeds both lanes of `line` at its start, each item exactly the spacing
 * behind the last one (a source faster than any belt), and takes off every
 * item within one tick's movement of its end (a sink faster than any belt,
 * which never lets the lane stop). Returns the items taken per lane.
 */
function flow(w: World, source: TransportLine, sink: TransportLine, warmup: number, ticks: number) {
  const counts = [0, 0];
  for (let t = 0; t < warmup + ticks; t++) {
    w.step();
    for (const lane of [Left, Right]) {
      while (w.table.takeAt(sink.id, lane, 0, sink.speed - 1) !== 0) {
        if (t >= warmup) counts[lane]!++;
      }
      const l = source.lanes[lane];
      const pos = l.count === 0 ? source.length : l.total + BELT_ITEM_SPACING;
      if (pos <= source.length) expect(w.table.insertAt(source.id, lane, pos, IRON)).toBe(true);
    }
    checkLanes(w.table);
    checkCross(w.table);
  }
  return counts;
}

describe('belt tier numbers', () => {
  it('live in src/data', () => {
    expect(TIERS.map((t) => t.belt.beltSpeed)).toEqual([8, 16, 24]);
    expect(TIERS.map((t) => t.underground.beltSpeed)).toEqual([8, 16, 24]);
    expect(TIERS.map((t) => t.underground.undergroundMaxGap)).toEqual([4, 6, 8]);
    expect(TIERS.map((t) => t.belt.undergroundMaxGap)).toEqual([undefined, undefined, undefined]);
    // 60 ticks/s × speed / spacing × 2 lanes.
    for (const t of TIERS) {
      expect((60 * t.belt.beltSpeed! * 2) / BELT_ITEM_SPACING).toBe(t.perSecond);
    }
    expect(RECIPES[RecipeId.FastTransportBelt].inputs).toEqual([
      [ItemId.TransportBelt, 1],
      [ItemId.IronGearWheel, 5],
    ]);
    expect(RECIPES[RecipeId.ExpressTransportBelt].inputs).toEqual([
      [ItemId.FastTransportBelt, 1],
      [ItemId.IronGearWheel, 10],
    ]);
    expect(RECIPES[RecipeId.UndergroundBelt].outputs).toEqual([[ItemId.UndergroundBelt, 2]]);
  });
});

describe('belt tiers', () => {
  it('carry exactly 15 / 30 / 45 items/s per belt, through an underground pair', () => {
    for (const tier of TIERS) {
      const w = world();
      // 4 belts, an entrance, the longest gap, an exit, 4 belts: one line.
      const gap = tier.underground.undergroundMaxGap!;
      w.run(tier.belt, 0, 0, East, 4);
      const entrance = w.place(tier.underground, 4, 0, East);
      const exit = w.place(tier.underground, 5 + gap, 0, East);
      w.run(tier.belt, 6 + gap, 0, East, 4);
      expect(w.table.mode(entrance)).toBe(UndergroundMode.Entrance);
      expect(w.table.mode(exit)).toBe(UndergroundMode.Exit);
      expect(w.table.lineCount).toBe(1);
      const line = w.lineOf(exit);
      // The hidden tiles count as belt length.
      expect(line.length).toBe((10 + gap) * BELT_LENGTH);
      expect(line.speed).toBe(tier.belt.beltSpeed);
      const counts = flow(w, line, line, 600, 600);
      // 600 ticks = 10 s.
      expect(counts).toEqual([tier.perSecond * 5, tier.perSecond * 5]);
      checkTopology(w);
    }
  });

  it('only merge belts of the same tier; a slower line hands items on at full speed', () => {
    const w = world();
    // Yellow, then red, then blue, east along y = 0.
    const y = w.run(YELLOW.belt, 0, 0, East, 4);
    const r = w.run(RED.belt, 4, 0, East, 4);
    const b = w.run(BLUE.belt, 8, 0, East, 4);
    expect(w.table.lineCount).toBe(3);
    const [yl, rl, bl] = [w.lineOf(y[0]!), w.lineOf(r[0]!), w.lineOf(b[0]!)];
    expect([yl.speed, rl.speed, bl.speed]).toEqual([8, 16, 24]);
    // Each line ends by handing on, lane by lane, to the start edge of the next.
    expect(yl.out).toBe(rl);
    expect(yl.outLane).toBe(-1);
    expect(yl.outPos).toBe(rl.length);
    expect(rl.out).toBe(bl);
    expect(bl.out).toBeNull();
    // Saturated from the yellow end: the yellow belt is the limit all the way.
    expect(flow(w, yl, bl, 600, 600)).toEqual([75, 75]);
    // Items keep their lane across the boundaries.
    w.table.insertAt(yl.id, Left, 0, COAL);
    checkTopology(w);
  });

  it('back-pressure a faster line from a slower one at the boundary', () => {
    const w = world();
    // Blue into red into yellow: the yellow belt sets the pace.
    const b = w.run(BLUE.belt, 0, 0, East, 4);
    const r = w.run(RED.belt, 4, 0, East, 4);
    const y = w.run(YELLOW.belt, 8, 0, East, 4);
    const [bl, rl, yl] = [w.lineOf(b[0]!), w.lineOf(r[0]!), w.lineOf(y[0]!)];
    expect(flow(w, bl, yl, 900, 600)).toEqual([75, 75]);
    // The faster lines backed up: packed at the spacing, their first items
    // at the spacing behind the last item of the line in front.
    for (const line of [bl, rl]) {
      for (const lane of line.lanes) {
        expect(Array.from(lane.gaps()).slice(1)).toEqual(Array(lane.count - 1).fill(64));
        expect(lane.count).toBeGreaterThanOrEqual(line.length / BELT_ITEM_SPACING - 1);
      }
    }
    checkCross(w.table);
  });

  it('keep the spacing across every tier boundary when backed up all the way', () => {
    for (const from of TIERS) {
      for (const to of TIERS) {
        if (from === to) continue;
        const w = world();
        const [a] = w.run(from.belt, 0, 0, East, 3);
        const [b] = w.run(to.belt, 3, 0, East, 3);
        const [src, dst] = [w.lineOf(a!), w.lineOf(b!)];
        // Fed at the start and never emptied: everything stops.
        for (let t = 0; t < 1500; t++) {
          for (const lane of [Left, Right]) {
            const l = src.lanes[lane];
            const pos = l.count === 0 ? src.length : l.total + BELT_ITEM_SPACING;
            if (pos <= src.length) w.table.insertAt(src.id, lane, pos, IRON);
          }
          w.step();
          checkLanes(w.table);
          checkCross(w.table);
        }
        expect(w.table.activeLanes, `${from.belt.name} → ${to.belt.name}`).toBe(0);
        for (const lane of [Left, Right]) {
          // Exactly the spacing across the boundary, and the target full.
          expect(src.lanes[lane].gap(0) + dst.length - dst.lanes[lane].total).toBe(64);
          expect(dst.lanes[lane].total).toBe(dst.length);
        }
      }
    }
  });

  it('keep the spacing across the boundaries of mixed-tier rings', () => {
    const ring: [number, number, Direction][] = [
      [0, 0, East],
      [1, 0, South],
      [1, 1, West],
      [0, 1, North],
    ];
    for (const tiers of [
      [0, 1, 0, 1],
      [0, 0, 1, 1],
      [2, 2, 0, 0],
      [1, 1, 2, 2],
      [2, 1, 2, 2],
    ]) {
      const w = world();
      const ids = ring.map(([x, y, d], k) => w.place(TIERS[tiers[k]!]!.belt, x, y, d));
      for (let t = 0; t < 1200; t++) {
        if (t < 600) for (const id of ids) w.entities.insert(id, IRON, 1);
        w.step();
        checkLanes(w.table);
        checkCross(w.table);
      }
    }
  });

  it("hand over at exactly the slower tier's rate across every tier boundary, both ways", () => {
    for (const from of TIERS) {
      for (const to of TIERS) {
        if (from === to) continue;
        // In both orders of placement, so either line can step first.
        for (const order of [0, 1]) {
          const w = world();
          const place = () => w.run(from.belt, 0, 0, East, 4);
          const placeTo = () => w.run(to.belt, 4, 0, East, 4);
          const [a, b] = order === 0 ? [place(), placeTo()] : [placeTo(), place()].reverse();
          const [src, dst] = [w.lineOf(a![0]!), w.lineOf(b![0]!)];
          expect(src.out).toBe(dst);
          const rate = Math.min(from.perSecond, to.perSecond) * 5;
          expect(flow(w, src, dst, 600, 600), `${from.belt.name} → ${to.belt.name}`).toEqual([
            rate,
            rate,
          ]);
        }
      }
    }
  });

  it("side-load onto the near lane at exactly one lane's worth: 7.5 / 15 / 22.5 items/s", () => {
    for (const tier of TIERS) {
      for (const order of [0, 1]) {
        const w = world();
        const main = () => w.run(tier.belt, 0, 0, East, 6);
        const feed = () => w.run(tier.belt, 2, 4, North, 4);
        const [m, f] = order === 0 ? [main(), feed()] : [feed(), main()].reverse();
        const ml = w.lineOf(m![0]!);
        const fl = w.lineOf(f![0]!);
        expect(fl.out).toBe(ml);
        expect(fl.outLane).toBe(Right);
        // The feeder carries twice what the near lane takes.
        expect(flow(w, fl, ml, 600, 600), tier.belt.name).toEqual([0, tier.perSecond * 5]);
      }
    }
    // A slower feeder side-loading a faster belt delivers its own rate.
    const w = world();
    const [main] = w.run(BLUE.belt, 0, 0, East, 6);
    const [feed] = w.run(YELLOW.belt, 2, 4, North, 4);
    const [ml, fl] = [w.lineOf(main!), w.lineOf(feed!)];
    expect(fl.out).toBe(ml);
    expect(flow(w, fl, ml, 600, 600)).toEqual([0, 150]);
  });

  it('hand items on in the same tick they reach the end, so an express loop runs at full speed', () => {
    const w = world();
    // A 2×2 express loop: 1 024 subtiles, 16 items per lane, packed.
    w.place(BLUE.belt, 0, 0, East);
    w.place(BLUE.belt, 1, 0, South);
    w.place(BLUE.belt, 1, 1, West);
    w.place(BLUE.belt, 0, 1, North);
    expect(w.table.lineCount).toBe(1);
    const line = w.lineOf(w.entities.at(0, 0));
    expect(line.out).toBe(line);
    // Sixteen different items, so the rotation can be followed.
    const ids = Array.from({ length: 16 }, (_, i) => i + 1);
    ids.forEach((item, i) => w.table.insertAt(line.id, Left, i * 64, item));
    // 8 ticks × 24 = 192 subtiles: exactly three items went round.
    w.step(8);
    const lane = line.lanes[Left];
    expect(Array.from(lane.items())).toEqual([...ids.slice(3), ...ids.slice(0, 3)]);
    expect(Array.from(lane.gaps())).toEqual([0, ...Array<number>(15).fill(64)]);
    // 64 ticks: 1 536 subtiles, one and a half times round.
    w.step(56);
    expect(Array.from(lane.items())).toEqual([...ids.slice(8), ...ids.slice(0, 8)]);
    checkLanes(w.table);
  });
});

describe('underground belts', () => {
  it('pair an entrance with the next one placed in front within the max gap', () => {
    for (const tier of TIERS) {
      const w = world();
      const gap = tier.underground.undergroundMaxGap!;
      const entrance = w.place(tier.underground, 0, 0, East);
      expect(w.table.mode(entrance)).toBe(UndergroundMode.Entrance);
      expect(w.table.partner(entrance)).toBe(0);
      // One tile too far: another entrance.
      const far = w.place(tier.underground, gap + 2, 0, East);
      expect(w.table.mode(far)).toBe(UndergroundMode.Entrance);
      expect(w.table.partner(entrance)).toBe(0);
      // At the max gap: the exit.
      const exit = w.place(tier.underground, gap + 1, 0, East);
      expect(w.table.mode(exit)).toBe(UndergroundMode.Exit);
      expect(w.table.partner(entrance)).toBe(exit);
      expect(w.table.partner(exit)).toBe(entrance);
      // The exit feeds the entrance in front of it like any belt.
      const line = w.lineOf(exit);
      expect(line.belts).toEqual([far, exit, ...Array<number>(gap).fill(0), entrance]);
      checkTopology(w);
    }
  });

  it('pair the nearest exit only, and are blocked by a same-tier underground in between', () => {
    const w = world();
    const u = YELLOW.underground;
    const entrance = w.place(u, 0, 0, East);
    const exit = w.place(u, 4, 0, East);
    expect(w.table.partner(entrance)).toBe(exit);
    // Another tier, or across the axis, in between: no effect.
    const red = w.place(RED.underground, 2, 0, East);
    const across = w.place(u, 3, 0, North);
    expect(w.table.partner(entrance)).toBe(exit);
    expect(w.table.mode(red)).toBe(UndergroundMode.Entrance);
    expect(w.table.mode(across)).toBe(UndergroundMode.Entrance);
    // A same-tier one facing back in between blocks the pair.
    const back = w.place(u, 1, 0, West);
    expect(w.table.mode(back)).toBe(UndergroundMode.Entrance);
    expect(w.table.partner(entrance)).toBe(0);
    expect(w.table.partner(exit)).toBe(0);
    expect(w.table.lineCount).toBe(5);
    checkTopology(w);
    // Removing it pairs them again.
    w.entities.remove(back);
    expect(w.table.partner(entrance)).toBe(exit);
    // A new exit in between takes the entrance; the old exit is left on its own.
    const near = w.place(u, 1, 0, East);
    expect(w.table.mode(near)).toBe(UndergroundMode.Exit);
    expect(w.table.partner(entrance)).toBe(near);
    expect(w.table.partner(exit)).toBe(0);
    checkTopology(w);
  });

  it('carry items under the ground with the same spacing, and keep them through rebuilds', () => {
    const w = world();
    const before = w.run(YELLOW.belt, 0, 0, East, 2);
    const entrance = w.place(YELLOW.underground, 2, 0, East);
    const exit = w.place(YELLOW.underground, 6, 0, East);
    const after = w.run(YELLOW.belt, 7, 0, East, 2);
    const line = w.lineOf(after[0]!);
    expect(line.belts).toEqual([after[1], after[0], exit, 0, 0, 0, entrance, before[1], before[0]]);
    for (let pos = 0; pos <= line.length; pos += 64) {
      w.table.insertAt(line.id, Left, pos, IRON);
      w.table.insertAt(line.id, Right, pos, COAL);
    }
    const total = w.onMap();
    expect(total).toBe(2 * (line.length / 64 + 1));
    // Under the ground, items are on no belt but belong to the exit.
    expect(w.table.itemsOn(exit).length).toBe(8);
    expect(w.table.itemsOwnedBy(exit).length).toBe(8 + 3 * 8);
    expect(w.table.contents(exit)).toEqual([
      { item: IRON, count: 16 },
      { item: COAL, count: 16 },
    ]);
    // A belt placed next to the line rebuilds it: every item stays where it was.
    const positions = () => line.lanes.map((l) => Array.from(l.gaps()));
    const gaps = positions();
    w.place(YELLOW.belt, 2, 1, South);
    const rebuilt = w.lineOf(after[0]!);
    expect(rebuilt).not.toBe(line);
    expect(rebuilt.lanes.map((l) => Array.from(l.gaps()))).toEqual(gaps);
    expect(w.onMap()).toBe(total);
    checkLanes(w.table);
    checkTopology(w);
  });

  it('let the items under the ground come out of the exit when the entrance goes', () => {
    const w = world();
    const entrance = w.place(YELLOW.underground, 0, 0, East);
    const exit = w.place(YELLOW.underground, 5, 0, East);
    const out = w.run(YELLOW.belt, 6, 0, East, 6);
    const line = w.lineOf(exit);
    // Two items under the ground, one on each lane.
    w.table.insertAt(line.id, Left, 3 * 256, IRON);
    w.table.insertAt(line.id, Right, 2 * 256 + 100, COAL);
    expect(w.table.contents(entrance)).toEqual([]);
    w.entities.remove(entrance);
    expect(w.table.mode(exit)).toBe(UndergroundMode.Exit);
    expect(w.table.partner(exit)).toBe(0);
    // They were pushed back past the start of the exit's line, and move on.
    expect(w.onMap()).toBe(2);
    w.step(200);
    expect(w.table.itemsOn(out[5]!).map((i) => i.item)).toEqual([IRON, COAL]);
    checkTopology(w);
  });

  it('end a line at an unpaired entrance, and never feed the tile in front of it', () => {
    const w = world();
    const entrance = w.place(YELLOW.underground, 0, 0, East);
    const front = w.place(YELLOW.belt, 1, 0, East);
    expect(w.table.lineCount).toBe(2);
    expect(w.lineOf(entrance).out).toBeNull();
    // A belt pointing into the back of an exit doesn't feed it either.
    const exitEntrance = w.place(YELLOW.underground, 3, 2, North);
    const exit = w.place(YELLOW.underground, 3, 0, North);
    expect(w.table.partner(exit)).toBe(exitEntrance);
    const behind = w.place(YELLOW.belt, 3, 1, North);
    expect(w.lineOf(behind).out).toBeNull();
    expect(w.table.beltLine(behind)).not.toBe(w.table.beltLine(exit));
    expect(w.table.beltLine(front)).not.toBe(w.table.beltLine(entrance));
    checkTopology(w);
  });

  it('take only the lane on their open half when side-loaded', () => {
    // Entrance facing east at (2, 0): its rear (west) half is open. A feeder
    // pointing south into it from (2, -1) has its right lane on the west.
    // Exit facing east at (6, 0): its front (east) half is open, where a
    // feeder pointing south has its left lane.
    const w = world();
    const entrance = w.place(YELLOW.underground, 2, 0, East);
    const exit = w.place(YELLOW.underground, 6, 0, East);
    const out = w.run(YELLOW.belt, 7, 0, East, 4);
    const intoEntrance = w.place(YELLOW.belt, 2, -1, South);
    const intoExit = w.place(YELLOW.belt, 6, -1, South);
    const line = w.lineOf(exit);
    const fe = w.lineOf(intoEntrance);
    const fx = w.lineOf(intoExit);
    expect(fe.out).toBe(line);
    expect(fe.outLane).toBe(Left);
    expect(fe.outOnly).toBe(Right);
    // The middle of the entrance's rear half.
    expect(fe.outPos).toBe(w.table.beltOffset(entrance) + 192);
    expect(fx.outOnly).toBe(Left);
    expect(fx.outPos).toBe(w.table.beltOffset(exit) + 64);
    for (const feeder of [fe, fx]) {
      w.table.insertAt(feeder.id, Left, 0, feeder === fe ? IRON : COAL);
      w.table.insertAt(feeder.id, Right, 0, feeder === fe ? COAL : IRON);
    }
    w.step(300);
    // Coal from both made it; the iron waits at the ends of the feeders.
    expect(w.table.itemsOn(out[3]!).map((i) => [i.lane, i.item])).toEqual([
      [Left, COAL],
      [Left, COAL],
    ]);
    expect(w.table.peekEnd(fe.id, Left)).toBe(IRON);
    expect(w.table.peekEnd(fx.id, Right)).toBe(IRON);
    // The blocked lanes sleep.
    expect(w.table.activeLanes).toBe(0);
    checkTopology(w);
  });

  it('reverse as a pair when rotated, and break the pair when turned across', () => {
    const w = world();
    const entrance = w.place(YELLOW.underground, 0, 0, East);
    const exit = w.place(YELLOW.underground, 3, 0, East);
    const [, west] = w.run(YELLOW.belt, -1, 0, West, 2);
    // The Rotate command's direction for an underground is the reverse.
    expect(w.entities.rotation(exit)).toBe(West);
    expect(w.entities.rotation(west!)).toBe(North);
    w.entities.setDirection(exit, West);
    expect(w.entities.store.dir(entrance)).toBe(West);
    expect(w.table.mode(exit)).toBe(UndergroundMode.Entrance);
    expect(w.table.mode(entrance)).toBe(UndergroundMode.Exit);
    expect(w.table.partner(exit)).toBe(entrance);
    // Items now come out at (0, 0) heading west.
    const line = w.lineOf(exit);
    w.table.insertAt(line.id, Left, line.length, IRON);
    w.step(400);
    expect(w.table.itemsOn(west!).map((i) => i.item)).toEqual([IRON]);
    checkTopology(w);
    // Turned a quarter: no longer on the axis, so the pair breaks.
    w.entities.setDirection(exit, North);
    expect(w.table.mode(exit)).toBe(UndergroundMode.Entrance);
    expect(w.table.partner(entrance)).toBe(0);
    checkTopology(w);
  });

  it('reverse through the Rotate command in the simulation', () => {
    const sim = new Sim({
      seed: 1,
      startingKit: [{ item: ItemId.UndergroundBelt, count: 2 }],
    });
    sim.state.players.x[0] = tileCenter(0);
    sim.state.players.y[0] = tileCenter(0);
    const { state } = sim;
    expect(placeEntity(state, 0, ItemId.UndergroundBelt, 2, 2, South)).toBe(BuildResult.Ok);
    expect(placeEntity(state, 0, ItemId.UndergroundBelt, 2, 5, South)).toBe(BuildResult.Ok);
    const table = beltTable(state.entities)!;
    const [a, b] = [state.entities.at(2, 2), state.entities.at(2, 5)];
    expect([table.mode(a), table.mode(b)]).toEqual([
      UndergroundMode.Entrance,
      UndergroundMode.Exit,
    ]);
    expect(rotateEntity(state, 0, 2, 2)).toBe(BuildResult.Ok);
    expect([state.entities.store.dir(a), state.entities.store.dir(b)]).toEqual([North, North]);
    expect([table.mode(a), table.mode(b)]).toEqual([
      UndergroundMode.Exit,
      UndergroundMode.Entrance,
    ]);
    expect(table.partner(a)).toBe(b);
  });
});

describe('random building with every belt type', () => {
  it('keeps every item, the spacing, pairs and lines consistent through random edits', () => {
    const protos = TIERS.flatMap((t) => [t.belt, t.underground]);
    const w = world();
    const rng = Rng.fromSeed(4646);
    let inserted = 0;
    let refunded = 0;
    for (let round = 0; round < 2500; round++) {
      // A narrow strip, so undergrounds often line up.
      const x = rng.nextInt(12);
      const y = rng.nextInt(4);
      const id = w.entities.at(x, y);
      const action = rng.nextInt(10);
      if (id === 0) {
        if (action < 6) {
          // Mostly along the strip.
          const dir = (
            rng.nextInt(3) === 0 ? rng.nextInt(4) : East + 2 * rng.nextInt(2)
          ) as Direction;
          w.place(protos[rng.nextInt(protos.length)]!, x, y, dir);
        }
      } else if (action < 2) {
        for (const s of w.entities.contents(id)) refunded += s.count;
        w.entities.remove(id);
      } else if (action < 4) {
        const dir = action === 2 ? w.entities.rotation(id) : (rng.nextInt(4) as Direction);
        w.entities.setDirection(id, dir);
      } else if (action < 7) {
        inserted += w.entities.insert(id, action === 4 ? IRON : COAL, 2);
      } else {
        const line = w.table.beltLine(id);
        const from = w.table.beltOffset(id);
        if (w.table.takeAt(line, rng.nextInt(2), from, w.table.beltEnd(id)) !== 0) refunded++;
      }
      // Moving items never brings them closer than the spacing across a
      // hand-over onto another line (a rebuild may push items together;
      // those only ever move apart).
      for (let n = rng.nextInt(20); n > 0; n--) {
        const before = crossGaps(w.table);
        w.step();
        for (const [key, d] of crossGaps(w.table)) {
          expect(d).toBeGreaterThanOrEqual(Math.min(BELT_ITEM_SPACING, before.get(key) ?? 64));
        }
      }
      checkLanes(w.table);
      checkAsleep(w.table);
      expect(w.onMap() + refunded).toBe(inserted);
      checkTopology(w);
    }
    expect(inserted).toBeGreaterThan(100);
    // Some pairs formed along the way and some still stand.
    let pairs = 0;
    for (const line of w.table.lines()) {
      for (const b of line.belts)
        if (b !== 0 && w.table.mode(b) === UndergroundMode.Exit && w.table.partner(b)) pairs++;
    }
    expect(pairs).toBeGreaterThan(0);
  });
});

describe('inserters on every belt tier', () => {
  it('drop onto a fast belt and pick up from an express underground exit', () => {
    const sim = new Sim({
      seed: 1,
      startingKit: [
        { item: ItemId.BurnerInserter, count: 2 },
        { item: ItemId.WoodenChest, count: 2 },
        { item: ItemId.FastTransportBelt, count: 2 },
        { item: ItemId.ExpressUndergroundBelt, count: 2 },
        { item: COAL, count: 20 },
        { item: IRON, count: 10 },
      ],
    });
    const { state } = sim;
    state.players.x[0] = tileCenter(0);
    state.players.y[0] = tileCenter(0);
    const { entities } = state;
    const place = (item: number, x: number, y: number, dir: Direction) => {
      expect(placeEntity(state, 0, item, x, y, dir)).toBe(BuildResult.Ok);
      return entities.at(x, y);
    };
    // Chest (2, -2) → inserter (2, -1) facing south → fast belts on y = 0
    // running east into an express underground pair (4, 0)–(6, 0), whose
    // exit an inserter on (6, 1) facing south empties into a chest on (6, 2).
    const source = place(ItemId.WoodenChest, 2, -2, North);
    const drop = place(ItemId.BurnerInserter, 2, -1, South);
    place(ItemId.FastTransportBelt, 2, 0, East);
    place(ItemId.FastTransportBelt, 3, 0, East);
    place(ItemId.ExpressUndergroundBelt, 4, 0, East);
    const exit = place(ItemId.ExpressUndergroundBelt, 6, 0, East);
    const pick = place(ItemId.BurnerInserter, 6, 1, South);
    const target = place(ItemId.WoodenChest, 6, 2, North);
    const table = beltTable(entities)!;
    expect(table.mode(exit)).toBe(UndergroundMode.Exit);
    entities.insert(drop, COAL, 2);
    entities.insert(pick, COAL, 2);
    expect(entities.insert(source, IRON, 3)).toBe(3);
    for (let i = 0; i < 1200; i++) sim.step();
    expect(entities.contents(target)).toEqual([{ item: IRON, count: 3 }]);
  });
});

/**
 * Runs `ticks` belt ticks counting, per tick, the lane steps and the steps
 * that moved nothing (by wrapping `Lane.move`).
 */
function countSteps(w: World, ticks: number) {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- restored below, only ever called with .call
  const move = Lane.prototype.move;
  const perTick: { calls: number; idle: number }[] = [];
  let calls = 0;
  let idle = 0;
  Lane.prototype.move = function (this: Lane, speed, outlet) {
    calls++;
    const [count, total] = [this.count, this.total];
    const moved = move.call(this, speed, outlet);
    if (moved === 0 && this.count === count && this.total === total) idle++;
    return moved;
  };
  try {
    for (let t = 0; t < ticks; t++) {
      calls = 0;
      idle = 0;
      w.step();
      perTick.push({ calls, idle });
    }
  } finally {
    Lane.prototype.move = move;
  }
  return perTick;
}

describe('belt sleep across tiers', () => {
  const RING2: [number, number, Direction][] = [
    [0, 0, East],
    [1, 0, South],
    [1, 1, West],
    [0, 1, North],
  ];
  const RING3: [number, number, Direction][] = [
    [0, 0, East],
    [1, 0, East],
    [2, 0, South],
    [2, 1, South],
    [2, 2, West],
    [1, 2, West],
    [0, 2, North],
    [0, 1, North],
  ];

  it('put a jammed two-tier ring to sleep, with no steps per tick', () => {
    // Express, fast, express, express: two lines feeding each other (768 and
    // 256 long), overfilled from both ends so nothing can move.
    const w = world();
    const tiers = [BLUE, RED, BLUE, BLUE];
    RING2.forEach(([x, y, d], k) => w.place(tiers[k]!.belt, x, y, d));
    expect(w.table.lineCount).toBe(2);
    for (const line of w.table.lines()) {
      for (const lane of [Left, Right]) {
        for (let pos = 0; pos <= line.length; pos += 64) w.table.insertAt(line.id, lane, pos, IRON);
      }
    }
    const items = w.onMap();
    w.step(10);
    expect(w.table.activeLanes).toBe(0);
    expect(countSteps(w, 64).every((t) => t.calls === 0)).toBe(true);
    expect(w.onMap()).toBe(items);
    checkLanes(w.table);
    // Taking an item wakes it up again; it settles back to sleep.
    const line = w.lineOf(w.entities.at(1, 0));
    expect(w.table.takeAt(line.id, Left, 0, line.length)).not.toBe(0);
    expect(w.table.activeLanes).toBeGreaterThan(0);
    w.step(200);
    expect(countSteps(w, 10).every((t) => t.calls === 0 || t.idle < t.calls)).toBe(true);
  });

  it('never keep lanes awake on a tick when nothing moves, in random mixed-tier rings', () => {
    let jammed = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const rng = Rng.fromSeed(seed);
      const w = world();
      const ring = seed % 2 ? RING2 : RING3;
      const ids = ring.map(([x, y, d]) => w.place(TIERS[rng.nextInt(3)]!.belt, x, y, d));
      for (let r = 0; r < 300; r++) {
        const k = rng.nextInt(ids.length);
        const a = rng.nextInt(4);
        if (a === 0) w.entities.setDirection(ids[k]!, rng.nextInt(4) as Direction);
        else if (a === 1) w.entities.setDirection(ids[k]!, ring[k]![2]);
        else w.entities.insert(ids[k]!, IRON, 2);
        w.step(rng.nextInt(10));
      }
      ids.forEach((id, k) => w.entities.setDirection(id, ring[k]![2]));
      for (let r = 0; r < 300; r++) {
        for (const id of ids) w.entities.insert(id, IRON, 2);
        w.step();
      }
      w.step(600);
      checkLanes(w.table);
      // Either the ring still circulates (something moves every tick) or
      // everything sleeps: a tick with awake lanes and no movement at all
      // would be a busy jam.
      const ticks = countSteps(w, 64);
      for (const t of ticks) expect(t.calls === 0 || t.idle < t.calls, `seed ${seed}`).toBe(true);
      if (ticks.every((t) => t.calls === 0)) jammed++;
    }
    // Some of the rings did jam (and sleep).
    expect(jammed).toBeGreaterThan(0);
  });
});

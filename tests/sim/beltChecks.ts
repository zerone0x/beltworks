/**
 * Shared helpers of the belt tier, underground and splitter tests: a bare
 * belt world, and the invariant checks every one of them runs (spacing,
 * spacing across hand-overs, sleep, topology).
 */
import { expect } from 'vitest';
import {
  BELT_ITEM_SPACING,
  ENTITIES,
  EntityTypeId,
  type EntityPrototype,
} from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { BeltTable, CROSS_REACH } from '../../src/sim/belts/belts';
import { Lane } from '../../src/sim/belts/lane';
import { BeltLane, type LineLane, type TransportLine } from '../../src/sim/belts/line';
import { UndergroundMode, findPartner } from '../../src/sim/belts/underground';
import type { Direction } from '../../src/sim/entities/direction';
import { Entities } from '../../src/sim/entities/entities';

const { Left, Right } = BeltLane;
export const IRON = ItemId.IronPlate;
export const COAL = ItemId.Coal;

/** The transport belt, underground belt and splitter of each tier, slowest first. */
export const TIERS = [
  {
    belt: ENTITIES[EntityTypeId.TransportBelt],
    underground: ENTITIES[EntityTypeId.UndergroundBelt],
    splitter: ENTITIES[EntityTypeId.Splitter],
    perSecond: 15,
  },
  {
    belt: ENTITIES[EntityTypeId.FastTransportBelt],
    underground: ENTITIES[EntityTypeId.FastUndergroundBelt],
    splitter: ENTITIES[EntityTypeId.FastSplitter],
    perSecond: 30,
  },
  {
    belt: ENTITIES[EntityTypeId.ExpressTransportBelt],
    underground: ENTITIES[EntityTypeId.ExpressUndergroundBelt],
    splitter: ENTITIES[EntityTypeId.ExpressSplitter],
    perSecond: 45,
  },
] as const;

export const DX = [0, 1, 0, -1];
export const DY = [-1, 0, 1, 0];

/** Bare entities with only the belt table. */
export function world() {
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

export type World = ReturnType<typeof world>;

/** Every gap behind the first item is at least the spacing, and the totals add up. */
export function checkLanes(table: BeltTable): void {
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

/**
 * Whether the first item of splitter half lane `lane`, where it is, could
 * go anywhere with a full tick's movement (the rule of `splitHandOn`): straight
 * on from the end, or across onto the other half's lane while that half's
 * output has room (an output that moved recently keeps the half awake).
 */
function outputHasRoom(out: TransportLine, lane: number): boolean {
  const t = out.lanes[lane as BeltLane];
  return t.count === 0 || out.length - t.total >= t.spacing;
}

function halfCouldHandOn(lane: LineLane): boolean {
  const line = lane.line;
  const sib = line.sibling!;
  const out = line.out;
  if (lane.gap(0) === 0 && out) {
    const target = out.lanes[lane.index];
    let pos = out.length - out.speed;
    if (target.count > 0) pos = Math.max(pos, target.total + target.spacing);
    if (pos <= out.length) return true;
  }
  if (lane.marked(0) && out && outputHasRoom(out, lane.index)) return false;
  if (!sib.out) return false;
  const t = sib.out.lanes[lane.index];
  if (t.count > 0 && sib.out.length - t.total < t.spacing) return false;
  const target = sib.lanes[lane.index];
  const floor = t.count > 0 ? Math.max(0, t.spacing - (sib.out.length - t.total)) : 0;
  const pos = target.fitNear(floor, CROSS_REACH, BELT_ITEM_SPACING);
  if (pos < 0) return false;
  const from = sib.feeders.find((f) => f.outLane < 0)?.lanes[lane.index];
  return !(from && from.count > 0 && pos > sib.length + from.gap(0) - target.spacing);
}

/** A lane asleep with items on it can't move, close up, or hand an item on. */
export function checkAsleep(table: BeltTable): void {
  for (const line of table.lines()) {
    for (const lane of line.lanes) {
      if (lane.active || lane.count === 0) continue;
      for (let i = 1; i < lane.count; i++) expect(lane.gap(i)).toBeLessThanOrEqual(lane.spacing);
      const out = line.out;
      if (line.splitter !== 0) {
        // A splitter half: held behind the belt in front, with nowhere to go.
        const target = out?.lanes[lane.index];
        const floor =
          out && target && target.count > 0 ? BELT_ITEM_SPACING - (out.length - target.total) : 0;
        expect(lane.gap(0)).toBeLessThanOrEqual(Math.max(0, floor));
        expect(halfCouldHandOn(lane), `asleep splitter half ${String(line.id)}`).toBe(false);
        continue;
      }
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
        const pos = target.fitNear(line.outPos, slack);
        // A side-load also stays the spacing ahead of the first item of the
        // lane handing on to the target's start from another line.
        const from = out.feeders.find((f) => f.outLane < 0 && f !== out)?.lanes[target.index];
        const limit =
          line.outLane >= 0 && from && from.count > 0
            ? out.length + from.gap(0) - BELT_ITEM_SPACING
            : Infinity;
        expect(pos < 0 || pos > limit).toBe(true);
      }
    }
  }
}

/**
 * Distances across every hand-over onto another line's start, per line and
 * lane: from the lane's first item to its end, plus from the target's start
 * to its last item. The spacing rule says at least 64. A splitter half's
 * hand-over is its straight one, onto the belt in front of it: what its
 * other half sends across lands in front of its first item too.
 */
export function crossGaps(table: BeltTable): Map<string, number> {
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

export function checkCross(table: BeltTable, opts: { overfullRings?: boolean } = {}): void {
  for (const [key, d] of crossGaps(table)) {
    if (opts.overfullRings && d < BELT_ITEM_SPACING) {
      const [id, lane] = key.split(':').map(Number) as [number, number];
      if (overfullRing(table.line(id)!, lane)) continue;
    }
    expect(d, `across the boundary of ${key}`).toBeGreaterThanOrEqual(BELT_ITEM_SPACING);
  }
}

/**
 * Whether lane `lane` of `line` is part of a ring of lines handing on lane
 * by lane that holds more items than fit at the spacing: a rebuild that
 * closes such a ring keeps the extra items past a line's start, the "loop
 * of lines too full" case of docs/ARCHITECTURE.md ("Rebuilds"), where the
 * spacing across one boundary can't hold.
 */
export function overfullRing(line: TransportLine, lane: number): boolean {
  let items = 0;
  let length = 0;
  const seen = new Set<TransportLine>();
  for (let c: TransportLine | null = line; c && !seen.has(c); c = c.outLane < 0 ? c.out : null) {
    seen.add(c);
    items += c.lanes[lane as BeltLane].count;
    length += c.length;
    if (c.out === line && c.outLane < 0) return items * BELT_ITEM_SPACING > length;
  }
  return false;
}

/** Lines, rows, pairs and hand-overs are consistent with each other and with the pairing rule. */
export function checkTopology(w: World): void {
  const { table, entities } = w;
  const belts = new Set<number>();
  for (const line of table.lines()) {
    expect(line.belts[0]).not.toBe(0);
    if (line.splitter !== 0) {
      // A splitter half: one belt long, on its own tile, paired with the other half.
      expect(line.belts).toEqual([line.splitter]);
      expect(table.beltLineAt(line.splitter, line.tileX, line.tileY)).toBe(line.id);
      expect(entities.at(line.tileX, line.tileY)).toBe(line.splitter);
      expect(line.sibling!.sibling).toBe(line);
      expect(line.sibling!.splitter).toBe(line.splitter);
      expect(line.sibling!.half).toBe(1 - line.half);
      expect(table.speed(line.splitter)).toBe(line.speed);
      expect(line.feeders.every((f) => f.outLane < 0)).toBe(true);
      belts.add(line.splitter);
    }
    line.belts.forEach((b, k) => {
      if (line.splitter !== 0) return;
      if (b === 0) {
        // Only under the ground: behind an exit (or another hidden tile).
        const exit = line.belts
          .slice(0, k)
          .reverse()
          .find((id) => id !== 0)!;
        expect(table.mode(exit)).toBe(UndergroundMode.Exit);
        return;
      }
      belts.add(b);
      expect(table.beltLine(b)).toBe(line.id);
      expect(table.beltIndex(b)).toBe(k);
      expect(table.speed(b)).toBe(line.speed);
    });
    if (line.out) {
      expect(line.out.dead).toBe(false);
      expect(line.out.feeders).toContain(line);
    }
    for (const f of line.feeders) expect(f.out).toBe(line);
  }
  expect(belts.size).toBe(table.count);
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
export function flow(
  w: World,
  source: TransportLine,
  sink: TransportLine,
  warmup: number,
  ticks: number,
) {
  const counts = [0, 0];
  for (let t = 0; t < warmup + ticks; t++) {
    w.step();
    for (const lane of [Left, Right]) {
      while (w.table.takeAt(sink.id, lane, 0, sink.speed - 1) !== 0) {
        if (t >= warmup) counts[lane]!++;
      }
      feed(w, source, lane);
    }
    checkLanes(w.table);
    checkCross(w.table);
  }
  return counts;
}

/** Puts an item at the start of lane `lane` of `line` if there is room there (a fast source). */
export function feed(w: World, line: TransportLine, lane: BeltLane, item: number = IRON): boolean {
  const l = line.lanes[lane];
  const pos = l.count === 0 ? line.length : l.total + l.spacing;
  return pos <= line.length && w.table.insertAt(line.id, lane, pos, item);
}

/** Lane `lane` of `line` as distances from its end. */
export function positions(line: TransportLine, lane: BeltLane): number[] {
  const out: number[] = [];
  let d = 0;
  for (const g of line.lanes[lane].gaps()) out.push((d += g));
  return out;
}

/**
 * Runs `ticks` belt ticks counting, per tick, the lane steps and the steps
 * that moved nothing (by wrapping `Lane.move`).
 */
export function countSteps(w: World, ticks: number) {
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

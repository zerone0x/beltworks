/**
 * Inserters drop into any free gap on the tile they reach (#83): the spot
 * closest to the middle of the tile where the item fits (`BeltTable.dropSpot`),
 * so single free slots on a busy, moving belt get filled whatever their
 * phase against the tile grid, on every tier, and an inserter keeps its full
 * rate on a nearly full belt. Through random building with inserters
 * dropping onto mixed-tier belts, undergrounds and splitters, the spacing
 * (within lanes and across hand-overs), item conservation and sleep hold,
 * and no inserter waits asleep to drop where its item would fit.
 */
import { describe, expect, it, vi } from 'vitest';
import { BELT_ITEM_SPACING, ENTITIES, EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { beltTable, type BeltTable } from '../../src/sim/belts/belts';
import { Lane } from '../../src/sim/belts/lane';
import { BELT_LENGTH, BeltLane } from '../../src/sim/belts/line';
import { UndergroundMode } from '../../src/sim/belts/underground';
import { BuildResult, placeEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import type { Entities } from '../../src/sim/entities/entities';
import {
  InserterState,
  farLane,
  inserterDropTile,
  inserterTable,
} from '../../src/sim/entities/inserter';
import { tileCenter } from '../../src/sim/fixed';
import { Rng } from '../../src/sim/rng';
import type { SparseSet } from '../../src/sim/entities/sparseSet';
import { Sim } from '../../src/sim/tick';
import {
  COAL,
  IRON,
  TIERS,
  checkCross,
  checkLanes,
  checkNoMissedWake,
  positions,
  world,
} from './beltChecks';

const { North, East, South } = Direction;
const { Left, Right } = BeltLane;
const COPPER = ItemId.CopperPlate;

/** Tile of belt `id` (its top-left one). */
function tileOf(entities: Entities, id: number) {
  const { x, y } = entities.footprint(id);
  return { x, y };
}

describe('Lane.fitBetween', () => {
  it('finds the free spot in a range closest to a point, the one nearer the end on a tie', () => {
    const lane = new Lane(BELT_ITEM_SPACING);
    // Empty: the point itself, clamped to the range.
    expect(lane.fitBetween(0, 255, 128)).toBe(128);
    expect(lane.fitBetween(200, 255, 128)).toBe(200);
    expect(lane.fitBetween(0, 100, 128)).toBe(100);
    expect(lane.fitBetween(-50, 10, -20)).toBe(0);
    expect(lane.fitBetween(30, 10, 20)).toBe(-1);
    for (const pos of [0, 128, 300]) lane.insert(pos, IRON);
    // Free: [64, 64], [192, 236], [364, ...).
    expect(lane.fitBetween(0, 255, 128)).toBe(64);
    expect(lane.fitBetween(65, 255, 128)).toBe(192);
    expect(lane.fitBetween(0, 255, 230)).toBe(230);
    expect(lane.fitBetween(0, 255, 250)).toBe(236);
    expect(lane.fitBetween(237, 363, 250)).toBe(-1);
    expect(lane.fitBetween(237, 400, 250)).toBe(364);
    // A wider spacing (a merging splitter half).
    expect(lane.fitBetween(0, 255, 128, 2 * BELT_ITEM_SPACING)).toBe(-1);
    expect(lane.fitBetween(0, 1000, 128, 2 * BELT_ITEM_SPACING)).toBe(428);
    // Whatever it returns, `insert` takes.
    expect(lane.insert(lane.fitBetween(0, 255, 250), COAL)).toBe(true);
  });

  it('agrees with insert on every spot of random lanes', () => {
    const rng = Rng.fromSeed(83);
    for (let round = 0; round < 300; round++) {
      const lane = new Lane(BELT_ITEM_SPACING);
      for (let n = rng.nextInt(12); n > 0; n--) lane.insert(rng.nextInt(800), IRON);
      const lo = rng.nextInt(600);
      const hi = lo + rng.nextInt(300);
      const near = lo + rng.nextInt(hi - lo + 1);
      // Brute force: every spot in range where insert would succeed.
      let best = -1;
      for (let p = lo; p <= hi; p++) {
        if (!lane.canInsert(p)) continue;
        if (best < 0 || Math.abs(p - near) < Math.abs(best - near)) best = p;
      }
      expect(lane.fitBetween(lo, hi, near), `round ${String(round)}`).toBe(best);
    }
  });
});

describe('where an inserter drops (dropSpot)', () => {
  it('uses the middle of the tile, else the free spot closest to it', () => {
    const w = world();
    const ids = w.run(TIERS[0].belt, 0, 0, East, 3);
    const mid = ids[1]!;
    const line = w.lineOf(mid);
    const { x, y } = tileOf(w.entities, mid);
    // The middle belt spans [256, 511] of its line.
    expect(w.table.dropSpot(mid, x, y, Right)).toBe(256 + 128);
    w.table.insertAt(line.id, Right, 256 + 128, IRON);
    // A tie between 320 and 448: the one nearer the end.
    expect(w.table.dropSpot(mid, x, y, Right)).toBe(256 + 64);
    w.table.insertAt(line.id, Right, 256 + 64, IRON);
    expect(w.table.dropSpot(mid, x, y, Right)).toBe(256 + 192);
    w.table.insertAt(line.id, Right, 256 + 192, IRON);
    expect(w.table.dropSpot(mid, x, y, Right)).toBe(256);
    w.table.insertAt(line.id, Right, 256, IRON);
    // Four on the tile: full. Room on the next tiles doesn't count.
    expect(w.table.dropSpot(mid, x, y, Right)).toBe(-1);
    expect(w.table.dropOnTile(mid, x, y, Right, IRON)).toBe(false);
    // The other lane is free.
    expect(w.table.dropOnTile(mid, x, y, Left, IRON)).toBe(true);
    expect(positions(line, Left)).toEqual([384]);
  });

  it("takes items only on an underground belt's open half", () => {
    const w = world();
    // An entrance (0, 0) and its exit (3, 0), facing east: one line, the exit at index 0.
    const entrance = w.place(TIERS[0].underground, 0, 0, East);
    const exit = w.place(TIERS[0].underground, 3, 0, East);
    expect(w.table.mode(exit)).toBe(UndergroundMode.Exit);
    const line = w.lineOf(exit);
    const e = w.table.beltOffset(entrance);
    const at = (id: number) => tileOf(w.entities, id);
    // The exit's front half: [0, 128].
    expect(w.table.dropSpot(exit, at(exit).x, at(exit).y, Right)).toBe(128);
    w.table.insertAt(line.id, Right, 128, IRON);
    expect(w.table.dropSpot(exit, at(exit).x, at(exit).y, Right)).toBe(64);
    w.table.insertAt(line.id, Right, 64, IRON);
    expect(w.table.dropSpot(exit, at(exit).x, at(exit).y, Right)).toBe(0);
    w.table.insertAt(line.id, Right, 0, IRON);
    expect(w.table.dropSpot(exit, at(exit).x, at(exit).y, Right)).toBe(-1);
    // The entrance's rear half: [e + 128, e + 255].
    expect(w.table.dropSpot(entrance, at(entrance).x, at(entrance).y, Left)).toBe(e + 128);
    w.table.insertAt(line.id, Left, e + 128, IRON);
    expect(w.table.dropSpot(entrance, at(entrance).x, at(entrance).y, Left)).toBe(e + 192);
    w.table.insertAt(line.id, Left, e + 192, IRON);
    expect(w.table.dropSpot(entrance, at(entrance).x, at(entrance).y, Left)).toBe(-1);
  });

  it('keeps the spacing across hand-overs onto and from another line', () => {
    const w = world();
    // A yellow belt (0, 0) feeding a fast belt (1, 0) feeding a yellow belt (2, 0):
    // three one-belt lines handing on at their starts.
    const [a, b, c] = [0, 1, 0].map((t, x) => w.place(TIERS[t]!.belt, x, 0, East));
    const [la, lb, lc] = [a!, b!, c!].map((id) => w.lineOf(id));
    const { x, y } = tileOf(w.entities, b!);
    // On `b`, free spots at [0, 36] and [228, 255] around items at 100 and 164.
    w.table.insertAt(lb!.id, Right, 100, IRON);
    w.table.insertAt(lb!.id, Right, 164, IRON);
    // The last item of the line `b` hands on to, 20 inside its start edge:
    // nothing on `b` closer than 44 to its end. The first item of the line
    // handing on to `b`, 30 from its end: nothing on `b` past 256 + 30 - 64.
    w.table.insertAt(lc!.id, Right, BELT_LENGTH - 20, IRON);
    w.table.insertAt(la!.id, Right, 30, IRON);
    expect(w.table.dropSpot(b!, x, y, Right)).toBe(-1);
    // Without the item in front, the front spot; without the one behind, the back one.
    expect(w.table.takeAt(lc!.id, Right, 0, BELT_LENGTH)).toBe(IRON);
    expect(w.table.dropSpot(b!, x, y, Right)).toBe(36);
    w.table.insertAt(lc!.id, Right, BELT_LENGTH - 20, IRON);
    // Something waiting on `b` (an inserter waiting to drop) is told when the
    // first item of the line feeding `b` is taken, though `b` didn't change.
    w.entities.wake.watch(c!, b!);
    const notify = vi.spyOn(w.entities, 'notify');
    expect(w.table.takeAt(la!.id, Right, 0, BELT_LENGTH)).toBe(IRON);
    expect(notify).toHaveBeenCalledWith(b!);
    notify.mockRestore();
    expect(w.table.dropSpot(b!, x, y, Right)).toBe(228);
    expect(w.table.dropOnTile(b!, x, y, Right, COAL)).toBe(true);
    checkCross(w.table);
    checkLanes(w.table);
  });

  it('keeps the spacing across the seam of a loop that is one line (#73)', () => {
    const w = world();
    // A 2×2 loop, clockwise: one line of 4 belts (1 024 long) whose end
    // hands on to its own start.
    const ids = [
      w.place(TIERS[0].belt, 0, 0, East),
      w.place(TIERS[0].belt, 1, 0, South),
      w.place(TIERS[0].belt, 1, 1, Direction.West),
      w.place(TIERS[0].belt, 0, 1, North),
    ];
    const line = w.lineOf(ids[0]!);
    expect(line.out).toBe(line);
    expect(line.length).toBe(4 * BELT_LENGTH);
    const start = line.belts[3]!;
    const end = line.belts[0]!;
    const s = tileOf(w.entities, start);
    const e = tileOf(w.entities, end);
    // Items at 0, 768, 832 and 900: the start tile [768, 1023] has room
    // from 964 on within the lane, but 964 is only 60 behind the item at 0
    // across the seam. Nothing fits there.
    for (const pos of [0, 768, 832, 900])
      expect(w.table.insertAt(line.id, Left, pos, IRON)).toBe(true);
    expect(w.table.dropSpot(start, s.x, s.y, Left)).toBe(-1);
    expect(w.table.dropOnTile(start, s.x, s.y, Left, COAL)).toBe(false);
    // With the first item 40 from the end, up to 1 024 + 40 − 64 = 1 000 is far enough.
    expect(w.table.takeAt(line.id, Left, 0, 0)).toBe(IRON);
    expect(w.table.insertAt(line.id, Left, 40, IRON)).toBe(true);
    expect(w.table.dropSpot(start, s.x, s.y, Left)).toBe(964);
    // The other way round: the last item 24 short of the start edge, items at
    // 100, 164 and 228 on the end tile. Its free spot [0, 36] is closer than 64
    // to that last item across the seam (36 + 24 = 60): nothing fits; with
    // the last item further back, from 40 on it does.
    const right = [100, 164, 228, 1000];
    for (const pos of right) expect(w.table.insertAt(line.id, Right, pos, IRON)).toBe(true);
    expect(w.table.dropSpot(end, e.x, e.y, Right)).toBe(-1);
    expect(w.table.takeAt(line.id, Right, 1000, 1000)).toBe(IRON);
    expect(w.table.insertAt(line.id, Right, 980, IRON)).toBe(true);
    expect(w.table.dropSpot(end, e.x, e.y, Right)).toBe(36);
    // And moving on, items dropped there keep the spacing across the seam.
    expect(w.table.dropOnTile(end, e.x, e.y, Right, COAL)).toBe(true);
    for (let t = 0; t < 300; t++) {
      w.step();
      for (const lane of line.lanes) {
        if (lane.count > 1) {
          expect(line.length - lane.total + lane.gap(0)).toBeGreaterThanOrEqual(BELT_ITEM_SPACING);
        }
      }
      checkLanes(w.table);
    }
  });

  it('drops onto the half of a splitter on the tile it reaches, behind the belt in front', () => {
    const w = world();
    // A splitter facing east on (1, 0)-(1, 1), a belt in front of its left half only.
    const sp = w.place(TIERS[0].splitter, 1, 0, East);
    const front = w.place(TIERS[0].belt, 2, 0, East);
    const [left, right] = w.table.halfLines(sp);
    expect(w.table.dropOnTile(sp, right.tileX, right.tileY, Left, IRON)).toBe(true);
    expect(positions(right, Left)).toEqual([128]);
    expect(left.lanes[Left].count).toBe(0);
    // An item at the start edge of the belt in front: nothing on the left
    // half closer than 64 to its end.
    w.table.insertAt(w.lineOf(front).id, Right, BELT_LENGTH, IRON);
    while (w.table.dropOnTile(sp, left.tileX, left.tileY, Right, COAL));
    expect(positions(left, Right)).toEqual([64, 128, 192]);
    checkCross(w.table);
  });
});

/**
 * A straight run of 12 belts of `tier` running east whose right lane is
 * full at the spacing from `1024 + phase` back, but for the free slots `hole`
 * picks (by slot number), moving, and emptied at its end; an
 * inserter that is always ready (it tries every tick) drops onto the right
 * lane of the belt at index 2 ([512, 767]). Checks every tick that nothing
 * leaves that tile downstream with a free slot in it: every gap between
 * items past the tile is narrower than two spacings.
 */
function fillsEveryHole(tierIndex: number, phase: number, hole: (k: number) => boolean) {
  const tier = TIERS[tierIndex]!;
  const w = world();
  const ids = w.run(tier.belt, 0, 0, East, 12);
  const line = w.lineOf(ids[0]!);
  const drop = ids.find((id) => w.table.beltIndex(id) === 2)!;
  const { x, y } = tileOf(w.entities, drop);
  const tileStart = w.table.beltOffset(drop);
  let initial = 0;
  let holes = 0;
  for (let k = 0, pos = 1024 + phase; pos < line.length; k++, pos += BELT_ITEM_SPACING) {
    if (hole(k)) {
      holes++;
      continue;
    }
    expect(w.table.insertAt(line.id, Right, pos, IRON)).toBe(true);
    initial++;
  }
  let drops = 0;
  let sunk = 0;
  const ticks = Math.ceil(line.length / tier.belt.beltSpeed!) + 10;
  for (let t = 0; t < ticks; t++) {
    w.step();
    while (w.table.takeAt(line.id, Right, 0, line.speed - 1) !== 0) sunk++;
    if (w.table.dropOnTile(drop, x, y, Right, COAL)) drops++;
    // Plain loops: this runs every tick of 64 phases.
    const lane = line.lanes[Right];
    let d = 0;
    for (let i = 0; i < lane.count; i++) {
      const g = lane.gap(i);
      d += g;
      if (d >= tileStart) break;
      if (i > 0 && (g < BELT_ITEM_SPACING || g >= 2 * BELT_ITEM_SPACING)) {
        expect.fail(
          `phase ${String(phase)} tick ${String(t)}: a gap of ${String(g)} at ${String(d)}`,
        );
      }
    }
  }
  checkLanes(w.table);
  expect(sunk + line.lanes[Right].count).toBe(initial + drops);
  return { holes, drops };
}

describe('inserters fill free slots on moving belts (#83)', () => {
  for (const [t, tier] of TIERS.entries()) {
    it(`${tier.belt.name}: fills single free slots at every phase against the tile`, () => {
      for (let phase = 0; phase < BELT_ITEM_SPACING; phase++) {
        const { holes, drops } = fillsEveryHole(t, phase, (k) => k % 4 === 1);
        expect(holes).toBeGreaterThan(5);
        expect(drops).toBeGreaterThanOrEqual(holes);
      }
    });

    it(`${tier.belt.name}: fills two-slot holes completely`, () => {
      for (let phase = 0; phase < BELT_ITEM_SPACING; phase += 4) {
        const { holes, drops } = fillsEveryHole(t, phase, (k) => k % 5 === 1 || k % 5 === 2);
        expect(drops).toBeGreaterThanOrEqual(holes);
      }
    });
  }
});

/**
 * A sim with a straight run of belts of `tier` running east along y = 0 from
 * x = -6 to 5, fed at its start on the right lane with items at the spacing
 * but for one free slot after every `holeEvery` items, and emptied at its end; a
 * chest of plates on (0, -2) and a burner inserter on (0, -1) facing south
 * that drops onto the right lane (its far lane) of belt (0, 0).
 */
function beltWithInserter(tierIndex: number, holeEvery: number) {
  const tier = TIERS[tierIndex]!;
  const sim = new Sim({
    seed: 1,
    startingKit: [
      { item: ItemId.BurnerInserter, count: 1 },
      { item: ItemId.IronChest, count: 1 },
      { item: tier.belt.item, count: 12 },
      { item: COAL, count: 50 },
      { item: COPPER, count: 400 },
    ],
  });
  const { state } = sim;
  state.players.x[0] = tileCenter(0);
  state.players.y[0] = tileCenter(3);
  const { entities } = state;
  const place = (item: number, x: number, y: number, dir: Direction) => {
    expect(placeEntity(state, 0, item, x, y, dir)).toBe(BuildResult.Ok);
    return entities.at(x, y);
  };
  for (let x = -6; x <= 5; x++) place(tier.belt.item, x, 0, East);
  const chest = place(ItemId.IronChest, 0, -2, North);
  const inserter = place(ItemId.BurnerInserter, 0, -1, South);
  entities.insert(inserter, COAL, 50);
  entities.insert(chest, COPPER, 400);
  const belts = beltTable(entities)!;
  const line = belts.line(belts.beltLine(entities.at(0, 0)))!;
  let fed = 0;
  let sunk = 0;
  const step = () => {
    sim.step();
    while (belts.takeAt(line.id, Right, 0, line.speed - 1) !== 0) sunk++;
    const lane = line.lanes[Right];
    const gap = (fed + 1) % holeEvery === 0 ? 2 * BELT_ITEM_SPACING : BELT_ITEM_SPACING;
    const pos = lane.count === 0 ? line.length : lane.total + gap;
    if (pos <= line.length && belts.insertAt(line.id, Right, pos, IRON)) fed++;
  };
  return {
    sim,
    entities,
    belts,
    line,
    inserter,
    chest,
    step,
    counts: () => ({ fed, sunk }),
    copperLeft: () => entities.contents(chest).reduce((n, s) => n + s.count, 0),
  };
}

describe('an inserter on a nearly full moving belt', () => {
  for (const [t, tier] of TIERS.entries()) {
    it(`${tier.belt.name}: drops at its full rate, one item per 72 ticks, into the free slots`, () => {
      // One free slot after every 3 items: one is always on the inserter's tile.
      const s = beltWithInserter(t, 3);
      for (let i = 0; i < 600; i++) s.step();
      const before = s.copperLeft();
      const fedBefore = s.counts().fed;
      const sunkBefore = s.counts().sunk;
      const cycles = 50;
      for (let i = 0; i < cycles * 72; i++) s.step();
      const dropped = before - s.copperLeft();
      expect(dropped).toBeGreaterThanOrEqual(cycles - 1);
      expect(dropped).toBeLessThanOrEqual(cycles + 1);
      // The belt carried what came in at its start and what the inserter put on.
      const fed = s.counts().fed - fedBefore;
      const sunk = s.counts().sunk - sunkBefore;
      const lane = BELT_LENGTH * 12;
      expect(Math.abs(sunk - (fed + dropped))).toBeLessThanOrEqual(lane / BELT_ITEM_SPACING);
    });

    it(`${tier.belt.name}: fills nearly every free slot when they are rarer than its rate`, () => {
      // One free slot after every 32 items: 7.5 / 15 / 22.5 items/s per lane
      // over 33 is below the burner inserter's 0.83 items/s, and the slots
      // come at least 72 ticks apart, so it is ready for each of them.
      const s = beltWithInserter(t, 32);
      for (let i = 0; i < 600; i++) s.step();
      const ticks = 3600;
      const before = s.copperLeft();
      for (let i = 0; i < ticks; i++) s.step();
      const dropped = before - s.copperLeft();
      const slotsPerTick = s.line.speed / BELT_ITEM_SPACING;
      const holes = (ticks * slotsPerTick) / 33;
      expect(dropped).toBeLessThanOrEqual(Math.ceil(holes) + 1);
      expect(dropped).toBeGreaterThanOrEqual(Math.floor(holes) - 1);
    });
  }
});

describe('random building with inserters dropping onto every belt type', () => {
  it('keeps every item, the spacing and sleep, and never leaves an inserter asleep where its item fits', () => {
    const protos = TIERS.flatMap((t) => [t.belt, t.belt, t.underground, t.splitter]);
    const inserterProto = ENTITIES[EntityTypeId.BurnerInserter];
    let drops = 0;
    let waits = 0;
    for (const seed of [83, 8383, 838383]) {
      const sim = new Sim({ seed: 1, startingKit: [] });
      const { entities } = sim.state;
      const table: BeltTable = beltTable(entities)!;
      const inserters = inserterTable(entities)!;
      const active = (inserters as unknown as { active: SparseSet }).active;
      const rng = Rng.fromSeed(seed);
      const W = 12;
      const H = 7;
      let inserted = 0;
      let refunded = 0;
      const free = (x: number, y: number) =>
        x >= 0 && x < W && y >= 0 && y < H && entities.at(x, y) === 0;
      const plates = (stacks: readonly { item: number; count: number }[]) =>
        stacks.reduce((n, s) => n + (s.item === COAL ? 0 : s.count), 0);
      const placed = new Set<number>();
      const held = () => {
        let n = 0;
        for (const id of placed) {
          const h = inserters.hand(id).held;
          if (h !== 0 && h !== COAL) n++;
        }
        return n;
      };
      const onBelts = () => {
        let n = 0;
        for (const line of table.lines()) n += line.lanes[0].count + line.lanes[1].count;
        return n;
      };
      const check = (where: string) => {
        checkLanes(table);
        checkCross(table, { overfullRings: true });
        // No inserter waits asleep at the drop end where its item would fit.
        for (const id of placed) {
          if (active.has(id) || inserters.hand(id).held === 0) continue;
          if (entities.status(id) !== InserterState.WaitingForTarget) continue;
          const dir = entities.store.dir(id);
          const to = inserterDropTile(entities.store.x(id), entities.store.y(id), dir, 1);
          const target = entities.at(to.x, to.y);
          if (target === 0 || !table.isBelt(target)) continue;
          waits++;
          const lane = farLane(dir, entities.store.dir(target));
          expect(table.dropSpot(target, to.x, to.y, lane), `inserter ${String(id)} ${where}`).toBe(
            -1,
          );
        }
        checkNoMissedWake(table, where);
        expect(onBelts() + held() + refunded, where).toBe(inserted);
      };
      for (let round = 0; round < 1200; round++) {
        const x = rng.nextInt(W);
        const y = rng.nextInt(H);
        const id = entities.at(x, y);
        const action = rng.nextInt(12);
        if (id === 0) {
          if (y % 2 === 0 && action < 8) {
            // Belts on the even rows, mostly running east or west.
            const dir = (
              rng.nextInt(4) === 0 ? rng.nextInt(4) : East + 2 * rng.nextInt(2)
            ) as Direction;
            const proto = protos[rng.nextInt(protos.length)]!;
            const [ex, ey] = (dir & 1) === 1 ? [x, y + 1] : [x + 1, y];
            if (!proto.splitter || free(ex, ey)) entities.add(proto, x, y, dir);
          } else if (y % 2 === 1 && action < 6) {
            // Inserters between them, from one row of belts to the next.
            const dir = rng.nextInt(2) === 0 ? North : South;
            const ins = entities.add(inserterProto, x, y, dir);
            entities.insert(ins, COAL, 50);
            placed.add(ins);
          }
        } else if (action < 1) {
          refunded += plates(entities.contents(id));
          entities.remove(id);
          placed.delete(id);
        } else if (action < 2 && table.isBelt(id) && !table.isSplitter(id)) {
          entities.setDirection(id, entities.rotation(id));
        } else if (action < 9 && table.isBelt(id)) {
          inserted += entities.insert(id, action < 6 ? IRON : COPPER, 2);
        }
        check(`seed ${String(seed)} round ${String(round)} after the edit`);
        const flowing = round % 4 === 0;
        for (let n = 1 + rng.nextInt(20); n > 0; n--) {
          const before = new Map<number, number>();
          for (const id of placed) before.set(id, inserters.hand(id).held);
          sim.step();
          for (const id of placed) {
            if (before.get(id) !== 0 && inserters.hand(id).held === 0) drops++;
          }
          if (flowing) {
            for (const line of Array.from(table.lines())) {
              for (const lane of [Left, Right]) {
                if (!line.out && rng.nextInt(8) === 0) {
                  if (table.takeAt(line.id, lane, 0, line.speed - 1) !== 0) refunded++;
                }
              }
            }
          }
          check(`seed ${String(seed)} round ${String(round)} tick ${String(n)}`);
        }
      }
    }
    // Inserters moved items around and often waited to drop.
    expect(drops).toBeGreaterThan(200);
    expect(waits).toBeGreaterThan(1500);
  }, 120_000);
});

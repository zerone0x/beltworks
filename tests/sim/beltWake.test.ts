/**
 * Sleep and waking of belt lanes (#79): no lane is ever asleep while it
 * could move, close up, or hand an item on (`asleepButMovable`), through
 * random edits and flows over every belt type, and a backed-up chain of
 * lines that starts moving again wakes lane by lane.
 */
import { describe, expect, it } from 'vitest';
import { Direction } from '../../src/sim/entities/direction';
import { BeltLane, type LineLane, type TransportLine } from '../../src/sim/belts/line';
import { Rng } from '../../src/sim/rng';
import {
  COAL,
  IRON,
  TIERS,
  asleepButMovable,
  checkNoMissedWake,
  feed,
  world,
  type World,
} from './beltChecks';

const { East } = Direction;
const { Left, Right } = BeltLane;
const LANES = [Left, Right] as const;

/** A row of one-belt lines, yellow and fast in turn, with nothing in front: full, and asleep. */
function chain() {
  const w = world();
  const ids = [0, 1, 0, 1, 0].map((t, x) => w.place(TIERS[t]!.belt, x, 0, East));
  const lines = ids.map((id) => w.lineOf(id));
  for (const line of lines) {
    for (let pos = 0; pos <= 192; pos += 64) w.table.insertAt(line.id, Left, pos, IRON);
  }
  w.step(100);
  return { w, lines, end: lines[lines.length - 1]! };
}

/** Takes off what reaches the end of `end` each tick, for `ticks` ticks. */
function drain(w: World, end: TransportLine, ticks: number, each?: (t: number) => void) {
  for (let t = 0; t < ticks; t++) {
    w.step();
    w.table.takeAt(end.id, Left, 0, end.speed - 1);
    each?.(t);
  }
}

describe('belt lanes asleep', () => {
  it('wake lane by lane when a backed-up chain of lines starts moving again', () => {
    const { w, lines, end } = chain();
    expect(w.table.activeLanes).toBe(0);
    expect(lines.map((l) => l.out)).toEqual([...lines.slice(1), null]);
    // The take wakes the end lane and the lane feeding it, which move on the
    // next tick; from there each lane starts moving one tick after the lane
    // it hands on to (woken as that lane moves, stepped from the next tick),
    // and at no tick boundary could an asleep lane move.
    const started = lines.map(() => -1);
    drain(w, end, 40, (t) => {
      checkNoMissedWake(w.table, `tick ${String(t)}`);
      lines.forEach((l, i) => {
        if (started[i] === -1 && l.lanes[Left].movedAll + l.lanes[Left].movedRest > 0) {
          started[i] = t;
        }
      });
    });
    expect(started).toEqual([4, 3, 2, 1, 1]);
  });

  it('are not woken late: waking every lane at once also moves lanes woken this tick', () => {
    // What #79 reported: after one tick of draining, the second line from
    // the end is asleep while the line in front of it is awake. Waking every
    // lane and stepping a tick moves it, as the line in front moves first in
    // that tick; but from where everything is, it can't move (its first item
    // is held 64 behind the last item of that line), and it is woken in the
    // tick the line in front moves.
    const wakeAllAndStep = () => {
      const { w, lines, end } = chain();
      drain(w, end, 1);
      const asleep = lines.map((l) => !l.lanes[Left].active);
      const gaps = lines.map((l) => Array.from(l.lanes[Left].gaps()));
      const table = w.table as unknown as { wakeLane(l: LineLane): void };
      for (const l of lines) table.wakeLane(l.lanes[Left]);
      w.step();
      return lines.flatMap((l, i) =>
        asleep[i] && Array.from(l.lanes[Left].gaps()).join() !== gaps[i]!.join() ? [i] : [],
      );
    };
    expect(wakeAllAndStep()).toEqual([2]);
    const { w, lines, end } = chain();
    drain(w, end, 1);
    expect(lines.map((l) => l.lanes[Left].active)).toEqual([false, false, false, true, true]);
    expect(asleepButMovable(w.table)).toEqual([]);
    const lane = lines[2]!.lanes[Left];
    w.step();
    expect(lane.active).toBe(true);
    expect(lane.movedAll).toBe(0);
    w.step();
    expect(lane.movedAll).toBeGreaterThan(0);
  });

  it('never could move, through random edits and flows with every belt type', () => {
    // After every edit, tick and flow step, on 300 random strips of belts,
    // undergrounds and splitters of every tier: fed at the start of lines
    // nothing feeds, emptied at the end of lines that hand on nowhere and
    // now and then at the end of lines that do (an inserter taking the
    // first item of a lane handing on to another line's start).
    const protos = TIERS.flatMap((t) => [t.belt, t.belt, t.underground, t.splitter, t.splitter]);
    let checks = 0;
    let asleep = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const w = world();
      const rng = Rng.fromSeed(seed * 7919);
      const free = (x: number, y: number) =>
        x >= 0 && x < 12 && y >= 0 && y < 6 && w.entities.at(x, y) === 0;
      const check = (where: string) => {
        checkNoMissedWake(w.table, `seed ${String(seed)} ${where}`);
        checks++;
        for (const line of w.table.lines()) {
          for (const lane of line.lanes) if (!lane.active && lane.count > 0) asleep++;
        }
      };
      for (let round = 0; round < 60; round++) {
        const x = rng.nextInt(12);
        const y = rng.nextInt(6);
        const action = rng.nextInt(10);
        const id = w.entities.at(x, y);
        if (id === 0) {
          if (action < 6) {
            const dir = rng.nextInt(4) as Direction;
            const proto = protos[rng.nextInt(protos.length)]!;
            const [ex, ey] = (dir & 1) === 1 ? [x, y + 1] : [x + 1, y];
            if (!proto.splitter || free(ex, ey)) w.place(proto, x, y, dir);
          }
        } else if (action < 2) {
          w.entities.remove(id);
        } else if (action < 4) {
          let dir = action === 2 ? w.entities.rotation(id) : (rng.nextInt(4) as Direction);
          if (w.table.isSplitter(id) && (dir & 1) !== (w.entities.store.dir(id) & 1)) {
            const { x: sx, y: sy } = w.entities.footprint(id);
            const [ex, ey] = (dir & 1) === 1 ? [sx, sy + 1] : [sx + 1, sy];
            if (!free(ex, ey)) dir = w.entities.rotation(id);
          }
          w.entities.setDirection(id, dir);
        } else if (action < 7) {
          w.entities.insert(id, action === 4 ? IRON : COAL, 1 + rng.nextInt(3));
        } else {
          const line = w.table.beltLineAt(id, x, y);
          w.table.takeAt(line, rng.nextInt(2), w.table.beltOffset(id), w.table.beltEnd(id));
        }
        check(`round ${String(round)} after the edit`);
        const flowing = round % 4 !== 0;
        for (let n = 1 + rng.nextInt(25), k = 0; k < n; k++) {
          w.step();
          check(`round ${String(round)} tick ${String(k)}`);
          if (!flowing) continue;
          for (const line of Array.from(w.table.lines())) {
            for (const lane of LANES) {
              if (line.feeders.length === 0 && line.splitter === 0 && rng.nextInt(2) === 0) {
                feed(w, line, lane, lane === Left ? IRON : COAL);
              }
              if ((!line.out || rng.nextInt(8) === 0) && rng.nextInt(3) === 0) {
                w.table.takeAt(line.id, lane, 0, line.speed - 1);
              }
            }
          }
          check(`round ${String(round)} tick ${String(k)} after the flows`);
        }
      }
    }
    // Plenty of lanes with items were asleep at those checks.
    expect(checks).toBeGreaterThan(200_000);
    expect(asleep).toBeGreaterThan(500_000);
  }, 120_000);
});

/**
 * A splitter-heavy micro-benchmark of the belt system alone (`npm run
 * bench:splitters`): the bench scenes (scenes/) have no splitters, so they
 * can't show the cost of the splitter merge rules (D44, D58, D71). Kept out
 * of `npm run bench` and its baselines on purpose.
 *
 * 300 rigs of two splitters in a row (the first feeding the second's half),
 * mixed tiers; half of them with the output in front of the full input's
 * half, half in front of the sparse input's (the full one crossing over).
 * Each rig's full input is fed at full rate and its sparse one at a quarter
 * to nine tenths of its belt, evenly spaced; outputs are emptied as items
 * arrive. Only `BeltTable.update` is timed.
 */
import { BELT_ITEM_SPACING, ENTITIES, EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { BeltTable } from '../../src/sim/belts/belts';
import type { TransportLine } from '../../src/sim/belts/line';
import { Direction } from '../../src/sim/entities/direction';
import { Entities } from '../../src/sim/entities/entities';

const TIERS = [
  [EntityTypeId.TransportBelt, EntityTypeId.Splitter],
  [EntityTypeId.FastTransportBelt, EntityTypeId.FastSplitter],
  [EntityTypeId.ExpressTransportBelt, EntityTypeId.ExpressSplitter],
].map(([belt, splitter]) => ({ belt: ENTITIES[belt!], splitter: ENTITIES[splitter!] }));

const FRACTIONS = [0.25, 0.45, 0.6, 0.9];

interface Rig {
  full: TransportLine;
  sparse: TransportLine;
  sink: TransportLine;
  /** Sparse items per tick per lane. */
  rate: number;
}

/** The rigs, built and warmed up; `tick()` feeds, empties and steps them once. */
export function splitterRigs(rigCount = 300, warmupTicks = 1000) {
  const table = new BeltTable();
  const entities = new Entities([table]);
  /** Places `n` belts east from `(x, y)`; returns the first one. */
  const run = (proto: (typeof TIERS)[number]['belt'], x: number, y: number, n: number) => {
    const first = entities.add(proto, x, y, Direction.East);
    for (let i = 1; i < n; i++) entities.add(proto, x + i, y, Direction.East);
    return first;
  };
  // Placing a belt can rebuild the lines next to it: look them up once a rig stands.
  const lineOf = (belt: number) => table.line(table.beltLine(belt))!;
  const rigs: Rig[] = [];
  for (let k = 0; k < rigCount; k++) {
    const x0 = (k % 3) * 12;
    const y0 = Math.floor(k / 3) * 3;
    const [s, i, o] = [TIERS[k % 3]!, TIERS[(k >> 1) % 3]!, TIERS[(k >> 2) % 3]!];
    entities.add(s.splitter, x0 + 2, y0, Direction.East);
    entities.add(s.splitter, x0 + 3, y0, Direction.East);
    const full = run(i.belt, x0, y0, 2);
    const sparse = run(i.belt, x0, y0 + 1, 2);
    const cross = k % 2 === 1;
    const sink = run(o.belt, x0 + 4, cross ? y0 + 1 : y0, 4);
    const rate = (FRACTIONS[k % 4]! * i.belt.beltSpeed!) / BELT_ITEM_SPACING;
    rigs.push({ full: lineOf(full), sparse: lineOf(sparse), sink: lineOf(sink), rate });
  }
  let t = 0;
  let delivered = 0;
  const tend = () => {
    for (const r of rigs) {
      for (const lane of [0, 1] as const) {
        while (table.takeAt(r.sink.id, lane, 0, r.sink.speed - 1) !== 0) delivered++;
        const l = r.full.lanes[lane];
        const pos = l.count === 0 ? r.full.length : l.total + l.spacing;
        if (pos <= r.full.length) table.insertAt(r.full.id, lane, pos, ItemId.IronPlate);
        if (Math.floor((t + 1) * r.rate) > Math.floor(t * r.rate)) {
          table.insertAt(r.sparse.id, lane, r.sparse.length, ItemId.Coal);
        }
      }
    }
    t++;
  };
  for (let n = 0; n < warmupTicks; n++) {
    tend();
    table.update();
  }
  return {
    table,
    /** Feeds and empties every rig (untimed), then steps the belts once (timed by the caller). */
    tend,
    step: () => table.update(),
    get delivered() {
      return delivered;
    },
  };
}

/** Times `ticks` belt steps `runs` times; returns the median and fastest ms per tick. */
export function measureSplitters(runs = 7, ticks = 2000) {
  const rigs = splitterRigs();
  const times: number[] = [];
  for (let r = 0; r < runs; r++) {
    let ns = 0n;
    for (let n = 0; n < ticks; n++) {
      rigs.tend();
      const t0 = process.hrtime.bigint();
      rigs.step();
      ns += process.hrtime.bigint() - t0;
    }
    times.push(Number(ns) / ticks / 1e6);
  }
  times.sort((a, b) => a - b);
  return {
    medianMs: times[runs >> 1]!,
    minMs: times[0]!,
    activeLanes: rigs.table.activeLanes,
  };
}

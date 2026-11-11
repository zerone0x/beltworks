import { describe, expect, it } from 'vitest';
import { measureSplitters, splitterRigs } from '../../tools/bench/splitters';

describe('splitter micro-benchmark', () => {
  it('builds rigs whose splitters merge, straight on and crossing over, and deliver', () => {
    const rigs = splitterRigs(12, 600);
    const before = rigs.delivered;
    for (let t = 0; t < 600; t++) {
      rigs.tend();
      rigs.step();
    }
    // 12 rigs, two lanes, at least a yellow belt's rate each (one item per 8 ticks).
    expect(rigs.delivered - before).toBeGreaterThan((12 * 2 * 600) / 8);
    const halves = [...rigs.table.lines()].filter((l) => l.splitter !== 0);
    expect(halves.length).toBe(12 * 2 * 2);
    // Items crossed over into halves (marked) in some of them.
    expect(halves.some((l) => l.lanes.some((lane) => lane.marks().length > 0))).toBe(true);
  });

  it('measures ms per belt tick', () => {
    const r = measureSplitters(1, 50);
    expect(r.medianMs).toBeGreaterThan(0);
    expect(r.activeLanes).toBeGreaterThan(0);
  });
});

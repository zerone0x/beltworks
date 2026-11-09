/**
 * The belt step's wake-notice de-dup (#115, D62): within one belt step a
 * line notifies a stretch of its watched belts at most once, but every
 * stretch that changed still notifies its belts. A de-dup that skipped a
 * later, different stretch in the same step would leave an inserter asleep
 * next to items it could take; the bench scenes' hashes would catch that
 * only indirectly, so it is pinned here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Direction } from '../../src/sim/entities/direction';
import { BELT_LENGTH, BeltLane } from '../../src/sim/belts/line';
import { IRON, TIERS, world } from './beltChecks';

const { East } = Direction;
const { Left, Right } = BeltLane;
/** Not an entity: only subscribes, so notices have somewhere to go. */
const WATCHER = 1_000_000;
const BELTS = 20;

/**
 * A straight line of `BELTS` belts, every belt watched, with items put on
 * its lanes at the middle of the belts `left` and `right` list (indices from
 * the end of the line). Returns how often one belt step notified each belt.
 */
function notifiedInOneStep(left: readonly number[], right: readonly number[]) {
  const w = world();
  const ids = w.run(TIERS[0].belt, 0, 0, East, BELTS);
  const line = w.lineOf(ids[0]!);
  expect(line.belts.length).toBe(BELTS);
  for (const id of ids) w.entities.wake.watch(WATCHER, id);
  for (const i of left)
    expect(w.table.insertAt(line.id, Left, i * BELT_LENGTH + 128, IRON)).toBe(true);
  for (const i of right) {
    expect(w.table.insertAt(line.id, Right, i * BELT_LENGTH + 128, IRON)).toBe(true);
  }
  const counts = new Map<number, number>();
  const notify = vi.spyOn(w.entities, 'notify').mockImplementation((target: number) => {
    counts.set(target, (counts.get(target) ?? 0) + 1);
  });
  w.step();
  notify.mockRestore();
  return (index: number) => counts.get(line.belts[index]!) ?? 0;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('belt wake notices within one step', () => {
  it('still notify a second stretch of the line apart from the first', () => {
    // Both lanes move in the same step, far apart: two disjoint stretches.
    const notified = notifiedInOneStep([4], [15]);
    expect(notified(4)).toBe(1);
    expect(notified(15)).toBe(1);
    // Nothing in between moved.
    expect(notified(10)).toBe(0);
  });

  it('notify the whole union of overlapping stretches', () => {
    // Left lane over belts 4-6, right lane over 5-7: each lane's stretch
    // reaches a belt the other's doesn't, whichever lane steps first (the
    // second notifies its whole stretch, so the shared belts may get two).
    const notified = notifiedInOneStep([4, 5, 6], [5, 6, 7]);
    for (const i of [4, 5, 6, 7]) {
      expect(notified(i), `belt ${String(i)}`).toBeGreaterThanOrEqual(1);
    }
    expect(notified(10)).toBe(0);
  });

  it('notify a stretch already notified in the step only once', () => {
    // Both lanes move the same stretch (a line moving as a whole).
    const notified = notifiedInOneStep([8, 9], [8, 9]);
    for (const i of [8, 9]) expect(notified(i), `belt ${String(i)}`).toBe(1);
  });

  it('start over on the next step', () => {
    const w = world();
    const ids = w.run(TIERS[0].belt, 0, 0, East, BELTS);
    const line = w.lineOf(ids[0]!);
    for (const id of ids) w.entities.wake.watch(WATCHER, id);
    w.table.insertAt(line.id, Left, 12 * BELT_LENGTH + 128, IRON);
    const notify = vi.spyOn(w.entities, 'notify');
    w.step();
    const first = notify.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    w.step();
    // The item moved again on the next step, so its belt was notified again.
    expect(notify.mock.calls.length).toBeGreaterThan(first);
  });
});

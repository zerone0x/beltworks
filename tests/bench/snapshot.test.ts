import { describe, expect, it } from 'vitest';
import { DELTA_SECTIONS } from '../../src/worker/protocol';
import { factory1k } from '../../tools/bench/scenes/factory1k';
import { measureSnapshots, sceneRange, snapshotMarkdown } from '../../tools/bench/snapshot';

describe('snapshot benchmark', () => {
  it('measures every section of every tick over the whole scene', () => {
    const { sim } = factory1k.build();
    const range = sceneRange(sim);
    expect(range.cx1).toBeGreaterThanOrEqual(range.cx0);
    const result = measureSnapshots('1k', sim, 30, range);
    expect(result.ticks).toBe(30);
    expect(result.entities).toBe(1000);
    expect(result.beltItems).toBeGreaterThan(0);
    for (const name of DELTA_SECTIONS) {
      const u = result.updates[name];
      expect(u.whole + u.patch + u.same).toBe(30);
      // Only the first snapshot sends a section whole (none grows past its patch here).
      expect(u.whole).toBe(1);
      // Reused writers and scratch: nothing per entity, only the Int32Array
      // view of its writer an encoder returns (96 bytes in Node 22; with a
      // spread, a closure or per-entity objects it was 28-40 KB here). The
      // 96 is exact on every section, run after run, with the JIT on or off
      // (`--max-opt=0`) and under load, so no encoder allocates on some calls
      // only; CI once measured 272 on a busy runner, which is V8's own heap
      // work (background compiles, concurrent GC) landing inside the timed
      // window, not the encoder. The bound leaves room for that and still
      // fails by two orders of magnitude on anything per entity.
      expect(result.allocated[name]).toBeLessThan(512);
    }
    expect(result.sentBytes).toBeLessThan(result.wholeBytes);
    expect(result.worker.meanMs).toBeGreaterThan(0);
    const md = snapshotMarkdown([result]);
    expect(md).toContain('| 1k | 1000 /');
    expect(md).toContain('belts (ms; bytes allocated; whole / patch / same)');
  });
});

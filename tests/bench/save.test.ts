import { describe, expect, it } from 'vitest';
import { gzip } from '../../src/save/compress';
import { saveSim } from '../../src/sim/save/save';
import { SCENES } from '../../tools/bench/scenes/index';
import { reload, stepTogether } from '../sim/saveRoundTrip';

/** Ticks each scene runs before it is saved, and after, side by side with its loaded copy. */
const WARMUP_TICKS = 120;
const COMPARED_TICKS = 300;

/**
 * The round-trip guarantee on the benchmark scenes (src/sim/save/save.ts):
 * dense belts with splitters and undergrounds of every tier, every inserter
 * type, machines, labs, overloaded networks. The 50k scene takes minutes to
 * build and adds nothing the 10k one lacks, so it is left out.
 */
describe('save round trip on the bench scenes', () => {
  for (const scene of SCENES.filter((s) => s.name !== '50k')) {
    it(`${scene.name}: loads to the same hash and runs on identically`, async () => {
      const { sim } = scene.build();
      for (let i = 0; i < WARMUP_TICKS; i++) sim.step();
      const start = performance.now();
      const bytes = saveSim(sim);
      const saveMs = performance.now() - start;
      const packed = await gzip(bytes);
      const copy = reload(sim);
      stepTogether(sim, copy, COMPARED_TICKS);
      expect(copy.state.entities.count).toBe(sim.state.entities.count);
      console.log(
        `save ${scene.name}: ${String(sim.state.entities.count)} entities, ` +
          `${(bytes.length / 1024).toFixed(0)} KiB raw, ${(packed.length / 1024).toFixed(0)} KiB gzipped, ` +
          `serialized in ${saveMs.toFixed(1)} ms`,
      );
    }, 300_000);
  }
});

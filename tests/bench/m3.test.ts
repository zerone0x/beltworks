import { describe, expect, it } from 'vitest';
import { technologyPrototype } from '../../src/data/technologies';
import { powerGrid } from '../../src/sim/power/grid';
import { DEFAULT_FORCE } from '../../src/sim/research/unlocks';
import { measureScene } from '../../tools/bench/measure';
import {
  M3_CELLS_PER_COLUMN,
  M3_COLUMNS,
  M3_ENTITIES,
  M3_RESEARCH,
  m3,
  m3AreaClear,
} from '../../tools/bench/scenes/m3';
import { SCENES } from '../../tools/bench/scenes/index';

const CELLS = M3_COLUMNS * M3_CELLS_PER_COLUMN;

describe('m3 scene', () => {
  it('is registered and stands on clear ground', () => {
    expect(SCENES).toContain(m3);
    expect(m3AreaClear()).toBe(true);
  });

  it('builds ten columns of science cells through commands, each its own network', () => {
    const built = m3.build();
    expect(built.sim.state.entities.count).toBe(M3_ENTITIES);
    expect(built.entityCounts).toEqual({
      'steam-engine': 2 * M3_COLUMNS,
      boiler: M3_COLUMNS,
      'small-electric-pole': 2 * M3_COLUMNS + 4 * CELLS,
      'iron-chest': 4 * CELLS,
      'burner-inserter': CELLS,
      'assembling-machine-1': 2 * CELLS,
      'fast-inserter': CELLS,
      'long-handed-inserter': CELLS,
      'electric-inserter': 5 * CELLS,
      'transport-belt': 5 * CELLS,
      'underground-belt': 2 * CELLS,
      splitter: CELLS,
      lab: 2 * CELLS,
    });
    expect(powerGrid(built.sim.state.entities)!.networkCount).toBe(M3_COLUMNS);
  });

  // Builds the 1 170-entity scene twice through commands: about 2.5 s on a
  // CI runner on its own, more while the other bench files run in parallel,
  // so a slow runner went past vitest's 5 s default without any sim change.
  it('is deterministic', () => {
    const a = m3.build();
    const b = m3.build();
    expect(a.setupTicks).toBe(b.setupTicks);
    expect(a.sim.hash()).toBe(b.sim.hash());
  }, 30_000);

  it('keeps its machines, inserters and labs busy, on full power', () => {
    const result = measureScene(m3, { runs: 1, warmupRuns: 0 });
    const { machineStates, powerSatisfaction } = result.activity;
    expect(powerSatisfaction).toEqual(Array<number>(M3_COLUMNS).fill(100));
    // Every lab gets its red packs from the red pack machine over the belt,
    // the underground pair and its half of the splitter.
    expect(machineStates.lab).toEqual({ Working: 2 * CELLS });
    expect(machineStates['assembling-machine-1']!.Working).toBeGreaterThanOrEqual(CELLS);
    expect(machineStates['burner-inserter']).toEqual({ Working: CELLS });
    // The end state `npm run bench -- m3` reports (tools/bench/baseline.json).
    expect(result.hash).toBe('0xd15cbc54');
    // (The cells run in step, so their belts sleep and wake together: on
    // the last tick none of them moves.)
  });

  it('leaves its research unfinished at the end of a run', () => {
    const { sim } = m3.build();
    for (let t = 0; t < 600 + 3600; t++) sim.step();
    const { research } = sim.state;
    expect(research.currentOf(DEFAULT_FORCE)).toBe(M3_RESEARCH);
    expect(research.unitsDone(DEFAULT_FORCE, M3_RESEARCH)).toBeLessThan(
      technologyPrototype(M3_RESEARCH)!.units,
    );
  });
});

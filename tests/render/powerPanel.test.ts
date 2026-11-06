import { describe, expect, it } from 'vitest';
import { EntityTypeId, SAT_ONE } from '../../src/data/entities';
import type { NetworkDetailData } from '../../src/sim/snapshot';
import { HISTORY_SECONDS, PowerHistory } from '../../src/ui/powerHistory';
import { graphScale, graphSeries, networkView, satisfactionPercent } from '../../src/ui/powerPanel';

describe('power history', () => {
  it('averages each simulated second into one sample', () => {
    const h = new PowerHistory();
    h.record(0, [{ id: 1, demand: 100, supply: 50 }]);
    h.record(30, [{ id: 1, demand: 300, supply: 50 }]);
    expect(h.samples(1)).toEqual([]);
    // The first snapshot of second 1 closes second 0.
    h.record(60, [{ id: 1, demand: 10, supply: 50 }]);
    expect(h.samples(1)).toEqual([{ second: 0, demand: 200, supply: 50, load: 50 }]);
    expect(h.second).toBe(1);
    expect(h.samples(2)).toEqual([]);
  });

  it('keeps the last 60 seconds and forgets networks out of sight', () => {
    const h = new PowerHistory();
    for (let s = 0; s <= 100; s++) {
      h.record(s * 60, [
        { id: 7, demand: s, supply: 1_000 },
        ...(s < 5 ? [{ id: 8, demand: 1, supply: 1 }] : []),
      ]);
    }
    const samples = h.samples(7);
    expect(samples).toHaveLength(HISTORY_SECONDS);
    expect(samples[0]!.second).toBe(100 - HISTORY_SECONDS);
    expect(samples.at(-1)).toEqual({ second: 99, demand: 99, supply: 1_000, load: 99 });
    expect(h.samples(8)).toEqual([]);
  });

  it('starts over when the tick goes back (a new game)', () => {
    const h = new PowerHistory();
    h.record(600, [{ id: 1, demand: 1, supply: 1 }]);
    h.record(660, [{ id: 1, demand: 1, supply: 1 }]);
    expect(h.samples(1)).toHaveLength(1);
    h.record(0, [{ id: 1, demand: 1, supply: 1 }]);
    expect(h.samples(1)).toEqual([]);
  });
});

const network = (fields: Partial<NetworkDetailData>): NetworkDetailData => ({
  pole: 5,
  network: 2,
  poles: 3,
  demand: 0,
  supply: 0,
  satisfaction: 0,
  load: 0,
  groups: [],
  ...fields,
});

describe('power panel', () => {
  it('shows production, consumption and satisfaction', () => {
    const view = networkView(
      network({
        demand: 24_000,
        supply: 15_000,
        satisfaction: 40_960,
        load: 15_000,
        groups: [
          {
            type: EntityTypeId.SteamEngine,
            producer: true,
            count: 2,
            demand: 0,
            maxOutput: 15_000,
            power: 15_000,
          },
          {
            type: EntityTypeId.ElectricMiningDrill,
            producer: false,
            count: 16,
            demand: 24_000,
            maxOutput: 0,
            power: 14_992,
          },
        ],
      }),
    );
    expect(view.satisfaction).toBe(62);
    expect(view.satisfactionText).toBe('62%');
    expect(view.production).toBe('900 kW / 900 kW');
    expect(view.consumption).toBe('899.5 kW / 1.4 MW');
    expect(view.producers).toEqual([
      expect.objectContaining({ name: 'steam-engine', count: 2, text: '900 kW / 900 kW' }),
    ]);
    expect(view.consumers).toEqual([
      expect.objectContaining({
        name: 'electric-mining-drill',
        label: 'Electric mining drill',
        count: 16,
        text: '899.5 kW / 1.4 MW',
      }),
    ]);
  });

  it('says when there is no demand or no power', () => {
    expect(networkView(network({ supply: 100, satisfaction: SAT_ONE })).satisfactionText).toBe(
      'No demand',
    );
    expect(networkView(network({ demand: 100 })).satisfactionText).toBe('No power');
    expect(satisfactionPercent(SAT_ONE)).toBe(100);
    expect(satisfactionPercent(SAT_ONE - 1)).toBe(99);
  });

  it('scales the graph to 1, 2 or 5 × 10^k watts', () => {
    const watts = (jPerTick: number) => Math.round(graphScale(jPerTick) * 60);
    // At least 1 J/tick (60 W).
    expect(watts(0)).toBe(100);
    expect(watts(1)).toBe(100);
    expect(watts(2)).toBe(200);
    expect(watts(5)).toBe(500);
    expect(watts(15_000)).toBe(1_000_000);
    expect(watts(30_000)).toBe(2_000_000);
    expect(watts(40_000)).toBe(5_000_000);
    expect(watts(100_000)).toBe(10_000_000);
  });

  it('puts the newest second at the right edge and breaks lines at gaps', () => {
    const sample = (second: number, v: number) => ({ second, demand: v, supply: 2 * v, load: v });
    const series = graphSeries(
      [sample(10, 1), sample(40, 1), sample(41, 2), sample(69, 5)],
      70,
      10,
      590,
      100,
    );
    // The window is the 60 s before second 70: seconds 10 to 69.
    expect(series.demand).toHaveLength(3);
    expect(series.demand[0]).toEqual([{ x: 0, y: 90 }]);
    expect(series.demand[1]).toEqual([
      { x: 300, y: 90 },
      { x: 310, y: 80 },
    ]);
    expect(series.demand[2]).toEqual([{ x: 590, y: 50 }]);
    expect(series.supply[2]).toEqual([{ x: 590, y: 0 }]);
    // Values above the scale are clipped to the top.
    expect(graphSeries([sample(69, 50)], 70, 10, 590, 100).demand).toEqual([[{ x: 590, y: 0 }]]);
  });
});

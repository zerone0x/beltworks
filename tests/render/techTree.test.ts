import { describe, expect, it } from 'vitest';
import { EntityTypeId } from '../../src/data/entities';
import { TECH_IDS, TECHNOLOGIES, TechId } from '../../src/data/technologies';
import { MachineState } from '../../src/sim/entities/machine';
import type { EntityDetailData, ResearchData } from '../../src/sim/snapshot';
import { NO_RESEARCH } from '../../src/sim/snapshot';
import { hasEntityGui, machineBars, statusView } from '../../src/ui/entityPanel';
import { CONTROLS } from '../../src/ui/help';
import { costText, techProgress, techState, treeLayout, unlocksText } from '../../src/ui/techTree';

const research = (
  current: number,
  done: Record<number, number>,
  inProgress: Record<number, [units: number, ticks: number]> = {},
): ResearchData => ({
  current,
  techs: new Map(
    TECH_IDS.map((id) => [
      id,
      {
        unitsDone: done[id] ?? 0,
        unitsInProgress: inProgress[id]?.[0] ?? 0,
        ticksInProgress: inProgress[id]?.[1] ?? 0,
      },
    ]),
  ),
});

describe('tech tree', () => {
  it('tells researched, current, available and locked technologies apart', () => {
    expect(techState(NO_RESEARCH, TechId.Automation)).toBe('available');
    expect(techState(NO_RESEARCH, TechId.Electronics)).toBe('locked');
    const r = research(TechId.Electronics, { [TechId.Automation]: 10, [TechId.Electronics]: 3 });
    expect(techState(r, TechId.Automation)).toBe('researched');
    expect(techState(r, TechId.Electronics)).toBe('current');
    expect(techState(r, TechId.LogisticSciencePack)).toBe('available');
    expect(techState(r, TechId.Automation2)).toBe('locked');
  });

  it('counts the work on units under way into the progress', () => {
    const t = TECHNOLOGIES[TechId.Automation];
    const half = t.ticksPerUnit / 2;
    // 4 units done, two labs halfway through one each: 5 of 10.
    const r = research(
      TechId.Automation,
      { [TechId.Automation]: 4 },
      {
        [TechId.Automation]: [2, 2 * half],
      },
    );
    expect(techProgress(r, TechId.Automation)).toBe(0.5);
    expect(techProgress(NO_RESEARCH, TechId.Automation)).toBe(0);
    expect(techProgress(research(0, { [TechId.Automation]: 10 }), TechId.Automation)).toBe(1);
  });

  it('lays technologies out in columns by depth, after their prerequisites', () => {
    const layout = treeLayout();
    expect(layout.size).toBe(TECH_IDS.length);
    for (const id of TECH_IDS) {
      for (const p of TECHNOLOGIES[id].prerequisites) {
        expect(layout.get(p)!.col).toBeLessThan(layout.get(id)!.col);
      }
    }
    const cells = [...layout.values()].map(({ col, row }) => `${String(col)},${String(row)}`);
    expect(new Set(cells).size).toBe(cells.length);
    expect(layout.get(TechId.Automation)).toEqual({ col: 0, row: 0 });
  });

  it('describes costs and unlocks', () => {
    expect(costText(TECHNOLOGIES[TechId.Automation])).toBe(
      '10 × (Automation science pack), 10 s each',
    );
    expect(costText(TECHNOLOGIES[TechId.Logistics2])).toBe(
      '200 × (Automation science pack + Logistic science pack), 30 s each',
    );
    expect(unlocksText(TECHNOLOGIES[TechId.Automation])).toBe(
      'Unlocks: Assembling machine 1, Long-handed inserter',
    );
    expect(unlocksText(TECHNOLOGIES[TechId.Electronics])).toBe('Leads on to further research');
  });

  it('has a key in the controls help', () => {
    expect(CONTROLS.some((c) => c.keys === 'T')).toBe(true);
  });
});

describe('lab window', () => {
  const detail = (fields: Partial<EntityDetailData>): EntityDetailData => ({
    id: 1,
    type: EntityTypeId.Lab,
    reachable: true,
    status: MachineState.Working,
    recipe: 0,
    progress: 0,
    energy: 0,
    burning: 0,
    power: 0,
    network: 0,
    satisfaction: 0,
    technology: 0,
    slots: [],
    recipeOptions: [],
    ...fields,
  });

  it('opens for labs and shows their state and unit progress', () => {
    expect(hasEntityGui(EntityTypeId.Lab)).toBe(true);
    expect(statusView(MachineState.NoResearch, EntityTypeId.Lab)).toEqual({
      key: 'no-research',
      text: 'No research',
    });
    expect(machineBars(detail({ technology: TechId.Automation, progress: 150 })).progress).toBe(
      150 / TECHNOLOGIES[TechId.Automation].ticksPerUnit,
    );
    expect(machineBars(detail({})).progress).toBe(0);
  });
});

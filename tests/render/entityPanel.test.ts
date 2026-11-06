import { describe, expect, it } from 'vitest';
import { EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { RecipeId } from '../../src/data/recipes';
import { MachineState } from '../../src/sim/entities/machine';
import type { EntityDetailData } from '../../src/sim/snapshot';
import { machineBars, hasEntityGui, statusView } from '../../src/ui/entityPanel';

const detail = (fields: Partial<EntityDetailData>): EntityDetailData => ({
  id: 1,
  type: EntityTypeId.StoneFurnace,
  reachable: true,
  status: MachineState.Working,
  recipe: 0,
  progress: 0,
  energy: 0,
  burning: 0,
  slots: [],
  ...fields,
});

describe('entity panel', () => {
  it('opens for chests, furnaces, drills and inserters only', () => {
    expect(hasEntityGui(EntityTypeId.WoodenChest)).toBe(true);
    expect(hasEntityGui(EntityTypeId.StoneFurnace)).toBe(true);
    expect(hasEntityGui(EntityTypeId.BurnerMiningDrill)).toBe(true);
    expect(hasEntityGui(EntityTypeId.BurnerInserter)).toBe(true);
    expect(hasEntityGui(EntityTypeId.TransportBelt)).toBe(false);
    expect(hasEntityGui(0)).toBe(false);
  });

  it('names every machine state', () => {
    expect(statusView(MachineState.Working)).toEqual({ key: 'working', text: 'Working' });
    expect(statusView(MachineState.NoInput).text).toBe('No input');
    expect(statusView(MachineState.NoFuel).text).toBe('No fuel');
    expect(statusView(MachineState.OutputFull).text).toBe('Output full');
    expect(statusView(MachineState.Depleted)).toEqual({ key: 'depleted', text: 'Depleted' });
    expect(statusView(MachineState.WaitingForSource)).toEqual({
      key: 'waiting-for-source',
      text: 'Waiting for source',
    });
    expect(statusView(MachineState.WaitingForTarget).text).toBe('Waiting for target');
    expect(statusView(MachineState.Idle).text).toBe('');
    expect(statusView(99).key).toBe('idle');
  });

  it('shows smelting progress and the fuel left in the burning unit', () => {
    expect(
      machineBars(
        detail({
          recipe: RecipeId.IronPlate,
          progress: 96,
          energy: 1_000_000,
          burning: ItemId.Coal,
        }),
      ),
    ).toEqual({ progress: 0.5, fuel: 0.25 });
    expect(machineBars(detail({ energy: 1_000, burning: 0 }))).toEqual({ progress: 0, fuel: 0 });
    // A leftover from an earlier unit can exceed the new unit's value: clamp.
    expect(machineBars(detail({ energy: 2_000_500, burning: ItemId.Wood })).fuel).toBe(1);
  });

  it('shows mining progress out of the 240 ticks a drill takes per unit', () => {
    const drill = (fields: Partial<EntityDetailData>) =>
      detail({ type: EntityTypeId.BurnerMiningDrill, ...fields });
    expect(machineBars(drill({ progress: 60, energy: 3_000_000, burning: ItemId.Coal }))).toEqual({
      progress: 0.25,
      fuel: 0.75,
    });
    expect(machineBars(drill({ progress: 0 })).progress).toBe(0);
  });

  it("shows an inserter's arm position out of its 36-tick swing", () => {
    const inserter = (fields: Partial<EntityDetailData>) =>
      detail({ type: EntityTypeId.BurnerInserter, ...fields });
    expect(machineBars(inserter({ progress: 9, energy: 2_000_000, burning: ItemId.Coal }))).toEqual(
      { progress: 0.25, fuel: 0.5 },
    );
    expect(machineBars(inserter({ progress: 36 })).progress).toBe(1);
  });
});

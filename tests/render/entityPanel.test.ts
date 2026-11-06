import { describe, expect, it } from 'vitest';
import { EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { RecipeId } from '../../src/data/recipes';
import { MachineState } from '../../src/sim/entities/machine';
import type { EntityDetailData } from '../../src/sim/snapshot';
import { furnaceBars, hasEntityGui, statusView } from '../../src/ui/entityPanel';

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
  it('opens for chests and furnaces only', () => {
    expect(hasEntityGui(EntityTypeId.WoodenChest)).toBe(true);
    expect(hasEntityGui(EntityTypeId.StoneFurnace)).toBe(true);
    expect(hasEntityGui(EntityTypeId.TransportBelt)).toBe(false);
    expect(hasEntityGui(0)).toBe(false);
  });

  it('names every machine state', () => {
    expect(statusView(MachineState.Working)).toEqual({ key: 'working', text: 'Working' });
    expect(statusView(MachineState.NoInput).text).toBe('No input');
    expect(statusView(MachineState.NoFuel).text).toBe('No fuel');
    expect(statusView(MachineState.OutputFull).text).toBe('Output full');
    expect(statusView(MachineState.Idle).text).toBe('');
    expect(statusView(99).key).toBe('idle');
  });

  it('shows smelting progress and the fuel left in the burning unit', () => {
    expect(
      furnaceBars(
        detail({
          recipe: RecipeId.IronPlate,
          progress: 96,
          energy: 1_000_000,
          burning: ItemId.Coal,
        }),
      ),
    ).toEqual({ progress: 0.5, fuel: 0.25 });
    expect(furnaceBars(detail({ energy: 1_000, burning: 0 }))).toEqual({ progress: 0, fuel: 0 });
    // A leftover from an earlier unit can exceed the new unit's value: clamp.
    expect(furnaceBars(detail({ energy: 2_000_500, burning: ItemId.Wood })).fuel).toBe(1);
  });
});

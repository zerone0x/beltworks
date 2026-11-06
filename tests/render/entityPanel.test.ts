import { describe, expect, it } from 'vitest';
import { EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { RecipeId } from '../../src/data/recipes';
import { MachineState } from '../../src/sim/entities/machine';
import type { EntityDetailData } from '../../src/sim/snapshot';
import { engineSpeed } from '../../src/render/generatorLayer';
import {
  formatPower,
  machineBars,
  hasEntityGui,
  powerView,
  statusView,
} from '../../src/ui/entityPanel';

const detail = (fields: Partial<EntityDetailData>): EntityDetailData => ({
  id: 1,
  type: EntityTypeId.StoneFurnace,
  reachable: true,
  status: MachineState.Working,
  recipe: 0,
  progress: 0,
  energy: 0,
  burning: 0,
  power: 0,
  network: 0,
  satisfaction: 0,
  slots: [],
  ...fields,
});

describe('entity panel', () => {
  it('opens for chests, furnaces, drills, inserters, boilers and steam engines only', () => {
    expect(hasEntityGui(EntityTypeId.Boiler)).toBe(true);
    expect(hasEntityGui(EntityTypeId.SteamEngine)).toBe(true);
    expect(hasEntityGui(EntityTypeId.SmallElectricPole)).toBe(false);
    expect(hasEntityGui(EntityTypeId.WoodenChest)).toBe(true);
    expect(hasEntityGui(EntityTypeId.StoneFurnace)).toBe(true);
    expect(hasEntityGui(EntityTypeId.BurnerMiningDrill)).toBe(true);
    expect(hasEntityGui(EntityTypeId.BurnerInserter)).toBe(true);
    expect(hasEntityGui(EntityTypeId.TransportBelt)).toBe(false);
    expect(hasEntityGui(0)).toBe(false);
  });

  it('names every machine state', () => {
    expect(statusView(MachineState.Working)).toEqual({ key: 'working', text: 'Working' });
    expect(statusView(MachineState.Working, EntityTypeId.StoneFurnace).text).toBe('Working');
    // A working inserter is swinging its arm.
    expect(statusView(MachineState.Working, EntityTypeId.BurnerInserter)).toEqual({
      key: 'swinging',
      text: 'Swinging',
    });
    expect(statusView(MachineState.NoFuel, EntityTypeId.BurnerInserter).text).toBe('No fuel');
    expect(statusView(MachineState.NoInput).text).toBe('No input');
    expect(statusView(MachineState.NoFuel).text).toBe('No fuel');
    expect(statusView(MachineState.OutputFull).text).toBe('Output full');
    expect(statusView(MachineState.Depleted)).toEqual({ key: 'depleted', text: 'Depleted' });
    expect(statusView(MachineState.WaitingForSource)).toEqual({
      key: 'waiting-for-source',
      text: 'Waiting for source',
    });
    expect(statusView(MachineState.WaitingForTarget).text).toBe('Waiting for target');
    expect(statusView(MachineState.NoDemand)).toEqual({ key: 'no-demand', text: 'No demand' });
    // A steam engine's input is steam.
    expect(statusView(MachineState.NoInput, EntityTypeId.SteamEngine)).toEqual({
      key: 'no-steam',
      text: 'No steam',
    });
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

  it('writes power in W, kW and MW (60 ticks per second)', () => {
    expect(formatPower(15_000)).toBe('900 kW');
    expect(formatPower(30_000)).toBe('1.8 MW');
    expect(formatPower(7)).toBe('420 W');
    expect(formatPower(0)).toBe('0 W');
    expect(formatPower(12_345)).toBe('740.7 kW');
  });

  it("shows a steam engine's output out of its maximum and its network's satisfaction", () => {
    const engine = (fields: Partial<EntityDetailData>) =>
      detail({ type: EntityTypeId.SteamEngine, ...fields });
    expect(powerView(engine({ power: 7_500, network: 3, satisfaction: 32_768 }))).toEqual({
      output: 0.5,
      text: 'Output: 450 kW / 900 kW',
      network: 'Network: 50% satisfied',
    });
    expect(powerView(engine({ power: 0, network: 0 })).network).toBe('Not connected');
    const boiler = powerView(detail({ type: EntityTypeId.Boiler, power: 30_000 }));
    expect(boiler).toEqual({ output: 1, text: 'Output: 1.8 MW / 1.8 MW', network: '' });
  });

  it('turns a steam engine flywheel with its output', () => {
    expect(engineSpeed(15_000, 15_000)).toBe(1);
    expect(engineSpeed(3_750, 15_000)).toBe(0.25);
    expect(engineSpeed(0, 15_000)).toBe(0);
    expect(engineSpeed(10, 0)).toBe(0);
  });
});

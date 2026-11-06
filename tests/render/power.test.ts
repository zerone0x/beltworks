import { describe, expect, it } from 'vitest';
import { ENTITIES, EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { TILE_PX } from '../../src/render/camera';
import type { EntityView } from '../../src/render/entityIndex';
import { LOW_POWER_COLOR, NO_POWER_COLOR, powerIconColor } from '../../src/render/entityLayer';
import { POLE_TOP, poleTop, powerFocus } from '../../src/render/powerLayer';
import { BuildResult, placeEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { MachineState } from '../../src/sim/entities/machine';
import { tileCenter } from '../../src/sim/fixed';
import {
  ENTITY_STRIDE,
  EntityField,
  decodePower,
  encodeEntities,
  encodePower,
  type PowerData,
} from '../../src/sim/snapshot';
import { Sim } from '../../src/sim/tick';

const POLE = ENTITIES[EntityTypeId.SmallElectricPole];
const CHEST = ENTITIES[EntityTypeId.WoodenChest];
const { North } = Direction;

/** A sim with poles at the given tiles, placed by a player standing on (0, 0). */
function simWithPoles(tiles: [number, number][]) {
  const sim = new Sim({ seed: 1, startingKit: [{ item: ItemId.SmallElectricPole, count: 20 }] });
  const { state } = sim;
  state.players.x[0] = tileCenter(0);
  state.players.y[0] = tileCenter(0);
  for (const [x, y] of tiles) {
    expect(placeEntity(state, 0, ItemId.SmallElectricPole, x, y, North)).toBe(BuildResult.Ok);
  }
  return sim;
}

describe('encodePower', () => {
  it('encodes the poles in range with their networks, the wires between them, and the networks', () => {
    // Ids 1–4: three wired across the chunk border at x = 0, one alone.
    const sim = simWithPoles([
      [-5, 2],
      [2, 2],
      [2, -4],
      [9, -4],
    ]);
    sim.step();
    const range = { cx0: -1, cy0: -1, cx1: 0, cy1: 0 };
    const power = decodePower(encodePower(sim.state, range).buffer);
    const type = EntityTypeId.SmallElectricPole;
    // In chunk order, like the entity records.
    expect(power.poles).toEqual([
      { id: 3, type, x: 2, y: -4, network: 1 },
      { id: 4, type, x: 9, y: -4, network: 1 },
      { id: 1, type, x: -5, y: 2, network: 1 },
      { id: 2, type, x: 2, y: 2, network: 1 },
    ]);
    expect(power.wires).toEqual([
      [3, 4],
      [1, 2],
      [2, 3],
    ]);
    expect(power.networks).toEqual([{ id: 1, poles: 4, demand: 0, supply: 0, satisfaction: 0 }]);
    // Wires to poles outside the range are left out.
    const east = decodePower(encodePower(sim.state, { cx0: 0, cy0: -1, cx1: 0, cy1: 0 }).buffer);
    expect(east.poles.map((p) => p.id)).toEqual([3, 4, 2]);
    expect(east.wires).toEqual([
      [3, 4],
      [2, 3],
    ]);
    expect(decodePower(encodePower(sim.state, null).buffer)).toEqual({
      poles: [],
      wires: [],
      networks: [],
      members: [],
    });
  });
});

describe('powerFocus', () => {
  const power: PowerData = {
    poles: [
      { id: 1, type: POLE.id, x: 0, y: 0, network: 1 },
      { id: 2, type: POLE.id, x: 7, y: 0, network: 1 },
      { id: 5, type: POLE.id, x: 0, y: 8, network: 2 },
    ],
    wires: [[1, 2]],
    networks: [],
    members: [],
  };
  const view = (id: number, proto = POLE, x = 0, y = 0): EntityView => ({
    id,
    type: proto.id,
    proto,
    x,
    y,
    w: 1,
    h: 1,
    dir: North,
    status: 0,
    recipe: 0,
  });

  it('previews the wires a pole ghost would get, judged like the simulation', () => {
    const ghost = (x: number, y: number) => ({ proto: POLE, x, y, dir: North, valid: true });
    expect(powerFocus(ghost(3, 4), null, power)).toEqual({
      kind: 'ghost',
      proto: POLE,
      x: 3,
      y: 4,
      id: 0,
      connects: [1, 2, 5], // 25, 32 and 25 squared
    });
    // 49 to pole 2, 50 to pole 5, 98 to pole 1.
    expect(powerFocus(ghost(7, 7), null, power)?.connects).toEqual([2]);
    expect(powerFocus(ghost(20, 20), null, power)?.connects).toEqual([]);
    // Other ghosts show nothing, even over a pole.
    expect(powerFocus({ ...ghost(0, 0), proto: CHEST }, view(1), power)).toBeNull();
  });

  it('shows a hovered pole with its wires when nothing is held', () => {
    expect(powerFocus(null, view(2, POLE, 7, 0), power)).toMatchObject({
      kind: 'pole',
      id: 2,
      x: 7,
      y: 0,
      connects: [1],
    });
    expect(powerFocus(null, view(5, POLE, 0, 8), power)?.connects).toEqual([]);
    expect(powerFocus(null, view(9, CHEST), power)).toBeNull();
    expect(powerFocus(null, null, power)).toBeNull();
  });

  it('hangs wires from the top of the pole', () => {
    expect(poleTop(POLE, 2, -1)).toEqual({
      x: 2.5 * TILE_PX,
      y: (-0.5 - POLE_TOP) * TILE_PX,
    });
  });
});

describe('power icons', () => {
  it('are red for no power, yellow for low power, and absent otherwise', () => {
    expect(powerIconColor(MachineState.NoPower)).toBe(NO_POWER_COLOR);
    expect(powerIconColor(MachineState.LowPower)).toBe(LOW_POWER_COLOR);
    expect(powerIconColor(MachineState.Working)).toBeNull();
    expect(powerIconColor(MachineState.NoFuel)).toBeNull();
  });

  it('show on electric consumers without power, from the snapshot status', () => {
    const sim = new Sim({
      seed: 1,
      startingKit: [
        { item: ItemId.ElectricInserter, count: 2 },
        { item: ItemId.SmallElectricPole, count: 1 },
      ],
    });
    const { state } = sim;
    state.players.x[0] = tileCenter(0);
    state.players.y[0] = tileCenter(0);
    // One not connected, one on a network with nothing producing.
    expect(placeEntity(state, 0, ItemId.ElectricInserter, -3, 0, North)).toBe(BuildResult.Ok);
    expect(placeEntity(state, 0, ItemId.ElectricInserter, 3, 0, North)).toBe(BuildResult.Ok);
    expect(placeEntity(state, 0, ItemId.SmallElectricPole, 4, 1, North)).toBe(BuildResult.Ok);
    sim.step();
    const records = encodeEntities(state, { cx0: -1, cy0: -1, cx1: 0, cy1: 0 });
    const statuses: number[] = [];
    for (let o = 0; o < records.length; o += ENTITY_STRIDE) {
      statuses.push(records[o + EntityField.status]!);
    }
    expect(statuses).toEqual([MachineState.NoPower, MachineState.NoPower, MachineState.Idle]);
  });
});

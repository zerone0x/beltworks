import { describe, expect, it } from 'vitest';
import { EntityTypeId, SAT_ONE } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { ResourceId } from '../../src/data/resources';
import { BuildResult, placeEntity, removeEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { tileCenter } from '../../src/sim/fixed';
import { powerGrid } from '../../src/sim/power/grid';
import { decodeNetworkDetail, encodeNetworkDetail } from '../../src/sim/snapshot';
import { Sim } from '../../src/sim/tick';
import { CHUNK_MASK, CHUNK_SHIFT, tileIndex } from '../../src/sim/world/chunk';

const { North } = Direction;

/**
 * A boiler facing north on (0..1, 0..2) feeding an engine on (-2..0, -5..-1);
 * a pole on (1, -6) covers the engine, an electric drill on (2..4, -9..-7)
 * (on iron ore, dropping into a chest on (3, -10)) and an electric inserter
 * on (2, -5). A second pole far away has a network of its own.
 */
function setup() {
  const sim = new Sim({
    seed: 1,
    startingKit: [
      { item: ItemId.Boiler, count: 1 },
      { item: ItemId.SteamEngine, count: 1 },
      { item: ItemId.SmallElectricPole, count: 2 },
      { item: ItemId.ElectricMiningDrill, count: 1 },
      { item: ItemId.ElectricInserter, count: 1 },
      { item: ItemId.WoodenChest, count: 1 },
      { item: ItemId.Coal, count: 5 },
    ],
  });
  const { state } = sim;
  state.players.x[0] = tileCenter(6);
  state.players.y[0] = tileCenter(-3);
  for (let y = -12; y <= 4; y++) {
    for (let x = -4; x <= 8; x++) {
      const chunk = state.world.getChunk(x >> CHUNK_SHIFT, y >> CHUNK_SHIFT);
      const i = tileIndex(x & CHUNK_MASK, y & CHUNK_MASK);
      const ore = x >= 2 && x <= 4 && y >= -9 && y <= -7;
      chunk.resource[i] = ore ? ResourceId.IronOre : ResourceId.None;
      chunk.amount[i] = ore ? 1_000 : 0;
    }
  }
  const { entities } = state;
  const place = (item: number, x: number, y: number) => {
    expect(placeEntity(state, 0, item, x, y, North)).toBe(BuildResult.Ok);
    return entities.at(x, y);
  };
  const ids = {
    boiler: place(ItemId.Boiler, 0, 0),
    engine: place(ItemId.SteamEngine, -2, -5),
    pole: place(ItemId.SmallElectricPole, 1, -6),
    drill: place(ItemId.ElectricMiningDrill, 2, -9),
    chest: place(ItemId.WoodenChest, 3, -10),
    inserter: place(ItemId.ElectricInserter, 2, -5),
    far: place(ItemId.SmallElectricPole, 8, 3),
  };
  const detail = (pole: number) => {
    const buffer = encodeNetworkDetail(state, pole);
    return buffer && decodeNetworkDetail(buffer.buffer);
  };
  return { sim, state, ids, detail };
}

describe('network detail (power panel)', () => {
  it('is only sent for poles', () => {
    const { ids, state } = setup();
    expect(encodeNetworkDetail(state, ids.drill)).toBeNull();
    expect(encodeNetworkDetail(state, ids.boiler)).toBeNull();
    expect(encodeNetworkDetail(state, 9_999)).toBeNull();
    expect(encodeNetworkDetail(state, ids.pole)).not.toBeNull();
  });

  it('groups the whole network by type: no power before the boiler has fuel', () => {
    const { sim, ids, state, detail } = setup();
    sim.step();
    const grid = powerGrid(state.entities)!;
    const d = detail(ids.pole)!;
    expect(d.pole).toBe(ids.pole);
    expect(d.network).toBe(grid.networkOfPole(ids.pole));
    expect(d).toMatchObject({ poles: 1, supply: 0, satisfaction: 0, load: 0 });
    // Without power both stay active and ask for their working energy (D26).
    expect(d.demand).toBe(1_500 + 220);
    expect(d.groups).toEqual([
      {
        type: EntityTypeId.SteamEngine,
        producer: true,
        count: 1,
        demand: 0,
        maxOutput: 0,
        power: 0,
      },
      {
        type: EntityTypeId.ElectricMiningDrill,
        producer: false,
        count: 1,
        demand: 1_500,
        maxOutput: 0,
        power: 0,
      },
      {
        type: EntityTypeId.ElectricInserter,
        producer: false,
        count: 1,
        demand: 220,
        maxOutput: 0,
        power: 0,
      },
    ]);
    // The other pole's network is empty.
    const far = detail(ids.far)!;
    expect(far.network).not.toBe(d.network);
    expect(far).toMatchObject({ poles: 1, demand: 0, supply: 0, groups: [] });
  });

  it('reports what the producers delivered and the consumers drew', () => {
    const { sim, ids, state, detail } = setup();
    expect(state.entities.insert(ids.boiler, ItemId.Coal, 5)).toBe(5);
    // Powered, the inserter finds nothing to pick up and sleeps on its drain.
    sim.step();
    sim.step();
    const d = detail(ids.pole)!;
    expect(d).toMatchObject({ supply: 15_000, satisfaction: SAT_ONE, demand: 1_507, load: 1_507 });
    const [engine, drill, inserter] = d.groups;
    expect(engine).toMatchObject({ count: 1, maxOutput: 15_000, power: 1_507 });
    expect(drill).toMatchObject({ demand: 1_500, power: 1_500 });
    expect(inserter).toMatchObject({ demand: 7, power: 7 });
  });

  it('follows the network when entities leave it', () => {
    const { sim, ids, state, detail } = setup();
    expect(removeEntity(state, 0, 2, -5)).toBe(BuildResult.Ok);
    sim.step();
    expect(detail(ids.pole)!.groups.map((g) => g.type)).toEqual([
      EntityTypeId.SteamEngine,
      EntityTypeId.ElectricMiningDrill,
    ]);
  });
});

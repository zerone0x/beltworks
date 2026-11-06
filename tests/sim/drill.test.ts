import { describe, expect, it } from 'vitest';
import { ENTITIES, EntityTypeId } from '../../src/data/entities';
import { ItemId, fuelValue, type ItemStack } from '../../src/data/items';
import { RecipeId } from '../../src/data/recipes';
import { ResourceId } from '../../src/data/resources';
import { BuildResult, placeEntity, removeEntity, rotateEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import {
  DRILL_ENERGY_PER_TICK,
  DRILL_MINING_TICKS,
  DrillSlot,
  drillDropTile,
  drillTable,
} from '../../src/sim/entities/drill';
import { FurnaceSlot } from '../../src/sim/entities/furnace';
import { MachineState } from '../../src/sim/entities/machine';
import { tileCenter } from '../../src/sim/fixed';
import { encodeEntityDetail, decodeEntityDetail } from '../../src/sim/snapshot';
import { Sim } from '../../src/sim/tick';
import { CHUNK_MASK, CHUNK_SHIFT, tileIndex } from '../../src/sim/world/chunk';
import type { World } from '../../src/sim/world/world';

// Shared M1 design numbers (issue #15).
const COAL_J = 4_000_000;
const DRILL_W = 2_500;
const UNIT_TICKS = 240;
const PLATE_TICKS = 192;

/** Sets the resource on tile `(x, y)` (test setup only; bypasses the world's bookkeeping). */
function setOre(world: World, x: number, y: number, resource: number, amount: number): void {
  const chunk = world.getChunk(x >> CHUNK_SHIFT, y >> CHUNK_SHIFT);
  const i = tileIndex(x & CHUNK_MASK, y & CHUNK_MASK);
  chunk.resource[i] = amount > 0 ? resource : ResourceId.None;
  chunk.amount[i] = amount;
}

/**
 * A sim whose player 0 stands on tile (0, 0), with a drill on (2..3, 0..1)
 * facing `dir` and `ore` units of iron ore under each of its tiles (row-major:
 * (2, 0), (3, 0), (2, 1), (3, 1)). The tiles around are cleared of resources.
 */
function setup(
  options: { dir?: Direction; ore?: readonly number[]; kit?: readonly ItemStack[] } = {},
) {
  const sim = new Sim({
    seed: 1,
    startingKit: [
      { item: ItemId.BurnerMiningDrill, count: 2 },
      { item: ItemId.WoodenChest, count: 2 },
      { item: ItemId.StoneFurnace, count: 1 },
      { item: ItemId.Coal, count: 50 },
      ...(options.kit ?? []),
    ],
  });
  const { state } = sim;
  state.players.x[0] = tileCenter(0);
  state.players.y[0] = tileCenter(0);
  for (let y = -3; y <= 4; y++) {
    for (let x = -3; x <= 6; x++) setOre(state.world, x, y, ResourceId.None, 0);
  }
  const ore = options.ore ?? [100, 100, 100, 100];
  ore.forEach((amount, i) => {
    setOre(state.world, 2 + (i % 2), Math.floor(i / 2), ResourceId.IronOre, amount);
  });
  const dir = options.dir ?? Direction.East;
  expect(placeEntity(state, 0, ItemId.BurnerMiningDrill, 2, 0, dir)).toBe(BuildResult.Ok);
  const { entities } = state;
  const id = entities.at(2, 0);
  const table = drillTable(entities)!;
  const slot = (s: number) => entities.slots(id)[s]!;
  const place = (item: number, x: number, y: number, d: Direction = Direction.North) => {
    expect(placeEntity(state, 0, item, x, y, d)).toBe(BuildResult.Ok);
    return entities.at(x, y);
  };
  return {
    sim,
    state,
    id,
    table,
    entities,
    world: state.world,
    place,
    step: (n: number) => {
      for (let i = 0; i < n; i++) sim.step();
    },
    fuel: () => slot(DrillSlot.Fuel),
    held: () => slot(DrillSlot.Output),
    detail: () => entities.detail(id)!,
    amounts: () => [0, 1, 2, 3].map((i) => state.world.amountAt(2 + (i % 2), Math.floor(i / 2))),
  };
}

describe('shared M1 numbers', () => {
  it('live in src/data', () => {
    const proto = ENTITIES[EntityTypeId.BurnerMiningDrill];
    expect([proto.width, proto.height, proto.rotatable]).toEqual([2, 2, true]);
    expect(proto.energyPerTick).toBe(DRILL_W);
    expect(proto.miningTicks).toBe(UNIT_TICKS);
    expect(DRILL_ENERGY_PER_TICK).toBe(DRILL_W);
    expect(DRILL_MINING_TICKS).toBe(UNIT_TICKS);
    expect(fuelValue(ItemId.Coal)).toBe(COAL_J);
  });
});

describe('drillDropTile', () => {
  it('is the tile in front of the left half of the front edge', () => {
    expect(drillDropTile(10, 20, Direction.North)).toEqual({ x: 10, y: 19 });
    expect(drillDropTile(10, 20, Direction.East)).toEqual({ x: 12, y: 20 });
    expect(drillDropTile(10, 20, Direction.South)).toEqual({ x: 11, y: 22 });
    expect(drillDropTile(10, 20, Direction.West)).toEqual({ x: 9, y: 21 });
  });
});

describe('burner mining drill', () => {
  it('takes only fuel, and lists its fuel and output slots', () => {
    const d = setup();
    const { entities, id } = d;
    expect(entities.insertable(id, ItemId.Coal)).toBe(50);
    expect(entities.insertable(id, ItemId.IronOre)).toBe(0);
    expect(entities.insertable(id, 999)).toBe(0);
    expect(entities.insert(id, ItemId.IronOre, 5)).toBe(0);
    expect(entities.insert(id, ItemId.Coal, 3)).toBe(3);
    expect(entities.insert(id, ItemId.Wood, 1)).toBe(0);
    expect(entities.slots(id)).toEqual([
      { item: ItemId.Coal, count: 3 },
      { item: 0, count: 0 },
    ]);
    expect(entities.outputSlot(id)).toBe(-1);
    expect(entities.take(id, DrillSlot.Fuel, 1)).toBe(1);
    expect(entities.take(id, DrillSlot.Output, 1)).toBe(0);
    expect(entities.take(id, 7, 1)).toBe(0);
    expect(d.fuel()).toEqual({ item: ItemId.Coal, count: 2 });
  });

  it('waits for fuel without burning or mining anything', () => {
    const d = setup();
    d.place(ItemId.WoodenChest, 4, 0);
    d.step(1000);
    expect(d.entities.status(d.id)).toBe(MachineState.NoFuel);
    expect(d.table.activeCount).toBe(0);
    expect(d.amounts()).toEqual([100, 100, 100, 100]);
    // Fuel wakes it.
    d.entities.insert(d.id, ItemId.Coal, 1);
    expect(d.table.activeCount).toBe(1);
    d.step(1);
    expect(d.entities.status(d.id)).toBe(MachineState.Working);
    expect(d.detail()).toMatchObject({ progress: 1, energy: COAL_J - DRILL_W });
  });

  it('mines exactly one unit every 240 ticks into a chest in front of it', () => {
    const d = setup();
    const chest = d.place(ItemId.WoodenChest, 4, 0);
    d.entities.insert(d.id, ItemId.Coal, 5);
    const stored = () => d.entities.slots(chest)[0]!.count;
    for (let unit = 1; unit <= 10; unit++) {
      d.step(UNIT_TICKS - 1);
      expect(stored()).toBe(unit - 1);
      d.step(1);
      expect(stored()).toBe(unit);
      expect(d.entities.status(d.id)).toBe(MachineState.Working);
    }
    expect(d.entities.slots(chest)[0]!.item).toBe(ItemId.IronOre);
    expect(d.amounts().reduce((a, b) => a + b)).toBe(400 - 10);
    expect(d.held()).toEqual({ item: 0, count: 0 });
  });

  it('runs exactly 1 600 working ticks on one coal (6 units and 160/240 of the 7th)', () => {
    const d = setup();
    const chest = d.place(ItemId.WoodenChest, 4, 0);
    d.entities.insert(d.id, ItemId.Coal, 1);
    expect(COAL_J / DRILL_W).toBe(1_600);
    d.step(1_599);
    expect(d.entities.status(d.id)).toBe(MachineState.Working);
    d.step(1);
    expect(d.detail()).toMatchObject({ energy: 0, burning: ItemId.Coal, progress: 160 });
    expect(d.entities.slots(chest)[0]!.count).toBe(6);
    d.step(1);
    expect(d.entities.status(d.id)).toBe(MachineState.NoFuel);
    expect(d.table.activeCount).toBe(0);
    d.step(500);
    expect(d.detail().progress).toBe(160);
    // The next coal picks up where it stopped: the 7th unit after 80 more ticks.
    d.entities.insert(d.id, ItemId.Coal, 1);
    d.step(79);
    expect(d.entities.slots(chest)[0]!.count).toBe(6);
    d.step(1);
    expect(d.entities.slots(chest)[0]!.count).toBe(7);
  });

  it('mines the covered tiles in turn, skipping empty ones, until all are empty', () => {
    // Tiles in row-major order: (2, 0), (3, 0), (2, 1), (3, 1).
    const d = setup({ ore: [1, 3, 0, 2] });
    d.world.getChunk(0, 0).resource[tileIndex(2, 0)] = ResourceId.CopperOre;
    const chest = d.place(ItemId.WoodenChest, 4, 0);
    d.entities.insert(d.id, ItemId.Coal, 10);
    const trace: number[][] = [];
    for (let unit = 0; unit < 6; unit++) {
      d.step(UNIT_TICKS);
      trace.push(d.amounts());
    }
    expect(trace).toEqual([
      [0, 3, 0, 2], // tile 0 (copper, now empty)
      [0, 2, 0, 2], // tile 1
      [0, 2, 0, 1], // tile 2 is empty: tile 3
      [0, 1, 0, 1], // tile 0 is empty: tile 1
      [0, 1, 0, 0], // tile 3
      [0, 0, 0, 0], // tile 1
    ]);
    expect(d.entities.contents(chest)).toEqual([
      { item: ItemId.CopperOre, count: 1 },
      { item: ItemId.IronOre, count: 5 },
    ]);
    // Emptied tiles lose their resource; the world records the change.
    expect(d.world.resourceAt(2, 0)).toBe(ResourceId.None);
    expect(d.world.chunkVersion(0, 0)).toBe(6);
    // All empty: depleted for good, off the active list, and burning nothing more.
    const energy = d.detail().energy;
    d.step(1);
    expect(d.entities.status(d.id)).toBe(MachineState.Depleted);
    expect(d.table.activeCount).toBe(0);
    d.step(500);
    expect(d.detail().energy).toBe(energy);
    expect(d.entities.contents(chest)[1]!.count).toBe(5);
  });

  it('is depleted right away on ground without resources, and burns nothing', () => {
    const d = setup({ ore: [0, 0, 0, 0] });
    d.entities.insert(d.id, ItemId.Coal, 1);
    d.step(10);
    expect(d.entities.status(d.id)).toBe(MachineState.Depleted);
    expect(d.fuel()).toEqual({ item: ItemId.Coal, count: 1 });
    expect(d.detail().energy).toBe(0);
  });

  it('holds one unit and stops while nothing in front takes it', () => {
    const d = setup();
    d.entities.insert(d.id, ItemId.Coal, 5);
    d.step(UNIT_TICKS);
    // Nothing on the drop tile: the unit waits in the output slot.
    expect(d.entities.status(d.id)).toBe(MachineState.OutputFull);
    expect(d.held()).toEqual({ item: ItemId.IronOre, count: 1 });
    expect(d.entities.outputSlot(d.id)).toBe(DrillSlot.Output);
    expect(d.table.activeCount).toBe(0);
    const energy = d.detail().energy;
    d.step(1000);
    expect(d.detail()).toMatchObject({ energy, progress: 0 });
    expect(d.amounts().reduce((a, b) => a + b)).toBe(399);

    // A chest placed on the drop tile wakes it; the unit drops on the next tick
    // and mining resumes in the same tick.
    const chest = d.place(ItemId.WoodenChest, 4, 0);
    expect(d.table.activeCount).toBe(1);
    d.step(1);
    expect(d.entities.contents(chest)).toEqual([{ item: ItemId.IronOre, count: 1 }]);
    expect(d.entities.status(d.id)).toBe(MachineState.Working);
    expect(d.detail().progress).toBe(1);
  });

  it('is not woken by entities placed next to it but off its drop tile', () => {
    const d = setup();
    d.entities.insert(d.id, ItemId.Coal, 5);
    d.step(UNIT_TICKS);
    expect(d.table.activeCount).toBe(0);
    d.place(ItemId.WoodenChest, 4, 1);
    d.place(ItemId.WoodenChest, 2, -1);
    expect(d.table.activeCount).toBe(0);
  });

  it('waits on a full chest and wakes when it gets room', () => {
    const d = setup({ kit: [{ item: ItemId.Stone, count: 800 }] });
    const chest = d.place(ItemId.WoodenChest, 4, 0);
    expect(d.entities.insert(chest, ItemId.Stone, 800)).toBe(800);
    d.entities.insert(d.id, ItemId.Coal, 5);
    d.step(UNIT_TICKS);
    expect(d.entities.status(d.id)).toBe(MachineState.OutputFull);
    expect(d.entities.wake.watchersOf(chest)).toEqual([d.id]);
    d.step(100);
    expect(d.table.activeCount).toBe(0);
    // Emptying a slot notifies the chest's subscribers.
    expect(d.entities.take(chest, 3, 50)).toBe(50);
    expect(d.table.activeCount).toBe(1);
    d.step(1);
    expect(d.entities.slots(chest)[3]).toEqual({ item: ItemId.IronOre, count: 1 });
    expect(d.entities.status(d.id)).toBe(MachineState.Working);
    // Once the unit is dropped the subscription ends.
    expect(d.entities.wake.watchersOf(chest)).toEqual([]);
  });

  it('wakes when the entity in front is removed, and keeps holding with nothing there', () => {
    const d = setup({ kit: [{ item: ItemId.Stone, count: 800 }] });
    const chest = d.place(ItemId.WoodenChest, 4, 0);
    d.entities.insert(chest, ItemId.Stone, 800);
    d.entities.insert(d.id, ItemId.Coal, 5);
    d.step(UNIT_TICKS);
    expect(d.entities.status(d.id)).toBe(MachineState.OutputFull);
    expect(removeEntity(d.state, 0, 4, 0)).toBe(BuildResult.Ok);
    expect(d.table.activeCount).toBe(1);
    expect(d.entities.wake.size).toBe(0);
    d.step(1);
    expect(d.entities.status(d.id)).toBe(MachineState.OutputFull);
    expect(d.table.activeCount).toBe(0);
    expect(d.held()).toEqual({ item: ItemId.IronOre, count: 1 });
    // The player can take the held unit, which lets the drill go on.
    expect(d.entities.take(d.id, DrillSlot.Output, 1)).toBe(1);
    expect(d.table.activeCount).toBe(1);
    d.step(1);
    expect(d.entities.status(d.id)).toBe(MachineState.Working);
    expect(d.detail().progress).toBe(1);
  });

  it('drops onto its new drop tile after rotating', () => {
    const d = setup({ dir: Direction.North });
    // Facing north it drops onto (2, -1); east onto (4, 0).
    const north = d.place(ItemId.WoodenChest, 2, -1);
    const east = d.place(ItemId.WoodenChest, 4, 0);
    d.entities.insert(d.id, ItemId.Coal, 5);
    d.step(UNIT_TICKS);
    expect(d.entities.slots(north)[0]!.count).toBe(1);
    expect(rotateEntity(d.state, 0, 2, 0)).toBe(BuildResult.Ok);
    expect(d.entities.store.dir(d.id)).toBe(Direction.East);
    d.step(UNIT_TICKS);
    expect(d.entities.slots(north)[0]!.count).toBe(1);
    expect(d.entities.slots(east)[0]!.count).toBe(1);
  });

  it('feeds a furnace, which smelts the ore into plates with no player input', () => {
    const d = setup();
    // A 2×2 furnace on (4..5, 0..1): the drill's drop tile (4, 0) is part of it.
    const furnace = d.place(ItemId.StoneFurnace, 4, 0);
    d.entities.insert(furnace, ItemId.Coal, 5);
    d.entities.insert(d.id, ItemId.Coal, 5);
    const slots = () => d.entities.slots(furnace);
    // Drills run before furnaces: the first ore arrives on tick 240 and the
    // furnace starts on it in the same tick, so its plate is done 192 ticks in.
    d.step(UNIT_TICKS);
    expect(d.entities.status(furnace)).toBe(MachineState.Working);
    expect(d.detail()).toMatchObject({ progress: 0 });
    expect(d.entities.detail(furnace)).toMatchObject({ recipe: RecipeId.IronPlate, progress: 1 });
    expect(slots()[FurnaceSlot.Input]!.count).toBe(0);
    d.step(PLATE_TICKS - 2);
    expect(slots()[FurnaceSlot.Output]!.count).toBe(0);
    d.step(1);
    expect(slots()[FurnaceSlot.Output]).toEqual({ item: ItemId.IronPlate, count: 1 });
    // The furnace is faster than the drill: every ore but the one in progress is a plate.
    d.step(10 * UNIT_TICKS - UNIT_TICKS - (PLATE_TICKS - 1));
    expect(slots()[FurnaceSlot.Output]!.count).toBe(9);
    expect(slots()[FurnaceSlot.Input]!.count).toBe(0);
    expect(d.entities.status(d.id)).toBe(MachineState.Working);
  });

  it('wakes when a full furnace input gets room', () => {
    const d = setup({ kit: [{ item: ItemId.IronOre, count: 50 }] });
    const furnace = d.place(ItemId.StoneFurnace, 4, 0);
    expect(d.entities.insert(furnace, ItemId.IronOre, 50)).toBe(50);
    d.entities.insert(d.id, ItemId.Coal, 5);
    d.step(UNIT_TICKS);
    expect(d.entities.status(d.id)).toBe(MachineState.OutputFull);
    // Fuelling the furnace notifies, but its input is still full.
    d.entities.insert(furnace, ItemId.Coal, 1);
    d.step(1);
    // The furnace took one ore to smelt on that tick: the drill drops on the next.
    expect(d.entities.status(d.id)).toBe(MachineState.OutputFull);
    d.step(1);
    expect(d.entities.status(d.id)).toBe(MachineState.Working);
    expect(d.entities.slots(furnace)[FurnaceSlot.Input]!.count).toBe(50);
  });

  it('drops mined coal into a furnace fuel slot, never into its own', () => {
    const d = setup();
    for (let i = 0; i < 4; i++)
      d.world.getChunk(0, 0).resource[tileIndex(2 + (i % 2), i >> 1)] = ResourceId.Coal;
    const furnace = d.place(ItemId.StoneFurnace, 4, 0);
    d.entities.insert(d.id, ItemId.Coal, 1);
    d.step(2 * UNIT_TICKS);
    expect(d.entities.slots(furnace)[FurnaceSlot.Fuel]).toEqual({ item: ItemId.Coal, count: 2 });
    expect(d.fuel()).toEqual({ item: 0, count: 0 });
  });

  it('refunds its fuel and held unit when removed', () => {
    const d = setup();
    d.entities.insert(d.id, ItemId.Coal, 3);
    d.step(UNIT_TICKS);
    expect(d.entities.contents(d.id)).toEqual([
      { item: ItemId.Coal, count: 2 },
      { item: ItemId.IronOre, count: 1 },
    ]);
    const inv = d.state.players.inventory(0);
    const coal = inv.count(ItemId.Coal);
    expect(removeEntity(d.state, 0, 3, 1)).toBe(BuildResult.Ok);
    expect(inv.count(ItemId.Coal)).toBe(coal + 2);
    expect(inv.count(ItemId.IronOre)).toBe(1);
    expect(inv.count(ItemId.BurnerMiningDrill)).toBe(2);
    expect(d.table.count).toBe(0);
    expect(d.table.activeCount).toBe(0);
  });

  it('keeps rows straight when a drill in the middle is removed', () => {
    const d = setup({ kit: [{ item: ItemId.BurnerMiningDrill, count: 2 }] });
    // Two more drills on bare ground west and south of the player.
    const second = d.place(ItemId.BurnerMiningDrill, -2, 2, Direction.West);
    setOre(d.world, 2, 3, ResourceId.Stone, 10);
    const third = d.place(ItemId.BurnerMiningDrill, 2, 2, Direction.South);
    d.entities.insert(third, ItemId.Coal, 2);
    d.entities.insert(d.id, ItemId.Coal, 4);
    d.step(1);
    expect(d.entities.status(second)).toBe(MachineState.Depleted);
    expect(removeEntity(d.state, 0, -2, 2)).toBe(BuildResult.Ok);
    d.step(UNIT_TICKS - 1);
    expect(d.entities.slots(third)).toEqual([
      { item: ItemId.Coal, count: 1 },
      { item: ItemId.Stone, count: 1 },
    ]);
    expect(d.held()).toEqual({ item: ItemId.IronOre, count: 1 });
    expect(d.fuel()).toEqual({ item: ItemId.Coal, count: 3 });
  });

  it('shows its state, progress and fuel in the GUI detail', () => {
    const d = setup();
    d.entities.insert(d.id, ItemId.Coal, 2);
    d.step(100);
    const buf = encodeEntityDetail(d.state, 0, d.id)!;
    expect(decodeEntityDetail(buf.buffer)).toEqual({
      id: d.id,
      type: EntityTypeId.BurnerMiningDrill,
      reachable: true,
      status: MachineState.Working,
      recipe: 0,
      progress: 100,
      energy: COAL_J - 100 * DRILL_W,
      burning: ItemId.Coal,
      power: 0,
      network: 0,
      satisfaction: 0,
      slots: [
        { item: ItemId.Coal, count: 1 },
        { item: 0, count: 0 },
      ],
    });
  });

  it('hashes its state', () => {
    const a = setup();
    const b = setup();
    expect(a.sim.hash()).toBe(b.sim.hash());
    a.entities.insert(a.id, ItemId.Coal, 1);
    b.entities.insert(b.id, ItemId.Coal, 1);
    a.step(10);
    b.step(10);
    expect(a.sim.hash()).toBe(b.sim.hash());
    b.step(1);
    a.sim.state.tick++;
    expect(a.sim.hash()).not.toBe(b.sim.hash());
  });
});

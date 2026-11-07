import { describe, expect, it, vi } from 'vitest';
import { ENTITIES, EntityTypeId } from '../../src/data/entities';
import { ItemId, fuelValue } from '../../src/data/items';
import { beltTable } from '../../src/sim/belts/belts';
import { BELT_LENGTH, BeltLane } from '../../src/sim/belts/line';
import { BuildResult, placeEntity, removeEntity, rotateEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { FurnaceSlot } from '../../src/sim/entities/furnace';
import {
  INSERTER_CYCLE_TICKS,
  INSERTER_ENERGY_PER_TICK,
  INSERTER_SWING_TICKS,
  InserterSlot,
  InserterState,
  farLane,
  inserterDropTile,
  inserterPickupTile,
  inserterTable,
} from '../../src/sim/entities/inserter';
import { MachineState } from '../../src/sim/entities/machine';
import { tileCenter } from '../../src/sim/fixed';
import { decodeEntityDetail, encodeEntityDetail } from '../../src/sim/snapshot';
import { saveSim } from '../../src/sim/save/save';
import { Sim } from '../../src/sim/tick';
import { reload, stepTogether } from './saveRoundTrip';

const { North, East, South, West } = Direction;
const COAL = ItemId.Coal;
const PLATE = ItemId.IronPlate;
const ORE = ItemId.IronOre;

// Shared M1 design numbers (issue #17).
const CYCLE_TICKS = 72;
const INSERTER_W = 1_667;
const COAL_J = 4_000_000;
const PLATE_TICKS = 192;

/**
 * A sim whose player 0 stands on tile (0, 0) with plenty of everything, and
 * helpers to build around it.
 */
function setup() {
  const sim = new Sim({
    seed: 1,
    startingKit: [
      { item: ItemId.BurnerInserter, count: 10 },
      { item: ItemId.WoodenChest, count: 10 },
      { item: ItemId.StoneFurnace, count: 4 },
      { item: ItemId.BurnerMiningDrill, count: 2 },
      { item: ItemId.TransportBelt, count: 20 },
      { item: COAL, count: 50 },
    ],
  });
  const { state } = sim;
  state.players.x[0] = tileCenter(0);
  state.players.y[0] = tileCenter(0);
  const { entities } = state;
  const table = inserterTable(entities)!;
  const place = (item: number, x: number, y: number, dir: Direction = North) => {
    expect(placeEntity(state, 0, item, x, y, dir)).toBe(BuildResult.Ok);
    return entities.at(x, y);
  };
  const count = (id: number, item: number) =>
    entities.contents(id).reduce((n, s) => n + (s.item === item ? s.count : 0), 0);
  return {
    sim,
    state,
    entities,
    table,
    place,
    count,
    step: (n = 1) => {
      for (let i = 0; i < n; i++) sim.step();
    },
    /** Inserter `id`'s hand: the item it holds and the arm position. */
    hand: (id: number) => table.hand(id),
    fuel: (id: number) => entities.slots(id)[InserterSlot.Fuel]!,
  };
}

/** Chest on (2, 0) → inserter on (3, 0) facing east → chest on (4, 0). */
function chestToChest() {
  const s = setup();
  const source = s.place(ItemId.WoodenChest, 2, 0);
  const inserter = s.place(ItemId.BurnerInserter, 3, 0, East);
  const target = s.place(ItemId.WoodenChest, 4, 0);
  return { ...s, source, inserter, target };
}

describe('shared M1 numbers', () => {
  it('live in src/data', () => {
    const proto = ENTITIES[EntityTypeId.BurnerInserter];
    expect([proto.width, proto.height, proto.rotatable]).toEqual([1, 1, true]);
    expect(proto.energyPerTick).toBe(INSERTER_W);
    expect(2 * proto.swingTicks!).toBe(CYCLE_TICKS);
    expect(INSERTER_ENERGY_PER_TICK).toBe(INSERTER_W);
    expect(INSERTER_SWING_TICKS).toBe(CYCLE_TICKS / 2);
    expect(INSERTER_CYCLE_TICKS).toBe(CYCLE_TICKS);
    expect(fuelValue(COAL)).toBe(COAL_J);
  });
});

describe('inserter geometry', () => {
  it('picks up from the tile behind it and drops onto the tile in front', () => {
    expect(inserterPickupTile(5, 5, North)).toEqual({ x: 5, y: 6 });
    expect(inserterDropTile(5, 5, North)).toEqual({ x: 5, y: 4 });
    expect(inserterPickupTile(5, 5, East)).toEqual({ x: 4, y: 5 });
    expect(inserterDropTile(5, 5, East)).toEqual({ x: 6, y: 5 });
    expect(inserterPickupTile(5, 5, South)).toEqual({ x: 5, y: 4 });
    expect(inserterDropTile(5, 5, West)).toEqual({ x: 4, y: 5 });
  });

  it('drops onto the far lane of a belt, and onto the right lane in line with it', () => {
    // An east-facing belt: its left lane is the north half.
    expect(farLane(South, East)).toBe(BeltLane.Right); // from the north
    expect(farLane(North, East)).toBe(BeltLane.Left); // from the south
    expect(farLane(East, North)).toBe(BeltLane.Right); // from the west
    expect(farLane(West, North)).toBe(BeltLane.Left); // from the east
    expect(farLane(East, East)).toBe(BeltLane.Right);
    expect(farLane(West, East)).toBe(BeltLane.Right);
  });
});

describe('burner inserter', () => {
  it('takes only fuel, and lists its fuel slot and hand', () => {
    const { entities, inserter } = chestToChest();
    expect(entities.insertable(inserter, COAL)).toBe(50);
    expect(entities.insertable(inserter, PLATE)).toBe(0);
    expect(entities.insert(inserter, PLATE, 1)).toBe(0);
    expect(entities.accepts(inserter, COAL)).toBe(true);
    expect(entities.accepts(inserter, ORE)).toBe(false);
    expect(entities.outputSlot(inserter)).toBe(-1);
    expect(entities.insert(inserter, COAL, 2)).toBe(2);
    expect(entities.slots(inserter)).toEqual([
      { item: COAL, count: 2 },
      { item: 0, count: 0 },
    ]);
  });

  it('moves one item chest to chest every 72 ticks: picks up on tick 0, drops on tick 36', () => {
    const d = chestToChest();
    d.entities.insert(d.source, PLATE, 10);
    d.entities.insert(d.inserter, COAL, 1);
    const drops: number[] = [];
    const pickups: number[] = [];
    let before = d.count(d.target, PLATE);
    let left = d.count(d.source, PLATE);
    for (let tick = 0; tick < 5 * CYCLE_TICKS; tick++) {
      d.step();
      if (d.count(d.target, PLATE) !== before) drops.push(tick);
      if (d.count(d.source, PLATE) !== left) pickups.push(tick);
      before = d.count(d.target, PLATE);
      left = d.count(d.source, PLATE);
    }
    expect(pickups).toEqual([0, 72, 144, 216, 288]);
    expect(drops).toEqual([36, 108, 180, 252, 324]);
    // Five whole cycles: the arm is back at the source, ready for the next pickup.
    expect(d.entities.status(d.inserter)).toBe(InserterState.Swinging);
    expect(d.hand(d.inserter)).toEqual({ held: 0, arm: 0 });
  });

  it('burns 1 667 J on every tick its arm moves: one coal runs 2 399 ticks with 867 J left', () => {
    const d = chestToChest();
    d.entities.insert(d.source, PLATE, 100);
    d.entities.insert(d.inserter, COAL, 1);
    d.step(CYCLE_TICKS);
    // One full cycle: 72 ticks of moving.
    expect(d.entities.detail(d.inserter)!.energy).toBe(COAL_J - CYCLE_TICKS * INSERTER_W);
    expect(d.count(d.target, PLATE)).toBe(1);
    const moving = Math.floor(COAL_J / INSERTER_W);
    expect(moving).toBe(2_399);
    d.step(moving - CYCLE_TICKS);
    expect(d.entities.status(d.inserter)).toBe(InserterState.Swinging);
    d.step(1);
    expect(d.entities.status(d.inserter)).toBe(InserterState.NoFuel);
    expect(d.entities.detail(d.inserter)!.energy).toBe(COAL_J - moving * INSERTER_W);
    expect(d.entities.detail(d.inserter)!.energy).toBe(867);
    // 33 full cycles (2 376 ticks), then 23 ticks out with the 34th plate.
    expect(d.count(d.target, PLATE)).toBe(33);
    expect(d.hand(d.inserter)).toEqual({ held: PLATE, arm: 23 });
    expect(d.count(d.source, PLATE)).toBe(100 - 34);
    // It stops where it is and sleeps until it gets fuel.
    d.step(100);
    expect(d.table.activeCount).toBe(0);
    expect(d.hand(d.inserter)).toEqual({ held: PLATE, arm: 23 });
    d.entities.insert(d.inserter, COAL, 1);
    expect(d.table.activeCount).toBe(1);
    d.step(INSERTER_SWING_TICKS - 23 + 1);
    expect(d.count(d.target, PLATE)).toBe(34);
  });

  it('sleeps on an empty chest at no cost per tick, and wakes when the chest gets an item', () => {
    const d = chestToChest();
    d.entities.insert(d.inserter, COAL, 1);
    d.step();
    expect(d.entities.status(d.inserter)).toBe(InserterState.WaitingForSource);
    expect(d.entities.wake.watchersOf(d.source)).toEqual([d.inserter]);
    expect(d.table.activeCount).toBe(0);
    // No energy is burnt and the inserter isn't stepped at all while it waits.
    const step = vi.spyOn(d.table as unknown as { step: () => unknown }, 'step');
    const hash = d.table.hashInto(0);
    d.step(1_000);
    expect(step).not.toHaveBeenCalled();
    expect(d.table.hashInto(0)).toBe(hash);
    expect(d.fuel(d.inserter)).toEqual({ item: COAL, count: 1 });
    // A plate in the chest wakes it; it picks the plate up on the next tick.
    d.entities.insert(d.source, PLATE, 1);
    expect(d.table.activeCount).toBe(1);
    d.step();
    expect(step).toHaveBeenCalledTimes(1);
    expect(d.hand(d.inserter)).toEqual({ held: PLATE, arm: 1 });
    expect(d.entities.wake.watchersOf(d.source)).toEqual([]);
    d.step(INSERTER_SWING_TICKS);
    expect(d.count(d.target, PLATE)).toBe(1);
    step.mockRestore();
  });

  it('waits without picking up while nothing is on its drop tile, and starts once a target is placed', () => {
    const s = setup();
    const source = s.place(ItemId.WoodenChest, 2, 0);
    const inserter = s.place(ItemId.BurnerInserter, 3, 0, East);
    s.entities.insert(source, PLATE, 5);
    s.entities.insert(inserter, COAL, 1);
    s.step(10);
    expect(s.entities.status(inserter)).toBe(InserterState.WaitingForTarget);
    expect(s.count(source, PLATE)).toBe(5);
    expect(s.table.activeCount).toBe(0);
    // Placing something next to it but not on its drop tile doesn't wake it.
    s.place(ItemId.WoodenChest, 3, 1);
    expect(s.table.activeCount).toBe(0);
    const target = s.place(ItemId.WoodenChest, 4, 0);
    expect(s.table.activeCount).toBe(1);
    s.step(INSERTER_SWING_TICKS + 1);
    expect(s.count(target, PLATE)).toBe(1);
  });

  it('does not pick up for a target with no room, and picks up once the target has room', () => {
    const d = chestToChest();
    d.entities.insert(d.inserter, COAL, 1);
    // Fill every slot of the target with stone; plates go in the source.
    for (let i = 0; i < 16; i++) d.entities.insert(d.target, ItemId.Stone, 50);
    d.entities.insert(d.source, PLATE, 2);
    d.step(5);
    expect(d.entities.status(d.inserter)).toBe(InserterState.WaitingForTarget);
    expect(d.hand(d.inserter)).toEqual({ held: 0, arm: 0 });
    expect(d.count(d.source, PLATE)).toBe(2);
    // Asleep on both: the target making room, or the source offering something else.
    expect(d.entities.wake.watchersOf(d.source)).toEqual([d.inserter]);
    expect(d.entities.wake.watchersOf(d.target)).toEqual([d.inserter]);
    expect(d.table.activeCount).toBe(0);
    // More plates in the source change nothing.
    d.entities.insert(d.source, PLATE, 1);
    d.step(3);
    expect(d.entities.status(d.inserter)).toBe(InserterState.WaitingForTarget);
    expect(d.table.activeCount).toBe(0);
    // Room in the target wakes it and it picks up right away.
    expect(d.entities.take(d.target, 3, 50)).toBe(50);
    d.step();
    expect(d.hand(d.inserter)).toEqual({ held: PLATE, arm: 1 });
    expect(d.entities.wake.watchersOf(d.source)).toEqual([]);
    expect(d.entities.wake.watchersOf(d.target)).toEqual([]);
  });

  it('keeps waiting on a full target and its source the same way after a save and load', () => {
    // Inserter `a` (3, 0) waits on its source chest (2, 0) and its full target
    // chest (4, 0). Unfuelled inserters on (5, 0) and (4, 1) take from the
    // target, so they wait on it too: one subscribed before `a`, one after.
    // Loading rebuilds `a`'s subscriptions target first; it must not take
    // that for a change and subscribe again (reordering the target's watchers).
    const s = setup();
    const source = s.place(ItemId.WoodenChest, 2, 0);
    const target = s.place(ItemId.WoodenChest, 4, 0);
    s.place(ItemId.WoodenChest, 6, 0);
    const before = s.place(ItemId.BurnerInserter, 5, 0, East);
    for (let i = 0; i < 16; i++) s.entities.insert(target, ItemId.Stone, 50);
    s.step();
    const a = s.place(ItemId.BurnerInserter, 3, 0, East);
    s.entities.insert(a, COAL, 1);
    s.entities.insert(source, PLATE, 2);
    s.step();
    expect(s.entities.status(a)).toBe(InserterState.WaitingForTarget);
    const after = s.place(ItemId.BurnerInserter, 4, 1, South);
    s.step();
    expect(s.entities.wake.watchersOf(target)).toEqual([before, a, after]);
    const copy = reload(s.sim);
    // More plates wake `a`, which still has nowhere to put them.
    s.entities.insert(source, PLATE, 1);
    copy.state.entities.insert(source, PLATE, 1);
    stepTogether(s.sim, copy, 3);
    expect(copy.state.entities.wake.watchersOf(target)).toEqual([before, a, after]);
    expect(Buffer.from(saveSim(copy)).equals(Buffer.from(saveSim(s.sim)))).toBe(true);
  });

  it('holds its item at a target filled while it swings, and drops it once the target has room', () => {
    const d = chestToChest();
    d.entities.insert(d.inserter, COAL, 1);
    d.entities.insert(d.source, PLATE, 1);
    d.step();
    expect(d.hand(d.inserter).held).toBe(PLATE);
    // The target fills up on the way: every slot gets stone.
    for (let i = 0; i < 16; i++) d.entities.insert(d.target, ItemId.Stone, 50);
    d.step(INSERTER_SWING_TICKS + 4);
    expect(d.entities.status(d.inserter)).toBe(InserterState.WaitingForTarget);
    expect(d.hand(d.inserter)).toEqual({ held: PLATE, arm: INSERTER_SWING_TICKS });
    expect(d.entities.wake.watchersOf(d.target)).toEqual([d.inserter]);
    expect(d.table.activeCount).toBe(0);
    // Room in the target wakes it and it drops right away.
    expect(d.entities.take(d.target, 3, 50)).toBe(50);
    d.step();
    expect(d.count(d.target, PLATE)).toBe(1);
    expect(d.hand(d.inserter)).toEqual({ held: 0, arm: INSERTER_SWING_TICKS - 1 });
    expect(d.entities.wake.watchersOf(d.target)).toEqual([]);
  });

  it('stops waiting on a full target once its hand is emptied through the GUI', () => {
    const d = chestToChest();
    d.entities.insert(d.inserter, COAL, 1);
    d.entities.insert(d.source, PLATE, 2);
    d.step();
    for (let i = 0; i < 16; i++) d.entities.insert(d.target, ItemId.Stone, 50);
    d.step(INSERTER_SWING_TICKS);
    expect(d.entities.wake.watchersOf(d.target)).toEqual([d.inserter]);
    expect(d.entities.take(d.inserter, InserterSlot.Hand, 1)).toBe(1);
    expect(d.entities.wake.watchersOf(d.target)).toEqual([]);
    expect(d.entities.take(d.target, 3, 50)).toBe(50);
    d.step(INSERTER_SWING_TICKS + 1);
    expect(d.hand(d.inserter)).toEqual({ held: PLATE, arm: 1 });
  });

  it('refuels itself with one coal from its source when its fuel slot is empty', () => {
    const d = chestToChest();
    d.entities.insert(d.source, COAL, 5);
    // No fuel at all: the first coal goes into its own fuel slot (no energy
    // needed with the hand at the source), the second into the hand.
    d.step();
    expect(d.count(d.source, COAL)).toBe(3);
    expect(d.hand(d.inserter)).toEqual({ held: COAL, arm: 1 });
    // The coal in the slot was burnt into the buffer for the first tick.
    expect(d.fuel(d.inserter)).toEqual({ item: 0, count: 0 });
    expect(d.entities.detail(d.inserter)!.energy).toBe(COAL_J - INSERTER_W);
    d.step(CYCLE_TICKS - 1);
    expect(d.count(d.target, COAL)).toBe(1);
    // Back at the source with an empty fuel slot: another coal for itself.
    d.step();
    expect(d.count(d.source, COAL)).toBe(1);
    expect(d.fuel(d.inserter)).toEqual({ item: COAL, count: 1 });
    expect(d.hand(d.inserter).held).toBe(COAL);
  });

  it('without fuel waits on its source, and refuels as soon as coal arrives there', () => {
    const d = chestToChest();
    d.entities.insert(d.source, PLATE, 3);
    d.step(5);
    expect(d.entities.status(d.inserter)).toBe(InserterState.NoFuel);
    expect(d.count(d.source, PLATE)).toBe(3);
    expect(d.entities.wake.watchersOf(d.source)).toEqual([d.inserter]);
    expect(d.table.activeCount).toBe(0);
    d.entities.insert(d.source, COAL, 1);
    d.step();
    expect(d.entities.status(d.inserter)).toBe(InserterState.Swinging);
    expect(d.count(d.source, COAL)).toBe(0);
    expect(d.hand(d.inserter).held).toBe(PLATE);
  });

  it('only picks up what its target accepts: fuel for a drill', () => {
    const s = setup();
    const source = s.place(ItemId.WoodenChest, 2, 0);
    const inserter = s.place(ItemId.BurnerInserter, 3, 0, East);
    const drill = s.place(ItemId.BurnerMiningDrill, 4, 0, East);
    s.entities.insert(inserter, COAL, 1);
    // Ore in the first slot, coal in the second.
    s.entities.insert(source, ORE, 5);
    s.step();
    expect(s.entities.status(inserter)).toBe(InserterState.WaitingForSource);
    expect(s.count(source, ORE)).toBe(5);
    s.entities.insert(source, COAL, 2);
    s.step(INSERTER_SWING_TICKS + 1);
    expect(s.entities.slots(drill)[0]).toEqual({ item: COAL, count: 1 });
    expect(s.count(source, ORE)).toBe(5);
    expect(s.count(source, COAL)).toBe(1);
  });

  it('feeds a furnace with a full fuel slot the ore behind the coal, and coal once it has room', () => {
    const s = setup();
    const source = s.place(ItemId.WoodenChest, 2, 0);
    const inserter = s.place(ItemId.BurnerInserter, 3, 0, East);
    const furnace = s.place(ItemId.StoneFurnace, 4, 0);
    s.entities.insert(inserter, COAL, 5);
    s.entities.insert(furnace, COAL, 50);
    // Coal in the first slot, ore in the second: the fuel slot has no room for coal.
    s.entities.insert(source, COAL, 10);
    s.entities.insert(source, ORE, 2);
    s.step();
    expect(s.hand(inserter)).toEqual({ held: ORE, arm: 1 });
    expect(s.count(source, COAL)).toBe(10);
    // Smelting it burns a coal out of the slot, so the next pickup tops the slot
    // up, the one after takes the second ore.
    s.step(4 * INSERTER_CYCLE_TICKS);
    expect(s.count(source, ORE)).toBe(0);
    expect(s.count(source, COAL)).toBe(9);
    expect(s.entities.slots(furnace)[FurnaceSlot.Fuel]).toEqual({ item: COAL, count: 50 });
    // No ore left and no room for coal: it waits on the furnace and its source.
    expect(s.entities.status(inserter)).toBe(InserterState.WaitingForTarget);
    expect(s.hand(inserter).held).toBe(0);
    expect(s.entities.wake.watchersOf(furnace)).toEqual([inserter]);
    expect(s.entities.wake.watchersOf(source)).toEqual([inserter]);
  });

  it('keeps feeding a furnace from a backed-up belt with coal on one lane and ore on the other', () => {
    const s = setup();
    // A belt from (-5, 2) east to (2, 2), where it ends; the inserter on
    // (2, 3) faces south into a furnace on (2..3, 4..5) whose fuel slot is
    // full. Coal goes onto the left lane, ore onto the right lane.
    const belts: number[] = [];
    for (let x = -5; x <= 2; x++) belts.push(s.place(ItemId.TransportBelt, x, 2, East));
    const inserter = s.place(ItemId.BurnerInserter, 2, 3, South);
    const furnace = s.place(ItemId.StoneFurnace, 2, 4);
    s.entities.insert(inserter, COAL, 5);
    s.entities.insert(furnace, COAL, 50);
    const table = beltTable(s.entities)!;
    const first = belts[0]!;
    const pos = table.beltOffset(first) + BELT_LENGTH / 2;
    for (let t = 0; t < 30 * PLATE_TICKS; t++) {
      const line = table.beltLine(first);
      table.insertAt(line, BeltLane.Left, pos, COAL);
      table.insertAt(line, BeltLane.Right, pos, ORE);
      s.step();
    }
    // The furnace smelts all the time: it never waits for ore behind the coal.
    expect(s.count(furnace, PLATE)).toBeGreaterThanOrEqual(28);
  });

  it('picks up from either belt lane on its tile, and feeds a furnace that smelts it', () => {
    const s = setup();
    // A belt on (2, 2) running east; the inserter on (2, 3) south of it,
    // facing south into a furnace on (2..3, 4..5).
    const belt = s.place(ItemId.TransportBelt, 2, 2, East);
    const inserter = s.place(ItemId.BurnerInserter, 2, 3, South);
    const furnace = s.place(ItemId.StoneFurnace, 2, 4);
    s.entities.insert(inserter, COAL, 1);
    s.entities.insert(furnace, COAL, 1);
    // One ore on each lane, at the middle of the belt.
    expect(s.entities.insert(belt, ORE, 2)).toBe(2);
    s.step();
    expect(s.hand(inserter)).toEqual({ held: ORE, arm: 1 });
    s.step(INSERTER_CYCLE_TICKS);
    expect(beltTable(s.entities)!.itemsOn(belt)).toEqual([]);
    // The first ore went in on tick 36 and is smelting; the second is on its way.
    expect(s.entities.detail(furnace)!.recipe).not.toBe(0);
    expect(s.hand(inserter)).toEqual({ held: ORE, arm: 1 });
    // Both ores went into the furnace: one is smelting, the other waits.
    s.step(2 * PLATE_TICKS);
    expect(s.entities.slots(furnace)[FurnaceSlot.Output]).toEqual({ item: PLATE, count: 2 });
    expect(s.entities.status(inserter)).toBe(InserterState.WaitingForSource);
    expect(s.entities.wake.watchersOf(belt)).toEqual([inserter]);
  });

  it('reaches past an item on its tile its target does not take for one it does', () => {
    const s = setup();
    // A belt on (2, 2) running east, an inserter on (2, 3) facing south into
    // a burner drill on (2..3, 4..5): ore at the front of the left lane, coal behind it.
    const belt = s.place(ItemId.TransportBelt, 2, 2, East);
    const inserter = s.place(ItemId.BurnerInserter, 2, 3, South);
    s.place(ItemId.BurnerMiningDrill, 2, 4, South);
    s.entities.insert(inserter, COAL, 1);
    const belts = beltTable(s.entities)!;
    const line = belts.beltLine(belt);
    expect(belts.insertAt(line, BeltLane.Left, 0, ORE)).toBe(true);
    expect(belts.insertAt(line, BeltLane.Left, 150, COAL)).toBe(true);
    s.step();
    expect(s.hand(inserter)).toEqual({ held: COAL, arm: 1 });
    expect(belts.itemsOn(belt)).toMatchObject([{ lane: BeltLane.Left, offset: 0, item: ORE }]);
  });

  it('picks up an item at the very start of a line (pos == line.length)', () => {
    const s = setup();
    // Two belts running east on (2..3, 2); the inserter south of the first
    // one, the line's start, facing south into a chest.
    const start = s.place(ItemId.TransportBelt, 2, 2, East);
    s.place(ItemId.TransportBelt, 3, 2, East);
    const inserter = s.place(ItemId.BurnerInserter, 2, 3, South);
    const chest = s.place(ItemId.WoodenChest, 2, 4);
    s.entities.insert(inserter, COAL, 1);
    s.step();
    expect(s.entities.status(inserter)).toBe(InserterState.WaitingForSource);
    const belts = beltTable(s.entities)!;
    const line = belts.line(belts.beltLine(start))!;
    expect(belts.beltOffset(start)).toBe(BELT_LENGTH);
    expect(belts.beltEnd(start)).toBeGreaterThanOrEqual(line.length);
    expect(belts.beltEnd(s.entities.at(3, 2))).toBe(BELT_LENGTH - 1);
    // An item put exactly on the start edge, where a loop hands items on to its
    // own start: the inserter's next step (before the belt moves it) takes it.
    expect(belts.insertAt(line.id, BeltLane.Left, line.length, ORE)).toBe(true);
    expect(belts.itemsOn(start)).toEqual([
      { lane: BeltLane.Left, offset: BELT_LENGTH, moved: 0, item: ORE },
    ]);
    s.table.update(s.entities);
    expect(s.hand(inserter)).toEqual({ held: ORE, arm: 1 });
    s.step(INSERTER_SWING_TICKS);
    expect(s.count(chest, ORE)).toBe(1);
  });

  it('takes plates out of a furnace into a chest as they are made', () => {
    const s = setup();
    const furnace = s.place(ItemId.StoneFurnace, 2, 1);
    // The inserter east of the furnace, facing east into a chest.
    const inserter = s.place(ItemId.BurnerInserter, 4, 1, East);
    const chest = s.place(ItemId.WoodenChest, 5, 1);
    s.entities.insert(inserter, COAL, 1);
    s.entities.insert(furnace, COAL, 1);
    s.entities.insert(furnace, ORE, 3);
    s.step(PLATE_TICKS);
    // Nothing in the output yet: it waits on the furnace.
    expect(s.entities.status(inserter)).toBe(InserterState.WaitingForSource);
    expect(s.entities.wake.watchersOf(furnace)).toEqual([inserter]);
    s.step(3 * PLATE_TICKS + INSERTER_CYCLE_TICKS);
    expect(s.count(chest, PLATE)).toBe(3);
    expect(s.entities.slots(furnace)[FurnaceSlot.Output]!.count).toBe(0);
  });

  it('drops onto the middle of the far lane of a belt, else anywhere on its tile, and waits while there is no room', () => {
    const s = setup();
    const chest = s.place(ItemId.WoodenChest, 2, 1);
    // The inserter north of a single east-facing belt, so its far lane is the right one.
    const inserter = s.place(ItemId.BurnerInserter, 2, 2, South);
    const belt = s.place(ItemId.TransportBelt, 2, 3, East);
    const belts = beltTable(s.entities)!;
    s.entities.insert(inserter, COAL, 5);
    s.entities.insert(chest, PLATE, 10);
    s.step(INSERTER_SWING_TICKS + 1);
    expect(belts.itemsOn(belt)).toEqual([
      { lane: BeltLane.Right, offset: BELT_LENGTH / 2, moved: 0, item: PLATE },
    ]);
    // Items stop at the end of the belt; once the middle is taken the
    // inserter drops behind it too, so the tile fills: four at the spacing.
    s.step(10 * INSERTER_CYCLE_TICKS);
    expect(belts.itemsOn(belt).filter((i) => i.lane === BeltLane.Right)).toEqual(
      [0, 1, 2, 3].map((k) => ({ lane: BeltLane.Right, offset: 64 * k, moved: 0, item: PLATE })),
    );
    expect(belts.itemsOn(belt).filter((i) => i.lane === BeltLane.Left)).toHaveLength(0);
    expect(s.entities.status(inserter)).toBe(InserterState.WaitingForTarget);
    expect(s.entities.wake.watchersOf(belt)).toEqual([inserter]);
    expect(s.table.activeCount).toBe(0);
    // Taking the front item lets the lane close up; the inserter drops again
    // into the slot that opens at the back of the tile.
    const line = belts.beltLine(belt);
    expect(belts.takeAt(line, BeltLane.Right, 0, 0)).toBe(PLATE);
    s.step(BELT_LENGTH / 4);
    expect(belts.itemsOn(belt).filter((i) => i.lane === BeltLane.Right)).toHaveLength(4);
    expect(s.entities.status(inserter)).toBe(InserterState.Swinging);
  });

  it('is not woken by items moving on a part of the line far from its tile', () => {
    const s = setup();
    // A line of 8 belts running east along y = 2 from x = -3 to 4; the
    // inserter picks up from its last belt (4, 2), which ends the line.
    for (let x = -3; x <= 4; x++) s.place(ItemId.TransportBelt, x, 2, East);
    const end = s.entities.at(4, 2);
    const inserter = s.place(ItemId.BurnerInserter, 4, 3, South);
    const chest = s.place(ItemId.WoodenChest, 4, 4);
    s.entities.insert(inserter, COAL, 1);
    s.step();
    expect(s.entities.status(inserter)).toBe(InserterState.WaitingForSource);
    // One plate at the start of the line, 7 tiles away from the end belt.
    const first = s.entities.at(-3, 2);
    s.entities.insert(first, PLATE, 1);
    const step = vi.spyOn(s.table as unknown as { step: () => unknown }, 'step');
    // It runs 8 subtiles a tick; it is within reach of the end belt's tile
    // once it is 256 + 64 from the end.
    const start = 7 * BELT_LENGTH + BELT_LENGTH / 2;
    const far = (start - (BELT_LENGTH + 64)) / 8;
    s.step(far - 1);
    expect(step).not.toHaveBeenCalled();
    s.step(1);
    expect(step).toHaveBeenCalled();
    // Woken while it comes near, it picks the plate up once it is on the end belt.
    s.step(BELT_LENGTH / 8 + INSERTER_CYCLE_TICKS);
    expect(s.count(chest, PLATE)).toBe(1);
    expect(beltTable(s.entities)!.itemsOn(end)).toEqual([]);
    step.mockRestore();
  });

  it('relinks when a belt next to it rotates, and swaps pickup and drop when rotated twice', () => {
    const d = chestToChest();
    d.entities.insert(d.inserter, COAL, 5);
    d.entities.insert(d.target, PLATE, 1);
    d.step();
    expect(d.entities.status(d.inserter)).toBe(InserterState.WaitingForSource);
    // Two quarter turns: it now takes from (4, 0) and drops onto (2, 0).
    expect(rotateEntity(d.state, 0, 3, 0)).toBe(BuildResult.Ok);
    expect(d.table.activeCount).toBe(1);
    expect(rotateEntity(d.state, 0, 3, 0)).toBe(BuildResult.Ok);
    expect(d.entities.store.dir(d.inserter)).toBe(West);
    d.step(INSERTER_SWING_TICKS + 1);
    expect(d.count(d.source, PLATE)).toBe(1);
    expect(d.count(d.target, PLATE)).toBe(0);

    // A belt on its drop tile turned around has its far lane on the other side.
    const s = setup();
    const chest = s.place(ItemId.WoodenChest, 2, 1);
    const inserter = s.place(ItemId.BurnerInserter, 2, 2, South);
    const belt = s.place(ItemId.TransportBelt, 2, 3, East);
    s.entities.insert(inserter, COAL, 1);
    s.entities.insert(chest, PLATE, 2);
    s.step(INSERTER_SWING_TICKS + 1);
    expect(
      beltTable(s.entities)!
        .itemsOn(belt)
        .map((i) => i.lane),
    ).toEqual([BeltLane.Right]);
    rotateEntity(s.state, 0, 2, 3);
    rotateEntity(s.state, 0, 2, 3);
    expect(s.entities.store.dir(belt)).toBe(West);
    s.step(INSERTER_CYCLE_TICKS);
    // Facing west, the belt's left lane is its south half: the far one now.
    expect(
      beltTable(s.entities)!
        .itemsOn(belt)
        .map((i) => i.lane)
        .sort(),
    ).toEqual([BeltLane.Left, BeltLane.Right]);
  });

  it('wakes when the entity it waits on is removed, and refunds its fuel and hand when removed', () => {
    const d = chestToChest();
    d.entities.insert(d.inserter, COAL, 3);
    for (let i = 0; i < 16; i++) d.entities.insert(d.target, ItemId.Stone, 50);
    d.entities.insert(d.source, PLATE, 1);
    d.step(INSERTER_SWING_TICKS + 1);
    expect(d.entities.status(d.inserter)).toBe(InserterState.WaitingForTarget);
    // Removing the full chest would need room for 800 stone: take it out first.
    for (let i = 0; i < 16; i++) d.entities.take(d.target, i, 50);
    d.step(INSERTER_CYCLE_TICKS);
    d.entities.insert(d.source, PLATE, 1);
    d.step(INSERTER_SWING_TICKS - 5);
    expect(d.hand(d.inserter).held).toBe(PLATE);
    const inv = d.state.players.inventory(0);
    const coal = inv.count(COAL);
    const plates = inv.count(PLATE);
    expect(removeEntity(d.state, 0, 3, 0)).toBe(BuildResult.Ok);
    expect(inv.count(COAL)).toBe(coal + 2);
    expect(inv.count(PLATE)).toBe(plates + 1);
    expect(d.table.count).toBe(0);
  });

  it('keeps rows straight when an inserter in the middle is removed', () => {
    const s = setup();
    const a = s.place(ItemId.BurnerInserter, 2, 0, East);
    const b = s.place(ItemId.BurnerInserter, 2, 2, East);
    const c = s.place(ItemId.BurnerInserter, 2, 4, East);
    s.entities.insert(a, COAL, 1);
    s.entities.insert(b, COAL, 2);
    s.entities.insert(c, COAL, 3);
    expect(removeEntity(s.state, 0, 2, 0)).toBe(BuildResult.Ok);
    expect(s.fuel(b)).toEqual({ item: COAL, count: 2 });
    expect(s.fuel(c)).toEqual({ item: COAL, count: 3 });
  });

  it('shows its state, arm position and fuel in the GUI detail, and lets the hand be emptied', () => {
    const d = chestToChest();
    d.entities.insert(d.source, PLATE, 3);
    d.entities.insert(d.inserter, COAL, 2);
    d.step(10);
    const detail = decodeEntityDetail(encodeEntityDetail(d.state, 0, d.inserter)!.buffer);
    expect(detail).toMatchObject({
      type: EntityTypeId.BurnerInserter,
      reachable: true,
      status: MachineState.Working,
      progress: 10,
      energy: COAL_J - 10 * INSERTER_W,
      burning: COAL,
      slots: [
        { item: COAL, count: 1 },
        { item: PLATE, count: 1 },
      ],
    });
    // Taking the plate out of the hand sends the arm back for another one.
    expect(d.entities.take(d.inserter, InserterSlot.Hand, 1)).toBe(1);
    d.step();
    expect(d.hand(d.inserter)).toEqual({ held: 0, arm: 9 });
  });

  it('hashes its state', () => {
    const run = (extra: boolean) => {
      const d = chestToChest();
      d.entities.insert(d.source, PLATE, 3);
      d.entities.insert(d.inserter, COAL, 1);
      d.step(20);
      if (extra) d.entities.take(d.inserter, InserterSlot.Hand, 1);
      return d.sim.hash();
    };
    expect(run(false)).toBe(run(false));
    expect(run(true)).not.toBe(run(false));
  });
});

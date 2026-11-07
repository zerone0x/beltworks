import { describe, expect, it } from 'vitest';
import { EntityTypeId } from '../../src/data/entities';
import { ItemId, MINED_ITEM } from '../../src/data/items';
import { RecipeId } from '../../src/data/recipes';
import { TREE_WOOD } from '../../src/data/trees';
import { BeltShape, beltTable } from '../../src/sim/belts/belts';
import { BeltLane } from '../../src/sim/belts/line';
import { UndergroundMode } from '../../src/sim/belts/underground';
import { CRAFT_QUEUE_LENGTH } from '../../src/sim/crafting/queue';
import { Direction } from '../../src/sim/entities/direction';
import { assemblerTable } from '../../src/sim/entities/assembler';
import { DrillSlot } from '../../src/sim/entities/drill';
import { FurnaceSlot } from '../../src/sim/entities/furnace';
import { InserterSlot, InserterState, inserterTable } from '../../src/sim/entities/inserter';
import { MachineState } from '../../src/sim/entities/machine';
import {
  DETERMINISM_ASSEMBLER,
  DETERMINISM_ASSEMBLER_TICK,
  DETERMINISM_BELTS,
  DETERMINISM_BOILER,
  DETERMINISM_BUILD_TICKS,
  DETERMINISM_CHAIN,
  DETERMINISM_CHAIN_CHEST,
  DETERMINISM_CHAIN_DRILL,
  DETERMINISM_CHAIN_FURNACE,
  DETERMINISM_CHAIN_PICK,
  DETERMINISM_CHAIN_PUT,
  DETERMINISM_CHAIN_TICK,
  DETERMINISM_DRILL_CHEST,
  DETERMINISM_ENGINE_EAST,
  DETERMINISM_ENGINE_WEST,
  DETERMINISM_KIT,
  DETERMINISM_LOGISTICS_FAST,
  DETERMINISM_LOGISTICS_LONG,
  DETERMINISM_LOGISTICS_MIDDLE,
  DETERMINISM_LOGISTICS_SOURCE,
  DETERMINISM_LOGISTICS_TARGET,
  DETERMINISM_LOGISTICS_TICK,
  DETERMINISM_PATCH_CHEST,
  DETERMINISM_PATCH_FURNACE,
  DETERMINISM_PATCH_DRILL,
  DETERMINISM_PLAYERS,
  DETERMINISM_POLES_TICK,
  DETERMINISM_POLE_BRIDGE,
  DETERMINISM_POLE_EAST,
  DETERMINISM_POLE_LONE,
  DETERMINISM_ELECTRIC_CHEST,
  DETERMINISM_ELECTRIC_DRILL,
  DETERMINISM_ELECTRIC_INSERTER,
  DETERMINISM_ELECTRIC_POLE,
  DETERMINISM_TIER_BELT,
  DETERMINISM_TIER_ENTRANCE,
  DETERMINISM_TIER_EXIT,
  DETERMINISM_TIER_FAST,
  DETERMINISM_TIER_ROW,
  DETERMINISM_TIER_TICK,
  DETERMINISM_ELECTRIC_TICK,
  DETERMINISM_POLE_REBRIDGE,
  DETERMINISM_POLE_SOUTH,
  DETERMINISM_POLE_WEST,
  DETERMINISM_SCRIPTED_TICKS,
  DETERMINISM_SEED,
  DETERMINISM_SPAWN_CHEST,
  DETERMINISM_SPAWN_INSERTER,
  DETERMINISM_STEAM_INSERTER,
  DETERMINISM_STEAM_TICK,
  DETERMINISM_TICKS,
  DETERMINISM_TREE_CHESTS,
  buildDeterminismScript,
  createDeterminismSim,
  runDeterminismScenario,
  nearestTree,
  DETERMINISM_LAB_A,
  DETERMINISM_LAB_B,
  DETERMINISM_RESEARCH_TICK,
} from '../../src/sim/scenarios/determinism';
import { labTable } from '../../src/sim/research/lab';
import { isRecipeUnlocked } from '../../src/sim/research/unlocks';
import { TechId } from '../../src/data/technologies';
import { Sim } from '../../src/sim/tick';
import { BoilerSlot, boilerTable } from '../../src/sim/power/boiler';
import { powerGrid } from '../../src/sim/power/grid';
import { steamEngineTable } from '../../src/sim/power/steamEngine';
import { startingPatches } from '../../src/sim/world/generate';
import { DETERMINISM_EXPECTED_HASH } from './determinism.expected';

const hex = (h: number): string => `0x${h.toString(16).padStart(8, '0')}`;

/**
 * The M1 chain on player 2's stone patch. Fuelled on tick 912, the drill
 * drops a stone on the middle of the first belt on ticks 1151 and 1391; the
 * second is on the inserter's belt 49 ticks later, in the furnace 36 ticks
 * after that (1476), a brick 192 ticks later (1668), and in the chest after
 * one more swing (1704). Then a brick every 480 ticks (two stones).
 */
const CHAIN_FIRST_BRICK_TICK = 1_704;
const CHAIN_CHECK_TICK = 4_000;
/** Bricks in the chest by `CHAIN_CHECK_TICK`: 1704, 2184, 2664, 3144, 3624. */
const CHAIN_BRICKS = 5;

/** Kit plates player 0 has left once its crafts are done (checked in the crafting test). */
const KIT_PLATES_LEFT_0 = 4;

/** Runs the scenario, recording the hash every `every` ticks. */
function hashTrace(every: number): number[] {
  const sim = createDeterminismSim();
  for (const cmd of buildDeterminismScript()) {
    sim.enqueue(cmd);
  }
  const trace: number[] = [];
  for (let i = 0; i < DETERMINISM_TICKS; i++) {
    sim.step();
    if (sim.tick % every === 0) {
      trace.push(sim.hash());
    }
  }
  return trace;
}

describe('determinism', () => {
  it('produces the same hash when run twice', () => {
    const a = runDeterminismScenario();
    const b = runDeterminismScenario();
    expect(a.tick).toBe(DETERMINISM_TICKS);
    expect(a.commands).toBeGreaterThan(1000);
    expect(hex(b.hash)).toBe(hex(a.hash));
  });

  it('walks every player to an ore patch and mines it', () => {
    const script = buildDeterminismScript();
    const scripted = script.filter((c) => c.tick < DETERMINISM_SCRIPTED_TICKS);
    // The scripted phase fits in its window (nothing got cut off).
    expect(scripted.some((c) => c.type === 'MineStop' && c.playerId === 1)).toBe(true);

    const sim = createDeterminismSim();
    script.forEach((c) => sim.enqueue(c));
    for (let i = 0; i < DETERMINISM_SCRIPTED_TICKS; i++) {
      sim.step();
    }
    const patches = startingPatches(DETERMINISM_SEED);
    for (let id = 0; id < DETERMINISM_PLAYERS; id++) {
      const inv = sim.state.players.inventory(id);
      const item = MINED_ITEM[patches[id]!.ore];
      const kit = DETERMINISM_KIT.find((s) => s.item === item)?.count ?? 0;
      let mined = inv.count(item) - kit;
      if (id === 0) {
        // Player 0's iron went into its furnace: count the ore still there,
        // the one being smelted, and every plate made from the others. The
        // chest and the inventory also hold the kit plates crafting left.
        const { entities } = sim.state;
        const furnace = DETERMINISM_PATCH_FURNACE;
        const plates =
          entities.slots(furnace)[FurnaceSlot.Output]!.count +
          entities.contents(DETERMINISM_PATCH_CHEST)[0]!.count +
          inv.count(ItemId.IronPlate) -
          KIT_PLATES_LEFT_0;
        const smelting = entities.detail(furnace)!.recipe !== 0 ? 1 : 0;
        mined += entities.slots(furnace)[FurnaceSlot.Input]!.count + smelting + plates;
      }
      if (id === 1) {
        // Player 1 mines coal and fuels its boiler with two, which has burnt
        // one of them for the electric inserter's drain, and puts four into
        // its logistics rig.
        expect(item).toBe(ItemId.Coal);
        mined += sim.state.entities.slots(DETERMINISM_BOILER)[BoilerSlot.Fuel]!.count + 1 + 4;
      }
      // 300 + 150 ticks of mining at 30 ticks per unit, on top of the starting kit.
      expect(mined).toBe(15);
    }
    // The mined patches show up in the world hash.
    expect(sim.state.world.chunkVersion(0, 0)).toBeGreaterThan(0);
    expect(runDeterminismScenario().itemsMined).toBeGreaterThanOrEqual(45);
  });

  it('builds at the spawn: places, rotates and removes, and ignores invalid commands', () => {
    const sim = createDeterminismSim();
    buildDeterminismScript().forEach((c) => sim.enqueue(c));
    for (let i = 0; i < DETERMINISM_BUILD_TICKS; i++) {
      sim.step();
    }
    const { entities } = sim.state;
    const at = (x: number, y: number) => {
      const id = entities.at(x, y);
      return id && [entities.store.type(id), entities.store.dir(id)];
    };
    expect(entities.count).toBe(11);
    expect(at(2, -2)).toBe(0); // placed, then removed
    expect(at(4, 1)).toEqual([EntityTypeId.StoneFurnace, Direction.North]);
    expect(at(1, 2)).toEqual([EntityTypeId.TransportBelt, Direction.South]);
    expect(at(-3, 1)).toEqual([EntityTypeId.BurnerMiningDrill, Direction.North]);
    expect(at(-1, 2)).toEqual([EntityTypeId.BurnerInserter, Direction.East]);
    expect(at(4, 4)).toEqual([EntityTypeId.BurnerInserter, Direction.East]);
    expect(at(5, 4)).toEqual([EntityTypeId.WoodenChest, Direction.North]);
    expect(at(0, 0)).toBe(0);
    expect(at(15, 0)).toBe(0);
    const inv = sim.state.players.inventory(0);
    expect(inv.count(ItemId.WoodenChest)).toBe(1);
    expect(inv.count(ItemId.BurnerInserter)).toBe(2);
    expect(inv.count(ItemId.StoneFurnace)).toBe(1);
    expect(inv.count(ItemId.TransportBelt)).toBe(4);
    // The random phase builds too.
    expect(runDeterminismScenario().entities).toBeGreaterThan(11);
    // The spawn furnace got 4 coal and gave 1 back; nothing else was moved.
    expect(entities.slots(entities.at(3, 0))).toEqual([
      { item: 0, count: 0 },
      { item: ItemId.Coal, count: 3 },
      { item: 0, count: 0 },
    ]);
    // 4 went into the furnace and 1 came back; 2 went onto belts.
    expect(inv.count(ItemId.Coal)).toBe(5);
  });

  it('lays a belt line through a curve with a side-loader, and runs coal to an inserter at its end', () => {
    const sim = createDeterminismSim();
    buildDeterminismScript().forEach((c) => sim.enqueue(c));
    for (let i = 0; i < DETERMINISM_BUILD_TICKS; i++) sim.step();
    const { entities } = sim.state;
    const belts = beltTable(entities)!;
    const ids = [[1, 2], ...DETERMINISM_BELTS].map(([x, y]) => entities.at(x, y));
    expect(ids).toEqual([3, 6, 7, 8, 9, 10]);
    // (1, 2) and (1, 3) run south, (1, 4) turns east: one line; (2, 5) side-loads it.
    expect(belts.lineCount).toBe(2);
    const main = belts.line(belts.beltLine(3))!;
    expect(main.belts).toEqual([9, 8, 7, 6, 3]);
    expect(belts.shape(7)).toBe(BeltShape.CurveFromLeft);
    const feeder = belts.line(belts.beltLine(10))!;
    expect(feeder.out).toBe(main);
    expect(feeder.outLane).toBe(BeltLane.Right);

    while (sim.tick < DETERMINISM_SCRIPTED_TICKS) sim.step();
    // Both coal ran to the end of the right lane, where the unfuelled inserter
    // burnt the first and moved the second into the chest.
    expect(main.lanes[BeltLane.Right].count + main.lanes[BeltLane.Left].count).toBe(0);
    expect(feeder.lanes[0].count + feeder.lanes[1].count).toBe(0);
    const inserter = DETERMINISM_SPAWN_INSERTER;
    expect(entities.contents(DETERMINISM_SPAWN_CHEST)).toEqual([{ item: ItemId.Coal, count: 1 }]);
    expect(entities.slots(inserter)[InserterSlot.Hand]!.count).toBe(0);
    expect(entities.detail(inserter)!.burning).toBe(ItemId.Coal);
    expect(entities.status(inserter)).toBe(InserterState.WaitingForSource);
    expect(entities.wake.watchersOf(9)).toEqual([inserter]);
    // Nothing moves here any more: every lane and both inserters sleep.
    for (const line of [main, feeder]) {
      expect(belts.laneAwake(line.id, BeltLane.Left)).toBe(false);
      expect(belts.laneAwake(line.id, BeltLane.Right)).toBe(false);
    }
    expect(inserterTable(entities)!.activeCount).toBe(0);
  });

  it('smelts the mined iron on the patch and stores plates in a chest', () => {
    const sim = createDeterminismSim();
    buildDeterminismScript().forEach((c) => sim.enqueue(c));
    for (let i = 0; i < DETERMINISM_SCRIPTED_TICKS; i++) {
      sim.step();
    }
    const { entities } = sim.state;
    const furnace = DETERMINISM_PATCH_FURNACE;
    const chest = DETERMINISM_PATCH_CHEST;
    expect(entities.store.type(furnace)).toBe(EntityTypeId.StoneFurnace);
    expect(entities.store.type(chest)).toBe(EntityTypeId.WoodenChest);
    expect(entities.status(furnace)).toBe(MachineState.Working);
    // 15 ores went in; two plates were done by the time they were taken out.
    // They went into the chest with the kit plates crafting left; one came back.
    const slots = entities.slots(furnace);
    expect(slots[FurnaceSlot.Input]!.item).toBe(ItemId.IronOre);
    expect(slots[FurnaceSlot.Input]!.count).toBeLessThan(13);
    expect(entities.contents(chest)).toEqual([
      { item: ItemId.IronPlate, count: 2 + KIT_PLATES_LEFT_0 - 1 },
    ]);
    expect(sim.state.players.inventory(0).count(ItemId.IronPlate)).toBe(1);
  });

  it('mines the iron patch with a drill, which waits until a chest is in front of it', () => {
    const sim = createDeterminismSim();
    const script = buildDeterminismScript();
    script.forEach((c) => sim.enqueue(c));
    const { entities } = sim.state;
    const drill = DETERMINISM_PATCH_DRILL;
    const chest = DETERMINISM_DRILL_CHEST;
    // The drill's chest is player 0's last chest placed in the scripted phase.
    const chestTick = Math.max(
      ...script
        .filter((c) => c.type === 'Place' && c.playerId === 0 && c.item === ItemId.WoodenChest)
        .filter((c) => c.tick < DETERMINISM_SCRIPTED_TICKS)
        .map((c) => c.tick),
    );
    while (sim.tick < chestTick) sim.step();
    expect(entities.store.type(drill)).toBe(EntityTypeId.BurnerMiningDrill);
    expect(entities.store.type(chest)).toBe(0);
    // Its first ore is mined and waits in the output slot.
    expect(entities.status(drill)).toBe(MachineState.OutputFull);
    expect(entities.slots(drill)[DrillSlot.Output]).toEqual({ item: ItemId.IronOre, count: 1 });
    sim.step();
    expect(entities.store.type(chest)).toBe(EntityTypeId.WoodenChest);
    expect(entities.contents(chest)).toEqual([{ item: ItemId.IronOre, count: 1 }]);
    expect(entities.status(drill)).toBe(MachineState.Working);
    expect(entities.slots(drill)[DrillSlot.Fuel]).toEqual({ item: ItemId.Coal, count: 1 });
  });

  it('hand-crafts with intermediates, partial crafts and cancels', () => {
    const sim = createDeterminismSim();
    buildDeterminismScript().forEach((c) => sim.enqueue(c));
    const entries = (id: number) => {
      const q = sim.state.crafting;
      const out: [number, number][] = [];
      for (let i = 0; i < q.size(id); i++) {
        out.push([q.recipe[id * CRAFT_QUEUE_LENGTH + i]!, q.crafts[id * CRAFT_QUEUE_LENGTH + i]!]);
      }
      return out;
    };
    while (sim.tick < DETERMINISM_BUILD_TICKS + 3) sim.step();
    const { Gear, Drill, Furnace, Chest, Belt, Inserter } = {
      Gear: RecipeId.IronGearWheel,
      Drill: RecipeId.BurnerMiningDrill,
      Furnace: RecipeId.StoneFurnace,
      Chest: RecipeId.WoodenChest,
      Belt: RecipeId.TransportBelt,
      Inserter: RecipeId.BurnerInserter,
    };
    expect(entries(0)).toEqual([
      [Furnace, 1],
      [Gear, 6],
      [Furnace, 1],
      [Drill, 2],
      [Chest, 2],
      [Gear, 1],
      [Belt, 1],
      [Gear, 4],
    ]);
    const inv0 = sim.state.players.inventory(0);
    expect(inv0.count(ItemId.IronPlate)).toBe(1);
    expect(inv0.count(ItemId.Wood)).toBe(0);
    expect(inv0.count(ItemId.Stone)).toBe(0);
    expect(entries(1)).toEqual([
      [Gear, 3],
      [Inserter, 3],
    ]);
    expect(entries(2)).toEqual([
      [Chest, 1],
      [Gear, 2],
      [Inserter, 2],
    ]);

    // Player 1 cancels its inserters and turns the refund into gears.
    while (sim.tick < 42) sim.step();
    expect(entries(1)).toEqual([[Gear, 14]]);

    // Just before player 0 moves its plates into the patch chest (smeltPhase),
    // everything left in its queue is done; the belt was cancelled.
    while (sim.tick < DETERMINISM_SCRIPTED_TICKS - 10) sim.step();
    expect(entries(0)).toEqual([]);
    expect(inv0.count(ItemId.IronPlate)).toBe(KIT_PLATES_LEFT_0);

    while (sim.tick < DETERMINISM_SCRIPTED_TICKS) sim.step();
    // The kit's two drills and two crafted ones; one went to the spawn, one onto the iron patch.
    expect(inv0.count(ItemId.BurnerMiningDrill)).toBe(2);
    // The kit's two chests and two crafted ones; one went to the spawn, two onto
    // the iron patch. The first furnace crafted went there too.
    expect(inv0.count(ItemId.WoodenChest)).toBe(1);
    expect(inv0.count(ItemId.StoneFurnace)).toBe(0);
    expect(sim.state.entities.store.type(DETERMINISM_PATCH_FURNACE)).toBe(
      EntityTypeId.StoneFurnace,
    );
    expect(inv0.count(ItemId.IronGearWheel)).toBe(4);
    expect(inv0.count(ItemId.TransportBelt)).toBe(4);
    // KIT_PLATES_LEFT_0 plates were left; they went into the patch chest (see the smelting test).
    expect(inv0.count(ItemId.IronPlate)).toBe(1);
    const inv1 = sim.state.players.inventory(1);
    expect(inv1.count(ItemId.IronGearWheel)).toBe(15);
    expect(inv1.count(ItemId.IronPlate)).toBe(0);
    // Player 2 crafted two inserters on top of the kit's four, and built two into its chain.
    expect(sim.state.players.inventory(2).count(ItemId.BurnerInserter)).toBe(4);
  });

  it('fells a tree outside the starting area and crafts chests from its wood', () => {
    const script = buildDeterminismScript();
    const mine = script.find(
      (c) =>
        c.type === 'MineStart' &&
        c.playerId === 1 &&
        c.tick > DETERMINISM_BUILD_TICKS + 500 &&
        c.tick < DETERMINISM_SCRIPTED_TICKS,
    );
    expect(mine).toBeDefined();
    const { x, y } = mine as { x: number; y: number };
    // The tree is outside the starting area, near player 1's copper patch.
    expect(x * x + y * y).toBeGreaterThan(48 * 48);
    const craft = script.find(
      (c) =>
        c.type === 'Craft' &&
        c.playerId === 1 &&
        c.recipe === RecipeId.WoodenChest &&
        c.tick < DETERMINISM_SCRIPTED_TICKS,
    )!;
    expect(craft.tick).toBeLessThan(DETERMINISM_SCRIPTED_TICKS - 30);

    const sim = createDeterminismSim();
    script.forEach((c) => sim.enqueue(c));
    expect(sim.state.world.treeAt(x, y)).toBe(true);
    expect(nearestTree(x, y)).toEqual({ x, y });
    for (let i = 0; i < craft.tick; i++) sim.step();
    const inv = sim.state.players.inventory(1);
    const kitWood = DETERMINISM_KIT.find((s) => s.item === ItemId.Wood)!.count;
    // The player reached the tree (no water in the way) and felled it.
    expect(sim.state.world.treeAt(x, y)).toBe(false);
    expect(inv.count(ItemId.Wood)).toBe(kitWood + TREE_WOOD);
    sim.step();
    // With the tree gone, mining ends.
    expect(sim.state.players.mining[1]).toBe(0);
    // The chests need more wood than the kit had: all three were queued.
    expect(inv.count(ItemId.Wood)).toBe(kitWood + TREE_WOOD - 2 * DETERMINISM_TREE_CHESTS);
    // The first chest is done after 30 ticks (counting the one it was queued
    // on), still in the scripted phase.
    const kitChests = DETERMINISM_KIT.find((s) => s.item === ItemId.WoodenChest)!.count;
    for (let i = 0; i < 28; i++) sim.step();
    expect(inv.count(ItemId.WoodenChest)).toBe(kitChests);
    sim.step();
    expect(inv.count(ItemId.WoodenChest)).toBe(kitChests + 1);
    expect(sim.tick).toBeLessThanOrEqual(DETERMINISM_SCRIPTED_TICKS);
  });

  it('runs the M1 automation chain on the stone patch with no further commands', () => {
    const sim = createDeterminismSim();
    const script = buildDeterminismScript();
    script.forEach((c) => sim.enqueue(c));
    const { entities } = sim.state;
    const { x, y } = DETERMINISM_CHAIN;
    // Player 2 sends no command after fuelling the chain, until the random
    // phase, but for its electric rig and its belt line off to the side.
    const last = Math.max(
      ...script
        .filter((c) => c.playerId === 2 && c.tick < DETERMINISM_ELECTRIC_TICK)
        .map((c) => c.tick),
    );
    expect(last).toBe(DETERMINISM_CHAIN_TICK + 2);
    while (sim.tick < DETERMINISM_CHAIN_TICK + 3) sim.step();
    const at = (dx: number) => {
      const id = entities.at(x + dx, y);
      return [id, entities.store.type(id), entities.store.dir(id)];
    };
    const { BurnerMiningDrill, TransportBelt, BurnerInserter, StoneFurnace, WoodenChest } =
      EntityTypeId;
    expect([0, 2, 3, 4, 5, 6, 8, 9].map(at)).toEqual([
      [DETERMINISM_CHAIN_DRILL, BurnerMiningDrill, Direction.East],
      [18, TransportBelt, Direction.East],
      [19, TransportBelt, Direction.East],
      [20, TransportBelt, Direction.East],
      [DETERMINISM_CHAIN_PICK, BurnerInserter, Direction.East],
      [DETERMINISM_CHAIN_FURNACE, StoneFurnace, Direction.North],
      [DETERMINISM_CHAIN_PUT, BurnerInserter, Direction.East],
      [DETERMINISM_CHAIN_CHEST, WoodenChest, Direction.North],
    ]);
    // Every machine is fuelled and the belts form one line.
    for (const id of [
      DETERMINISM_CHAIN_DRILL,
      DETERMINISM_CHAIN_FURNACE,
      DETERMINISM_CHAIN_PICK,
      DETERMINISM_CHAIN_PUT,
    ]) {
      const coal = entities.contents(id).find((c) => c.item === ItemId.Coal)?.count ?? 0;
      expect(coal > 0 || entities.detail(id)!.burning === ItemId.Coal).toBe(true);
    }
    const belts = beltTable(entities)!;
    expect(belts.line(belts.beltLine(18))!.belts).toEqual([20, 19, 18]);
    expect(entities.status(DETERMINISM_CHAIN_DRILL)).toBe(MachineState.Working);

    // Stone goes drill → belt → inserter → furnace (two per brick) → inserter
    // → chest: a brick every 480 ticks.
    const bricks = () =>
      entities
        .contents(DETERMINISM_CHAIN_CHEST)
        .reduce((n, s) => n + (s.item === ItemId.StoneBrick ? s.count : 0), 0);
    let first = 0;
    while (sim.tick < CHAIN_CHECK_TICK) {
      sim.step();
      if (first === 0 && bricks() > 0) first = sim.tick;
    }
    expect(first).toBe(CHAIN_FIRST_BRICK_TICK);
    expect(entities.contents(DETERMINISM_CHAIN_CHEST)).toEqual([
      { item: ItemId.StoneBrick, count: CHAIN_BRICKS },
    ]);
    // Nothing but stone runs on the belt.
    expect(belts.itemsOn(20).every((i) => i.item === ItemId.Stone)).toBe(true);
  });

  it('runs coal through an underground pair onto fast belts, reversing the pair and back', () => {
    const sim = createDeterminismSim();
    buildDeterminismScript().forEach((c) => sim.enqueue(c));
    const { entities } = sim.state;
    const belts = beltTable(entities)!;
    const { x, y } = DETERMINISM_CHAIN;
    const row = y + DETERMINISM_TIER_ROW;
    while (sim.tick < DETERMINISM_TIER_TICK + 2) sim.step();
    const ids = [1, 2, 5, 6, 7].map((dx) => entities.at(x + dx, row));
    const [belt, entrance, exit, fast] = [
      DETERMINISM_TIER_BELT,
      DETERMINISM_TIER_ENTRANCE,
      DETERMINISM_TIER_EXIT,
      DETERMINISM_TIER_FAST,
    ];
    expect(ids).toEqual([belt, entrance, exit, fast, fast + 1]);
    expect(belts.mode(entrance)).toBe(UndergroundMode.Entrance);
    expect(belts.mode(exit)).toBe(UndergroundMode.Exit);
    expect(belts.partner(entrance)).toBe(exit);
    // One yellow line through the pair (two tiles under the ground), handing on to the fast line.
    const yellow = belts.line(belts.beltLine(belt))!;
    expect(yellow.belts).toEqual([exit, 0, 0, entrance, belt]);
    const red = belts.line(belts.beltLine(fast))!;
    expect(red.speed).toBe(16);
    expect(yellow.out).toBe(red);
    expect(yellow.outPos).toBe(red.length);
    const coalOnLine = () =>
      [belt, entrance, exit, fast, fast + 1].reduce(
        (n, id) => n + (entities.contents(id).find((s) => s.item === ItemId.Coal)?.count ?? 0),
        0,
      );
    expect(coalOnLine()).toBe(2);
    // Reversed (a Rotate on the exit): the pair swaps ends and faces west.
    while (sim.tick < DETERMINISM_TIER_TICK + 31) sim.step();
    expect(belts.mode(exit)).toBe(UndergroundMode.Entrance);
    expect(entities.store.dir(entrance)).toBe(Direction.West);
    expect(belts.partner(exit)).toBe(entrance);
    // And back: by the end of the script both coal are under the ground,
    // which counts as the exit's (it would refund them).
    while (sim.tick < DETERMINISM_SCRIPTED_TICKS) sim.step();
    expect(belts.mode(exit)).toBe(UndergroundMode.Exit);
    expect(coalOnLine()).toBe(2);
    expect(entities.contents(exit)).toEqual([{ item: ItemId.Coal, count: 2 }]);
    expect(belts.itemsOn(exit)).toEqual([]);
  });

  it("strings poles on player 1's patch: a network, a split, a merge, and a lone pole", () => {
    const sim = createDeterminismSim();
    buildDeterminismScript().forEach((c) => sim.enqueue(c));
    const { entities } = sim.state;
    const grid = powerGrid(entities)!;
    const net = (id: number) => grid.networkOfPole(id);
    const [west, bridge, east, south] = [
      DETERMINISM_POLE_WEST,
      DETERMINISM_POLE_BRIDGE,
      DETERMINISM_POLE_EAST,
      DETERMINISM_POLE_SOUTH,
    ];
    while (sim.tick <= DETERMINISM_POLES_TICK) sim.step();
    for (const id of [west, bridge, east, south]) {
      expect(entities.store.type(id)).toBe(EntityTypeId.SmallElectricPole);
      expect(net(id)).toBe(1);
    }
    expect(grid.neighbours(bridge)).toEqual([west, east, south]);
    expect(grid.neighbours(west)).toEqual([bridge]);
    sim.step();
    // The bridge is gone: west keeps network 1, east and south get 2 and 3.
    expect(entities.store.type(bridge)).toBe(0);
    expect([net(west), net(east), net(south)]).toEqual([1, 2, 3]);
    sim.step();
    for (const id of [west, east, south, DETERMINISM_POLE_REBRIDGE]) expect(net(id)).toBe(1);
    expect(grid.networkIds()).toEqual([1]);
    sim.step();
    expect(net(DETERMINISM_POLE_LONE)).toBe(4);
    expect(grid.neighbours(DETERMINISM_POLE_LONE)).toEqual([]);
    while (sim.tick < DETERMINISM_SCRIPTED_TICKS) sim.step();
    // Player 1's five, and the one over player 2's electric rig.
    expect(grid.poleCount).toBe(6);
    expect(grid.networkCount).toBe(3);
    expect(sim.state.players.inventory(1).count(ItemId.SmallElectricPole)).toBe(5);
  });

  it("builds a boiler and two steam engines among player 1's poles, powering an electric inserter", () => {
    const sim = createDeterminismSim();
    buildDeterminismScript().forEach((c) => sim.enqueue(c));
    const { entities } = sim.state;
    const grid = powerGrid(entities)!;
    const boilers = boilerTable(entities)!;
    const engines = steamEngineTable(entities)!;
    const [boiler, west, east] = [
      DETERMINISM_BOILER,
      DETERMINISM_ENGINE_WEST,
      DETERMINISM_ENGINE_EAST,
    ];
    while (sim.tick <= DETERMINISM_STEAM_TICK + 3) sim.step();
    expect(entities.store.type(boiler)).toBe(EntityTypeId.Boiler);
    expect([west, east].map((e) => entities.store.type(e))).toEqual([
      EntityTypeId.SteamEngine,
      EntityTypeId.SteamEngine,
    ]);
    expect(engines.enginesOf(boiler)).toEqual([west, east]);
    expect([west, east].map((e) => grid.networkOf(e))).toEqual([1, 1]);
    // No consumers yet: the engines could deliver 30 000 J/tick, nothing is drawn or burnt.
    expect(grid.network(1)).toMatchObject({ supply: 30_000, demand: 0, load: 0 });
    for (const id of [boiler, west, east]) expect(entities.status(id)).toBe(MachineState.NoDemand);
    expect(entities.slots(boiler)).toEqual([{ item: ItemId.Coal, count: 2 }]);
    // The electric inserter next to the boiler, with nothing to pick up:
    // 220 J on the tick it was placed (active), then its 7 J drain asleep.
    const inserter = DETERMINISM_STEAM_INSERTER;
    while (sim.tick <= DETERMINISM_STEAM_TICK + 4) sim.step();
    expect(entities.store.type(inserter)).toBe(EntityTypeId.ElectricInserter);
    expect(grid.networkOf(inserter)).toBe(1);
    expect(grid.network(1)).toMatchObject({ demand: 220, load: 220 });
    // Until player 1 adds its assembling machine (see the next test).
    while (sim.tick < DETERMINISM_ASSEMBLER_TICK) sim.step();
    expect(entities.status(inserter)).toBe(MachineState.WaitingForSource);
    expect(grid.network(1)).toMatchObject({ supply: 30_000, demand: 7, load: 7 });
    // The boiler burnt one coal for all of it, 100% efficiently.
    const drawn = 220 + 7 * (DETERMINISM_ASSEMBLER_TICK - DETERMINISM_STEAM_TICK - 5);
    expect(entities.slots(boiler)).toEqual([{ item: ItemId.Coal, count: 1 }]);
    expect(boilers.detail(boiler).energy).toBe(4_000_000 - drawn);
  });

  it("runs player 1's assembling machine on the steam network, with recipe changes", () => {
    const sim = createDeterminismSim();
    buildDeterminismScript().forEach((c) => sim.enqueue(c));
    const { entities, players } = sim.state;
    const grid = powerGrid(entities)!;
    const table = assemblerTable(entities, EntityTypeId.AssemblingMachine1)!;
    const id = DETERMINISM_ASSEMBLER;
    const t = DETERMINISM_ASSEMBLER_TICK;
    const copper = () => players.inventory(1).count(ItemId.CopperPlate);
    const cable = () => players.inventory(1).count(ItemId.CopperCable);
    const until = (tick: number) => {
      while (sim.tick <= tick) sim.step();
    };
    until(t);
    expect(entities.store.type(id)).toBe(EntityTypeId.AssemblingMachine1);
    expect(grid.networkOf(id)).toBe(1);
    expect(entities.status(id)).toBe(MachineState.NoRecipe);
    until(t + 1);
    expect(entities.selectedRecipe(id)).toBe(RecipeId.CopperCable);
    expect(entities.status(id)).toBe(MachineState.NoInput);
    // The input slot takes 2 of the 10 plates; a craft starts at once and draws 1 250 J.
    until(t + 2);
    expect(copper()).toBe(8);
    expect(table.crafting(id)).toBe(true);
    expect(entities.slots(id)).toEqual([
      { item: ItemId.CopperPlate, count: 1 },
      { item: 0, count: 0 },
    ]);
    expect(grid.member(id)!.demand).toBe(1_250);
    // The ignored recipe commands changed nothing.
    until(t + 3);
    expect(entities.selectedRecipe(id)).toBe(RecipeId.CopperCable);
    // 60 ticks a craft (30 at speed 1/2): two cables on tick t + 61.
    until(t + 60);
    expect(entities.slots(id)[1]).toEqual({ item: 0, count: 0 });
    until(t + 61);
    expect(entities.slots(id)[1]).toEqual({ item: ItemId.CopperCable, count: 2 });
    until(t + 62);
    expect(cable()).toBe(2);
    until(t + 63);
    expect(copper()).toBe(6);
    // Switching to gears refunds the plate in the craft under way and the two in the slot.
    until(t + 64);
    expect(entities.selectedRecipe(id)).toBe(RecipeId.IronGearWheel);
    expect(copper()).toBe(9);
    expect(table.crafting(id)).toBe(false);
    until(t + 66);
    expect(copper()).toBe(7);
    while (sim.tick < DETERMINISM_SCRIPTED_TICKS) sim.step();
    expect(entities.status(id)).toBe(MachineState.Working);
    // With player 1's logistics rig on the same network: the long-handed
    // inserter swinging (333 J) and the fast one asleep (its 15 J drain);
    // and its two labs researching (1 000 J each).
    const demand = 1_250 + 7 + 333 + 15 + 2 * 1_000;
    expect(grid.network(1)).toMatchObject({ demand, load: demand });
  });

  it("researches with player 1's two labs: logistics, then automation, which completes", () => {
    const sim = createDeterminismSim();
    buildDeterminismScript().forEach((c) => sim.enqueue(c));
    const { entities, research } = sim.state;
    const grid = powerGrid(entities)!;
    const labs = labTable(entities)!;
    const [a, b] = [DETERMINISM_LAB_A, DETERMINISM_LAB_B];
    const t = DETERMINISM_RESEARCH_TICK;
    const until = (tick: number) => {
      while (sim.tick <= tick) sim.step();
    };
    until(t);
    // The research commands before the labs were ignored.
    expect(research.currentOf(0)).toBe(0);
    for (const id of [a, b]) {
      expect(entities.store.type(id)).toBe(EntityTypeId.Lab);
      expect(grid.networkOf(id)).toBe(1);
      expect(entities.status(id)).toBe(MachineState.NoResearch);
    }
    until(t + 1);
    expect(research.currentOf(0)).toBe(TechId.Logistics);
    expect(entities.status(a)).toBe(MachineState.NoInput);
    // Fed: each starts a unit of logistics at once.
    until(t + 2);
    for (const id of [a, b]) {
      expect(entities.status(id)).toBe(MachineState.Working);
      expect(labs.unitTech(id)).toBe(TechId.Logistics);
      expect(entities.slots(id)[0]).toEqual({ item: ItemId.AutomationSciencePack, count: 19 });
    }
    // The craft of a locked recipe was ignored.
    const queued = () => {
      const q = sim.state.crafting;
      return Array.from(q.recipe.subarray(CRAFT_QUEUE_LENGTH, CRAFT_QUEUE_LENGTH + q.size(1)));
    };
    until(t + 3);
    const before = queued();
    until(t + 4);
    expect(queued()).toEqual(before);
    expect(before).not.toContain(RecipeId.AssemblingMachine1);
    // Switched to automation: the units under way still count for logistics.
    until(t + 20);
    expect(research.currentOf(0)).toBe(TechId.Automation);
    expect(labs.unitTech(a)).toBe(TechId.Logistics);
    while (research.unitsDone(0, TechId.Logistics) < 2) sim.step();
    expect(sim.tick).toBe(t + 2 + 15 * 60);
    expect(research.unitsDone(0, TechId.Automation)).toBe(0);
    // (By then random commands switch the research now and then.)
    sim.step();
    expect(labs.unitTech(a)).toBe(research.currentOf(0));
    // In the random phase automation completes, unlocking its recipes.
    while (!research.isResearched(0, TechId.Automation) && sim.tick < DETERMINISM_TICKS) {
      sim.step();
    }
    expect(sim.tick).toBeLessThan(DETERMINISM_TICKS);
    expect(isRecipeUnlocked(sim.state, 0, RecipeId.AssemblingMachine1)).toBe(true);
  });

  it("moves coal through player 1's iron chests with a long-handed and a fast inserter", () => {
    const sim = createDeterminismSim();
    buildDeterminismScript().forEach((c) => sim.enqueue(c));
    const { entities } = sim.state;
    const grid = powerGrid(entities)!;
    while (sim.tick <= DETERMINISM_LOGISTICS_TICK + 1) sim.step();
    const types = [
      DETERMINISM_LOGISTICS_SOURCE,
      DETERMINISM_LOGISTICS_LONG,
      DETERMINISM_LOGISTICS_MIDDLE,
      DETERMINISM_LOGISTICS_FAST,
      DETERMINISM_LOGISTICS_TARGET,
    ].map((id) => entities.store.type(id));
    expect(types).toEqual([
      EntityTypeId.IronChest,
      EntityTypeId.LongHandedInserter,
      EntityTypeId.IronChest,
      EntityTypeId.FastInserter,
      EntityTypeId.IronChest,
    ]);
    const long = DETERMINISM_LOGISTICS_LONG;
    const fast = DETERMINISM_LOGISTICS_FAST;
    // The long-handed inserter reaches 2 tiles each way, over the empty tiles between.
    const { store } = entities;
    expect(store.x(DETERMINISM_LOGISTICS_SOURCE)).toBe(store.x(long) - 2);
    expect(store.x(DETERMINISM_LOGISTICS_MIDDLE)).toBe(store.x(long) + 2);
    expect([grid.networkOf(long), grid.networkOf(fast)]).toEqual([1, 1]);
    const coal = (id: number) => entities.contents(id).find((s) => s.item === ItemId.Coal)?.count;
    while (sim.tick < DETERMINISM_SCRIPTED_TICKS) sim.step();
    // Two of the four coal are on their way: one in the long hand, one already in the last chest.
    expect(coal(DETERMINISM_LOGISTICS_SOURCE)).toBe(2);
    expect(coal(long)).toBe(1);
    expect(coal(DETERMINISM_LOGISTICS_MIDDLE)).toBeUndefined();
    expect(coal(DETERMINISM_LOGISTICS_TARGET)).toBe(1);
    expect(entities.status(fast)).toBe(MachineState.WaitingForSource);
  });

  it("puts player 2's electric drill and inserter on a network without power", () => {
    const sim = createDeterminismSim();
    buildDeterminismScript().forEach((c) => sim.enqueue(c));
    const { entities } = sim.state;
    const grid = powerGrid(entities)!;
    while (sim.tick <= DETERMINISM_ELECTRIC_TICK + 1) sim.step();
    const { x, y } = DETERMINISM_CHAIN;
    const at = (dx: number, dy: number) => entities.at(x + dx, y + dy);
    expect(at(9, 2)).toBe(DETERMINISM_ELECTRIC_POLE);
    expect(at(5, 3)).toBe(DETERMINISM_ELECTRIC_DRILL);
    expect(at(8, 4)).toBe(DETERMINISM_ELECTRIC_INSERTER);
    expect(at(9, 4)).toBe(DETERMINISM_ELECTRIC_CHEST);
    const drill = DETERMINISM_ELECTRIC_DRILL;
    const inserter = DETERMINISM_ELECTRIC_INSERTER;
    expect(entities.store.type(drill)).toBe(EntityTypeId.ElectricMiningDrill);
    expect(entities.store.type(inserter)).toBe(EntityTypeId.ElectricInserter);
    const net = grid.networkOfPole(DETERMINISM_ELECTRIC_POLE);
    expect(grid.networkOf(drill)).toBe(net);
    expect(grid.networkOf(inserter)).toBe(net);
    expect(entities.status(drill)).toBe(MachineState.NoPower);
    expect(entities.status(inserter)).toBe(MachineState.NoPower);
    expect(grid.network(net)).toMatchObject({ demand: 1_500 + 220, supply: 0, satisfaction: 0 });
  });

  it('matches the expected hash shared with the Chromium test', () => {
    expect(hex(runDeterminismScenario().hash)).toBe(hex(DETERMINISM_EXPECTED_HASH));
  });

  it('produces identical intermediate hashes, and they keep changing', () => {
    const a = hashTrace(100);
    const b = hashTrace(100);
    expect(b).toEqual(a);
    expect(new Set(a).size).toBe(a.length);
  });

  it('is sensitive to the seed and to the commands', () => {
    const base = createDeterminismSim();
    const otherSeed = new Sim({ seed: DETERMINISM_SEED + 1, players: DETERMINISM_PLAYERS });
    expect(otherSeed.hash()).not.toBe(base.hash());

    const script = buildDeterminismScript(2000);
    const plain = createDeterminismSim();
    const withExtra = createDeterminismSim();
    for (const cmd of script) {
      plain.enqueue(cmd);
      withExtra.enqueue(cmd);
    }
    // A mining target far outside the script's range, so it can't be a no-op.
    withExtra.enqueue({ tick: 1000, playerId: 1, type: 'MineStart', x: 12_345, y: 0 });
    withExtra.enqueue({ tick: 1999, playerId: 1, type: 'MineStart', x: 12_345, y: 0 });
    for (let i = 0; i < 2000; i++) {
      plain.step();
      withExtra.step();
    }
    expect(withExtra.hash()).not.toBe(plain.hash());
  });

  it('does not depend on the enqueue order across players and ticks', () => {
    const script = buildDeterminismScript(3000);
    const sorted = script.slice().sort((a, b) => a.tick - b.tick || a.playerId - b.playerId);
    const run = (commands: typeof script): number => {
      const sim = createDeterminismSim();
      commands.forEach((c) => sim.enqueue(c));
      for (let i = 0; i < 3000; i++) {
        sim.step();
      }
      return sim.hash();
    };
    expect(run(sorted)).toBe(run(script));
  });
});

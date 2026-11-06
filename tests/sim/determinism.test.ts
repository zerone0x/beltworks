import { describe, expect, it } from 'vitest';
import { EntityTypeId } from '../../src/data/entities';
import { ItemId, MINED_ITEM } from '../../src/data/items';
import { RecipeId } from '../../src/data/recipes';
import { BeltShape, beltTable } from '../../src/sim/belts/belts';
import { BeltLane } from '../../src/sim/belts/line';
import { CRAFT_QUEUE_LENGTH } from '../../src/sim/crafting/queue';
import { Direction } from '../../src/sim/entities/direction';
import { DrillSlot } from '../../src/sim/entities/drill';
import { FurnaceSlot } from '../../src/sim/entities/furnace';
import { InserterSlot, InserterState, inserterTable } from '../../src/sim/entities/inserter';
import { MachineState } from '../../src/sim/entities/machine';
import {
  DETERMINISM_BELTS,
  DETERMINISM_BUILD_TICKS,
  DETERMINISM_CHAIN,
  DETERMINISM_CHAIN_CHEST,
  DETERMINISM_CHAIN_DRILL,
  DETERMINISM_CHAIN_FURNACE,
  DETERMINISM_CHAIN_PICK,
  DETERMINISM_CHAIN_PUT,
  DETERMINISM_CHAIN_TICK,
  DETERMINISM_DRILL_CHEST,
  DETERMINISM_KIT,
  DETERMINISM_PATCH_CHEST,
  DETERMINISM_PATCH_FURNACE,
  DETERMINISM_PATCH_DRILL,
  DETERMINISM_PLAYERS,
  DETERMINISM_SCRIPTED_TICKS,
  DETERMINISM_SEED,
  DETERMINISM_SPAWN_CHEST,
  DETERMINISM_SPAWN_INSERTER,
  DETERMINISM_TICKS,
  buildDeterminismScript,
  createDeterminismSim,
  runDeterminismScenario,
} from '../../src/sim/scenarios/determinism';
import { Sim } from '../../src/sim/tick';
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
    // Nothing moves any more: every lane and both inserters sleep.
    expect(belts.activeLanes).toBe(0);
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

  it('runs the M1 automation chain on the stone patch with no further commands', () => {
    const sim = createDeterminismSim();
    const script = buildDeterminismScript();
    script.forEach((c) => sim.enqueue(c));
    const { entities } = sim.state;
    const { x, y } = DETERMINISM_CHAIN;
    // Player 2 sends no command after fuelling the chain, until the random phase.
    const last = Math.max(
      ...script
        .filter((c) => c.playerId === 2 && c.tick < DETERMINISM_SCRIPTED_TICKS)
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

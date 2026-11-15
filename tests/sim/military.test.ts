import { describe, expect, it } from 'vitest';
import { entityForItem } from '../../src/data/entities';
import { ITEMS, ItemId, type ItemStack } from '../../src/data/items';
import {
  ASSEMBLER_RECIPES,
  HAND_RECIPES,
  RECIPES,
  RecipeId,
  STEEL_SMELTING_TICKS,
  handRecipeFor,
  smeltingRecipeFor,
} from '../../src/data/recipes';
import {
  SCIENCE_PACKS,
  TECHNOLOGIES,
  TechId,
  unlockingTechnology,
} from '../../src/data/technologies';
import { BuildResult, placeEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { FurnaceSlot, furnaceTable } from '../../src/sim/entities/furnace';
import { InserterState, inserterTable } from '../../src/sim/entities/inserter';
import { MachineState } from '../../src/sim/entities/machine';
import { TransferResult, insertIntoEntity } from '../../src/sim/entities/transfer';
import { tileCenter } from '../../src/sim/fixed';
import { LAB_SLOTS, labSlotOf } from '../../src/sim/research/lab';
import { isRecipeUnlocked } from '../../src/sim/research/unlocks';
import { beltTable } from '../../src/sim/belts/belts';
import { BELT_LENGTH, BeltLane } from '../../src/sim/belts/line';
import { LAB_INSERTER_LIMIT } from '../../src/data/entities';
import { Sim, setResearch } from '../../src/sim/tick';
import { expectRoundTrip, reload } from './saveRoundTrip';

/**
 * Military science (D76): steel, stone walls, ammunition, grenades and the
 * third science pack, with Factorio 1.1's recipes, times and technologies.
 */

const S = 60;
const RED = ItemId.AutomationSciencePack;
const GREEN = ItemId.LogisticSciencePack;
const MILITARY = ItemId.MilitarySciencePack;

/** Every technology of the military branch, researched. */
const MILITARY_TECHS = [
  TechId.Automation,
  TechId.LogisticSciencePack,
  TechId.Military,
  TechId.StoneWall,
  TechId.SteelProcessing,
  TechId.Military2,
  TechId.MilitarySciencePack,
];

function sim(kit: readonly ItemStack[], researched: readonly number[] = []): Sim {
  const s = new Sim({ seed: 3, startingKit: kit, researched });
  s.state.players.x[0] = tileCenter(0);
  s.state.players.y[0] = tileCenter(0);
  return s;
}

function steps(s: Sim, n: number): void {
  for (let i = 0; i < n; i++) s.step();
}

describe('military science items (D76)', () => {
  it('have stable ids, names and stack sizes', () => {
    const items = [
      [ItemId.SteelPlate, 38, 'steel-plate', 100],
      [ItemId.StoneWall, 39, 'stone-wall', 100],
      [ItemId.FirearmMagazine, 40, 'firearm-magazine', 200],
      [ItemId.PiercingRoundsMagazine, 41, 'piercing-rounds-magazine', 200],
      [ItemId.Grenade, 42, 'grenade', 100],
      [ItemId.MilitarySciencePack, 43, 'military-science-pack', 200],
    ] as const;
    for (const [item, id, name, stack] of items) {
      expect(item).toBe(id);
      expect(ITEMS[item].name).toBe(name);
      expect(ITEMS[item].stackSize).toBe(stack);
      expect(ITEMS[item].fuelValue).toBeUndefined();
    }
  });

  it('place nothing: a stone wall is an ingredient only', () => {
    expect(entityForItem(ItemId.StoneWall)).toBeUndefined();
    const s = sim([{ item: ItemId.StoneWall, count: 5 }]);
    expect(placeEntity(s.state, 0, ItemId.StoneWall, 2, 0, Direction.North)).toBe(
      BuildResult.NotPlaceable,
    );
    expect(s.state.players.inventory(0).count(ItemId.StoneWall)).toBe(5);
  });
});

describe('military science recipes (D76)', () => {
  const shape = (id: keyof typeof RECIPES) => {
    const r = RECIPES[id];
    return { inputs: r.inputs, outputs: r.outputs, ticks: r.ticks, category: r.category };
  };

  it('are Factorio 1.1’s, inputs, outputs and times', () => {
    expect(STEEL_SMELTING_TICKS).toBe(16 * S);
    expect(shape(RecipeId.SteelPlate)).toEqual({
      inputs: [[ItemId.IronPlate, 5]],
      outputs: [[ItemId.SteelPlate, 1]],
      ticks: 16 * S,
      category: 'smelting',
    });
    expect(shape(RecipeId.StoneWall)).toEqual({
      inputs: [[ItemId.StoneBrick, 5]],
      outputs: [[ItemId.StoneWall, 1]],
      ticks: S / 2,
      category: 'hand',
    });
    expect(shape(RecipeId.FirearmMagazine)).toEqual({
      inputs: [[ItemId.IronPlate, 4]],
      outputs: [[ItemId.FirearmMagazine, 1]],
      ticks: 1 * S,
      category: 'hand',
    });
    expect(shape(RecipeId.PiercingRoundsMagazine)).toEqual({
      inputs: [
        [ItemId.FirearmMagazine, 1],
        [ItemId.SteelPlate, 1],
        [ItemId.CopperPlate, 5],
      ],
      outputs: [[ItemId.PiercingRoundsMagazine, 1]],
      ticks: 3 * S,
      category: 'hand',
    });
    expect(shape(RecipeId.Grenade)).toEqual({
      inputs: [
        [ItemId.Coal, 10],
        [ItemId.IronPlate, 5],
      ],
      outputs: [[ItemId.Grenade, 1]],
      ticks: 8 * S,
      category: 'hand',
    });
    expect(shape(RecipeId.MilitarySciencePack)).toEqual({
      inputs: [
        [ItemId.PiercingRoundsMagazine, 1],
        [ItemId.Grenade, 1],
        [ItemId.StoneWall, 2],
      ],
      outputs: [[ItemId.MilitarySciencePack, 2]],
      ticks: 10 * S,
      category: 'hand',
    });
  });

  it('are hand-crafted and made in assembling machines, except steel, which only a furnace makes', () => {
    const hand = [
      RecipeId.StoneWall,
      RecipeId.FirearmMagazine,
      RecipeId.PiercingRoundsMagazine,
      RecipeId.Grenade,
      RecipeId.MilitarySciencePack,
    ];
    for (const id of hand) {
      expect(HAND_RECIPES.map((r) => r.id)).toContain(id);
      expect(ASSEMBLER_RECIPES.map((r) => r.id)).toContain(id);
      expect(handRecipeFor(RECIPES[id].outputs[0]![0])?.id).toBe(id);
    }
    expect(HAND_RECIPES.map((r) => r.id)).not.toContain(RecipeId.SteelPlate);
    expect(ASSEMBLER_RECIPES.map((r) => r.id)).not.toContain(RecipeId.SteelPlate);
    expect(handRecipeFor(ItemId.SteelPlate)).toBeUndefined();
    expect(smeltingRecipeFor(ItemId.IronPlate)?.id).toBe(RecipeId.SteelPlate);
  });
});

describe('military science technologies (D76)', () => {
  it('follow Factorio 1.1’s tree, costs and times', () => {
    const tech = (id: keyof typeof TECHNOLOGIES) => {
      const t = TECHNOLOGIES[id];
      return [t.name, t.prerequisites, t.packs, t.units, t.ticksPerUnit, t.unlocks];
    };
    expect(tech(TechId.Military)).toEqual(['military', [], [RED], 10, 15 * S, []]);
    expect(tech(TechId.StoneWall)).toEqual([
      'stone-wall',
      [],
      [RED],
      10,
      10 * S,
      [RecipeId.StoneWall],
    ]);
    expect(tech(TechId.SteelProcessing)).toEqual([
      'steel-processing',
      [],
      [RED],
      50,
      5 * S,
      [RecipeId.SteelPlate],
    ]);
    expect(tech(TechId.Military2)).toEqual([
      'military-2',
      [TechId.Military, TechId.SteelProcessing, TechId.LogisticSciencePack],
      [RED, GREEN],
      20,
      15 * S,
      [RecipeId.PiercingRoundsMagazine, RecipeId.Grenade],
    ]);
    expect(tech(TechId.MilitarySciencePack)).toEqual([
      'military-science-pack',
      [TechId.Military2, TechId.StoneWall],
      [RED, GREEN],
      30,
      15 * S,
      [RecipeId.MilitarySciencePack],
    ]);
    // Firearm magazines need no research, as in Factorio.
    expect(unlockingTechnology(RecipeId.FirearmMagazine)).toBe(TechId.None);
  });

  it('gate the recipes for the force until researched', () => {
    const gated = [
      [RecipeId.SteelPlate, TechId.SteelProcessing],
      [RecipeId.StoneWall, TechId.StoneWall],
      [RecipeId.PiercingRoundsMagazine, TechId.Military2],
      [RecipeId.Grenade, TechId.Military2],
      [RecipeId.MilitarySciencePack, TechId.MilitarySciencePack],
    ] as const;
    for (const [recipe, tech] of gated) {
      const s = sim([]);
      expect(isRecipeUnlocked(s.state, 0, recipe)).toBe(false);
      s.state.research.markResearched(0, tech);
      expect(isRecipeUnlocked(s.state, 0, recipe)).toBe(true);
    }
    expect(isRecipeUnlocked(sim([]).state, 0, RecipeId.FirearmMagazine)).toBe(true);
  });

  it('keep research speed red + green: the demo has no military line yet', () => {
    expect(TECHNOLOGIES[TechId.ResearchSpeed].packs).toEqual([RED, GREEN]);
  });
});

describe('hand-crafting military science (D76)', () => {
  const kit: ItemStack[] = [
    { item: ItemId.IronPlate, count: 9 },
    { item: ItemId.CopperPlate, count: 5 },
    { item: ItemId.Coal, count: 10 },
    { item: ItemId.StoneBrick, count: 10 },
    { item: ItemId.SteelPlate, count: 1 },
  ];

  it('is refused before the technology', () => {
    const s = sim(
      kit,
      MILITARY_TECHS.filter((t) => t !== TechId.MilitarySciencePack),
    );
    s.enqueue({
      tick: s.tick,
      playerId: 0,
      type: 'Craft',
      recipe: RecipeId.MilitarySciencePack,
      count: 1,
    });
    steps(s, 2000);
    expect(s.state.players.inventory(0).count(MILITARY)).toBe(0);
    expect(s.state.players.inventory(0).count(ItemId.IronPlate)).toBe(9);
  });

  it('makes two packs from plates, coal, bricks and steel, with every intermediate', () => {
    const s = sim(kit, MILITARY_TECHS);
    s.enqueue({
      tick: s.tick,
      playerId: 0,
      type: 'Craft',
      recipe: RecipeId.MilitarySciencePack,
      count: 1,
    });
    // Magazine 60, piercing 180, grenade 480, two walls 2 × 30, the pack 600.
    const total = 60 + 180 + 480 + 2 * 30 + 600;
    steps(s, total - 1);
    const inv = s.state.players.inventory(0);
    expect(inv.count(MILITARY)).toBe(0);
    s.step();
    expect(inv.count(MILITARY)).toBe(2);
    for (const item of [
      ItemId.IronPlate,
      ItemId.CopperPlate,
      ItemId.Coal,
      ItemId.SteelPlate,
      ItemId.FirearmMagazine,
      ItemId.PiercingRoundsMagazine,
      ItemId.Grenade,
      ItemId.StoneWall,
    ]) {
      expect(inv.count(item)).toBe(0);
    }
    expect(inv.count(ItemId.StoneBrick)).toBe(0);
  });
});

describe('steel in a stone furnace (D76)', () => {
  function furnaceSim(researched: readonly number[]) {
    const s = sim(
      [
        { item: ItemId.StoneFurnace, count: 1 },
        { item: ItemId.IronPlate, count: 100 },
        { item: ItemId.Coal, count: 10 },
      ],
      researched,
    );
    expect(placeEntity(s.state, 0, ItemId.StoneFurnace, 2, 0, Direction.North)).toBe(
      BuildResult.Ok,
    );
    const id = s.state.entities.at(2, 0);
    return { s, id, slot: (i: number) => s.state.entities.slots(id)[i]! };
  }

  it('takes no iron plates before steel processing', () => {
    const { s, id } = furnaceSim([]);
    const { entities } = s.state;
    expect(entities.insertable(id, ItemId.IronPlate)).toBe(0);
    expect(furnaceTable(entities)!.accepts(id, ItemId.IronPlate)).toBe(false);
    expect(insertIntoEntity(s.state, 0, id, ItemId.IronPlate, 10)).toBe(TransferResult.NoRoom);
    expect(s.state.players.inventory(0).count(ItemId.IronPlate)).toBe(100);
  });

  it('smelts 5 iron plates into 1 steel plate in 960 ticks once researched', () => {
    const { s, id, slot } = furnaceSim([TechId.SteelProcessing]);
    const { entities } = s.state;
    expect(furnaceTable(entities)!.accepts(id, ItemId.IronPlate)).toBe(true);
    expect(entities.insertable(id, ItemId.IronPlate)).toBe(100);
    expect(insertIntoEntity(s.state, 0, id, ItemId.Coal, 2)).toBe(TransferResult.Ok);
    expect(insertIntoEntity(s.state, 0, id, ItemId.IronPlate, 10)).toBe(TransferResult.Ok);
    steps(s, STEEL_SMELTING_TICKS - 1);
    expect(entities.status(id)).toBe(MachineState.Working);
    expect(slot(FurnaceSlot.Output).count).toBe(0);
    s.step();
    expect(slot(FurnaceSlot.Output)).toEqual({ item: ItemId.SteelPlate, count: 1 });
    // The second craft takes its 5 plates when it starts, on the next tick.
    expect(slot(FurnaceSlot.Input)).toEqual({ item: ItemId.IronPlate, count: 5 });
    steps(s, STEEL_SMELTING_TICKS);
    expect(slot(FurnaceSlot.Output)).toEqual({ item: ItemId.SteelPlate, count: 2 });
  });

  it('takes two crafts’ worth of plates from an inserter, enough for a full steel craft (D75)', () => {
    const { s, id } = furnaceSim([TechId.SteelProcessing]);
    const { entities } = s.state;
    expect(entities.insertable(id, ItemId.IronPlate, true)).toBe(2 * 5);
    expect(entities.insert(id, ItemId.IronPlate, 7, true)).toBe(7);
    expect(entities.insertable(id, ItemId.IronPlate, true)).toBe(3);
    expect(furnaceSim([]).s.state.entities.insertable(id, ItemId.IronPlate, true)).toBe(0);
  });

  it('starts taking iron plates the moment steel processing completes', () => {
    const { s, id } = furnaceSim([]);
    expect(s.state.entities.insertable(id, ItemId.IronPlate)).toBe(0);
    s.state.research.markResearched(0, TechId.SteelProcessing);
    expect(s.state.entities.insertable(id, ItemId.IronPlate)).toBe(100);
  });
});

describe('inserters asleep on a furnace’s source when steel processing completes (D76)', () => {
  // A source -> burner inserter on (3, 0) facing east -> fuelled stone
  // furnace on (4..5, 0..1). Before steel processing the furnace takes no
  // plates, so the inserter goes to sleep on its source; nothing about the
  // source changes after that, so only the research can wake it.
  function line(source: (s: Sim) => number) {
    const s = sim([
      { item: ItemId.BurnerInserter, count: 1 },
      { item: ItemId.WoodenChest, count: 1 },
      { item: ItemId.TransportBelt, count: 10 },
      { item: ItemId.StoneFurnace, count: 1 },
    ]);
    const { state } = s;
    const { entities } = state;
    const src = source(s);
    expect(placeEntity(state, 0, ItemId.BurnerInserter, 3, 0, Direction.East)).toBe(BuildResult.Ok);
    const ins = entities.at(3, 0);
    expect(placeEntity(state, 0, ItemId.StoneFurnace, 4, 0, Direction.North)).toBe(BuildResult.Ok);
    const furnace = entities.at(4, 0);
    entities.insert(ins, ItemId.Coal, 5);
    entities.insert(furnace, ItemId.Coal, 5);
    return { s, src, ins, furnace };
  }

  function chestOfPlates(s: Sim): number {
    expect(placeEntity(s.state, 0, ItemId.WoodenChest, 2, 0, Direction.North)).toBe(BuildResult.Ok);
    const chest = s.state.entities.at(2, 0);
    s.state.entities.insert(chest, ItemId.IronPlate, 50);
    return chest;
  }

  /** A belt from (-3, 0) east to (2, 0), where it ends, backed up with plates. */
  function stalledBeltOfPlates(s: Sim): number {
    s.state.players.y[0] = tileCenter(4); // off the belt
    for (let x = -3; x <= 2; x++) {
      expect(placeEntity(s.state, 0, ItemId.TransportBelt, x, 0, Direction.East)).toBe(
        BuildResult.Ok,
      );
    }
    const belts = beltTable(s.state.entities)!;
    const first = s.state.entities.at(-3, 0);
    const pos = belts.beltOffset(first) + BELT_LENGTH / 2;
    for (let t = 0; t < 600; t++) {
      belts.insertAt(belts.beltLine(first), BeltLane.Left, pos, ItemId.IronPlate);
      belts.insertAt(belts.beltLine(first), BeltLane.Right, pos, ItemId.IronPlate);
      s.step();
    }
    return s.state.entities.at(2, 0);
  }

  /** Asleep on its source, the furnace input empty. */
  function expectAsleepOn(s: Sim, ins: number, src: number, furnace: number): void {
    const { entities } = s.state;
    expect(inserterTable(entities)!.status(ins)).toBe(InserterState.WaitingForSource);
    expect(entities.wake.watchersOf(src)).toEqual([ins]);
    expect(entities.slots(furnace)[FurnaceSlot.Input]!.count).toBe(0);
  }

  const sources = [
    ['a chest of iron plates', chestOfPlates],
    ['a stalled full belt of iron plates', stalledBeltOfPlates],
  ] as const;
  const completions = [
    // Labs finishing its last unit (`ResearchState.completeUnit`).
    [
      'labs complete it',
      (s: Sim) => {
        const r = s.state.research;
        while (!r.isResearched(0, TechId.SteelProcessing))
          r.completeUnit(0, TechId.SteelProcessing);
      },
    ],
    // Without labs (tests and tools: `markResearched`).
    [
      'it is marked researched',
      (s: Sim) => s.state.research.markResearched(0, TechId.SteelProcessing),
    ],
  ] as const;

  for (const [what, source] of sources) {
    for (const [how, complete] of completions) {
      it(`makes steel from ${what} once ${how}`, () => {
        const { s, src, ins, furnace } = line(source);
        steps(s, 300);
        expectAsleepOn(s, ins, src, furnace);
        // Asleep, it would stay so: a whole steel craft's time changes nothing.
        steps(s, STEEL_SMELTING_TICKS);
        expectAsleepOn(s, ins, src, furnace);
        complete(s);
        steps(s, 3000);
        expect(s.state.entities.slots(furnace)[FurnaceSlot.Output]!.item).toBe(ItemId.SteelPlate);
        expect(s.state.entities.slots(furnace)[FurnaceSlot.Output]!.count).toBeGreaterThan(0);
      });
    }
  }

  it('wakes every furnace, not only the first: three furnaces fed from chests and a stalled belt make steel', () => {
    const s = sim([
      { item: ItemId.BurnerInserter, count: 3 },
      { item: ItemId.WoodenChest, count: 2 },
      { item: ItemId.TransportBelt, count: 10 },
      { item: ItemId.StoneFurnace, count: 3 },
    ]);
    const { state } = s;
    const { entities } = state;
    state.players.y[0] = tileCenter(3);
    const furnaces: number[] = [];
    const inserters: number[] = [];
    const sourcesOf: number[] = [];
    // Lines at y = 0 and 3 start from a chest, the line at y = 6 from a belt.
    for (const y of [0, 3, 6]) {
      if (y === 6) {
        for (let x = -3; x <= 2; x++) {
          expect(placeEntity(state, 0, ItemId.TransportBelt, x, y, Direction.East)).toBe(
            BuildResult.Ok,
          );
        }
      } else {
        expect(placeEntity(state, 0, ItemId.WoodenChest, 2, y, Direction.North)).toBe(
          BuildResult.Ok,
        );
        entities.insert(entities.at(2, y), ItemId.IronPlate, 50);
      }
      expect(placeEntity(state, 0, ItemId.BurnerInserter, 3, y, Direction.East)).toBe(
        BuildResult.Ok,
      );
      expect(placeEntity(state, 0, ItemId.StoneFurnace, 4, y, Direction.North)).toBe(
        BuildResult.Ok,
      );
      const ins = entities.at(3, y);
      const furnace = entities.at(4, y);
      entities.insert(ins, ItemId.Coal, 5);
      entities.insert(furnace, ItemId.Coal, 5);
      inserters.push(ins);
      furnaces.push(furnace);
      sourcesOf.push(entities.at(2, y));
    }
    const belts = beltTable(entities)!;
    const first = entities.at(-3, 6);
    const pos = belts.beltOffset(first) + BELT_LENGTH / 2;
    for (let t = 0; t < 600; t++) {
      belts.insertAt(belts.beltLine(first), BeltLane.Left, pos, ItemId.IronPlate);
      belts.insertAt(belts.beltLine(first), BeltLane.Right, pos, ItemId.IronPlate);
      s.step();
    }
    steps(s, 300);
    // All three furnaces and their inserters are asleep before the research.
    for (let i = 0; i < 3; i++) {
      expectAsleepOn(s, inserters[i]!, sourcesOf[i]!, furnaces[i]!);
    }
    state.research.markResearched(0, TechId.SteelProcessing);
    steps(s, 3000);
    for (const furnace of furnaces) {
      expect(entities.slots(furnace)[FurnaceSlot.Output]!.item).toBe(ItemId.SteelPlate);
      expect(entities.slots(furnace)[FurnaceSlot.Output]!.count).toBeGreaterThan(0);
    }
  });

  it('wakes nothing for a technology that unlocks no smelting recipe', () => {
    const { s, src, ins, furnace } = line(chestOfPlates);
    steps(s, 300);
    s.state.research.markResearched(0, TechId.StoneWall);
    // Woken, it would leave the sleep list only after a step.
    expect(inserterTable(s.state.entities)!.activeCount).toBe(0);
    steps(s, 10);
    expectAsleepOn(s, ins, src, furnace);
  });

  it('wakes nothing when steel processing is marked researched again', () => {
    // An empty chest: asleep on its source with steel processing done.
    const { s, src, ins } = line((t) => {
      t.state.research.markResearched(0, TechId.SteelProcessing);
      expect(placeEntity(t.state, 0, ItemId.WoodenChest, 2, 0, Direction.North)).toBe(
        BuildResult.Ok,
      );
      return t.state.entities.at(2, 0);
    });
    steps(s, 10);
    expect(inserterTable(s.state.entities)!.status(ins)).toBe(InserterState.WaitingForSource);
    expect(s.state.entities.wake.watchersOf(src)).toEqual([ins]);
    expect(inserterTable(s.state.entities)!.activeCount).toBe(0);
    s.state.research.markResearched(0, TechId.SteelProcessing);
    expect(inserterTable(s.state.entities)!.activeCount).toBe(0);
  });
});

describe('labs and the military science pack (D76)', () => {
  it('have a slot for it', () => {
    expect(SCIENCE_PACKS).toEqual([RED, GREEN, MILITARY]);
    expect(LAB_SLOTS).toBe(3);
    expect(labSlotOf(MILITARY)).toBe(2);
  });

  // A chest -> burner inserter on (3, 0) facing east -> lab on (4..6, 0..2),
  // without power, so it never uses a pack: only the inserter moves them.
  function labLine(research: number) {
    const s = sim(
      [
        { item: ItemId.BurnerInserter, count: 1 },
        { item: ItemId.WoodenChest, count: 1 },
        { item: ItemId.Lab, count: 1 },
      ],
      [TechId.Automation, TechId.Logistics, TechId.LogisticSciencePack],
    );
    const { state } = s;
    const { entities } = state;
    const place = (item: number, x: number) => {
      expect(placeEntity(state, 0, item, x, 0, Direction.East)).toBe(BuildResult.Ok);
      return entities.at(x, 0);
    };
    const chest = place(ItemId.WoodenChest, 2);
    const ins = place(ItemId.BurnerInserter, 3);
    const lab = place(ItemId.Lab, 4);
    entities.insert(ins, ItemId.Coal, 5);
    expect(setResearch(state, 0, research)).toBe(true);
    return { s, chest, ins, lab };
  }

  it('let an inserter feeding a full lab sleep on the lab alone, whatever its unused military slot (counters)', () => {
    // Research red + green; the lab's red and green slots full (D75), its
    // military slot empty. The chest offers only red and green.
    const { s, chest, ins, lab } = labLine(TechId.Logistics2);
    const { entities } = s.state;
    expect(entities.insert(lab, RED, LAB_INSERTER_LIMIT, true)).toBe(LAB_INSERTER_LIMIT);
    expect(entities.insert(lab, GREEN, LAB_INSERTER_LIMIT, true)).toBe(LAB_INSERTER_LIMIT);
    entities.insert(chest, RED, 10);
    entities.insert(chest, GREEN, 10);
    steps(s, 10);
    expect(entities.hasRoom(lab)).toBe(false);
    expect(entities.status(ins)).toBe(InserterState.WaitingForTarget);
    expect(entities.wake.watchersOf(lab)).toEqual([ins]);
    expect(entities.wake.watchersOf(chest)).toEqual([]);
    // The chest changing every tick (another inserter filling it, say) wakes
    // it no more: 0 inserter steps in 100 ticks, not one a tick.
    const table = inserterTable(entities)!;
    let stepped = 0;
    for (let t = 0; t < 100; t++) {
      entities.insert(chest, RED, 1);
      s.step();
      stepped += table.steppedCount;
    }
    expect(stepped).toBe(0);
    // A free slot the research uses still counts.
    expect(entities.take(lab, labSlotOf(GREEN), 1)).toBe(1);
    expect(entities.hasRoom(lab)).toBe(true);
  });

  it('wake an inserter asleep on a lab when the research switches to one using more packs', () => {
    // Research red only (military), the red slot full: the inserter sleeps on the lab
    // alone, so green arriving in the chest doesn't wake it (unused).
    const { s, chest, ins, lab } = labLine(TechId.Military);
    const { entities } = s.state;
    expect(entities.insert(lab, RED, LAB_INSERTER_LIMIT, true)).toBe(LAB_INSERTER_LIMIT);
    entities.insert(chest, RED, 10);
    steps(s, 10);
    expect(entities.wake.watchersOf(chest)).toEqual([]);
    expect(entities.wake.watchersOf(lab)).toEqual([ins]);
    entities.insert(chest, GREEN, 10);
    steps(s, 100);
    expect(entities.slots(lab)[labSlotOf(GREEN)]!.count).toBe(0);
    // Red + green now: the green slot counts, and the green goes in.
    expect(setResearch(s.state, 0, TechId.Logistics2)).toBe(true);
    steps(s, 300);
    expect(entities.slots(lab)[labSlotOf(GREEN)]!.count).toBe(LAB_INSERTER_LIMIT);
  });

  it('count no room with no current research', () => {
    const { s, lab } = labLine(TechId.Military);
    expect(s.state.entities.hasRoom(lab)).toBe(true);
    expect(setResearch(s.state, 0, 0)).toBe(true);
    expect(s.state.entities.hasRoom(lab)).toBe(false);
  });
});

describe('saves with military science (D76)', () => {
  it('round-trip steel in a furnace and the new items in an inventory', () => {
    const s = sim(
      [
        { item: ItemId.StoneFurnace, count: 1 },
        { item: ItemId.IronPlate, count: 50 },
        { item: ItemId.Coal, count: 10 },
        { item: ItemId.StoneWall, count: 3 },
        { item: ItemId.Grenade, count: 4 },
        { item: MILITARY, count: 7 },
      ],
      [TechId.SteelProcessing],
    );
    expect(placeEntity(s.state, 0, ItemId.StoneFurnace, 2, 0, Direction.North)).toBe(
      BuildResult.Ok,
    );
    const id = s.state.entities.at(2, 0);
    insertIntoEntity(s.state, 0, id, ItemId.Coal, 2);
    insertIntoEntity(s.state, 0, id, ItemId.IronPlate, 20);
    steps(s, 500);
    const loaded = reload(s);
    expect(loaded.state.players.inventory(0).count(MILITARY)).toBe(7);
    expect(loaded.state.players.inventory(0).count(ItemId.StoneWall)).toBe(3);
    expect(loaded.state.entities.slots(id)[FurnaceSlot.Input]).toEqual({
      item: ItemId.IronPlate,
      count: 15,
    });
    // The loaded furnace still knows steel processing is researched.
    expect(loaded.state.entities.insertable(id, ItemId.IronPlate)).toBe(85);
    expectRoundTrip(s, 1200);
  });
});

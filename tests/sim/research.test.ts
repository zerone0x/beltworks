import { describe, expect, it } from 'vitest';
import { ENTITIES, EntityTypeId, SAT_ONE } from '../../src/data/entities';
import { ItemId, type ItemStack } from '../../src/data/items';
import { HAND_RECIPES, RECIPE_IDS, RecipeId, recipePrototype } from '../../src/data/recipes';
import { ResourceId } from '../../src/data/resources';
import { STARTING_KIT } from '../../src/data/start';
import {
  SCIENCE_PACKS,
  TECH_IDS,
  TECHNOLOGIES,
  TechId,
  technologyDepth,
  technologyPrototype,
  unlockingTechnology,
} from '../../src/data/technologies';
import { BuildResult, placeEntity, removeEntity } from '../../src/sim/entities/build';
import { Direction } from '../../src/sim/entities/direction';
import { MachineState } from '../../src/sim/entities/machine';
import { createEntityTables } from '../../src/sim/entities/registry';
import type { EntityTypeTable } from '../../src/sim/entities/table';
import { TransferResult, insertIntoEntity, takeFromEntity } from '../../src/sim/entities/transfer';
import { tileCenter } from '../../src/sim/fixed';
import { labTable } from '../../src/sim/research/lab';
import { ResearchState } from '../../src/sim/research/research';
import { isRecipeUnlocked } from '../../src/sim/research/unlocks';
import {
  NO_RESEARCH,
  decodeEntityDetail,
  decodeResearch,
  encodeEntityDetail,
  encodeResearch,
  isResearchedIn,
  researchUnlocks,
} from '../../src/sim/snapshot';
import { hashState } from '../../src/sim/state';
import { Sim } from '../../src/sim/tick';
import { CHUNK_MASK, CHUNK_SHIFT, tileIndex } from '../../src/sim/world/chunk';

const { North, East } = Direction;
const RED = ItemId.AutomationSciencePack;
const GREEN = ItemId.LogisticSciencePack;
const LAB_W = ENTITIES[EntityTypeId.Lab].energyPerTick!;
const AUTOMATION = TECHNOLOGIES[TechId.Automation];

/** A fake power producer (on the steam engine's footprint) offering exactly what the test sets. */
class FakeProducers implements EntityTypeTable {
  readonly type = EntityTypeId.SteamEngine;
  readonly max = new Map<number, number>();
  add(): void {}
  remove(): void {}
  contents(): readonly ItemStack[] {
    return [];
  }
  hashInto(h: number): number {
    return h;
  }
  powerMaxOutput(id: number): number {
    return this.max.get(id) ?? 0;
  }
  powerDraw(): void {}
}

/**
 * A sim whose player 0 stands on tile (0, 0) with labs, packs and poles, a
 * fake producer offering `supply` J/tick on (-3..-1, 3..7) (none for
 * `null`), `labs` labs in a row from (2, 0) (3 tiles apart), and poles so
 * they share one network with the producer.
 */
function rig(options: { labs?: number; supply?: number | null; researched?: number[] } = {}) {
  const producers = new FakeProducers();
  const sim = new Sim({
    seed: 1,
    startingKit: [
      { item: ItemId.Lab, count: 10 },
      { item: RED, count: 200 },
      { item: GREEN, count: 200 },
      { item: ItemId.SmallElectricPole, count: 10 },
      { item: ItemId.ElectricInserter, count: 4 },
      { item: ItemId.WoodenChest, count: 4 },
    ],
    entityTables: [
      ...createEntityTables().filter((t) => t.type !== EntityTypeId.SteamEngine),
      producers,
    ],
    ...(options.researched && { researched: options.researched }),
  });
  const { state } = sim;
  state.players.x[0] = tileCenter(0);
  state.players.y[0] = tileCenter(0);
  for (let y = -8; y <= 8; y++) {
    for (let x = -8; x <= 12; x++) {
      const chunk = state.world.getChunk(x >> CHUNK_SHIFT, y >> CHUNK_SHIFT);
      const i = tileIndex(x & CHUNK_MASK, y & CHUNK_MASK);
      chunk.resource[i] = ResourceId.None;
      chunk.amount[i] = 0;
    }
  }
  const { entities } = state;
  const place = (item: number, x: number, y: number, dir: Direction = North) => {
    expect(placeEntity(state, 0, item, x, y, dir)).toBe(BuildResult.Ok);
    return entities.at(x, y);
  };
  const n = options.labs ?? 1;
  const labs: number[] = [];
  // Over the producer and the first lab.
  place(ItemId.SmallElectricPole, 0, 4);
  for (let i = 0; i < n; i++) {
    labs.push(place(ItemId.Lab, 2 + 3 * i, 0));
    place(ItemId.SmallElectricPole, 3 + 3 * i, 3);
  }
  const supply = options.supply === undefined ? n * LAB_W : options.supply;
  if (supply !== null) {
    const id = entities.add(ENTITIES[EntityTypeId.SteamEngine], -3, 3, North);
    producers.max.set(id, supply);
  }
  const table = labTable(entities)!;
  const command = (c: Record<string, unknown>) => {
    sim.enqueue({ tick: sim.tick, playerId: 0, ...c } as Parameters<Sim['enqueue']>[0]);
  };
  return {
    sim,
    state,
    entities,
    table,
    labs,
    place,
    inventory: state.players.inventory(0),
    command,
    research: (tech: number) => {
      command({ type: 'SetResearch', tech });
    },
    feed: (lab: number, item: number, count: number) => {
      expect(insertIntoEntity(state, 0, lab, item, count)).toBe(TransferResult.Ok);
    },
    units: (tech: number) => state.research.unitsDone(0, tech),
    step: (n = 1) => {
      for (let i = 0; i < n; i++) sim.step();
    },
  };
}

/** Steps `r` until `done()` or `limit` ticks; returns the ticks run. */
function ticksUntil(r: ReturnType<typeof rig>, done: () => boolean, limit = 100_000): number {
  let ticks = 0;
  while (!done() && ticks < limit) {
    r.step();
    ticks++;
  }
  return ticks;
}

describe('technology data', () => {
  it('has prerequisites that exist and come first, and no cycles', () => {
    expect(TECH_IDS.length).toBeGreaterThanOrEqual(8);
    expect(TECH_IDS).toEqual([...TECH_IDS].sort((a, b) => a - b));
    const names = new Set<string>();
    for (const id of TECH_IDS) {
      const t = TECHNOLOGIES[id];
      expect(t.id).toBe(id);
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
      for (const p of t.prerequisites) {
        expect(technologyPrototype(p)).toBeDefined();
        expect(p).toBeLessThan(id);
      }
      expect(Number.isInteger(t.units) && t.units > 0).toBe(true);
      expect(Number.isInteger(t.ticksPerUnit) && t.ticksPerUnit > 0).toBe(true);
      expect(technologyDepth(id)).toBe(
        Math.max(-1, ...t.prerequisites.map((p) => technologyDepth(p))) + 1,
      );
    }
  });

  it('costs red, or red and green behind the logistic science pack', () => {
    const ancestors = (id: number): Set<number> => {
      const out = new Set<number>();
      for (const p of technologyPrototype(id)!.prerequisites) {
        out.add(p);
        for (const a of ancestors(p)) out.add(a);
      }
      return out;
    };
    for (const id of TECH_IDS) {
      const { packs } = TECHNOLOGIES[id];
      expect([[RED], [RED, GREEN]]).toContainEqual(packs);
      expect(packs.every((p) => SCIENCE_PACKS.includes(p))).toBe(true);
      if (packs.includes(GREEN)) expect(ancestors(id).has(TechId.LogisticSciencePack)).toBe(true);
    }
    // Express belts stay behind a red and green technology.
    const express = technologyPrototype(unlockingTechnology(RecipeId.ExpressTransportBelt))!;
    expect(express.packs).toEqual([RED, GREEN]);
  });

  it('unlocks each locked hand recipe from one technology, and the M1/M2 recipes from the start', () => {
    const seen = new Set<number>();
    for (const id of TECH_IDS) {
      for (const r of TECHNOLOGIES[id].unlocks) {
        expect(recipePrototype(r)?.category).toBe('hand');
        expect(seen.has(r)).toBe(false);
        seen.add(r);
        expect(unlockingTechnology(r)).toBe(id);
      }
    }
    const fromStart = [
      ...RECIPE_IDS.filter((r) => r <= RecipeId.ElectricInserter),
      RecipeId.IronChest,
      RecipeId.Lab,
      RecipeId.AutomationSciencePack,
    ];
    for (const r of fromStart) expect(unlockingTechnology(r)).toBe(TechId.None);
    // Everything in the starting kit can be crafted from the start.
    for (const { item } of STARTING_KIT) {
      const recipe = HAND_RECIPES.find((r) => r.outputs[0]![0] === item);
      if (recipe) expect(unlockingTechnology(recipe.id)).toBe(TechId.None);
    }
    expect(unlockingTechnology(RecipeId.LogisticSciencePack)).toBe(TechId.LogisticSciencePack);
    expect(unlockingTechnology(999)).toBe(TechId.None);
  });
});

describe('research state', () => {
  it('needs prerequisites, and a researched technology is done for good', () => {
    const r = new ResearchState();
    expect(r.isAvailable(0, TechId.Automation)).toBe(true);
    expect(r.isAvailable(0, TechId.Electronics)).toBe(false);
    expect(r.setCurrent(0, TechId.Electronics)).toBe(false);
    expect(r.setCurrent(0, 999)).toBe(false);
    expect(r.setCurrent(1, TechId.Automation)).toBe(false);
    expect(r.setCurrent(0, TechId.Automation)).toBe(true);
    expect(r.setCurrent(0, TechId.Automation)).toBe(false);
    for (let i = 1; i < AUTOMATION.units; i++) {
      expect(r.completeUnit(0, TechId.Automation)).toBe(false);
    }
    expect(r.isResearched(0, TechId.Automation)).toBe(false);
    expect(r.completeUnit(0, TechId.Automation)).toBe(true);
    expect(r.isResearched(0, TechId.Automation)).toBe(true);
    expect(r.currentOf(0)).toBe(0);
    // Done: no more units, and it can't be picked again.
    expect(r.completeUnit(0, TechId.Automation)).toBe(false);
    expect(r.unitsDone(0, TechId.Automation)).toBe(AUTOMATION.units);
    expect(r.setCurrent(0, TechId.Automation)).toBe(false);
    // Electronics needs only automation; automation 2 also the green pack.
    expect(r.isAvailable(0, TechId.Electronics)).toBe(true);
    expect(r.isAvailable(0, TechId.Automation2)).toBe(false);
    r.markResearched(0, TechId.Electronics);
    expect(r.isAvailable(0, TechId.Automation2)).toBe(false);
    r.markResearched(0, TechId.LogisticSciencePack);
    expect(r.isAvailable(0, TechId.Automation2)).toBe(true);
  });

  it('takes SetResearch commands from players only, and hashes the research', () => {
    const r = rig();
    const before = hashState(r.state);
    r.command({ type: 'SetResearch', tech: TechId.Electronics });
    r.command({ type: 'SetResearch', tech: TechId.Automation, playerId: 5 });
    r.step();
    expect(r.state.research.currentOf(0)).toBe(0);
    r.research(TechId.Automation);
    r.step();
    expect(r.state.research.currentOf(0)).toBe(TechId.Automation);
    expect(hashState(r.state)).not.toBe(before);
    r.research(0);
    r.step();
    expect(r.state.research.currentOf(0)).toBe(0);
    expect(() => {
      r.command({ type: 'SetResearch', tech: -1 });
    }).toThrow();
  });

  it('starts new games with the researched technologies asked for', () => {
    const r = rig({ researched: [TechId.Automation, TechId.Logistics] });
    expect(r.state.research.isResearched(0, TechId.Automation)).toBe(true);
    expect(r.state.research.isResearched(0, TechId.Electronics)).toBe(false);
    expect(isRecipeUnlocked(r.state, 0, RecipeId.UndergroundBelt)).toBe(true);
    expect(isRecipeUnlocked(r.state, 0, RecipeId.FastInserter)).toBe(false);
  });
});

describe('unlocks', () => {
  it('gate hand crafting, intermediates included', () => {
    const r = rig();
    const inv = r.inventory;
    inv.add(ItemId.ElectronicCircuit, 20);
    inv.add(ItemId.IronGearWheel, 40);
    inv.add(ItemId.IronPlate, 100);
    inv.add(ItemId.CopperPlate, 1);
    const craft = (recipe: number) => {
      r.command({ type: 'Craft', recipe, count: 1 });
      r.step();
    };
    craft(RecipeId.AssemblingMachine1);
    expect(r.state.crafting.size(0)).toBe(0);
    expect(inv.count(ItemId.IronPlate)).toBe(100);
    // Assembling machine 2 researched, but not the machine 1 it is made from:
    // the machine 1 is not auto-queued.
    r.state.research.markResearched(0, TechId.Automation2);
    craft(RecipeId.AssemblingMachine2);
    expect(r.state.crafting.size(0)).toBe(0);
    r.state.research.markResearched(0, TechId.Automation);
    craft(RecipeId.AssemblingMachine2);
    expect(r.state.crafting.size(0)).toBe(2);
    // Basic recipes need nothing.
    craft(RecipeId.AutomationSciencePack);
    expect(r.state.crafting.size(0)).toBe(3);
  });

  it('follow the snapshot on the main thread', () => {
    const r = rig();
    const research = () => decodeResearch(encodeResearch(r.state, 0).buffer);
    expect(researchUnlocks(research(), RecipeId.AssemblingMachine1)).toBe(false);
    expect(researchUnlocks(NO_RESEARCH, RecipeId.IronGearWheel)).toBe(true);
    r.state.research.markResearched(0, TechId.Automation);
    expect(researchUnlocks(research(), RecipeId.AssemblingMachine1)).toBe(true);
    expect(isResearchedIn(research(), TechId.Automation)).toBe(true);
    expect(isResearchedIn(research(), TechId.Logistics)).toBe(false);
  });
});

describe('labs', () => {
  it('research a unit in exactly ticksPerUnit ticks, and a technology in units × that', () => {
    const r = rig();
    const [lab] = r.labs as [number];
    r.feed(lab, RED, 50);
    r.research(TechId.Automation);
    const done: number[] = [];
    let units = 0;
    for (let t = 0; t < AUTOMATION.units * AUTOMATION.ticksPerUnit; t++) {
      r.step();
      if (r.units(TechId.Automation) !== units) {
        units = r.units(TechId.Automation);
        done.push(t);
      }
    }
    expect(done).toEqual(
      Array.from({ length: AUTOMATION.units }, (_, i) => (i + 1) * AUTOMATION.ticksPerUnit - 1),
    );
    expect(r.state.research.isResearched(0, TechId.Automation)).toBe(true);
    expect(r.state.research.currentOf(0)).toBe(0);
    // One pack per unit, and nothing more once it is done.
    expect(r.entities.slots(lab)[0]).toEqual({ item: RED, count: 50 - AUTOMATION.units });
    r.step(5);
    expect(r.entities.status(lab)).toBe(MachineState.NoResearch);
    expect(r.table.activeCount).toBe(0);
    expect(r.entities.slots(lab)[0]!.count).toBe(50 - AUTOMATION.units);
    expect(isRecipeUnlocked(r.state, 0, RecipeId.AssemblingMachine1)).toBe(true);
  });

  it('add up: two labs research two units at once', () => {
    const r = rig({ labs: 2 });
    for (const lab of r.labs) r.feed(lab, RED, 10);
    r.research(TechId.Automation);
    const ticks = ticksUntil(r, () => r.state.research.isResearched(0, TechId.Automation));
    expect(ticks).toBe((AUTOMATION.units / 2) * AUTOMATION.ticksPerUnit);
    // Each took half the packs.
    for (const lab of r.labs) expect(r.entities.slots(lab)[0]!.count).toBe(5);
  });

  it('never start more units than are left (three labs, ten units)', () => {
    const r = rig({ labs: 3 });
    for (const lab of r.labs) r.feed(lab, RED, 10);
    r.research(TechId.Automation);
    const ticks = ticksUntil(r, () => r.state.research.isResearched(0, TechId.Automation));
    expect(ticks).toBe(Math.ceil(AUTOMATION.units / 3) * AUTOMATION.ticksPerUnit);
    const used = r.labs.reduce((n, lab) => n + 10 - r.entities.slots(lab)[0]!.count, 0);
    expect(used).toBe(AUTOMATION.units);
    // In the last round one lab works on the last unit; the others had nothing to research.
    expect(r.labs.map((lab) => r.entities.slots(lab)[0]!.count).sort()).toEqual([6, 7, 7]);
  });

  it('take twice as long at half power, and draw half their energy', () => {
    const r = rig({ supply: LAB_W / 2 });
    const [lab] = r.labs as [number];
    r.feed(lab, RED, 10);
    r.research(TechId.Automation);
    r.step();
    expect(r.state.entities.status(lab)).toBe(MachineState.Working);
    const detail = decodeEntityDetail(encodeEntityDetail(r.state, 0, lab)!.buffer);
    expect(detail.power).toBe(LAB_W / 2);
    expect(detail.satisfaction).toBe(SAT_ONE / 2);
    expect(detail.technology).toBe(TechId.Automation);
    const ticks = 1 + ticksUntil(r, () => r.state.research.isResearched(0, TechId.Automation));
    expect(ticks).toBe(2 * AUTOMATION.units * AUTOMATION.ticksPerUnit);
  });

  it('report NoResearch, NoInput and NoPower, and draw nothing while idle', () => {
    const r = rig({ supply: null });
    const [lab] = r.labs as [number];
    r.step();
    expect(r.entities.status(lab)).toBe(MachineState.NoResearch);
    r.research(TechId.Automation);
    r.step();
    expect(r.entities.status(lab)).toBe(MachineState.NoInput);
    // Green packs alone don't do for a red technology.
    r.feed(lab, GREEN, 5);
    r.step();
    expect(r.entities.status(lab)).toBe(MachineState.NoInput);
    r.feed(lab, RED, 5);
    r.step(3);
    expect(r.entities.status(lab)).toBe(MachineState.NoPower);
    expect(r.table.activeCount).toBe(1);
    expect(r.table.unitTech(lab)).toBe(0);
    expect(r.entities.slots(lab)).toEqual([
      { item: RED, count: 5 },
      { item: GREEN, count: 5 },
    ]);
    // A red and green technology takes one of each.
    const g = rig({
      researched: [TechId.Automation, TechId.Electronics, TechId.LogisticSciencePack],
    });
    const [glab] = g.labs as [number];
    g.feed(glab, RED, 3);
    g.feed(glab, GREEN, 1);
    g.research(TechId.Automation2);
    g.step();
    expect(g.entities.status(glab)).toBe(MachineState.Working);
    expect(g.entities.slots(glab)).toEqual([
      { item: RED, count: 2 },
      { item: 0, count: 0 },
    ]);
    g.step(TECHNOLOGIES[TechId.Automation2].ticksPerUnit);
    expect(g.units(TechId.Automation2)).toBe(1);
    expect(g.entities.status(glab)).toBe(MachineState.NoInput);
  });

  it('keep each technology’s progress when switching research', () => {
    const r = rig();
    const [lab] = r.labs as [number];
    const T = AUTOMATION.ticksPerUnit;
    r.feed(lab, RED, 100);
    r.research(TechId.Automation);
    r.step(3 * T + 100);
    expect(r.units(TechId.Automation)).toBe(3);
    // Switch: the unit under way still counts for automation (its pack is spent).
    r.research(TechId.Logistics);
    r.step(T - 100);
    expect(r.units(TechId.Automation)).toBe(4);
    expect(r.table.unitTech(lab)).toBe(0);
    const L = TECHNOLOGIES[TechId.Logistics].ticksPerUnit;
    r.step(2 * L);
    expect(r.units(TechId.Logistics)).toBe(2);
    expect(r.units(TechId.Automation)).toBe(4);
    // Back to automation: it picks up from 4 of 10 (after the logistics unit under way).
    r.research(TechId.Automation);
    const ticks = ticksUntil(r, () => r.state.research.isResearched(0, TechId.Automation));
    expect(ticks).toBe(6 * T);
    expect(r.units(TechId.Logistics)).toBe(2);
    expect(r.entities.slots(lab)[0]!.count).toBe(100 - 10 - 2);
  });

  it('refund their packs and the unit under way when removed, freeing the unit', () => {
    const r = rig({ labs: 2 });
    const [a, b] = r.labs as [number, number];
    // Lab a gets the packs for 9 units, lab b for 1: b takes the last unit.
    r.feed(a, RED, 9);
    r.feed(b, RED, 1);
    r.research(TechId.Automation);
    r.step(10);
    expect(r.table.unitsInProgress(TechId.Automation)).toBe(2);
    const before = r.inventory.count(RED);
    expect(removeEntity(r.state, 0, 3, 1)).toBe(BuildResult.Ok);
    expect(r.inventory.count(RED)).toBe(before + 8 + 1);
    expect(r.table.unitsInProgress(TechId.Automation)).toBe(1);
    expect(r.entities.contents(b)).toEqual([{ item: RED, count: 1 }]);
    // Taking packs out works too; b has none left in its slot.
    expect(takeFromEntity(r.state, 0, b, 0, 1)).toBe(TransferResult.NothingToMove);
    expect(r.entities.insertable(b, RED)).toBe(200);
    expect(r.entities.insertable(b, ItemId.IronPlate)).toBe(0);
    expect(r.entities.accepts(b, GREEN)).toBe(true);
    expect(r.entities.outputSlot(b)).toBe(-1);
  });

  it('are filled by inserters', () => {
    const r = rig();
    // A chest of packs west of the lab, an electric inserter between them.
    const chest = r.place(ItemId.WoodenChest, 0, 1);
    r.place(ItemId.ElectricInserter, 1, 1, East);
    r.feed(chest, RED, 3);
    r.research(TechId.Automation);
    // The inserter shares the network: give it power too.
    const ticks = ticksUntil(r, () => r.units(TechId.Automation) === 1, 5_000);
    expect(ticks).toBeLessThan(5_000);
    expect(r.entities.contents(chest)).toEqual([]);
  });

  it('report their research in the snapshot', () => {
    const r = rig({ labs: 2 });
    for (const lab of r.labs) r.feed(lab, RED, 10);
    r.research(TechId.Automation);
    r.step(AUTOMATION.ticksPerUnit + 30);
    const data = decodeResearch(encodeResearch(r.state, 0).buffer);
    expect(data.current).toBe(TechId.Automation);
    expect(data.techs.get(TechId.Automation)).toEqual({
      unitsDone: 2,
      unitsInProgress: 2,
      ticksInProgress: 2 * 30,
    });
    expect(data.techs.size).toBe(TECH_IDS.length);
  });
});

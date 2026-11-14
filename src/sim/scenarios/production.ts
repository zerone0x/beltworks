/**
 * Production counters for tests and tools (the demo factory's sim test and
 * the promo capture, D72): what the factory mined, made and consumed over a
 * span of ticks. They read the simulation after every tick and never change
 * it, so they are not simulation state (nothing to save or hash).
 *
 * A drill, furnace or assembling machine counts one finished unit or craft
 * whenever its progress goes back down (a craft takes at least a few ticks,
 * so every finish is seen); a lab counts the packs of each unit it finishes.
 */

import { EntityTypeId } from '../../data/entities';
import { itemPrototype, minedItem } from '../../data/items';
import { RECIPES, type RealRecipeId, type Recipe } from '../../data/recipes';
import { technologyPrototype } from '../../data/technologies';
import type { Sim } from '../tick';

/** Counts by item name (`iron-ore`, `iron-plate`, `automation-science-pack`, ...). */
export type ItemCounts = Record<string, number>;

export interface ProductionCounts {
  /** Ticks observed. */
  ticks: number;
  /** Units mined by drills. */
  mined: ItemCounts;
  /** Items made by furnaces and assembling machines. */
  made: ItemCounts;
  /** Science packs used up by the research units labs finished. */
  consumed: ItemCounts;
}

const DRILLS: readonly number[] = [
  EntityTypeId.ElectricMiningDrill,
  EntityTypeId.BurnerMiningDrill,
];
const CRAFTERS: readonly number[] = [
  EntityTypeId.StoneFurnace,
  EntityTypeId.AssemblingMachine1,
  EntityTypeId.AssemblingMachine2,
];

const nameOf = (item: number): string => itemPrototype(item)?.name ?? String(item);

function add(counts: ItemCounts, item: number, n: number): void {
  const name = nameOf(item);
  counts[name] = (counts[name] ?? 0) + n;
}

export class ProductionCounter {
  private readonly progress = new Map<number, number>();
  private readonly ores = new Map<number, number>();
  private readonly recipes = new Map<number, number>();
  private counts: ProductionCounts = { ticks: 0, mined: {}, made: {}, consumed: {} };

  constructor(private readonly sim: Sim) {
    this.reset();
  }

  /** Starts counting again from now. */
  reset(): void {
    this.counts = { ticks: 0, mined: {}, made: {}, consumed: {} };
    this.progress.clear();
    this.recipes.clear();
    this.observe(false);
  }

  /** What was counted since the last `reset` (a copy). */
  read(): ProductionCounts {
    return structuredClone(this.counts);
  }

  /** Reads the simulation after a tick (call it after every `step`). */
  observe(count = true): void {
    const { entities } = this.sim.state;
    if (count) this.counts.ticks++;
    for (const id of entities.store.ids) {
      const type = entities.store.type(id);
      const drill = DRILLS.includes(type);
      const lab = type === EntityTypeId.Lab;
      if (!drill && !lab && !CRAFTERS.includes(type)) continue;
      const detail = entities.detail(id);
      if (!detail) continue;
      const before = this.progress.get(id);
      const recipeBefore = this.recipes.get(id) ?? 0;
      this.progress.set(id, detail.progress);
      this.recipes.set(id, lab ? (detail.technology ?? 0) : detail.recipe);
      if (!count || before === undefined || detail.progress >= before) continue;
      if (drill) {
        add(this.counts.mined, this.oreOf(id), 1);
      } else if (lab) {
        // A unit finished: it took one of each of its technology's packs.
        for (const pack of technologyPrototype(recipeBefore)?.packs ?? []) {
          add(this.counts.consumed, pack, 1);
        }
      } else {
        // The recipe of the craft that finished (a furnace's is 0 once it is idle).
        const recipe = RECIPES[recipeBefore as RealRecipeId] as Recipe | undefined;
        for (const [item, n] of recipe?.outputs ?? []) add(this.counts.made, item, n);
      }
    }
  }

  /** The item drill `id` mines: the first resource in its mining area (a demo drill stands on one ore). */
  private oreOf(id: number): number {
    const cached = this.ores.get(id);
    if (cached !== undefined) return cached;
    const { entities, world } = this.sim.state;
    const f = entities.footprint(id);
    const size = entities.prototypeOf(id)?.miningArea ?? f.w;
    const x0 = f.x + ((f.w - size) >> 1);
    const y0 = f.y + ((f.h - size) >> 1);
    let item = 0;
    for (let y = y0; y < y0 + size && item === 0; y++) {
      for (let x = x0; x < x0 + size && item === 0; x++)
        item = minedItem(world.resourceAt(x, y)) ?? 0;
    }
    this.ores.set(id, item);
    return item;
  }
}

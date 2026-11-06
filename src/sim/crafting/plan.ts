/**
 * Hand-crafting plans: what queueing `n` crafts of a recipe takes out of an
 * inventory, and which intermediate crafts it queues first.
 *
 * Pure functions over item counts, so the main thread can show the same
 * craftable counts the simulation will accept.
 *
 * Intermediates: an input the inventory lacks is auto-queued from its hand
 * recipe (recursively, up to `MAX_INTERMEDIATE_DEPTH` levels), as long as
 * that recipe makes exactly one unit of exactly one item. Then every unit an
 * intermediate entry makes is used by the craft it was queued for, which is
 * what lets the queue refund a cancelled craft without storing the
 * intermediates it already made (see src/sim/crafting/queue.ts).
 */

import { handRecipeFor, type Recipe } from '../../data/recipes';

/** Most crafts one queue entry holds (stored as a uint16). */
export const MAX_ENTRY_CRAFTS = 0xffff;
/** How deep intermediates are auto-queued (an intermediate of an intermediate is depth 2). */
export const MAX_INTERMEDIATE_DEPTH = 4;

/** One queue entry of a plan. */
export interface PlannedEntry {
  readonly recipe: Recipe;
  /** Number of crafts, in [1, MAX_ENTRY_CRAFTS]. */
  readonly crafts: number;
  /** Whether this is an intermediate, made for the next non-intermediate entry. */
  readonly intermediate: boolean;
}

export interface CraftPlan {
  /**
   * Entries in queue order: every intermediate comes before the entry that
   * uses it, and the requested recipe comes last.
   */
  readonly entries: readonly PlannedEntry[];
  /** Units to take out of the inventory, per item id. */
  readonly take: ReadonlyMap<number, number>;
}

/** The recipe auto-queued to make a missing `item`, or `undefined` if there is none. */
export function intermediateRecipeFor(item: number): Recipe | undefined {
  const recipe = handRecipeFor(item);
  if (!recipe || recipe.outputs.length !== 1 || recipe.outputs[0]![1] !== 1) {
    return undefined;
  }
  return recipe;
}

/**
 * Plans `crafts` crafts of `recipe` from the items in `available` (units per
 * item id). Inputs are taken in recipe order: what the inventory has is
 * taken, what it lacks is made by intermediates (which take their own inputs
 * the same way). Returns `null` if the items don't suffice, or an entry would
 * hold more than `MAX_ENTRY_CRAFTS` crafts.
 */
export function planCraft(
  recipe: Recipe,
  crafts: number,
  available: ReadonlyMap<number, number>,
): CraftPlan | null {
  if (!Number.isInteger(crafts) || crafts < 1 || crafts > MAX_ENTRY_CRAFTS) {
    return null;
  }
  const left = new Map(available);
  const take = new Map<number, number>();
  const entries: PlannedEntry[] = [];

  const plan = (r: Recipe, n: number, depth: number): boolean => {
    if (n > MAX_ENTRY_CRAFTS) {
      return false;
    }
    for (const [item, count] of r.inputs) {
      const want = count * n;
      const have = Math.min(left.get(item) ?? 0, want);
      if (have > 0) {
        left.set(item, (left.get(item) ?? 0) - have);
        take.set(item, (take.get(item) ?? 0) + have);
      }
      const missing = want - have;
      if (missing > 0) {
        const sub = intermediateRecipeFor(item);
        if (!sub || depth >= MAX_INTERMEDIATE_DEPTH || !plan(sub, missing, depth + 1)) {
          return false;
        }
      }
    }
    entries.push({ recipe: r, crafts: n, intermediate: depth > 0 });
    return true;
  };

  return plan(recipe, crafts, 0) ? { entries, take } : null;
}

/**
 * The most crafts of `recipe` (at most `limit`) that can be queued from
 * `available` in at most `freeEntries` queue entries. Feasibility only grows
 * harder with more crafts, so this is a binary search.
 */
export function maxCraftable(
  recipe: Recipe,
  available: ReadonlyMap<number, number>,
  freeEntries: number,
  limit: number = MAX_ENTRY_CRAFTS,
): number {
  const fits = (n: number): boolean => {
    const plan = planCraft(recipe, n, available);
    return plan !== null && plan.entries.length <= freeEntries;
  };
  let lo = 0;
  let hi = Math.min(limit, MAX_ENTRY_CRAFTS);
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Units per item id over parallel item/count columns (item 0 is skipped). */
export function countItems(
  items: ArrayLike<number>,
  counts: ArrayLike<number>,
): Map<number, number> {
  const out = new Map<number, number>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item !== 0 && counts[i]! > 0) out.set(item, (out.get(item) ?? 0) + counts[i]!);
  }
  return out;
}

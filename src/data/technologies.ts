/**
 * Technology prototypes: the research tree (docs/GDD.md, "Tech tree").
 *
 * A technology is researched in labs (src/sim/research/lab.ts): `units`
 * units, each of which takes one of every science pack in `packs` and
 * `ticksPerUnit` ticks of a lab's work at full power. It can be researched
 * once all its `prerequisites` are, and researching it unlocks its recipes
 * for the force (`isRecipeUnlocked` in src/sim/research/unlocks.ts). A
 * recipe no technology unlocks is available from the start.
 *
 * Technology ids are stored in simulation state (the current research as a
 * uint16, progress per technology), where 0 means "no technology". They must
 * stay stable: changing an id breaks saves and state hashes. Every amount
 * and duration is an integer; durations are in ticks (60 per second).
 */

import { ItemId, type RealItemId } from './items';
import { RecipeId, type RealRecipeId } from './recipes';

/** Numeric technology ids. `None` (0) marks "no technology". */
export const TechId = {
  None: 0,
  Automation: 1,
  Logistics: 2,
  Electronics: 3,
  FastInserter: 4,
  LogisticSciencePack: 5,
  Automation2: 6,
  Logistics2: 7,
  Logistics3: 8,
} as const;

export type TechId = (typeof TechId)[keyof typeof TechId];

/** Ids of real technologies, i.e. every id except {@link TechId.None}. */
export type RealTechId = Exclude<TechId, typeof TechId.None>;

export interface Technology {
  readonly id: RealTechId;
  /** Internal name, e.g. `automation`. */
  readonly name: string;
  /** Human-readable name for the UI. */
  readonly label: string;
  /** Technologies that must be researched first (all of them; lower ids). */
  readonly prerequisites: readonly RealTechId[];
  /** Science packs one unit takes: one of each, in {@link SCIENCE_PACKS} order. */
  readonly packs: readonly RealItemId[];
  /** Units to research. */
  readonly units: number;
  /** Ticks of a lab's work at full power per unit. */
  readonly ticksPerUnit: number;
  /** Recipes researching it unlocks. */
  readonly unlocks: readonly RealRecipeId[];
}

/**
 * The science packs, in the order of a lab's slots (one slot each). A lab
 * takes any of them, whatever is being researched.
 */
export const SCIENCE_PACKS: readonly RealItemId[] = [
  ItemId.AutomationSciencePack,
  ItemId.LogisticSciencePack,
];

const RED = [ItemId.AutomationSciencePack] as const;
const RED_GREEN = [ItemId.AutomationSciencePack, ItemId.LogisticSciencePack] as const;
/** Ticks per second, for readable durations below. */
const S = 60;

/** Technology prototypes keyed by id. There is no entry for id 0 ("no technology"). */
export const TECHNOLOGIES: Readonly<Record<RealTechId, Technology>> = {
  [TechId.Automation]: {
    id: TechId.Automation,
    name: 'automation',
    label: 'Automation',
    prerequisites: [],
    packs: RED,
    units: 10,
    ticksPerUnit: 10 * S,
    unlocks: [RecipeId.AssemblingMachine1, RecipeId.LongHandedInserter],
  },
  [TechId.Logistics]: {
    id: TechId.Logistics,
    name: 'logistics',
    label: 'Logistics',
    prerequisites: [],
    packs: RED,
    units: 20,
    ticksPerUnit: 15 * S,
    // Splitters (#49) join this list when they land.
    unlocks: [RecipeId.UndergroundBelt],
  },
  [TechId.Electronics]: {
    id: TechId.Electronics,
    name: 'electronics',
    label: 'Electronics',
    prerequisites: [TechId.Automation],
    packs: RED,
    units: 30,
    ticksPerUnit: 15 * S,
    // A milestone: it leads on to the faster inserters and machines.
    unlocks: [],
  },
  [TechId.FastInserter]: {
    id: TechId.FastInserter,
    name: 'fast-inserter',
    label: 'Fast inserter',
    prerequisites: [TechId.Electronics],
    packs: RED,
    units: 30,
    ticksPerUnit: 15 * S,
    unlocks: [RecipeId.FastInserter],
  },
  [TechId.LogisticSciencePack]: {
    id: TechId.LogisticSciencePack,
    name: 'logistic-science-pack',
    label: 'Logistic science pack',
    prerequisites: [TechId.Automation],
    packs: RED,
    units: 75,
    ticksPerUnit: 5 * S,
    unlocks: [RecipeId.LogisticSciencePack],
  },
  [TechId.Automation2]: {
    id: TechId.Automation2,
    name: 'automation-2',
    label: 'Automation 2',
    prerequisites: [TechId.Electronics, TechId.LogisticSciencePack],
    packs: RED_GREEN,
    units: 40,
    ticksPerUnit: 5 * S,
    unlocks: [RecipeId.AssemblingMachine2],
  },
  [TechId.Logistics2]: {
    id: TechId.Logistics2,
    name: 'logistics-2',
    label: 'Logistics 2',
    prerequisites: [TechId.Logistics, TechId.LogisticSciencePack],
    packs: RED_GREEN,
    units: 200,
    ticksPerUnit: 30 * S,
    unlocks: [RecipeId.FastTransportBelt, RecipeId.FastUndergroundBelt],
  },
  [TechId.Logistics3]: {
    id: TechId.Logistics3,
    name: 'logistics-3',
    label: 'Logistics 3',
    prerequisites: [TechId.Logistics2, TechId.Automation2],
    packs: RED_GREEN,
    units: 300,
    ticksPerUnit: 15 * S,
    unlocks: [RecipeId.ExpressTransportBelt, RecipeId.ExpressUndergroundBelt],
  },
};

/** Every real technology id, in id order (prerequisites always come first). */
export const TECH_IDS: readonly RealTechId[] = [
  TechId.Automation,
  TechId.Logistics,
  TechId.Electronics,
  TechId.FastInserter,
  TechId.LogisticSciencePack,
  TechId.Automation2,
  TechId.Logistics2,
  TechId.Logistics3,
];

/** One more than the highest technology id: the length of per-technology arrays. */
export const TECH_SLOTS = Math.max(...TECH_IDS) + 1;

/** The prototype of technology `id`, or `undefined` for 0 and unknown ids. */
export function technologyPrototype(id: number): Technology | undefined {
  return (TECHNOLOGIES as Readonly<Record<number, Technology | undefined>>)[id];
}

const UNLOCKED_BY = new Map<number, RealTechId>();
for (const id of TECH_IDS) {
  for (const recipe of TECHNOLOGIES[id].unlocks) UNLOCKED_BY.set(recipe, id);
}

/**
 * The technology that unlocks recipe `recipe`, or {@link TechId.None} for a
 * recipe that is available from the start (and for unknown ids).
 */
export function unlockingTechnology(recipe: number): TechId {
  return UNLOCKED_BY.get(recipe) ?? TechId.None;
}

/**
 * Whether recipe `recipe` is unlocked for a force whose researched
 * technologies `researched` reports: it is unlocked from the start, or the
 * technology that unlocks it is researched. Pure, so the main thread can
 * answer from a snapshot what the simulation answers from its state.
 */
export function recipeUnlockedBy(researched: (tech: number) => boolean, recipe: number): boolean {
  const tech = unlockingTechnology(recipe);
  return tech === TechId.None || researched(tech);
}

/**
 * The column a technology goes in in the tech tree: 0 without prerequisites,
 * else one more than its deepest prerequisite.
 */
export function technologyDepth(id: number): number {
  const tech = technologyPrototype(id);
  if (!tech) return 0;
  let depth = 0;
  for (const p of tech.prerequisites) depth = Math.max(depth, technologyDepth(p) + 1);
  return depth;
}

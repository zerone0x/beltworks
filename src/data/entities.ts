/**
 * Entity prototypes: everything that can be placed on the map.
 *
 * Entity type ids are stored in the entity tables (`Uint8Array`), where 0
 * means "no entity". They must stay stable: changing an id breaks saves and
 * state hashes.
 *
 * Chests (wooden and iron), furnaces, mining drills, inserters (burner,
 * electric, fast and long-handed) and assembling machines have their own
 * tables and behavior (src/sim/entities/), belts (every tier, underground
 * belts included, in one table) theirs in src/sim/belts/, small electric
 * poles (the power grid), boilers and steam
 * engines theirs in src/sim/power/, and labs theirs in src/sim/research/.
 *
 * Energy is in integer joules; a burner entity burns `energyPerTick` joules on
 * every tick it works (60 ticks/s, so 1 500 J/tick is 90 kW). An electric
 * entity draws `energyPerTick` from its network while it works (scaled by the
 * network's satisfaction, see {@link SAT_ONE}) plus `drainPerTick` while idle.
 */

import { ItemId, type RealItemId } from './items';

/** Numeric entity type ids. `None` (0) marks "no entity". */
export const EntityTypeId = {
  None: 0,
  WoodenChest: 1,
  StoneFurnace: 2,
  BurnerMiningDrill: 3,
  TransportBelt: 4,
  BurnerInserter: 5,
  SmallElectricPole: 6,
  Boiler: 7,
  SteamEngine: 8,
  ElectricMiningDrill: 9,
  ElectricInserter: 10,
  AssemblingMachine1: 11,
  AssemblingMachine2: 12,
  // M3 logistics.
  IronChest: 13,
  FastInserter: 14,
  LongHandedInserter: 15,
  // Belt tiers and underground belts (M3).
  FastTransportBelt: 16,
  ExpressTransportBelt: 17,
  UndergroundBelt: 18,
  FastUndergroundBelt: 19,
  ExpressUndergroundBelt: 20,
  // Research (M3).
  Lab: 21,
} as const;

export type EntityTypeId = (typeof EntityTypeId)[keyof typeof EntityTypeId];

/** Ids of real entity types, i.e. every id except {@link EntityTypeId.None}. */
export type RealEntityTypeId = Exclude<EntityTypeId, typeof EntityTypeId.None>;

export interface EntityPrototype {
  readonly id: RealEntityTypeId;
  /** Internal name, e.g. `wooden-chest`. */
  readonly name: string;
  /** Human-readable name for the UI. */
  readonly label: string;
  /** Footprint in tiles when facing north (swapped when facing east or west). */
  readonly width: number;
  readonly height: number;
  /** Whether the entity has a meaningful direction (and can be rotated). */
  readonly rotatable: boolean;
  /** The item that places this entity, and that removing it gives back. */
  readonly item: RealItemId;
  /** Placeholder display color as 0xRRGGBB. */
  readonly color: number;
  /** Where an entity that uses energy gets it from: a fuel slot, or an electric network. */
  readonly energySource?: EnergySource;
  /**
   * Joules per tick while it works: what a burner entity burns, or what an
   * electric entity draws at full satisfaction.
   */
  readonly energyPerTick?: number;
  /** Joules per tick an electric entity draws while it is idle but powered. */
  readonly drainPerTick?: number;
  /**
   * Most joules per tick a power producer can deliver: a boiler's output to
   * its steam engines, a steam engine's output to its network.
   */
  readonly maxOutputPerTick?: number;
  /**
   * How far an electric pole's wires reach, in tiles: it connects to every pole
   * whose center is within this distance (Euclidean, compared as integer
   * squared distances).
   */
  readonly wireReach?: number;
  /** Edge of the square area, in tiles and centered on the pole, an electric pole supplies. */
  readonly supplyArea?: number;
  /** Item slots of a container. */
  readonly slots?: number;
  /** Working ticks a mining drill takes per unit it mines (at full power for electric drills). */
  readonly miningTicks?: number;
  /**
   * Edge of the square area, in tiles and centered on the drill, that a
   * mining drill mines; absent when it mines exactly its own footprint.
   */
  readonly miningArea?: number;
  /**
   * How far items on a belt move per tick, in subtiles (1/256 tile). Every
   * belt type has one (transport belts and underground belts); it is also the
   * belt's tier: only belts of the same speed join one transport line, and an
   * underground belt only pairs with one of the same speed.
   */
  readonly beltSpeed?: number;
  /**
   * Underground belts: most tiles between an entrance and its exit (the
   * exit can be at most `undergroundMaxGap + 1` tiles in front of the
   * entrance).
   */
  readonly undergroundMaxGap?: number;
  /**
   * Ticks an inserter's arm takes to swing from its pickup tile to its drop
   * tile (and as many to swing back). Every inserter has it, and only
   * inserters do (see {@link isInserterPrototype}).
   */
  readonly swingTicks?: number;
  /**
   * An assembling machine's crafting speed as an exact fraction: a recipe of
   * `ticks` ticks takes `ceil(ticks × den / num)` working ticks at full power
   * (see {@link craftingTicks}).
   */
  readonly craftingSpeed?: { readonly num: number; readonly den: number };
  /**
   * How far an inserter reaches, in tiles: it picks up from the tile `reach`
   * tiles behind it and drops onto the tile `reach` tiles in front of it
   * (1 when absent; 2 for the long-handed inserter).
   */
  readonly reach?: number;
}

/** Where an entity gets its energy from. */
export type EnergySource = 'burner' | 'electric';

/**
 * Fixed-point one of an electric network's satisfaction, `min(1, supply /
 * demand)`, which has a resolution of 1/65536. Consumers at satisfaction `s`
 * advance by `s` per tick in 1/65536 units of progress and draw
 * `energyPerTick × s / SAT_ONE`.
 */
export const SAT_ONE = 65_536;

/**
 * Closest two items on one belt lane may be, in subtiles: a quarter tile, so
 * a lane holds 4 items per belt and carries `60 * speed / spacing` items/s
 * (7.5 at the yellow belt's 8 subtiles/tick, 15 per belt over both lanes;
 * 30 per belt for the fast belt's 16 and 45 for the express belt's 24).
 */
export const BELT_ITEM_SPACING = 64;

/** Most units a stone furnace's output slot holds before it stops. */
export const FURNACE_OUTPUT_LIMIT = 100;

/**
 * An assembling machine's input slots take up to this many times the
 * recipe's amount of each ingredient (from inserters and by hand alike), so
 * one craft can wait while the next one runs, as in Factorio.
 */
export const ASSEMBLER_INPUT_MULTIPLIER = 2;

/**
 * Working ticks at full power an entity with crafting speed `speed` takes
 * for a recipe of `ticks` ticks: `ceil(ticks × den / num)` (assembling
 * machine 1, speed 1/2: twice the recipe's ticks; assembling machine 2,
 * speed 3/4: four thirds, rounded up). Recipe ticks for an entity without a
 * crafting speed.
 */
export function craftingTicks(
  ticks: number,
  speed: EntityPrototype['craftingSpeed'] | undefined,
): number {
  if (!speed) return ticks;
  return Math.floor((ticks * speed.den + speed.num - 1) / speed.num);
}

/** Entity prototypes keyed by id. There is no entry for id 0 ("no entity"). */
export const ENTITIES: Readonly<Record<RealEntityTypeId, EntityPrototype>> = {
  [EntityTypeId.WoodenChest]: {
    id: EntityTypeId.WoodenChest,
    name: 'wooden-chest',
    label: 'Wooden chest',
    width: 1,
    height: 1,
    rotatable: false,
    item: ItemId.WoodenChest,
    color: 0x9a6a3a,
    slots: 16,
  },
  [EntityTypeId.StoneFurnace]: {
    id: EntityTypeId.StoneFurnace,
    name: 'stone-furnace',
    label: 'Stone furnace',
    width: 2,
    height: 2,
    rotatable: false,
    item: ItemId.StoneFurnace,
    color: 0x8c7f6a,
    energySource: 'burner',
    // 90 kW.
    energyPerTick: 1_500,
  },
  [EntityTypeId.BurnerMiningDrill]: {
    id: EntityTypeId.BurnerMiningDrill,
    name: 'burner-mining-drill',
    label: 'Burner mining drill',
    width: 2,
    height: 2,
    // The drill drops what it mines onto the tile in front of it.
    rotatable: true,
    item: ItemId.BurnerMiningDrill,
    color: 0x6d6f78,
    energySource: 'burner',
    // 150 kW.
    energyPerTick: 2_500,
    // 0.25 units/s.
    miningTicks: 240,
  },
  [EntityTypeId.TransportBelt]: {
    id: EntityTypeId.TransportBelt,
    name: 'transport-belt',
    label: 'Transport belt',
    width: 1,
    height: 1,
    rotatable: true,
    item: ItemId.TransportBelt,
    color: 0xd9b23a,
    // 1.875 tiles/s.
    beltSpeed: 8,
  },
  [EntityTypeId.BurnerInserter]: {
    id: EntityTypeId.BurnerInserter,
    name: 'burner-inserter',
    label: 'Burner inserter',
    width: 1,
    height: 1,
    rotatable: true,
    item: ItemId.BurnerInserter,
    color: 0xb5562f,
    energySource: 'burner',
    // 100 kW (100 000 / 60 ≈ 1 667 J/tick), only while moving.
    energyPerTick: 1_667,
    // One pickup → drop → return cycle takes 2 × 36 = 72 ticks (1.2 s).
    swingTicks: 36,
  },
  // Power (M2), with the shared design numbers.
  [EntityTypeId.SmallElectricPole]: {
    id: EntityTypeId.SmallElectricPole,
    name: 'small-electric-pole',
    label: 'Small electric pole',
    width: 1,
    height: 1,
    rotatable: false,
    item: ItemId.SmallElectricPole,
    color: 0x8a6440,
    // Connects to poles within 7 tiles (squared distance <= 49).
    wireReach: 7,
    // Supplies the 5×5 tiles centered on it.
    supplyArea: 5,
  },
  [EntityTypeId.Boiler]: {
    id: EntityTypeId.Boiler,
    name: 'boiler',
    label: 'Boiler',
    width: 2,
    height: 3,
    // Feeds the steam engines in front of its output side.
    rotatable: true,
    item: ItemId.Boiler,
    color: 0x9a8a78,
    // Burns fuel for exactly the energy its engines draw (100% efficiency).
    energySource: 'burner',
    // 1.8 MW: exactly two steam engines at full load.
    maxOutputPerTick: 30_000,
  },
  [EntityTypeId.SteamEngine]: {
    id: EntityTypeId.SteamEngine,
    name: 'steam-engine',
    label: 'Steam engine',
    width: 3,
    height: 5,
    rotatable: true,
    item: ItemId.SteamEngine,
    color: 0x6f8a94,
    // 900 kW, only while a boiler feeds it.
    maxOutputPerTick: 15_000,
  },
  [EntityTypeId.ElectricMiningDrill]: {
    id: EntityTypeId.ElectricMiningDrill,
    name: 'electric-mining-drill',
    label: 'Electric mining drill',
    width: 3,
    height: 3,
    // Drops what it mines onto the tile in front of it.
    rotatable: true,
    item: ItemId.ElectricMiningDrill,
    color: 0x4f6f96,
    energySource: 'electric',
    // 90 kW while working.
    energyPerTick: 1_500,
    // 0.5 units/s at full power.
    miningTicks: 120,
    // Mines the 5×5 tiles centered on it.
    miningArea: 5,
  },
  [EntityTypeId.ElectricInserter]: {
    id: EntityTypeId.ElectricInserter,
    name: 'electric-inserter',
    label: 'Electric inserter',
    width: 1,
    height: 1,
    rotatable: true,
    item: ItemId.ElectricInserter,
    color: 0x3f7fc8,
    energySource: 'electric',
    // 13.2 kW while moving, plus a 420 W drain while idle.
    energyPerTick: 220,
    drainPerTick: 7,
    // One cycle takes 2 × 26 = 52 ticks.
    swingTicks: 26,
  },
  // Production (M3), with the shared design numbers.
  [EntityTypeId.AssemblingMachine1]: {
    id: EntityTypeId.AssemblingMachine1,
    name: 'assembling-machine-1',
    label: 'Assembling machine 1',
    width: 3,
    height: 3,
    rotatable: false,
    item: ItemId.AssemblingMachine1,
    color: 0x8c8f6e,
    energySource: 'electric',
    // 75 kW while crafting.
    energyPerTick: 1_250,
    // Recipes take twice their ticks.
    craftingSpeed: { num: 1, den: 2 },
  },
  [EntityTypeId.AssemblingMachine2]: {
    id: EntityTypeId.AssemblingMachine2,
    name: 'assembling-machine-2',
    label: 'Assembling machine 2',
    width: 3,
    height: 3,
    rotatable: false,
    item: ItemId.AssemblingMachine2,
    color: 0x5f8a78,
    energySource: 'electric',
    // 150 kW while crafting.
    energyPerTick: 2_500,
    // Recipes take 4/3 of their ticks, rounded up.
    craftingSpeed: { num: 3, den: 4 },
  },
  // Logistics (M3), with the shared design numbers.
  [EntityTypeId.IronChest]: {
    id: EntityTypeId.IronChest,
    name: 'iron-chest',
    label: 'Iron chest',
    width: 1,
    height: 1,
    rotatable: false,
    item: ItemId.IronChest,
    color: 0x8f97a3,
    slots: 32,
  },
  [EntityTypeId.FastInserter]: {
    id: EntityTypeId.FastInserter,
    name: 'fast-inserter',
    label: 'Fast inserter',
    width: 1,
    height: 1,
    rotatable: true,
    item: ItemId.FastInserter,
    color: 0xc8443c,
    energySource: 'electric',
    // 46.2 kW while moving, plus a 900 W drain while idle.
    energyPerTick: 770,
    drainPerTick: 15,
    // One cycle takes 2 × 13 = 26 ticks.
    swingTicks: 13,
  },
  [EntityTypeId.LongHandedInserter]: {
    id: EntityTypeId.LongHandedInserter,
    name: 'long-handed-inserter',
    label: 'Long-handed inserter',
    width: 1,
    height: 1,
    rotatable: true,
    item: ItemId.LongHandedInserter,
    color: 0x4f9a4a,
    energySource: 'electric',
    // 20 kW while moving (19.98), plus a 420 W drain while idle.
    energyPerTick: 333,
    drainPerTick: 7,
    // One cycle takes 2 × 25 = 50 ticks.
    swingTicks: 25,
    // Picks up 2 tiles behind it and drops 2 tiles in front of it.
    reach: 2,
  },
  // Belt tiers (M3), with the shared design numbers: 15 / 30 / 45 items/s
  // per belt, undergrounds reaching over 4 / 6 / 8 tiles.
  [EntityTypeId.FastTransportBelt]: {
    id: EntityTypeId.FastTransportBelt,
    name: 'fast-transport-belt',
    label: 'Fast transport belt',
    width: 1,
    height: 1,
    rotatable: true,
    item: ItemId.FastTransportBelt,
    color: 0xd0473a,
    // 3.75 tiles/s.
    beltSpeed: 16,
  },
  [EntityTypeId.ExpressTransportBelt]: {
    id: EntityTypeId.ExpressTransportBelt,
    name: 'express-transport-belt',
    label: 'Express transport belt',
    width: 1,
    height: 1,
    rotatable: true,
    item: ItemId.ExpressTransportBelt,
    color: 0x3a8fd9,
    // 5.625 tiles/s.
    beltSpeed: 24,
  },
  [EntityTypeId.UndergroundBelt]: {
    id: EntityTypeId.UndergroundBelt,
    name: 'underground-belt',
    label: 'Underground belt',
    width: 1,
    height: 1,
    rotatable: true,
    item: ItemId.UndergroundBelt,
    color: 0xd9b23a,
    beltSpeed: 8,
    undergroundMaxGap: 4,
  },
  [EntityTypeId.FastUndergroundBelt]: {
    id: EntityTypeId.FastUndergroundBelt,
    name: 'fast-underground-belt',
    label: 'Fast underground belt',
    width: 1,
    height: 1,
    rotatable: true,
    item: ItemId.FastUndergroundBelt,
    color: 0xd0473a,
    beltSpeed: 16,
    undergroundMaxGap: 6,
  },
  [EntityTypeId.ExpressUndergroundBelt]: {
    id: EntityTypeId.ExpressUndergroundBelt,
    name: 'express-underground-belt',
    label: 'Express underground belt',
    width: 1,
    height: 1,
    rotatable: true,
    item: ItemId.ExpressUndergroundBelt,
    color: 0x3a8fd9,
    beltSpeed: 24,
    undergroundMaxGap: 8,
  },
  // Research (M3), with the shared design numbers.
  [EntityTypeId.Lab]: {
    id: EntityTypeId.Lab,
    name: 'lab',
    label: 'Lab',
    width: 3,
    height: 3,
    rotatable: false,
    item: ItemId.Lab,
    color: 0xc9d2db,
    energySource: 'electric',
    // 60 kW while researching; no drain.
    energyPerTick: 1_000,
  },
};

/** Every real entity type id, in id order. */
export const ENTITY_TYPE_IDS: readonly RealEntityTypeId[] = [
  EntityTypeId.WoodenChest,
  EntityTypeId.StoneFurnace,
  EntityTypeId.BurnerMiningDrill,
  EntityTypeId.TransportBelt,
  EntityTypeId.BurnerInserter,
  EntityTypeId.SmallElectricPole,
  EntityTypeId.Boiler,
  EntityTypeId.SteamEngine,
  EntityTypeId.ElectricMiningDrill,
  EntityTypeId.ElectricInserter,
  EntityTypeId.AssemblingMachine1,
  EntityTypeId.AssemblingMachine2,
  EntityTypeId.IronChest,
  EntityTypeId.FastInserter,
  EntityTypeId.LongHandedInserter,
  EntityTypeId.FastTransportBelt,
  EntityTypeId.ExpressTransportBelt,
  EntityTypeId.UndergroundBelt,
  EntityTypeId.FastUndergroundBelt,
  EntityTypeId.ExpressUndergroundBelt,
  EntityTypeId.Lab,
];

/** Whether `proto` is an inserter (burner, electric, fast or long-handed). */
export function isInserterPrototype(proto: EntityPrototype | undefined): boolean {
  return proto?.swingTicks !== undefined;
}

/** How far inserter type `proto` reaches, in tiles (see {@link EntityPrototype.reach}). */
export function inserterReach(proto: EntityPrototype): number {
  return proto.reach ?? 1;
}

/** Whether `proto` is a chest (wooden or iron): the only entities with `slots`. */
export function isChestPrototype(proto: EntityPrototype | undefined): boolean {
  return proto?.slots !== undefined;
}

/** The belt types (transport and underground belts of every tier), in id order. */
export const BELT_TYPE_IDS: readonly RealEntityTypeId[] = [
  EntityTypeId.TransportBelt,
  EntityTypeId.FastTransportBelt,
  EntityTypeId.ExpressTransportBelt,
  EntityTypeId.UndergroundBelt,
  EntityTypeId.FastUndergroundBelt,
  EntityTypeId.ExpressUndergroundBelt,
];

/** Whether entity type `type` is a belt (any tier, underground or not). */
export function isBeltType(type: number): boolean {
  return entityPrototype(type)?.beltSpeed !== undefined;
}

/** Whether entity type `type` is an underground belt. */
export function isUndergroundType(type: number): boolean {
  return entityPrototype(type)?.undergroundMaxGap !== undefined;
}

/** Largest footprint edge of any entity, in tiles (the steam engine's 5). */
export const MAX_ENTITY_SIZE = 5;

/** The prototype of entity type `id`, or `undefined` for 0 and unknown ids. */
export function entityPrototype(id: number): EntityPrototype | undefined {
  return (ENTITIES as Readonly<Record<number, EntityPrototype | undefined>>)[id];
}

const BY_ITEM = new Map<number, EntityPrototype>(
  ENTITY_TYPE_IDS.map((id) => [ENTITIES[id].item, ENTITIES[id]]),
);

/** The entity that item `item` places, or `undefined` if it doesn't place one. */
export function entityForItem(item: number): EntityPrototype | undefined {
  return BY_ITEM.get(item);
}

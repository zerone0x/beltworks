/**
 * Entity prototypes: everything that can be placed on the map.
 *
 * Entity type ids are stored in the entity tables (`Uint8Array`), where 0
 * means "no entity". They must stay stable: changing an id breaks saves and
 * state hashes.
 *
 * Chests and furnaces have their own tables and behavior (src/sim/entities/);
 * drills, belts and inserters are still placeholders that can only be placed,
 * rotated and removed.
 *
 * Energy is in integer joules; a burner entity burns `energyPerTick` joules on
 * every tick it works (60 ticks/s, so 1 500 J/tick is 90 kW).
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
  /** Joules a burner entity burns per tick while it works. */
  readonly energyPerTick?: number;
  /** Item slots of a container. */
  readonly slots?: number;
}

/** Most units a stone furnace's output slot holds before it stops. */
export const FURNACE_OUTPUT_LIMIT = 100;

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
    // 150 kW.
    energyPerTick: 2_500,
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
    // 100 kW (100 000 / 60 ≈ 1 667 J/tick), only while moving.
    energyPerTick: 1_667,
  },
};

/** Every real entity type id, in id order. */
export const ENTITY_TYPE_IDS: readonly RealEntityTypeId[] = [
  EntityTypeId.WoodenChest,
  EntityTypeId.StoneFurnace,
  EntityTypeId.BurnerMiningDrill,
  EntityTypeId.TransportBelt,
  EntityTypeId.BurnerInserter,
];

/** Largest footprint edge of any entity, in tiles. */
export const MAX_ENTITY_SIZE = 2;

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

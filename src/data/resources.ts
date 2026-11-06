/**
 * Raw resource prototypes (ore patches on the map).
 *
 * Resource ids are stored directly in chunk resource arrays (`Uint8Array`),
 * where 0 means "no resource". They must stay stable: changing an id breaks
 * saves and state hashes.
 */

/** Numeric resource ids. `None` (0) marks a tile without a resource. */
export const ResourceId = {
  None: 0,
  IronOre: 1,
  CopperOre: 2,
  Coal: 3,
  Stone: 4,
} as const;

export type ResourceId = (typeof ResourceId)[keyof typeof ResourceId];

/** Ids of real resources, i.e. every id except {@link ResourceId.None}. */
export type OreId = Exclude<ResourceId, typeof ResourceId.None>;

export interface ResourcePrototype {
  readonly id: OreId;
  readonly name: string;
  /** Display color as 0xRRGGBB, used by the renderer and map mode. */
  readonly color: number;
}

/** Resource prototypes keyed by id. There is no entry for id 0 ("no resource"). */
export const RESOURCES: Readonly<Record<OreId, ResourcePrototype>> = {
  [ResourceId.IronOre]: { id: ResourceId.IronOre, name: 'iron-ore', color: 0x6f8597 },
  [ResourceId.CopperOre]: { id: ResourceId.CopperOre, name: 'copper-ore', color: 0xc0703e },
  [ResourceId.Coal]: { id: ResourceId.Coal, name: 'coal', color: 0x262626 },
  [ResourceId.Stone]: { id: ResourceId.Stone, name: 'stone', color: 0xa89a7c },
};

/** Every real resource id, in id order. */
export const ORE_IDS: readonly OreId[] = [
  ResourceId.IronOre,
  ResourceId.CopperOre,
  ResourceId.Coal,
  ResourceId.Stone,
];

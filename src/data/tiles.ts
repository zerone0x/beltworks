/**
 * Terrain tile prototypes.
 *
 * Tile ids are stored directly in chunk terrain arrays (`Uint8Array`), so they
 * must stay stable: changing an id breaks saves and state hashes.
 */

/** Numeric tile ids. */
export const TileId = {
  Grass: 0,
  Sand: 1,
  Water: 2,
  Rock: 3,
} as const;

export type TileId = (typeof TileId)[keyof typeof TileId];

export interface TilePrototype {
  readonly id: TileId;
  readonly name: string;
  /** Whether entities can be placed on this tile. */
  readonly buildable: boolean;
  /** Whether players can walk on this tile. */
  readonly walkable: boolean;
  /** Display color as 0xRRGGBB, used by the renderer and map mode. */
  readonly color: number;
}

/** Tile prototypes indexed by id (`TILES[id].id === id`). */
export const TILES: readonly TilePrototype[] = [
  { id: TileId.Grass, name: 'grass', walkable: true, buildable: true, color: 0x4f7a3a },
  { id: TileId.Sand, name: 'sand', walkable: true, buildable: true, color: 0xc8b47a },
  { id: TileId.Water, name: 'water', walkable: false, buildable: false, color: 0x2f5f8a },
  { id: TileId.Rock, name: 'rock', walkable: true, buildable: true, color: 0x6e6a64 },
];

/** Whether entities can be placed on a tile with the given id. Unknown ids are not buildable. */
export function isBuildable(id: number): boolean {
  return TILES[id]?.buildable ?? false;
}

/** Whether players can walk on a tile with the given id. Unknown ids are not walkable. */
export function isWalkable(id: number): boolean {
  return TILES[id]?.walkable ?? false;
}

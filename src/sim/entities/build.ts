/**
 * The build commands: `Place`, `Remove` and `Rotate` (see src/sim/commands.ts).
 *
 * They come straight from player input, so anything that doesn't apply (an
 * item that places nothing or that the player doesn't have, a blocked or
 * out-of-reach footprint, an empty tile, a full inventory) is ignored without
 * changing any state. Each function returns what happened, for tests.
 */

import { entityForItem, entityPrototype } from '../../data/entities';
import type { ItemStack } from '../../data/items';
import { isBuildable } from '../../data/tiles';
import type { SimState } from '../state';
import { isDirection, rotateClockwise, Direction } from './direction';
import { Placement, checkPlacement, inBuildReach, type PlacementView } from './placement';

/** Outcome of a build command. */
export const BuildResult = {
  Ok: 0,
  /** The item doesn't place an entity, or the direction is invalid. */
  NotPlaceable: 1,
  /** The player has none of the item. */
  NoItem: 2,
  /** The placement check failed (see `Placement`). */
  Blocked: 3,
  /** There is no entity on the tile. */
  NoEntity: 4,
  /** The entity is out of build reach. */
  OutOfReach: 5,
  /** The refund doesn't fit in the inventory. */
  InventoryFull: 6,
  /** The entity can't be rotated. */
  NotRotatable: 7,
} as const;

export type BuildResult = (typeof BuildResult)[keyof typeof BuildResult];

/** A placement view of the simulation state itself. */
export function simPlacementView(state: SimState): PlacementView {
  const { world, entities, players } = state;
  return {
    inMap: (x, y) => world.isTileInRange(x, y),
    buildable: (x, y) => isBuildable(world.tileAt(x, y)),
    tree: (x, y) => world.treeAt(x, y),
    occupant: (x, y) => entities.at(x, y),
    playerCount: players.count,
    playerX: (i) => players.x[i]!,
    playerY: (i) => players.y[i]!,
  };
}

/**
 * Places the entity that `item` places, facing `dir`, with its top-left tile
 * at `(x, y)`, taking one `item` from the player's inventory. Directions of
 * entities that can't rotate are ignored (they always face north).
 */
export function placeEntity(
  state: SimState,
  playerId: number,
  item: number,
  x: number,
  y: number,
  dir: number,
): BuildResult {
  const proto = entityForItem(item);
  if (!proto || !isDirection(dir)) {
    return BuildResult.NotPlaceable;
  }
  const inventory = state.players.inventory(playerId);
  if (inventory.count(item) === 0) {
    return BuildResult.NoItem;
  }
  const facing = proto.rotatable ? dir : Direction.North;
  const { players } = state;
  const verdict = checkPlacement(
    simPlacementView(state),
    proto,
    x,
    y,
    facing,
    players.x[playerId]!,
    players.y[playerId]!,
  );
  if (verdict !== Placement.Ok) {
    return BuildResult.Blocked;
  }
  inventory.remove(item, 1);
  state.entities.add(proto, x, y, facing);
  return BuildResult.Ok;
}

/** Whether `playerId` can reach entity `id` (which must exist) to build on or use it. */
export function reaches(state: SimState, playerId: number, id: number): boolean {
  const { x, y, w, h } = state.entities.footprint(id);
  const { players } = state;
  return inBuildReach(players.x[playerId]!, players.y[playerId]!, x, y, w, h);
}

/**
 * Removes the entity covering tile `(x, y)` and puts its item and contents
 * into the player's inventory. Refused if they don't all fit.
 */
export function removeEntity(state: SimState, playerId: number, x: number, y: number): BuildResult {
  const { entities } = state;
  const id = state.world.isTileInRange(x, y) ? entities.at(x, y) : 0;
  const proto = entities.prototypeOf(id);
  if (!proto) {
    return BuildResult.NoEntity;
  }
  if (!reaches(state, playerId, id)) {
    return BuildResult.OutOfReach;
  }
  const refund: ItemStack[] = [{ item: proto.item, count: 1 }, ...entities.contents(id)];
  const inventory = state.players.inventory(playerId);
  if (!inventory.fitsAll(refund)) {
    return BuildResult.InventoryFull;
  }
  entities.remove(id);
  for (const stack of refund) {
    inventory.add(stack.item, stack.count);
  }
  return BuildResult.Ok;
}

/**
 * Turns the entity covering tile `(x, y)` a quarter turn clockwise. Entities
 * whose footprint isn't square must have room for the turned footprint.
 */
export function rotateEntity(state: SimState, playerId: number, x: number, y: number): BuildResult {
  const { entities } = state;
  const id = state.world.isTileInRange(x, y) ? entities.at(x, y) : 0;
  const proto = entityPrototype(entities.store.type(id));
  if (!proto) {
    return BuildResult.NoEntity;
  }
  if (!proto.rotatable) {
    return BuildResult.NotRotatable;
  }
  if (!reaches(state, playerId, id)) {
    return BuildResult.OutOfReach;
  }
  const dir = rotateClockwise(entities.store.dir(id));
  if (proto.width !== proto.height) {
    const { players } = state;
    const { x: ex, y: ey } = entities.footprint(id);
    const verdict = checkPlacement(
      simPlacementView(state),
      proto,
      ex,
      ey,
      dir,
      players.x[playerId]!,
      players.y[playerId]!,
      id,
    );
    if (verdict !== Placement.Ok) {
      return BuildResult.Blocked;
    }
  }
  entities.setDirection(id, dir);
  return BuildResult.Ok;
}

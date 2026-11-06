/**
 * The entity GUI commands: `Insert` moves items from the player's inventory
 * into an entity, `Take` moves the contents of one of its slots back (see
 * src/sim/commands.ts). Both go through the entity's item hooks (table.ts),
 * like drills and inserters will, so the routing rules (fuel into the fuel
 * slot, ores into the input) live in one place.
 *
 * As with the build commands, anything that doesn't apply (no such entity,
 * out of reach, nothing to move, no room) is ignored without changing state.
 * The entity must be within build reach.
 */

import { itemPrototype } from '../../data/items';
import type { SimState } from '../state';
import { reaches } from './build';

/** Outcome of a transfer command. */
export const TransferResult = {
  Ok: 0,
  /** There is no entity with that id. */
  NoEntity: 1,
  /** The entity is out of reach. */
  OutOfReach: 2,
  /** The player has none of the item, or the slot is empty. */
  NothingToMove: 3,
  /** The entity (for `Insert`) or the inventory (for `Take`) has no room. */
  NoRoom: 4,
} as const;

export type TransferResult = (typeof TransferResult)[keyof typeof TransferResult];

function check(state: SimState, playerId: number, entity: number): TransferResult {
  if (!state.entities.prototypeOf(entity)) {
    return TransferResult.NoEntity;
  }
  return reaches(state, playerId, entity) ? TransferResult.Ok : TransferResult.OutOfReach;
}

/**
 * Moves up to `count` units of `item` from player `playerId`'s inventory into
 * entity `entity`, wherever the entity puts that item.
 */
export function insertIntoEntity(
  state: SimState,
  playerId: number,
  entity: number,
  item: number,
  count: number,
): TransferResult {
  const verdict = check(state, playerId, entity);
  if (verdict !== TransferResult.Ok) {
    return verdict;
  }
  const inventory = state.players.inventory(playerId);
  const have = itemPrototype(item) ? Math.min(count, inventory.count(item)) : 0;
  if (have === 0) {
    return TransferResult.NothingToMove;
  }
  const moved = state.entities.insert(entity, item, have);
  if (moved === 0) {
    return TransferResult.NoRoom;
  }
  inventory.remove(item, moved);
  return TransferResult.Ok;
}

/**
 * Moves up to `count` units out of slot `slot` of entity `entity` into player
 * `playerId`'s inventory, as many as fit.
 */
export function takeFromEntity(
  state: SimState,
  playerId: number,
  entity: number,
  slot: number,
  count: number,
): TransferResult {
  const verdict = check(state, playerId, entity);
  if (verdict !== TransferResult.Ok) {
    return verdict;
  }
  const { entities } = state;
  const stack = entities.slots(entity)[slot];
  if (!stack || stack.count === 0) {
    return TransferResult.NothingToMove;
  }
  const inventory = state.players.inventory(playerId);
  const n = Math.min(count, stack.count, inventory.spaceFor(stack.item));
  if (n === 0) {
    return TransferResult.NoRoom;
  }
  const taken = entities.take(entity, slot, n);
  inventory.add(stack.item, taken);
  return TransferResult.Ok;
}

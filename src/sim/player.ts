/**
 * Players: struct-of-arrays state for every player character, and the player
 * system that moves them and runs hand-mining.
 *
 * - Movement: a constant integer speed along the current `Move` intent. The
 *   player is an axis-aligned box of `2 * PLAYER_HALF_SIZE` subtiles that
 *   can't overlap a non-walkable tile (water). Each axis is resolved on its
 *   own, so a player pushing diagonally into a shore slides along it.
 * - Belts carry the player (D66): after its own step, the belt under the
 *   player's center pushes it along the belt's direction at the belt's item
 *   speed (8 / 16 / 24 subtiles/tick), so walking with a belt is faster and
 *   against it slower, and pulls it toward the belt's center line at half
 *   that speed (unless the player walks along that axis). The push is
 *   stopped by water under the box and by an entity that isn't a belt on the
 *   tile ahead of the center.
 * - Hand-mining: while the mining intent is set and the target tile is within
 *   reach, one unit is mined every `HAND_MINING_TICKS` ticks and goes into the
 *   player's inventory. A tree is felled whole after `TREE_MINING_TICKS`
 *   ticks and gives `TREE_WOOD` wood. Out of reach, mining pauses (progress
 *   resets) until the player comes back; a depleted tile, a felled tree, or
 *   an inventory without room for what the next unit (or tree) gives ends it.
 */

import { entityPrototype } from '../data/entities';
import { minedItem } from '../data/items';
import { TREE_ITEM, TREE_MINING_TICKS, TREE_WOOD } from '../data/trees';
import type { Axis } from './commands';
import {
  HALF_TILE,
  SUBTILES_PER_TILE,
  fixedToTile,
  isInt32,
  tileCenter,
  tileToFixed,
} from './fixed';
import { DIRECTION_DX, DIRECTION_DY } from './entities/direction';
import type { Entities } from './entities/entities';
import { fnv1a32 } from './hash';
import { SaveError, type SaveReader, type SaveWriter } from './save/codec';
import { Inventory, PLAYER_INVENTORY_SLOTS } from './inventory';
import type { World } from './world/world';

/** Straight-line speed, in subtiles (1/256 tile) per tick: about 8.9 tiles/s. */
export const PLAYER_SPEED = 38;
/** Per-axis speed when moving diagonally: round(PLAYER_SPEED / sqrt(2)). */
export const PLAYER_DIAGONAL_SPEED = 27;
/** Half the edge of the player's collision box, in subtiles (the box is 0.4 tiles wide). */
export const PLAYER_HALF_SIZE = 51;

/** Ticks of hand-mining per unit of resource (0.5 s at 60 ticks/s). */
export const HAND_MINING_TICKS = 30;
/**
 * Hand-mining reach in subtiles (2.5 tiles), measured from the player's
 * position to the center of the target tile.
 */
export const MINING_REACH = (5 * SUBTILES_PER_TILE) / 2;
const MINING_REACH_SQ = MINING_REACH * MINING_REACH;

/**
 * Whether a player at `(px, py)` (subtiles) can reach the center of tile
 * `(tileX, tileY)`. Integer-only: the squared distance is compared exactly,
 * after a per-axis check that keeps the squares small.
 */
export function inMiningReach(px: number, py: number, tileX: number, tileY: number): boolean {
  const dx = tileToFixed(tileX) + HALF_TILE - px;
  const dy = tileToFixed(tileY) + HALF_TILE - py;
  if (dx > MINING_REACH || dx < -MINING_REACH || dy > MINING_REACH || dy < -MINING_REACH) {
    return false;
  }
  return dx * dx + dy * dy <= MINING_REACH_SQ;
}

export class PlayerTable {
  readonly count: number;
  /** Position in subtiles. */
  readonly x: Int32Array;
  readonly y: Int32Array;
  /** Movement intent per axis: -1, 0 or +1. */
  readonly moveX: Int8Array;
  readonly moveY: Int8Array;
  /** 1 while the player wants to hand-mine the tile at (mineX, mineY), else 0. */
  readonly mining: Uint8Array;
  readonly mineX: Int32Array;
  readonly mineY: Int32Array;
  /** Ticks spent on the current unit, in [0, HAND_MINING_TICKS) (or TREE_MINING_TICKS for a tree). */
  readonly mineProgress: Uint16Array;
  /** Inventories of every player, `PLAYER_INVENTORY_SLOTS` consecutive slots each. */
  readonly invItems: Uint16Array;
  readonly invCounts: Uint16Array;
  private readonly inventories: Inventory[];

  constructor(count: number) {
    if (!Number.isInteger(count) || count < 1 || count > 0x1_0000) {
      throw new RangeError(`player count must be an integer in [1, 65536], got ${String(count)}`);
    }
    this.count = count;
    this.x = new Int32Array(count);
    this.y = new Int32Array(count);
    this.moveX = new Int8Array(count);
    this.moveY = new Int8Array(count);
    this.mining = new Uint8Array(count);
    this.mineX = new Int32Array(count);
    this.mineY = new Int32Array(count);
    this.mineProgress = new Uint16Array(count);
    this.invItems = new Uint16Array(count * PLAYER_INVENTORY_SLOTS);
    this.invCounts = new Uint16Array(count * PLAYER_INVENTORY_SLOTS);
    this.inventories = [];
    for (let i = 0; i < count; i++) {
      const from = i * PLAYER_INVENTORY_SLOTS;
      const to = from + PLAYER_INVENTORY_SLOTS;
      this.inventories.push(
        new Inventory(this.invItems.subarray(from, to), this.invCounts.subarray(from, to)),
      );
    }
  }

  has(id: number): boolean {
    return id >= 0 && id < this.count;
  }

  /** Player `id`'s inventory (a view into the table's columns). */
  inventory(id: number): Inventory {
    const inv = this.inventories[id];
    if (!inv) {
      throw new RangeError(`no player ${String(id)}`);
    }
    return inv;
  }

  setMove(id: number, dx: Axis, dy: Axis): void {
    this.moveX[id] = dx;
    this.moveY[id] = dy;
  }

  /** Sets the mining target. Re-targeting the same tile keeps the progress made on it. */
  startMining(id: number, tileX: number, tileY: number): void {
    if (this.mining[id] === 1 && this.mineX[id] === tileX && this.mineY[id] === tileY) {
      return;
    }
    this.mining[id] = 1;
    this.mineX[id] = tileX;
    this.mineY[id] = tileY;
    this.mineProgress[id] = 0;
  }

  stopMining(id: number): void {
    this.mining[id] = 0;
    this.mineX[id] = 0;
    this.mineY[id] = 0;
    this.mineProgress[id] = 0;
  }

  /** Folds every field into a running FNV-1a hash, in a fixed order. */
  hashInto(h: number): number {
    h = fnv1a32(Uint32Array.of(this.count, PLAYER_INVENTORY_SLOTS), h);
    for (const column of [
      this.x,
      this.y,
      this.moveX,
      this.moveY,
      this.mining,
      this.mineX,
      this.mineY,
      this.mineProgress,
      this.invItems,
      this.invCounts,
    ]) {
      h = fnv1a32(column, h);
    }
    return h;
  }

  /** The columns `save` and `load` cover, in order (every column of the table). */
  private columns() {
    return [
      this.x,
      this.y,
      this.moveX,
      this.moveY,
      this.mining,
      this.mineX,
      this.mineY,
      this.mineProgress,
      this.invItems,
      this.invCounts,
    ];
  }

  save(w: SaveWriter): void {
    w.u32(this.count);
    w.u32(PLAYER_INVENTORY_SLOTS);
    for (const column of this.columns()) w.column(column);
  }

  /** Restores what `save` wrote into a table with the same number of players. */
  load(r: SaveReader): void {
    const count = r.u32();
    const slots = r.u32();
    if (count !== this.count || slots !== PLAYER_INVENTORY_SLOTS) {
      throw new SaveError(`players: ${String(count)} players of ${String(slots)} slots`);
    }
    for (const column of this.columns()) r.columnInto(column);
  }
}

/**
 * Whether tile line `line` (a column when `horizontal`, else a row) blocks
 * movement: any of its tiles `from..to` of the other axis that is outside
 * the supported map range or not walkable (water) does. With `entities`
 * (the belt carrying the player, see `beltDrift`) so does an entity that
 * isn't a belt on its tile `center` (the one in front of the player's
 * center), but not one the box only reaches into beside the belt; players
 * walk through entities on their own.
 */
function lineBlocked(
  world: World,
  entities: Entities | null,
  horizontal: boolean,
  line: number,
  from: number,
  to: number,
  center: number,
): boolean {
  for (let t = from; t <= to; t++) {
    if (horizontal ? !world.isWalkable(line, t) : !world.isWalkable(t, line)) {
      return true;
    }
  }
  if (entities === null) return false;
  const id = horizontal ? entities.at(line, center) : entities.at(center, line);
  return id !== 0 && entityPrototype(entities.store.type(id))?.beltSpeed === undefined;
}

/**
 * Moves player `i`'s box (half size `PLAYER_HALF_SIZE`, covering subtiles
 * `[pos - H, pos + H)` on each axis) by `delta` along one axis (x when
 * `horizontal`), stopping flush against the first blocking tile line (see
 * `blocked`). `delta` is smaller than a tile, so at most one new tile line
 * is entered. No closures, so moving allocates nothing.
 */
function moveAxis(
  players: PlayerTable,
  world: World,
  entities: Entities | null,
  i: number,
  horizontal: boolean,
  delta: number,
): void {
  const H = PLAYER_HALF_SIZE;
  const pos = horizontal ? players.x[i]! : players.y[i]!;
  const across = horizontal ? players.y[i]! : players.x[i]!;
  const next = pos + delta;
  if (!isInt32(next - H) || !isInt32(next + H)) {
    return;
  }
  const from = fixedToTile(across - H);
  const to = fixedToTile(across + H - 1);
  const center = fixedToTile(across);
  let moved = next;
  if (delta > 0) {
    const line = fixedToTile(next + H - 1);
    if (
      line !== fixedToTile(pos + H - 1) &&
      lineBlocked(world, entities, horizontal, line, from, to, center)
    ) {
      moved = tileToFixed(line) - H;
    }
  } else if (delta < 0) {
    const line = fixedToTile(next - H);
    if (
      line !== fixedToTile(pos - H) &&
      lineBlocked(world, entities, horizontal, line, from, to, center)
    ) {
      moved = tileToFixed(line + 1) + H;
    }
  }
  if (horizontal) players.x[i] = moved;
  else players.y[i] = moved;
}

/** Moves player `i` one tick along its intent. */
function movePlayer(players: PlayerTable, world: World, i: number): void {
  const dx = players.moveX[i]!;
  const dy = players.moveY[i]!;
  if (dx === 0 && dy === 0) {
    return;
  }
  const speed = dx !== 0 && dy !== 0 ? PLAYER_DIAGONAL_SPEED : PLAYER_SPEED;
  if (dx !== 0) moveAxis(players, world, null, i, true, dx * speed);
  if (dy !== 0) moveAxis(players, world, null, i, false, dy * speed);
}

/**
 * The belt under a player at `(px, py)` (subtiles): the push it gives, as a
 * direction (0–3, see src/sim/entities/direction.ts) in the low 2 bits and
 * its belt speed (subtiles/tick) above them, or -1 when the tile under the
 * player's center has no belt (transport belt, underground belt end or
 * splitter, any tier). One occupancy lookup; read-only.
 */
export function beltDrift(entities: Entities, px: number, py: number): number {
  const id = entities.at(fixedToTile(px), fixedToTile(py));
  if (id === 0) return -1;
  const speed = entityPrototype(entities.store.type(id))?.beltSpeed;
  if (speed === undefined) return -1;
  return (speed << 2) | entities.store.dir(id);
}

/**
 * Lets the belt under player `i` (after its own step) carry it one tick
 * along the belt's direction (its output side, so a curve carries it round
 * the corner) at the belt's item speed. The push can't move the box into
 * water nor the center into an entity that isn't a belt: it stops flush
 * against it. Across the belt, unless the player walks along that axis, the
 * belt pulls the player toward its center line at half its speed, never
 * past it, so a player who stepped on at the belt's edge or came round a
 * curve rides in the middle of the belt. The center stays on the belt's
 * tile line, so the pull enters no new tile and needs no collision check.
 */
function ridePlayer(players: PlayerTable, world: World, entities: Entities, i: number): void {
  const drift = beltDrift(entities, players.x[i]!, players.y[i]!);
  if (drift < 0) return;
  const speed = drift >> 2;
  const dir = drift & 3;
  const dx = DIRECTION_DX[dir]!;
  const horizontal = dx !== 0;
  moveAxis(
    players,
    world,
    entities,
    i,
    horizontal,
    horizontal ? dx * speed : DIRECTION_DY[dir]! * speed,
  );
  if ((horizontal ? players.moveY[i]! : players.moveX[i]!) !== 0) return;
  const across = horizontal ? players.y : players.x;
  const p = across[i]!;
  const off = tileCenter(fixedToTile(p)) - p;
  const pull = speed >> 1;
  across[i] = p + (off > pull ? pull : off < -pull ? -pull : off);
}

/** Advances player `i`'s hand-mining by one tick. */
function minePlayer(players: PlayerTable, world: World, i: number): void {
  if (players.mining[i] !== 1) {
    return;
  }
  const tx = players.mineX[i]!;
  const ty = players.mineY[i]!;
  if (!inMiningReach(players.x[i]!, players.y[i]!, tx, ty)) {
    // Keep the intent: mining resumes once the player is back in reach.
    players.mineProgress[i] = 0;
    return;
  }
  const inRange = world.isTileInRange(tx, ty);
  // Trees never stand on resource tiles, so a tile has at most one of the two.
  const tree = inRange && world.treeAt(tx, ty);
  const item = tree ? TREE_ITEM : inRange ? minedItem(world.resourceAt(tx, ty)) : undefined;
  const units = tree ? TREE_WOOD : 1;
  const inventory = players.inventory(i);
  if (item === undefined || inventory.spaceFor(item) < units) {
    // Nothing (left) to mine, or nowhere to put all of it.
    players.stopMining(i);
    return;
  }
  const progress = players.mineProgress[i]! + 1;
  if (progress < (tree ? TREE_MINING_TICKS : HAND_MINING_TICKS)) {
    players.mineProgress[i] = progress;
    return;
  }
  players.mineProgress[i] = 0;
  if (tree) {
    world.removeTree(tx, ty);
    inventory.add(item, units);
    return;
  }
  const taken = world.mine(tx, ty, 1);
  inventory.add(item, taken);
}

/**
 * Player system: moves every player one tick along its movement intent, lets
 * the belt it then stands on carry it (D66; only with `entities`), then
 * advances its hand-mining (reach is checked from the new position).
 */
export function updatePlayers(players: PlayerTable, world: World, entities?: Entities): void {
  for (let i = 0; i < players.count; i++) {
    movePlayer(players, world, i);
    if (entities) ridePlayer(players, world, entities, i);
    minePlayer(players, world, i);
  }
}

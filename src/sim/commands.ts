/**
 * Commands: every player action that changes simulation state.
 *
 * A command is tagged with the tick it applies on and the player that issued
 * it. Commands for the same tick are applied in a stable order (by player id,
 * then insertion order), so the same command log always produces the same
 * state. All fields are integers.
 */

import { isDirection, type Direction } from './entities/direction';
import { isInt32 } from './fixed';

/** A movement axis: -1, 0 or +1. */
export type Axis = -1 | 0 | 1;

interface CommandBase {
  /** Tick the command applies on (a non-negative safe integer). */
  readonly tick: number;
  /** Issuing player (a uint16; lockstep multiplayer is reserved for later). */
  readonly playerId: number;
}

/** Sets the player's movement intent; it persists until the next `Move`. */
export interface MoveCommand extends CommandBase {
  readonly type: 'Move';
  readonly dx: Axis;
  readonly dy: Axis;
}

/** Starts (or retargets) hand-mining of tile `(x, y)`, in tile coordinates. */
export interface MineStartCommand extends CommandBase {
  readonly type: 'MineStart';
  readonly x: number;
  readonly y: number;
}

/** Stops hand-mining. */
export interface MineStopCommand extends CommandBase {
  readonly type: 'MineStop';
}

/**
 * Places the entity that `item` places, with the top-left tile of its
 * footprint at `(x, y)` and facing `dir`, using one `item` from the
 * inventory. Ignored if it can't be placed there (see src/sim/entities/build.ts).
 */
export interface PlaceCommand extends CommandBase {
  readonly type: 'Place';
  readonly item: number;
  readonly x: number;
  readonly y: number;
  readonly dir: Direction;
}

/** Removes the entity covering tile `(x, y)`, refunding its item and contents. */
export interface RemoveCommand extends CommandBase {
  readonly type: 'Remove';
  readonly x: number;
  readonly y: number;
}

/** Turns the entity covering tile `(x, y)` a quarter turn clockwise. */
export interface RotateCommand extends CommandBase {
  readonly type: 'Rotate';
  readonly x: number;
  readonly y: number;
}

/**
 * Moves up to `count` units of `item` from the player's inventory into entity
 * `entity` (an id), which puts them where they belong: fuel into the fuel
 * slot, ores into a furnace's input, anything into a chest. Ignored if the
 * entity doesn't exist, is out of reach, or has no room
 * (see src/sim/entities/transfer.ts).
 */
export interface InsertCommand extends CommandBase {
  readonly type: 'Insert';
  readonly entity: number;
  readonly item: number;
  readonly count: number;
}

/** Moves up to `count` units out of slot `slot` of entity `entity` into the player's inventory. */
export interface TakeCommand extends CommandBase {
  readonly type: 'Take';
  readonly entity: number;
  readonly slot: number;
  readonly count: number;
}

/**
 * Sets the recipe of entity `entity` (an assembling machine; 0 clears it),
 * refunding what it holds to the player's inventory. Ignored if the entity
 * doesn't exist, is out of reach, can't make that recipe, the recipe isn't
 * unlocked, or the refund doesn't fit (see src/sim/entities/transfer.ts).
 */
export interface SetRecipeCommand extends CommandBase {
  readonly type: 'SetRecipe';
  readonly entity: number;
  readonly recipe: number;
}

/**
 * Queues up to `count` hand-crafts of `recipe`, as many as the inventory
 * allows, auto-queueing missing intermediates (see src/sim/crafting/queue.ts).
 */
export interface CraftCommand extends CommandBase {
  readonly type: 'Craft';
  readonly recipe: number;
  readonly count: number;
}

/** Cancels entry `index` of the crafting queue (with its intermediates) and refunds it. */
export interface CancelCraftCommand extends CommandBase {
  readonly type: 'CancelCraft';
  readonly index: number;
}

/**
 * Makes technology `tech` the current research of the player's force (0
 * stops researching). Ignored unless it can be researched: it isn't yet,
 * and its prerequisites are (see src/sim/research/research.ts). Needs no
 * reach.
 */
export interface SetResearchCommand extends CommandBase {
  readonly type: 'SetResearch';
  readonly tech: number;
}

export type Command =
  | MoveCommand
  | MineStartCommand
  | MineStopCommand
  | PlaceCommand
  | RemoveCommand
  | RotateCommand
  | InsertCommand
  | TakeCommand
  | SetRecipeCommand
  | CraftCommand
  | CancelCraftCommand
  | SetResearchCommand;
export type CommandType = Command['type'];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A command without its tick, as sent by the main thread; the worker stamps the tick. */
export type CommandInput = DistributiveOmit<Command, 'tick'>;

export const MAX_PLAYER_ID = 0xffff;

const isAxis = (v: unknown): v is Axis => v === -1 || v === 0 || v === 1;
const isTile = (v: unknown): boolean => typeof v === 'number' && isInt32(v);
const isUint16 = (v: unknown): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffff;
const isUint32 = (v: unknown): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffff_ffff;
const isCount = (v: unknown): boolean => isUint16(v) && (v as number) > 0;

/**
 * Checks the fields of a command that has no tick yet (e.g. one received from
 * the main thread). Returns an error message, or `null` if the command is valid.
 */
export function validateCommandInput(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) {
    return 'command must be an object';
  }
  const c = input as Record<string, unknown>;
  const { playerId } = c;
  if (
    typeof playerId !== 'number' ||
    !Number.isInteger(playerId) ||
    playerId < 0 ||
    playerId > MAX_PLAYER_ID
  ) {
    return `invalid playerId ${String(playerId)}`;
  }
  switch (c.type) {
    case 'Move':
      return isAxis(c.dx) && isAxis(c.dy) ? null : 'Move needs dx and dy in {-1, 0, 1}';
    case 'MineStart':
      return isTile(c.x) && isTile(c.y) ? null : 'MineStart needs int32 x and y';
    case 'MineStop':
      return null;
    case 'Place':
      return isUint16(c.item) && isTile(c.x) && isTile(c.y) && isDirection(c.dir)
        ? null
        : 'Place needs a uint16 item, int32 x and y, and dir in [0, 3]';
    case 'Remove':
    case 'Rotate':
      return isTile(c.x) && isTile(c.y) ? null : `${c.type} needs int32 x and y`;
    case 'Insert':
      return isUint32(c.entity) && isUint16(c.item) && isCount(c.count)
        ? null
        : 'Insert needs a uint32 entity, a uint16 item and a count in [1, 65535]';
    case 'Take':
      return isUint32(c.entity) && isUint16(c.slot) && isCount(c.count)
        ? null
        : 'Take needs a uint32 entity, a uint16 slot and a count in [1, 65535]';
    case 'SetRecipe':
      return isUint32(c.entity) && isUint16(c.recipe)
        ? null
        : 'SetRecipe needs a uint32 entity and a uint16 recipe';
    case 'Craft':
      return isUint16(c.recipe) && isUint16(c.count) && c.count !== 0
        ? null
        : 'Craft needs a uint16 recipe and a count in [1, 65535]';
    case 'CancelCraft':
      return isUint16(c.index) ? null : 'CancelCraft needs a uint16 index';
    case 'SetResearch':
      return isUint16(c.tech) ? null : 'SetResearch needs a uint16 tech';
    default:
      return `unknown command type ${String(c.type)}`;
  }
}

/** Like {@link validateCommandInput}, but also checks the tick. */
export function validateCommand(cmd: unknown): string | null {
  const tick = (cmd as { tick?: unknown } | null)?.tick;
  if (typeof tick !== 'number' || !Number.isSafeInteger(tick) || tick < 0) {
    return `invalid tick ${String(tick)}`;
  }
  return validateCommandInput(cmd);
}

/**
 * Pending commands, kept sorted by (tick, playerId, insertion order).
 * Commands are only ever taken from the front, one tick at a time.
 */
export class CommandQueue {
  private items: { readonly cmd: Command; readonly seq: number }[] = [];
  private head = 0;
  private nextSeq = 0;

  get size(): number {
    return this.items.length - this.head;
  }

  /** Adds a command; it must already be validated. */
  push(cmd: Command): void {
    const entry = { cmd, seq: this.nextSeq++ };
    // Find the first item that sorts after `entry`. New entries usually belong
    // at the end, so check that first.
    let lo = this.head;
    let hi = this.items.length;
    const last = this.items[hi - 1];
    if (last === undefined || hi === lo || compare(last.cmd, cmd) <= 0) {
      this.items.push(entry);
      return;
    }
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (compare(this.items[mid]!.cmd, cmd) <= 0) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this.items.splice(lo, 0, entry);
  }

  /** The queued commands in the order they will run (for saves). */
  pending(): Command[] {
    return this.items.slice(this.head).map((e) => e.cmd);
  }

  /** Removes and returns, in order, every command whose tick is `<= tick`. */
  takeUpTo(tick: number): Command[] {
    const out: Command[] = [];
    while (this.head < this.items.length && this.items[this.head]!.cmd.tick <= tick) {
      out.push(this.items[this.head]!.cmd);
      this.head++;
    }
    // Compact once the consumed prefix dominates, keeping pushes amortized O(1).
    if (this.head > 64 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return out;
  }
}

/** Orders by tick, then playerId. Equal keys keep insertion order (the queue inserts after equals). */
function compare(a: Command, b: Command): number {
  return a.tick - b.tick || a.playerId - b.playerId;
}

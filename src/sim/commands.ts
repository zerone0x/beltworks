/**
 * Commands: every player action that changes simulation state.
 *
 * A command is tagged with the tick it applies on and the player that issued
 * it. Commands for the same tick are applied in a stable order (by player id,
 * then insertion order), so the same command log always produces the same
 * state. All fields are integers.
 */

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

export type Command = MoveCommand | MineStartCommand | MineStopCommand;
export type CommandType = Command['type'];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A command without its tick, as sent by the main thread; the worker stamps the tick. */
export type CommandInput = DistributiveOmit<Command, 'tick'>;

export const MAX_PLAYER_ID = 0xffff;

const isAxis = (v: unknown): v is Axis => v === -1 || v === 0 || v === 1;

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
      return typeof c.x === 'number' && typeof c.y === 'number' && isInt32(c.x) && isInt32(c.y)
        ? null
        : 'MineStart needs int32 x and y';
    case 'MineStop':
      return null;
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

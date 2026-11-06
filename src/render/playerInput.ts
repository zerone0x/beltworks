/**
 * Player controls: WASD moves, holding the right mouse button on a resource
 * tile hand-mines it, `E` toggles the inventory and `F` makes the camera
 * follow the player again.
 *
 * Input becomes commands (see src/sim/commands.ts) that are only sent when
 * they change something: one `Move` when the held keys change direction, one
 * `MineStart` when the mined tile changes, one `MineStop` when mining ends.
 */

import type { Axis, CommandInput } from '../sim/commands';
import type { Point } from './camera';

/** Movement keys by `KeyboardEvent.code`, so they sit in the same place on every layout. */
const MOVE_KEYS: Readonly<Record<string, readonly [Axis, Axis]>> = {
  KeyW: [0, -1],
  KeyA: [-1, 0],
  KeyS: [0, 1],
  KeyD: [1, 0],
};
const RIGHT_BUTTON = 2;
/** `PointerEvent.buttons` bit of the right button. */
const RIGHT_BUTTONS_BIT = 2;

/** The movement direction for a set of held key codes; opposite keys cancel out. */
export function moveAxes(held: Iterable<string>): [Axis, Axis] {
  let dx = 0;
  let dy = 0;
  for (const code of held) {
    const dir = MOVE_KEYS[code];
    if (dir) {
      dx += dir[0];
      dy += dir[1];
    }
  }
  return [Math.sign(dx) as Axis, Math.sign(dy) as Axis];
}

export interface PlayerInputOptions {
  /** The game canvas: right-clicks on it start mining. */
  element: HTMLElement;
  /** The player the commands are for. */
  playerId: number;
  /** Sends commands to the simulation. */
  send: (commands: CommandInput[]) => void;
  /** Pointer position over the canvas in CSS pixels, or `null` when it is elsewhere. */
  pointer: () => Point | null;
  /** Tile under a screen position. */
  tileAt: (sx: number, sy: number) => Point;
  /** Whether tile `(x, y)` has a resource to mine, as far as the renderer knows. */
  isMineable: (x: number, y: number) => boolean;
  onToggleInventory?: () => void;
  onFollow?: () => void;
}

export class PlayerInput {
  private readonly held = new Set<string>();
  private rightHeld = false;
  private sentMove: readonly [Axis, Axis] = [0, 0];
  private sentTarget: Point | null = null;
  private readonly controller = new AbortController();

  constructor(private readonly options: PlayerInputOptions) {
    const opts = { signal: this.controller.signal };
    const { element } = options;
    element.addEventListener('pointerdown', this.onPointerDown, opts);
    element.addEventListener('contextmenu', preventDefault, opts);
    window.addEventListener('pointerup', this.onPointerUp, opts);
    window.addEventListener('pointermove', this.onPointerMove, opts);
    window.addEventListener('keydown', this.onKeyDown, opts);
    window.addEventListener('keyup', this.onKeyUp, opts);
    window.addEventListener('blur', this.onBlur, opts);
  }

  /** Whether the right mouse button is held for mining. */
  get mining(): boolean {
    return this.rightHeld;
  }

  /**
   * Sends whatever changed since the last call. Call once per frame, after the
   * camera moved: the tile under a still pointer changes as the view follows
   * the player.
   */
  update(): void {
    const commands: CommandInput[] = [];
    const { playerId } = this.options;

    const [dx, dy] = moveAxes(this.held);
    if (dx !== this.sentMove[0] || dy !== this.sentMove[1]) {
      this.sentMove = [dx, dy];
      commands.push({ type: 'Move', playerId, dx, dy });
    }

    const target = this.miningTarget();
    const sent = this.sentTarget;
    if (target && (!sent || sent.x !== target.x || sent.y !== target.y)) {
      commands.push({ type: 'MineStart', playerId, x: target.x, y: target.y });
    } else if (!target && sent) {
      commands.push({ type: 'MineStop', playerId });
    }
    this.sentTarget = target;

    if (commands.length > 0) {
      this.options.send(commands);
    }
  }

  destroy(): void {
    this.controller.abort();
  }

  /** The tile to mine right now: the resource tile under the pointer while the right button is held. */
  private miningTarget(): Point | null {
    if (!this.rightHeld) {
      return null;
    }
    const p = this.options.pointer();
    if (!p) {
      return null;
    }
    const tile = this.options.tileAt(p.x, p.y);
    return this.options.isMineable(tile.x, tile.y) ? tile : null;
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button === RIGHT_BUTTON) {
      e.preventDefault();
      this.rightHeld = true;
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.button === RIGHT_BUTTON) {
      this.rightHeld = false;
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    // Catches a release that happened outside the window.
    if ((e.buttons & RIGHT_BUTTONS_BIT) === 0) {
      this.rightHeld = false;
    }
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    if (e.code in MOVE_KEYS) {
      e.preventDefault();
      this.held.add(e.code);
    } else if (e.code === 'KeyE' && !e.repeat) {
      e.preventDefault();
      this.options.onToggleInventory?.();
    } else if (e.code === 'KeyF' && !e.repeat) {
      e.preventDefault();
      this.options.onFollow?.();
    }
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.held.delete(e.code);
  };

  private readonly onBlur = (): void => {
    this.held.clear();
    this.rightHeld = false;
  };
}

function preventDefault(e: Event): void {
  e.preventDefault();
}

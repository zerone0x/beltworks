/**
 * Player controls: WASD moves, the right mouse button removes the entity
 * under the cursor or, where there is none, hand-mines the resource or tree
 * tile (held), `E` toggles the inventory and `F` makes the camera follow the
 * player again. Build controls (placing, rotating) are in buildInput.ts.
 *
 * Input becomes commands (see src/sim/commands.ts) that are only sent when
 * they change something: one `Move` when the held keys change direction, one
 * `MineStart` when the mined tile changes, one `MineStop` when mining ends,
 * one `Remove` per entity the held right button passes over.
 *
 * A right-button press that starts on an entity only removes: it never turns
 * into mining, so removing a drill doesn't start mining the ore under it.
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
  /** Whether tile `(x, y)` has a resource or a tree to mine, as far as the renderer knows. */
  isMineable: (x: number, y: number) => boolean;
  /** Id of the entity covering tile `(x, y)`, or 0, as far as the renderer knows. */
  entityAt?: (x: number, y: number) => number;
  onToggleInventory?: () => void;
  onFollow?: () => void;
}

export class PlayerInput {
  private readonly held = new Set<string>();
  private rightHeld = false;
  /** What the current right-button press does: decided on the first frame of the press. */
  private rightMode: 'pending' | 'remove' | 'mine' = 'pending';
  /** A press not yet seen by `update()`, so a quick click still removes. */
  private pressPending = false;
  /** The last entity this press sent a `Remove` for. */
  private removedId = 0;
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

    const hovered = this.hoveredEntity();
    const pressed = this.rightHeld || this.pressPending;
    this.pressPending = false;
    if (pressed) {
      if (this.rightMode === 'pending') {
        this.rightMode = hovered.id !== 0 ? 'remove' : 'mine';
      }
      if (hovered.id !== 0 && hovered.id !== this.removedId) {
        this.removedId = hovered.id;
        commands.push({ type: 'Remove', playerId, x: hovered.x, y: hovered.y });
      }
    }

    const target = this.rightMode === 'mine' && hovered.id === 0 ? this.miningTarget() : null;
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

  /** The tile under the pointer and the entity covering it (id 0 for none). */
  private hoveredEntity(): { x: number; y: number; id: number } {
    const p = this.options.pointer();
    if (!p) {
      return { x: 0, y: 0, id: 0 };
    }
    const tile = this.options.tileAt(p.x, p.y);
    return { ...tile, id: this.options.entityAt?.(tile.x, tile.y) ?? 0 };
  }

  /** The tile to mine right now: the resource or tree tile under the pointer while the right button is held. */
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
      this.rightMode = 'pending';
      this.pressPending = true;
      this.removedId = 0;
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

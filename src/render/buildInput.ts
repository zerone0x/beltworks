/**
 * Build controls: the `1`–`0` keys select a hotbar slot (again to deselect,
 * `Q` clears the selection); while the selected item places an entity, a
 * ghost preview follows the cursor, `R` rotates it, and the left mouse button
 * places it (holding it and dragging places along the way). Without a ghost,
 * `R` rotates the entity under the cursor.
 *
 * Removing entities is on the right mouse button, together with mining (see
 * playerInput.ts).
 */

import { entityForItem, type EntityPrototype } from '../data/entities';
import type { CommandInput } from '../sim/commands';
import { Direction, rotateClockwise } from '../sim/entities/direction';
import { footprintSize } from '../sim/entities/store';
import type { SlotData } from '../sim/snapshot';
import { HOTBAR_SLOTS } from '../ui/inventory';
import { TILE_PX, type Point } from './camera';
import type { EntityView } from './entityIndex';
import type { Ghost } from './entityLayer';

const LEFT_BUTTON = 0;
/** `PointerEvent.buttons` bit of the left button. */
const LEFT_BUTTONS_BIT = 1;

/** Hotbar slot per `KeyboardEvent.code`: `1`…`9` are slots 0–8, `0` is slot 9. */
export function hotbarSlotForKey(code: string): number | null {
  const m = /^Digit(\d)$/.exec(code);
  if (!m) return null;
  const digit = Number(m[1]);
  const slot = digit === 0 ? 9 : digit - 1;
  return slot < HOTBAR_SLOTS ? slot : null;
}

/**
 * The top-left tile of a footprint of `proto` facing `dir` centered as
 * closely as possible on world position `(wx, wy)` (world pixels): a 1×1
 * entity lands on the tile under the cursor, a 2×2 one on the four tiles
 * around the nearest tile corner.
 */
export function ghostOrigin(proto: EntityPrototype, dir: Direction, wx: number, wy: number): Point {
  const { w, h } = footprintSize(proto, dir);
  return {
    x: Math.floor(wx / TILE_PX - w / 2 + 0.5),
    y: Math.floor(wy / TILE_PX - h / 2 + 0.5),
  };
}

export interface BuildInputOptions {
  /** The game canvas: left clicks on it place. */
  element: HTMLElement;
  /** The player the commands are for. */
  playerId: number;
  send: (commands: CommandInput[]) => void;
  /** Pointer position over the canvas in CSS pixels, or `null` when it is elsewhere. */
  pointer: () => Point | null;
  /** World position (world pixels) under a screen position. */
  screenToWorld: (sx: number, sy: number) => Point;
  /** Tile under a screen position. */
  tileAt: (sx: number, sy: number) => Point;
  /** The local player's inventory as last received. */
  inventory: () => readonly SlotData[];
  /** The entity covering tile `(x, y)`, as far as the renderer knows. */
  entityAt: (x: number, y: number) => EntityView | null;
  /** Whether `proto` can be placed there, as far as the renderer can tell. */
  canPlace: (proto: EntityPrototype, x: number, y: number, dir: Direction) => boolean;
  /** Called when the selected hotbar slot changes. */
  onSelect?: (slot: number | null) => void;
}

export class BuildInput {
  /** Selected hotbar slot, or `null`. */
  selected: number | null = null;
  /** Direction of the ghost. Kept across selections, like a held item's rotation. */
  dir: Direction = Direction.North;
  /** The ghost after the latest `update()`, or `null` when there is none. */
  ghost: Ghost | null = null;
  private leftHeld = false;
  /** A press not yet seen by `update()`, so a quick click still places. */
  private clickPending = false;
  /** Where the current left-button press last placed, so a held button places once per spot. */
  private lastPlaced: string | null = null;
  private rotateRequested = false;
  private readonly controller = new AbortController();

  constructor(private readonly options: BuildInputOptions) {
    const opts = { signal: this.controller.signal };
    options.element.addEventListener('pointerdown', this.onPointerDown, opts);
    window.addEventListener('pointerup', this.onPointerUp, opts);
    window.addEventListener('pointermove', this.onPointerMove, opts);
    window.addEventListener('keydown', this.onKeyDown, opts);
    window.addEventListener('blur', this.onBlur, opts);
  }

  /** The prototype the selected slot's item places, or `null`. */
  selectedPrototype(): EntityPrototype | null {
    if (this.selected === null) return null;
    const slot = this.options.inventory()[this.selected];
    if (!slot || slot.count === 0) return null;
    return entityForItem(slot.item) ?? null;
  }

  /** Selects hotbar slot `slot` (or clears the selection for `null`). */
  select(slot: number | null): void {
    if (slot === this.selected) return;
    this.selected = slot;
    this.options.onSelect?.(slot);
  }

  /** Updates the ghost and sends whatever the input asks for. Call once per frame, after the camera moved. */
  update(): void {
    const { options } = this;
    const commands: CommandInput[] = [];
    const proto = this.selectedPrototype();
    const p = options.pointer();
    const pressed = this.leftHeld || this.clickPending;
    this.clickPending = false;

    if (this.rotateRequested) {
      this.rotateRequested = false;
      if (proto) {
        if (proto.rotatable) this.dir = rotateClockwise(this.dir);
      } else if (p) {
        const tile = options.tileAt(p.x, p.y);
        if (options.entityAt(tile.x, tile.y)?.proto?.rotatable) {
          commands.push({ type: 'Rotate', playerId: options.playerId, x: tile.x, y: tile.y });
        }
      }
    }

    if (proto && p) {
      const dir = proto.rotatable ? this.dir : Direction.North;
      const world = options.screenToWorld(p.x, p.y);
      const { x, y } = ghostOrigin(proto, dir, world.x, world.y);
      const valid = options.canPlace(proto, x, y, dir);
      this.ghost = { proto, x, y, dir, valid };
      const spot = `${String(proto.id)}:${String(x)}:${String(y)}:${String(dir)}`;
      if (pressed && valid && spot !== this.lastPlaced) {
        this.lastPlaced = spot;
        commands.push({ type: 'Place', playerId: options.playerId, item: proto.item, x, y, dir });
      }
    } else {
      this.ghost = null;
    }

    if (commands.length > 0) {
      options.send(commands);
    }
  }

  destroy(): void {
    this.controller.abort();
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    if (e.button === LEFT_BUTTON) {
      this.leftHeld = true;
      this.clickPending = true;
      this.lastPlaced = null;
    }
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    if (e.button === LEFT_BUTTON) {
      this.leftHeld = false;
    }
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    if ((e.buttons & LEFT_BUTTONS_BIT) === 0) {
      this.leftHeld = false;
    }
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    if (e.ctrlKey || e.metaKey || e.altKey) {
      return;
    }
    const slot = hotbarSlotForKey(e.code);
    if (slot !== null) {
      e.preventDefault();
      if (!e.repeat) this.select(slot === this.selected ? null : slot);
    } else if (e.code === 'KeyQ' && !e.repeat) {
      e.preventDefault();
      this.select(null);
    } else if (e.code === 'KeyR' && !e.repeat) {
      e.preventDefault();
      this.rotateRequested = true;
    }
  };

  private readonly onBlur = (): void => {
    this.leftHeld = false;
  };
}

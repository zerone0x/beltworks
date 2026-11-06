/**
 * Build controls: the `1`–`0` keys select a hotbar slot (again to deselect,
 * `Q` clears the selection), and a click in the inventory window selects any
 * slot holding a placeable item (`selectSlot`, wired up in main.ts). `Q` with
 * nothing selected is the pipette: it selects the item of the entity under
 * the cursor, if the inventory holds one, facing the same way. While the
 * selected item places an entity, a
 * ghost preview follows the cursor, `R` rotates it, and the left mouse button
 * places it (holding it and dragging places along the way). Without a ghost,
 * `R` rotates the entity under the cursor and a left click opens its GUI
 * (`onOpenEntity`).
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
 * The slot to select for placing item `item`: the first one holding it (so
 * the hotbar comes first), or `null` if no slot does.
 */
export function slotWithItem(slots: readonly SlotData[], item: number): number | null {
  const i = slots.findIndex((s) => s.item === item && s.count > 0);
  return i < 0 ? null : i;
}

/**
 * Where a selection of slot `slot` past the hotbar, made for item `item`,
 * goes once the inventory is `slots`: it stays while the slot still holds the
 * item, moves to another slot holding it once the slot runs out (or something
 * else lands there), and is dropped (`null`) when none does. Hotbar slots stay
 * selected whatever they hold, like their number keys.
 */
export function followSelection(
  slots: readonly SlotData[],
  slot: number,
  item: number,
): number | null {
  if (slot < HOTBAR_SLOTS) return slot;
  const s = slots[slot];
  if (s && s.item === item && s.count > 0) return slot;
  return slotWithItem(slots, item);
}

/** Whether inventory slot `slot` of `slots` holds an item that places an entity. */
export function isPlaceableSlot(slots: readonly SlotData[], slot: number): boolean {
  const s = slots[slot];
  return s !== undefined && s.count > 0 && entityForItem(s.item) !== undefined;
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
  /** Called when the selected slot changes (an inventory slot index: 0–9 are the hotbar). */
  onSelect?: (slot: number | null) => void;
  /** A left click with nothing to place landed on this entity: open its GUI. */
  onOpenEntity?: (entity: EntityView) => void;
}

export class BuildInput {
  /** Selected inventory slot (0–9 are the hotbar slots), or `null`. */
  selected: number | null = null;
  /** The item a selection past the hotbar was made for (see `followSelection`). */
  private selectedItem = 0;
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

  /**
   * Selects inventory slot `slot` (or clears the selection for `null`). A
   * slot past the hotbar is only selected while it holds a placeable item.
   */
  select(slot: number | null): void {
    if (slot !== null && slot >= HOTBAR_SLOTS) {
      const inventory = this.options.inventory();
      if (!isPlaceableSlot(inventory, slot)) slot = null;
      else this.selectedItem = inventory[slot]!.item;
    }
    if (slot === this.selected) return;
    this.selected = slot;
    this.options.onSelect?.(slot);
  }

  /**
   * The pipette: with nothing selected, selects the slot holding the item of
   * the entity under the cursor and turns the ghost the way the entity faces.
   * Does nothing if there is no entity there or the inventory has none of its
   * item. Returns whether it selected something.
   */
  pipette(): boolean {
    const { options } = this;
    const p = options.pointer();
    if (this.selected !== null || !p) return false;
    const tile = options.tileAt(p.x, p.y);
    const entity = options.entityAt(tile.x, tile.y);
    const proto = entity?.proto;
    if (!entity || !proto) return false;
    const slot = slotWithItem(options.inventory(), proto.item);
    if (slot === null) return false;
    if (proto.rotatable) this.dir = entity.dir;
    this.select(slot);
    return true;
  }

  /** Updates the ghost and sends whatever the input asks for. Call once per frame, after the camera moved. */
  update(): void {
    const { options } = this;
    const commands: CommandInput[] = [];
    if (this.selected !== null && this.selected >= HOTBAR_SLOTS) {
      this.select(followSelection(options.inventory(), this.selected, this.selectedItem));
    }
    const proto = this.selectedPrototype();
    const p = options.pointer();
    const clicked = this.clickPending;
    const pressed = this.leftHeld || clicked;
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
      if (clicked && p) {
        const tile = options.tileAt(p.x, p.y);
        const entity = options.entityAt(tile.x, tile.y);
        if (entity) options.onOpenEntity?.(entity);
      }
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
      if (this.selected !== null) this.select(null);
      else this.pipette();
    } else if (e.code === 'KeyR' && !e.repeat) {
      e.preventDefault();
      this.rotateRequested = true;
    }
  };

  private readonly onBlur = (): void => {
    this.leftHeld = false;
  };
}

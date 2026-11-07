/**
 * Build controls and the cursor stack (D52). What the cursor holds is the
 * `selection`: a hotbar slot (its key, `1`–`0` by default, or a click on it;
 * again to put it away, `Q` too) or a stack picked up in the inventory
 * window (`pickUp`, wired up in main.ts, which also drops it into other
 * slots and entities). `Q` with nothing held is the pipette: it takes the
 * item of the entity under the cursor, if the inventory holds one, facing
 * the same way. While the held item places an entity, a ghost preview
 * follows the cursor, `R` rotates it, and the left mouse button places it
 * (holding it and dragging places along the way). Without a ghost, `R`
 * rotates the entity under the cursor and a left click opens its GUI
 * (`onOpenEntity`). `Alt` with a hotbar key asks to pin an item to that
 * hotbar slot (`onAssignHotbar`).
 *
 * The keys are the default bindings (src/ui/keybindings.ts). Removing
 * entities is on the right mouse button, together with mining (see
 * playerInput.ts).
 */

import { entityForItem, type EntityPrototype } from '../data/entities';
import type { CommandInput } from '../sim/commands';
import { Direction, rotateClockwise } from '../sim/entities/direction';
import { footprintSize } from '../sim/entities/store';
import type { SlotData } from '../sim/snapshot';
import { HOTBAR_SLOTS } from '../ui/inventory';
import { actionFor, hotbarSlotForCode } from '../ui/keybindings';
import { TILE_PX, type Point } from './camera';
import type { EntityView } from './entityIndex';
import type { Ghost } from './entityLayer';

const LEFT_BUTTON = 0;
/** `PointerEvent.buttons` bit of the left button. */
const LEFT_BUTTONS_BIT = 1;

/**
 * Hotbar slot per `KeyboardEvent.code` under the current bindings: by
 * default `1`…`9` are slots 0–8 and `0` is slot 9.
 */
export function hotbarSlotForKey(code: string): number | null {
  const slot = hotbarSlotForCode(code);
  return slot !== null && slot < HOTBAR_SLOTS ? slot : null;
}

/**
 * What the cursor holds: hotbar slot `index` (whatever it shows: the
 * inventory slot of the same index, or the item pinned there), or `count`
 * units (`null`: the whole stack) of the stack of `item` in inventory slot
 * `slot`, picked up in a window.
 */
export type Selection =
  | { readonly kind: 'hotbar'; readonly index: number }
  | {
      readonly kind: 'slot';
      readonly slot: number;
      readonly item: number;
      readonly count: number | null;
    };

/**
 * The slot to select for placing item `item`: the first one holding it (so
 * the hotbar comes first), or `null` if no slot does.
 */
export function slotWithItem(slots: readonly SlotData[], item: number): number | null {
  const i = slots.findIndex((s) => s.item === item && s.count > 0);
  return i < 0 ? null : i;
}

/**
 * Where a stack picked up from slot `slot`, holding item `item`, goes once
 * the inventory is `slots`: it stays while the slot still holds the item,
 * moves to another slot holding it once the slot runs out (or something else
 * lands there), and is dropped (`null`) when none does.
 */
export function followSelection(
  slots: readonly SlotData[],
  slot: number,
  item: number,
): number | null {
  const s = slots[slot];
  if (s && s.item === item && s.count > 0) return slot;
  return slotWithItem(slots, item);
}

/**
 * The inventory slot `selection` takes its items from, with the inventory
 * `slots` and hotbar pins `pins` (item ids by hotbar slot, 0 for none): an
 * unpinned hotbar slot is the inventory slot of the same index (selected
 * whatever it holds, like its key); a pinned one is the first slot holding
 * the pinned item, or `null` while there is none (the selection stays); a
 * picked-up stack follows its item (`followSelection`), and the selection is
 * dropped (`selection` `null`) once the inventory has none of it.
 */
export function resolveSelection(
  slots: readonly SlotData[],
  pins: readonly number[],
  selection: Selection | null,
): { selection: Selection | null; slot: number | null } {
  if (selection === null) return { selection, slot: null };
  if (selection.kind === 'hotbar') {
    const pin = pins[selection.index] ?? 0;
    return { selection, slot: pin === 0 ? selection.index : slotWithItem(slots, pin) };
  }
  const slot = followSelection(slots, selection.slot, selection.item);
  if (slot === null) return { selection: null, slot: null };
  return { selection: slot === selection.slot ? selection : { ...selection, slot }, slot };
}

/** The hotbar slot to highlight for `selection` (`null` for none). */
export function hotbarHighlight(
  selection: Selection | null,
  pins: readonly number[],
): number | null {
  if (selection === null) return null;
  if (selection.kind === 'hotbar') return selection.index;
  return selection.slot < HOTBAR_SLOTS && (pins[selection.slot] ?? 0) === 0 ? selection.slot : null;
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
  /** Item pinned to hotbar slot `index`, or 0 when it shows the inventory slot of that index. */
  hotbarPin?: (index: number) => number;
  /**
   * Called when what the cursor holds changes: the inventory slot it takes
   * from (`null` for none) and the hotbar slot to highlight (`null` for none).
   */
  onSelect?: (slot: number | null, hotbar: number | null) => void;
  /** `Alt` and the key of hotbar slot `index`: pin an item there. */
  onAssignHotbar?: (index: number) => void;
  /** A left click with nothing to place landed on this entity: open its GUI. */
  onOpenEntity?: (entity: EntityView) => void;
}

export class BuildInput {
  /** The inventory slot the cursor takes from (the hotbar slot's, a picked-up stack's), or `null`. */
  selected: number | null = null;
  /** What the cursor holds, or `null`. */
  selection: Selection | null = null;
  /** The hotbar slot highlighted for the selection, or `null`. */
  private highlighted: number | null = null;
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

  /** Item pins by hotbar slot. */
  private pins(): number[] {
    const pin = this.options.hotbarPin;
    return Array.from({ length: HOTBAR_SLOTS }, (_, i) => pin?.(i) ?? 0);
  }

  /** Holds `selection` (or nothing for `null`) and reports the change. */
  private hold(selection: Selection | null): void {
    const pins = this.pins();
    const resolved = resolveSelection(this.options.inventory(), pins, selection);
    this.selection = resolved.selection;
    const highlighted = hotbarHighlight(resolved.selection, pins);
    if (resolved.slot === this.selected && highlighted === this.highlighted) return;
    this.selected = resolved.slot;
    this.highlighted = highlighted;
    this.options.onSelect?.(this.selected, highlighted);
  }

  /** Holds hotbar slot `index` (whatever it shows). */
  selectHotbar(index: number): void {
    this.hold({ kind: 'hotbar', index });
  }

  /**
   * Picks up `count` units (`null`: all) of the stack in inventory slot
   * `slot`; nothing for an empty slot. The whole stack of an unpinned hotbar
   * slot is that hotbar slot.
   */
  pickUp(slot: number, count: number | null = null): void {
    const s = this.options.inventory()[slot];
    if (!s || s.count === 0) return;
    if (count === null && slot < HOTBAR_SLOTS && (this.options.hotbarPin?.(slot) ?? 0) === 0) {
      this.selectHotbar(slot);
    } else {
      this.hold({ kind: 'slot', slot, item: s.item, count: count && Math.min(count, s.count) });
    }
  }

  /** Units the cursor would drop: the picked-up count, at most what its slot holds (0 for none). */
  handCount(): number {
    if (this.selected === null) return 0;
    const have = this.options.inventory()[this.selected]?.count ?? 0;
    const sel = this.selection;
    return sel?.kind === 'slot' && sel.count !== null ? Math.min(sel.count, have) : have;
  }

  /** Re-resolves the selection, e.g. after the hotbar pins changed. */
  refresh(): void {
    this.hold(this.selection);
  }

  /**
   * Selects inventory slot `slot` (or clears the selection for `null`): the
   * hotbar slot of that index, or the stack of a slot past the hotbar (only
   * while it holds an item).
   */
  select(slot: number | null): void {
    if (slot === null) this.hold(null);
    else if (slot < HOTBAR_SLOTS) this.selectHotbar(slot);
    else this.pickUp(slot);
  }

  /**
   * The pipette: with nothing selected, takes the item of the entity under
   * the cursor (from a hotbar slot pinned to it, else from the first slot
   * holding it) and turns the ghost the way the entity faces. Does nothing
   * if there is no entity there or the inventory has none of its item.
   * Returns whether it selected something.
   */
  pipette(): boolean {
    const { options } = this;
    const p = options.pointer();
    if (this.selection !== null || !p) return false;
    const tile = options.tileAt(p.x, p.y);
    const entity = options.entityAt(tile.x, tile.y);
    const proto = entity?.proto;
    if (!entity || !proto) return false;
    const slot = slotWithItem(options.inventory(), proto.item);
    if (slot === null) return false;
    if (proto.rotatable) this.dir = entity.dir;
    const pinned = this.pins().indexOf(proto.item);
    if (pinned >= 0) this.selectHotbar(pinned);
    else this.pickUp(slot);
    return true;
  }

  /** Updates the ghost and sends whatever the input asks for. Call once per frame, after the camera moved. */
  update(): void {
    const { options } = this;
    const commands: CommandInput[] = [];
    // A picked-up stack follows its item; a pinned hotbar slot finds its item.
    if (this.selection !== null) this.hold(this.selection);
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
    if (e.ctrlKey || e.metaKey) {
      return;
    }
    const slot = hotbarSlotForKey(e.code);
    if (e.altKey) {
      if (slot !== null) {
        e.preventDefault();
        if (!e.repeat) this.options.onAssignHotbar?.(slot);
      }
      return;
    }
    const action = actionFor(e.code);
    if (slot !== null) {
      e.preventDefault();
      if (e.repeat) return;
      const held = this.selection;
      if (held?.kind === 'hotbar' && held.index === slot) this.hold(null);
      else this.selectHotbar(slot);
    } else if (action === 'pipette' && !e.repeat) {
      e.preventDefault();
      if (this.selection !== null) this.hold(null);
      else this.pipette();
    } else if (action === 'rotate' && !e.repeat) {
      e.preventDefault();
      this.rotateRequested = true;
    }
  };

  private readonly onBlur = (): void => {
    this.leftHeld = false;
  };
}

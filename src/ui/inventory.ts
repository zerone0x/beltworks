/**
 * Inventory UI (plain DOM): the inventory panel, toggled with `E` (other
 * panels such as crafting can add sections to it), and the hotbar strip of
 * `HOTBAR_SLOTS` slots, each showing the inventory slot of the same index
 * or, once an item is pinned to it, that item and how many the inventory
 * holds (`hotbarSlots`, D51). Both highlight what the cursor holds (D52):
 * keys `1`–`0` or a click on a hotbar slot select one there, a click in the
 * inventory panel picks up a stack. Both show each slot's item as its icon
 * (src/render/itemIcons.ts, the same as on belts and in inserter hands)
 * with its count.
 *
 * Slots have fixed pixel sizes and an empty slot has no text, so the hotbar
 * looks the same on every machine (it is part of the screenshot tests).
 */

import { ITEM_IDS, ITEMS, itemPrototype } from '../data/items';
import { ICON_PX, hasRenderedIcon, iconDataUrl, onIconsChanged } from '../render/itemIcons';
import type { SlotData } from '../sim/snapshot';

/** Slots in the hotbar. */
export const HOTBAR_SLOTS = 10;
/** Columns in the inventory panel grid. */
export const INVENTORY_COLUMNS = 10;
export const SLOT_PX = 36;
export const GAP_PX = 2;
/** Distance of the hotbar from the bottom of the screen. */
export const HOTBAR_BOTTOM_PX = 8;
const SLOT_BORDER = '1px solid rgba(232, 226, 208, 0.25)';
/** Drawn as an outline inside the slot, so selecting doesn't shift its contents. */
const SELECTED_OUTLINE = '2px solid #f2d36b';
/** Border of a hotbar slot with a pinned item. */
const PINNED_BORDER = '1px solid rgba(120, 190, 255, 0.85)';

/** Icons in slots are drawn this many CSS pixels per icon pixel. */
const ICON_SCALE = 2;

/** How much of a stack a click on a slot moves (between the inventory and an entity). */
export type Transfer = 'all' | 'half' | 'one';

/**
 * What a mouse event on a slot asks for: a left click (or shift-click) moves
 * the whole stack, a right click half of it (rounded up), and a ctrl-click
 * (⌘-click on a Mac) or a middle click a single item. `null` for other buttons.
 */
export function transferFor(
  e: Pick<MouseEvent, 'button' | 'ctrlKey' | 'metaKey'>,
): Transfer | null {
  switch (e.button) {
    case 0:
      return e.ctrlKey || e.metaKey ? 'one' : 'all';
    case 1:
      return 'one';
    case 2:
      return 'half';
    default:
      return null;
  }
}

/** Units of a stack of `count` that `transfer` moves. */
export function transferCount(count: number, transfer: Transfer): number {
  switch (transfer) {
    case 'all':
      return count;
    case 'half':
      return Math.ceil(count / 2);
    case 'one':
      return Math.min(1, count);
  }
}

/**
 * An element showing an item icon in a slot-sized box (`SLOT_PX` with a 1px
 * border), centered; set its item with `setSlotIcon`.
 */
export function makeSlotIcon(): HTMLElement {
  const iconPx = ICON_PX * ICON_SCALE;
  const inset = `${String(Math.floor((SLOT_PX - 2 - iconPx) / 2))}px`;
  const icon = document.createElement('div');
  icon.className = 'icon';
  Object.assign(icon.style, {
    position: 'absolute',
    left: inset,
    top: inset,
    width: `${String(iconPx)}px`,
    height: `${String(iconPx)}px`,
    backgroundSize: '100% 100%',
    imageRendering: 'pixelated',
  } satisfies Partial<CSSStyleDeclaration>);
  return icon;
}

/** Shows item `item`'s icon on an element from `makeSlotIcon`, or nothing for 0. */
export function setSlotIcon(icon: HTMLElement, item: number): void {
  icon.dataset.item = String(item);
  icon.style.backgroundImage = item === 0 ? 'none' : `url(${iconDataUrl(item)})`;
  // Rendered icons scale smoothly; the lettered pixel art stays crisp.
  icon.style.imageRendering = hasRenderedIcon(item) ? 'auto' : 'pixelated';
}

// When the rendered icons arrive (or letters are toggled), every slot shows the new ones.
onIconsChanged(() => {
  for (const icon of document.querySelectorAll<HTMLElement>('.icon[data-item]')) {
    setSlotIcon(icon, Number(icon.dataset.item));
  }
});

/** CSS color for a 0xRRGGBB value. */
export function cssColor(rgb: number): string {
  return `#${rgb.toString(16).padStart(6, '0')}`;
}

/** What a slot displays: swatch color, count text, and a tooltip. */
export interface SlotView {
  /** Internal item name, or `''` for an empty slot. */
  name: string;
  /** Swatch color, or `null` for an empty slot. */
  color: string | null;
  /** Count text; empty for an empty slot. */
  count: string;
  title: string;
}

export function slotView(slot: SlotData): SlotView {
  if (slot.item === 0 || slot.count === 0) {
    return { name: '', color: null, count: '', title: 'Empty' };
  }
  const proto = itemPrototype(slot.item);
  const count = String(slot.count);
  if (!proto) {
    return { name: `item#${String(slot.item)}`, color: '#ff00ff', count, title: `Unknown item` };
  }
  return {
    name: proto.name,
    color: cssColor(proto.color),
    count,
    title: `${proto.label} × ${count}`,
  };
}

/**
 * What the hotbar shows with inventory `slots` and item pins `pins` (by
 * hotbar slot, 0 for none): a pinned slot shows its item with the total the
 * inventory holds (empty while there is none; the hotbar shows it faintly),
 * an unpinned one the inventory slot of the same index.
 */
export function hotbarSlots(slots: readonly SlotData[], pins: readonly number[]): SlotData[] {
  return Array.from({ length: HOTBAR_SLOTS }, (_, i) => {
    const pin = pins[i] ?? 0;
    if (pin === 0) return slots[i] ?? { item: 0, count: 0 };
    let count = 0;
    for (const s of slots) if (s.item === pin) count += s.count;
    return count > 0 ? { item: pin, count } : { item: 0, count: 0 };
  });
}

/** No item pinned to any hotbar slot: the hotbar shows the first inventory slots. */
export const NO_PINS: readonly number[] = Array.from({ length: HOTBAR_SLOTS }, () => 0);

/**
 * Pins `item` to hotbar slot `index` (0 unpins it), taking it off any other
 * slot it was pinned to, so each item has at most one hotbar slot.
 */
export function pinItem(pins: readonly number[], index: number, item: number): number[] {
  return Array.from({ length: HOTBAR_SLOTS }, (_, i) => {
    if (i === index) return item;
    const pin = pins[i] ?? 0;
    return item !== 0 && pin === item ? 0 : pin;
  });
}

/** Hotbar pins as item names for storing (`''` for none). */
export function pinNames(pins: readonly number[]): string[] {
  return Array.from({ length: HOTBAR_SLOTS }, (_, i) => itemPrototype(pins[i] ?? 0)?.name ?? '');
}

/** Hotbar pins from stored item names; unknown names (and a missing list) pin nothing. */
export function pinsFromNames(names: readonly string[] | undefined): number[] {
  return Array.from({ length: HOTBAR_SLOTS }, (_, i) => {
    const name = names?.[i] ?? '';
    return name === '' ? 0 : (ITEM_IDS.find((id) => ITEMS[id].name === name) ?? 0);
  });
}

/** Total units of item `name` across `slots`. */
export function countByName(slots: readonly SlotData[], name: string): number {
  let n = 0;
  for (const s of slots) {
    if (s.count > 0 && itemPrototype(s.item)?.name === name) n += s.count;
  }
  return n;
}

/** Where a drag between slot grids started (a left press on a slot), or `null`. */
let dragSource: { grid: SlotGrid; index: number } | null = null;
globalThis.window?.addEventListener('pointerup', () => {
  // After the cells' own handlers: a drop on a cell has been handled by now.
  setTimeout(() => {
    dragSource = null;
  });
});

/** Optional behaviors of a `SlotGrid` besides clicks. */
export interface SlotGridOptions {
  /**
   * A left-button drag from cell `from` of grid `source` (this one or
   * another) ended on cell `index` of this grid.
   */
  onDrop?: (source: SlotGrid, from: number, index: number) => void;
  /** The pointer moved onto cell `index`, or off the grid (`null`). */
  onHover?: (index: number | null) => void;
}

/**
 * A row-major grid of slot elements that only touches the DOM for slots that
 * changed. With `onClick`, a click on a slot calls it with the slot index and
 * the `Transfer` the click asks for (see `transferFor`); a right click then
 * opens no context menu, and a middle click doesn't start scrolling.
 */
export class SlotGrid {
  readonly element: HTMLElement;
  private readonly cells: { root: HTMLElement; icon: HTMLElement; count: HTMLElement }[] = [];
  private readonly shown: (string | null)[] = [];
  /** Per cell, the item shown faintly while the cell is empty (0 for none). */
  private hints: readonly number[] = [];

  constructor(
    slots: number,
    columns: number,
    onClick?: (index: number, transfer: Transfer) => void,
    options: SlotGridOptions = {},
  ) {
    const el = document.createElement('div');
    el.className = 'slot-grid';
    Object.assign(el.style, {
      display: 'grid',
      gridTemplateColumns: `repeat(${String(columns)}, ${String(SLOT_PX)}px)`,
      gap: `${String(GAP_PX)}px`,
    } satisfies Partial<CSSStyleDeclaration>);
    for (let i = 0; i < slots; i++) {
      const root = document.createElement('div');
      root.className = 'slot';
      root.dataset.slot = String(i);
      Object.assign(root.style, {
        position: 'relative',
        boxSizing: 'border-box',
        width: `${String(SLOT_PX)}px`,
        height: `${String(SLOT_PX)}px`,
        border: SLOT_BORDER,
        borderRadius: '3px',
        background: 'rgba(0, 0, 0, 0.55)',
      } satisfies Partial<CSSStyleDeclaration>);
      const icon = makeSlotIcon();
      icon.style.display = 'none';
      const count = document.createElement('span');
      count.className = 'count';
      Object.assign(count.style, {
        position: 'absolute',
        right: '2px',
        bottom: '0',
        font: '11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace',
        color: '#f4efe0',
        textShadow: '0 0 2px #000, 0 0 2px #000',
      } satisfies Partial<CSSStyleDeclaration>);
      root.append(icon, count);
      if (onClick) {
        root.style.cursor = 'pointer';
        root.addEventListener('click', (e) => {
          const transfer = transferFor(e);
          if (transfer !== null) onClick(i, transfer);
        });
        root.addEventListener('auxclick', (e) => {
          // Right clicks arrive as `contextmenu` below, so they don't count twice.
          if (e.button === 1) onClick(i, 'one');
        });
        root.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          // On a Mac, ctrl-click opens the context menu instead of clicking.
          onClick(i, e.ctrlKey || e.metaKey ? 'one' : 'half');
        });
        root.addEventListener('mousedown', (e) => {
          // No autoscroll on a middle click, no text selection on a shift-click.
          if (e.button === 1 || e.shiftKey) e.preventDefault();
        });
      }
      if (options.onDrop) {
        const { onDrop } = options;
        root.addEventListener('pointerdown', (e) => {
          if (e.button === 0) dragSource = { grid: this, index: i };
        });
        root.addEventListener('pointerup', (e) => {
          const source = dragSource;
          dragSource = null;
          if (e.button !== 0 || !source || (source.grid === this && source.index === i)) return;
          onDrop(source.grid, source.index, i);
        });
      }
      if (options.onHover) {
        const { onHover } = options;
        root.addEventListener('pointerenter', () => {
          onHover(i);
        });
        root.addEventListener('pointerleave', () => {
          onHover(null);
        });
      }
      el.appendChild(root);
      this.cells.push({ root, icon, count });
      this.shown.push(null);
    }
    this.element = el;
  }

  /** Highlights cell `index` (and un-highlights the others); `null` for none. */
  highlight(index: number | null): void {
    this.cells.forEach((cell, i) => {
      const on = i === index;
      if ((cell.root.dataset.selected === 'true') === on) return;
      cell.root.dataset.selected = String(on);
      cell.root.style.outline = on ? SELECTED_OUTLINE : 'none';
      cell.root.style.outlineOffset = on ? '-2px' : '0';
    });
  }

  /** The item shown in cell `index` (0 for none), as of the latest `update`. */
  itemAt(index: number): number {
    return Number(this.cells[index]?.icon.dataset.item ?? 0);
  }

  /** Marks the cells whose `pinned[i]` is true as holding a pinned item (a blue border). */
  setPinned(pinned: readonly boolean[]): void {
    this.cells.forEach((cell, i) => {
      const on = pinned[i] === true;
      if ((cell.root.dataset.pinned === 'true') === on) return;
      cell.root.dataset.pinned = String(on);
      cell.root.style.border = on ? PINNED_BORDER : SLOT_BORDER;
    });
  }

  /**
   * Items to show faintly in cells while they are empty (an assembling
   * machine's ingredients and products), by cell; applies from the next
   * `update`.
   */
  setHints(items: readonly number[]): void {
    this.hints = items;
  }

  /** Shows `slots[i]` in cell `i`; missing entries show as empty (with the cell's hint, if any). */
  update(slots: readonly SlotData[]): void {
    this.cells.forEach((cell, i) => {
      const slot = slots[i] ?? { item: 0, count: 0 };
      const view = slotView(slot);
      const hint = view.color ? 0 : (this.hints[i] ?? 0);
      const key = `${view.name}:${view.count}:${String(hint)}`;
      if (this.shown[i] === key) {
        return;
      }
      this.shown[i] = key;
      cell.root.dataset.item = view.name;
      cell.root.dataset.count = view.count === '' ? '0' : view.count;
      cell.root.title = hint !== 0 ? (itemPrototype(hint)?.label ?? view.title) : view.title;
      cell.icon.style.display = view.color || hint !== 0 ? 'block' : 'none';
      cell.icon.style.opacity = hint !== 0 ? '0.3' : '1';
      setSlotIcon(cell.icon, view.color ? slot.item : hint);
      cell.count.textContent = view.count;
    });
  }
}

export interface HotbarOptions {
  /**
   * A click on hotbar slot `slot`: a left click selects it (or deselects it),
   * a right click deselects, a middle click (or ctrl-click) clears its pin.
   */
  onClick: (slot: number, transfer: Transfer) => void;
  /** A drag from cell `from` of `source` (e.g. the inventory) ended on hotbar slot `slot`. */
  onDrop?: (source: SlotGrid, from: number, slot: number) => void;
}

/**
 * The hotbar strip at the bottom of the screen. With `options`, its slots are
 * clickable, and the strip catches the pointer: the game under it gets no clicks.
 */
export class Hotbar {
  readonly element: HTMLElement;
  private readonly grid: SlotGrid;

  constructor(parent: HTMLElement, options?: HotbarOptions) {
    this.grid = new SlotGrid(HOTBAR_SLOTS, HOTBAR_SLOTS, options?.onClick, {
      ...(options?.onDrop && { onDrop: options.onDrop }),
    });
    const el = document.createElement('div');
    el.id = 'hotbar';
    Object.assign(el.style, {
      position: 'fixed',
      bottom: `${String(HOTBAR_BOTTOM_PX)}px`,
      left: '50%',
      // Whole pixels, so the strip doesn't land on a half pixel and blur.
      marginLeft: `${String(-Math.round(barWidth(HOTBAR_SLOTS) / 2))}px`,
      padding: '4px',
      background: 'rgba(0, 0, 0, 0.45)',
      borderRadius: '4px',
      zIndex: '10',
    } satisfies Partial<CSSStyleDeclaration>);
    el.appendChild(this.grid.element);
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
    parent.appendChild(el);
    this.element = el;
    this.grid.update([]);
  }

  /**
   * Shows inventory `slots` with item pins `pins` (by hotbar slot, 0 for
   * none; see `hotbarSlots`); a pinned item the inventory has none of shows
   * faintly.
   */
  update(slots: readonly SlotData[], pins: readonly number[] = []): void {
    this.grid.setHints(pins);
    this.grid.setPinned(Array.from({ length: HOTBAR_SLOTS }, (_, i) => (pins[i] ?? 0) !== 0));
    this.grid.update(hotbarSlots(slots, pins));
  }

  /** Highlights hotbar slot `slot`, or none for `null` or a slot past the hotbar. */
  select(slot: number | null): void {
    const shown = slot !== null && slot < HOTBAR_SLOTS ? slot : null;
    this.element.dataset.selected = shown === null ? '' : String(shown);
    this.grid.highlight(shown);
  }
}

export interface InventoryPanelOptions {
  /** A click on slot `slot`, moving `transfer` (see `transferFor`): picks up or drops the cursor stack. */
  onClick: (slot: number, transfer: Transfer) => void;
  /** A drag from cell `from` of `source` ended on slot `slot`. */
  onDrop?: (source: SlotGrid, from: number, slot: number) => void;
  /** The pointer is over slot `slot` now (`null`: none). */
  onHover?: (slot: number | null) => void;
}

/**
 * The inventory panel, hidden until toggled. With `options`, its slots are
 * clickable (for the cursor stack; transfers into an entity happen in the
 * entity window's own copy of the inventory, see entityPanel.ts).
 */
export class InventoryPanel {
  readonly element: HTMLElement;
  /** The slot grid (a drag source for the hotbar). */
  readonly grid: SlotGrid;
  private readonly body: HTMLElement;

  constructor(parent: HTMLElement, slots: number, options?: InventoryPanelOptions) {
    const el = document.createElement('div');
    el.id = 'inventory-panel';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Inventory');
    el.hidden = true;
    Object.assign(el.style, {
      position: 'fixed',
      top: '64px',
      left: '8px',
      padding: '8px',
      color: '#e8e2d0',
      font: '13px/1.4 system-ui, sans-serif',
      background: 'rgba(20, 22, 26, 0.88)',
      border: '1px solid rgba(232, 226, 208, 0.2)',
      borderRadius: '6px',
      zIndex: '20',
    } satisfies Partial<CSSStyleDeclaration>);
    const title = document.createElement('div');
    title.textContent = 'Inventory';
    Object.assign(title.style, { fontWeight: '600', marginBottom: '6px' });
    this.grid = new SlotGrid(slots, INVENTORY_COLUMNS, options?.onClick, {
      ...(options?.onDrop && { onDrop: options.onDrop }),
      ...(options?.onHover && { onHover: options.onHover }),
    });
    // Sections (the inventory, then e.g. crafting) side by side.
    this.body = document.createElement('div');
    Object.assign(this.body.style, { display: 'flex', alignItems: 'flex-start', gap: '12px' });
    const section = document.createElement('div');
    section.append(title, this.grid.element);
    this.body.appendChild(section);
    el.appendChild(this.body);
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    parent.appendChild(el);
    this.element = el;
    this.grid.update([]);
  }

  /** Adds a section to the right of the inventory grid (e.g. the crafting panel). */
  addSection(section: HTMLElement): void {
    this.body.appendChild(section);
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  toggle(): void {
    this.element.hidden = !this.element.hidden;
  }

  close(): void {
    this.element.hidden = true;
  }

  update(slots: readonly SlotData[]): void {
    this.grid.update(slots);
  }

  /** Highlights the slot the cursor takes from, or none for `null`. */
  select(slot: number | null): void {
    this.element.dataset.selected = slot === null ? '' : String(slot);
    this.grid.highlight(slot);
  }
}

/** Outer width (and, for one slot, height) of a bar of `slots` slots like the hotbar. */
export function barWidth(slots: number): number {
  return 2 * 4 + slots * SLOT_PX + (slots - 1) * GAP_PX;
}

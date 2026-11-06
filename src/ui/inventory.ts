/**
 * Inventory UI (plain DOM): the inventory panel, toggled with `E` (other
 * panels such as crafting can add sections to it), and the
 * hotbar strip showing the first `HOTBAR_SLOTS` slots, with the slot selected
 * for building (keys `1`–`0`, or a click on the slot) highlighted. Both
 * show each slot's item as its icon (src/render/itemIcons.ts, the same as on
 * belts and in inserter hands) with its count.
 *
 * Slots have fixed pixel sizes and an empty slot has no text, so the hotbar
 * looks the same on every machine (it is part of the screenshot tests).
 */

import { itemPrototype } from '../data/items';
import { ICON_PX, iconDataUrl } from '../render/itemIcons';
import type { SlotData } from '../sim/snapshot';

/** Slots shown in the hotbar: the first slots of the inventory. */
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
  icon.style.backgroundImage = item === 0 ? 'none' : `url(${iconDataUrl(item)})`;
}

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

/** Total units of item `name` across `slots`. */
export function countByName(slots: readonly SlotData[], name: string): number {
  let n = 0;
  for (const s of slots) {
    if (s.count > 0 && itemPrototype(s.item)?.name === name) n += s.count;
  }
  return n;
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

  constructor(
    slots: number,
    columns: number,
    onClick?: (index: number, transfer: Transfer) => void,
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

  /** Shows `slots[i]` in cell `i`; missing entries show as empty. */
  update(slots: readonly SlotData[]): void {
    this.cells.forEach((cell, i) => {
      const slot = slots[i] ?? { item: 0, count: 0 };
      const view = slotView(slot);
      const key = `${view.name}:${view.count}`;
      if (this.shown[i] === key) {
        return;
      }
      this.shown[i] = key;
      cell.root.dataset.item = view.name;
      cell.root.dataset.count = view.count === '' ? '0' : view.count;
      cell.root.title = view.title;
      cell.icon.style.display = view.color ? 'block' : 'none';
      setSlotIcon(cell.icon, view.color ? slot.item : 0);
      cell.count.textContent = view.count;
    });
  }
}

export interface HotbarOptions {
  /** A left click on hotbar slot `slot`: select it, or deselect it if it is selected. */
  onClick: (slot: number) => void;
  /** A right click on a hotbar slot: deselect. */
  onRightClick: () => void;
}

/**
 * The hotbar strip at the bottom of the screen. With `options`, its slots are
 * clickable, and the strip catches the pointer: the game under it gets no clicks.
 */
export class Hotbar {
  readonly element: HTMLElement;
  private readonly grid: SlotGrid;

  constructor(parent: HTMLElement, options?: HotbarOptions) {
    this.grid = new SlotGrid(
      HOTBAR_SLOTS,
      HOTBAR_SLOTS,
      options &&
        ((slot, transfer) => {
          if (transfer === 'half') options.onRightClick();
          else options.onClick(slot);
        }),
    );
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

  update(slots: readonly SlotData[]): void {
    this.grid.update(slots.slice(0, HOTBAR_SLOTS));
  }

  /** Highlights the slot selected for building, or none for `null`. */
  select(slot: number | null): void {
    this.element.dataset.selected = slot === null ? '' : String(slot);
    this.grid.highlight(slot);
  }
}

/** The inventory panel, hidden until toggled. */
export class InventoryPanel {
  readonly element: HTMLElement;
  private readonly grid: SlotGrid;
  private readonly body: HTMLElement;

  constructor(parent: HTMLElement, slots: number) {
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
    this.grid = new SlotGrid(slots, INVENTORY_COLUMNS);
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
}

/** Outer width (and, for one slot, height) of a bar of `slots` slots like the hotbar. */
export function barWidth(slots: number): number {
  return 2 * 4 + slots * SLOT_PX + (slots - 1) * GAP_PX;
}

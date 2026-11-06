/**
 * Inventory UI (plain DOM): the inventory panel, toggled with `E`, and the
 * hotbar strip showing the first `HOTBAR_SLOTS` slots, with the slot selected
 * for building (keys `1`–`0`) highlighted. Both show each slot's item as a
 * colored swatch with its count.
 *
 * Slots have fixed pixel sizes and an empty slot has no text, so the hotbar
 * looks the same on every machine (it is part of the screenshot tests).
 */

import { itemPrototype } from '../data/items';
import type { SlotData } from '../sim/snapshot';

/** Slots shown in the hotbar: the first slots of the inventory. */
export const HOTBAR_SLOTS = 10;
/** Columns in the inventory panel grid. */
export const INVENTORY_COLUMNS = 10;
const SLOT_PX = 36;
const GAP_PX = 2;
const SLOT_BORDER = '1px solid rgba(232, 226, 208, 0.25)';
/** Drawn as an outline inside the slot, so selecting doesn't shift its contents. */
const SELECTED_OUTLINE = '2px solid #f2d36b';

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

/** A row-major grid of slot elements that only touches the DOM for slots that changed. */
class SlotGrid {
  readonly element: HTMLElement;
  private readonly cells: { root: HTMLElement; swatch: HTMLElement; count: HTMLElement }[] = [];
  private readonly shown: (string | null)[] = [];

  constructor(slots: number, columns: number) {
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
      const swatch = document.createElement('div');
      Object.assign(swatch.style, {
        position: 'absolute',
        left: '7px',
        top: '7px',
        width: '20px',
        height: '20px',
        borderRadius: '4px',
        boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.22)',
        display: 'none',
      } satisfies Partial<CSSStyleDeclaration>);
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
      root.append(swatch, count);
      el.appendChild(root);
      this.cells.push({ root, swatch, count });
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
      const view = slotView(slots[i] ?? { item: 0, count: 0 });
      const key = `${view.name}:${view.count}`;
      if (this.shown[i] === key) {
        return;
      }
      this.shown[i] = key;
      cell.root.dataset.item = view.name;
      cell.root.dataset.count = view.count === '' ? '0' : view.count;
      cell.root.title = view.title;
      cell.swatch.style.display = view.color ? 'block' : 'none';
      cell.swatch.style.background = view.color ?? 'transparent';
      cell.count.textContent = view.count;
    });
  }
}

/** The hotbar strip at the bottom of the screen. */
export class Hotbar {
  readonly element: HTMLElement;
  private readonly grid = new SlotGrid(HOTBAR_SLOTS, HOTBAR_SLOTS);

  constructor(parent: HTMLElement) {
    const el = document.createElement('div');
    el.id = 'hotbar';
    Object.assign(el.style, {
      position: 'fixed',
      bottom: '8px',
      left: '50%',
      // Whole pixels, so the strip doesn't land on a half pixel and blur.
      marginLeft: `${String(-Math.round(barWidth(HOTBAR_SLOTS) / 2))}px`,
      padding: '4px',
      background: 'rgba(0, 0, 0, 0.45)',
      borderRadius: '4px',
      // Clicks pass through to the game for now.
      pointerEvents: 'none',
      zIndex: '10',
    } satisfies Partial<CSSStyleDeclaration>);
    el.appendChild(this.grid.element);
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
    el.append(title, this.grid.element);
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

function barWidth(slots: number): number {
  return 2 * 4 + slots * SLOT_PX + (slots - 1) * GAP_PX;
}

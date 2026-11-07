/**
 * The cursor stack's icon (plain DOM, D52): the held item and how many the
 * cursor would drop, following the mouse while a window with slots is open
 * (over the game, the ghost shows what a placeable item builds). The items
 * themselves stay in their inventory slot until dropped.
 */

import { makeSlotIcon, setSlotIcon, SLOT_PX } from './inventory';

/** Offset of the icon from the pointer, so it doesn't hide the slot under it. */
const OFFSET_PX = 10;

export class CursorStack {
  readonly element: HTMLElement;
  private readonly icon: HTMLElement;
  private readonly count: HTMLElement;
  private shown = '';

  constructor(parent: HTMLElement) {
    const el = document.createElement('div');
    el.id = 'cursor-stack';
    Object.assign(el.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: `${String(SLOT_PX)}px`,
      height: `${String(SLOT_PX)}px`,
      pointerEvents: 'none',
      zIndex: '60',
      display: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    this.icon = makeSlotIcon();
    this.count = document.createElement('span');
    Object.assign(this.count.style, {
      position: 'absolute',
      right: '2px',
      bottom: '0',
      font: '11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace',
      color: '#f4efe0',
      textShadow: '0 0 2px #000, 0 0 2px #000',
    } satisfies Partial<CSSStyleDeclaration>);
    el.append(this.icon, this.count);
    window.addEventListener('pointermove', (e) => {
      el.style.transform = `translate(${String(e.clientX + OFFSET_PX)}px, ${String(e.clientY + OFFSET_PX)}px)`;
    });
    parent.append(el);
    this.element = el;
  }

  /** Shows `count` of `item` at the cursor, or nothing for `count` 0. */
  show(item: number, count: number): void {
    const key = count > 0 ? `${String(item)}:${String(count)}` : '';
    if (key === this.shown) return;
    this.shown = key;
    this.element.style.display = key === '' ? 'none' : 'block';
    this.element.dataset.item = String(item);
    this.element.dataset.count = String(count);
    if (key !== '') {
      setSlotIcon(this.icon, item);
      this.count.textContent = String(count);
    }
  }
}

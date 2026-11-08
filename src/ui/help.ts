/**
 * In-game controls help (plain DOM): a small "H: controls" hint in the
 * bottom-left corner, and a panel listing every control, toggled with `H`
 * (or by clicking the hint) and closed with `Escape`. The list mirrors the
 * controls in the README and shows the keys as currently bound
 * (src/ui/keybindings.ts); the options live in the settings panel.
 */

import {
  DEFAULT_BINDINGS,
  HOTBAR_ACTIONS,
  actionFor,
  bindings,
  keyLabel,
  type Bindings,
} from './keybindings';

/** One line of the help panel: the keys or buttons, and what they do. */
export interface ControlHelp {
  keys: string;
  action: string;
}

/** Labels of keys `codes` run together (`WASD`) when each is one character, else spaced. */
function keysLabel(codes: readonly string[]): string {
  const labels = codes.map(keyLabel);
  return labels.every((l) => [...l].length === 1) ? labels.join('') : labels.join(' ');
}

/** Every control with keys `b` (the current bindings by default), in the order a new player needs them. */
export function controls(b: Bindings = bindings()): ControlHelp[] {
  const k = (action: keyof Bindings): string => keyLabel(b[action]);
  const hotbar = `${k(HOTBAR_ACTIONS[0]!)}–${k(HOTBAR_ACTIONS[HOTBAR_ACTIONS.length - 1]!)}`;
  const pan = [b.panUp, b.panLeft, b.panDown, b.panRight];
  const defaultPan = [
    DEFAULT_BINDINGS.panUp,
    DEFAULT_BINDINGS.panLeft,
    DEFAULT_BINDINGS.panDown,
    DEFAULT_BINDINGS.panRight,
  ];
  const panLabel = pan.every((c, i) => c === defaultPan[i]) ? 'arrows' : keysLabel(pan);
  return [
    { keys: keysLabel([b.moveUp, b.moveLeft, b.moveDown, b.moveRight]), action: 'Walk' },
    { keys: 'Hold right mouse', action: 'Mine the ore under the cursor (within reach)' },
    { keys: k('inventory'), action: 'Inventory and crafting (click a recipe to craft)' },
    { keys: k('techTree'), action: 'Tech tree: pick what labs research from science packs' },
    {
      keys: `${hotbar} / click`,
      action: `Select a hotbar item; again, right-click or ${k('pipette')} to put it away`,
    },
    {
      keys: `Alt+${hotbar}`,
      action: 'Pin the held item (or the one under the mouse in the inventory) to a hotbar slot',
    },
    { keys: 'Middle click on hotbar', action: 'Unpin: the slot shows its inventory slot again' },
    {
      keys: 'Click in inventory',
      action: 'Pick up a stack (right click: half); click another slot to put it there',
    },
    { keys: 'Drag to hotbar', action: 'Pin an inventory item to a hotbar slot' },
    {
      keys: k('pipette'),
      action: 'With nothing selected: pick the item of the entity under the cursor',
    },
    { keys: 'Left click / drag', action: 'Place the selected item (green ghost)' },
    { keys: k('rotate'), action: 'Rotate the ghost, or the entity under the cursor' },
    {
      keys: 'Left click',
      action: 'With nothing selected: open a machine or chest; on a pole, its electric network',
    },
    { keys: 'Click / shift-click', action: 'In a window: move a whole stack in or out' },
    { keys: 'Right click', action: 'In a window: move half a stack (rounded up)' },
    { keys: 'Ctrl-click / middle click', action: 'In a window: move one item' },
    { keys: 'Holding a stack', action: 'In a window: click its slots to put the stack in' },
    { keys: 'Right click', action: 'Pick up the entity under the cursor' },
    { keys: 'Mouse wheel', action: 'Zoom; zoomed far out, the map view (flat colours)' },
    { keys: k('minimap'), action: 'Minimap; click or drag on it to move the camera there' },
    {
      keys: `Middle drag / ${panLabel}`,
      action: `Pan the camera; ${k('follow')} follows the player again`,
    },
    { keys: k('help'), action: 'This list' },
    {
      keys: 'Esc',
      action: 'Close windows; with none open, the game menu (save, load, settings, new game)',
    },
  ];
}

const PANEL_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'fixed',
  left: '8px',
  bottom: '60px',
  padding: '8px 10px',
  color: '#e8e2d0',
  font: '13px/1.5 system-ui, sans-serif',
  background: 'rgba(20, 22, 26, 0.92)',
  border: '1px solid rgba(232, 226, 208, 0.2)',
  borderRadius: '6px',
  zIndex: '30',
};

const HINT_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'fixed',
  left: '8px',
  bottom: '8px',
  padding: '3px 8px',
  color: '#e8e2d0',
  font: '12px/1.4 system-ui, sans-serif',
  background: 'rgba(0, 0, 0, 0.6)',
  border: 'none',
  borderRadius: '4px',
  cursor: 'pointer',
  zIndex: '30',
};

export class HelpPanel {
  /** The hint button in the corner. */
  readonly hint: HTMLButtonElement;
  /** The panel with the controls. */
  readonly element: HTMLElement;
  private readonly table: HTMLTableElement;

  constructor(parent: HTMLElement) {
    const hint = document.createElement('button');
    hint.id = 'help-hint';
    hint.type = 'button';
    Object.assign(hint.style, HINT_STYLE);
    hint.addEventListener('click', () => {
      this.toggle();
      // Keep keyboard focus on the game, so WASD and the hotbar keys keep working.
      hint.blur();
    });

    const el = document.createElement('div');
    el.id = 'help-panel';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Controls');
    el.hidden = true;
    Object.assign(el.style, PANEL_STYLE);
    const title = document.createElement('div');
    title.textContent = 'Controls';
    Object.assign(title.style, { fontWeight: '600', marginBottom: '4px' });
    const table = document.createElement('table');
    Object.assign(table.style, { borderCollapse: 'collapse' });
    const more = document.createElement('div');
    more.textContent = 'Keys, graphics and the UI scale: Esc → Settings.';
    Object.assign(more.style, { marginTop: '6px', opacity: '0.7', fontSize: '12px' });
    el.append(title, table, more);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.close();
      } else if (
        actionFor(e.code) === 'help' &&
        !e.repeat &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        this.toggle();
      }
    });
    parent.append(el, hint);
    this.hint = hint;
    this.element = el;
    this.table = table;
    this.refresh();
  }

  /** Lists the controls with the current key bindings (and labels the hint with the help key). */
  refresh(): void {
    const table = this.table;
    table.replaceChildren();
    for (const { keys, action } of controls()) {
      const row = table.insertRow();
      const k = row.insertCell();
      k.textContent = keys;
      Object.assign(k.style, {
        padding: '0 12px 0 0',
        color: '#f2d36b',
        whiteSpace: 'nowrap',
        verticalAlign: 'top',
      });
      const a = row.insertCell();
      a.textContent = action;
    }
    const key = keyLabel(bindings().help);
    this.hint.textContent = `${key}: controls`;
    this.hint.title = `Show the controls (${key})`;
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
}

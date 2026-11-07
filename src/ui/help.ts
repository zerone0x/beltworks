/**
 * In-game controls help (plain DOM): a small "H: controls" hint in the
 * bottom-left corner, and a panel listing every control, toggled with `H`
 * (or by clicking the hint) and closed with `Escape`. The list mirrors the
 * controls in the README.
 */

/** One line of the help panel: the keys or buttons, and what they do. */
export interface ControlHelp {
  keys: string;
  action: string;
}

/** Every control, in the order a new player needs them. */
export const CONTROLS: readonly ControlHelp[] = [
  { keys: 'WASD', action: 'Walk' },
  { keys: 'Hold right mouse', action: 'Mine the ore under the cursor (within reach)' },
  { keys: 'E', action: 'Inventory and crafting (click a recipe to craft)' },
  { keys: 'T', action: 'Tech tree: pick what labs research from science packs' },
  { keys: '1–0 / click', action: 'Select a hotbar item; again, right-click or Q to put it away' },
  { keys: 'Click in inventory', action: 'Select any item to build from the inventory (E)' },
  { keys: 'Q', action: 'With nothing selected: pick the item of the entity under the cursor' },
  { keys: 'Left click / drag', action: 'Place the selected item (green ghost)' },
  { keys: 'R', action: 'Rotate the ghost, or the entity under the cursor' },
  {
    keys: 'Left click',
    action: 'With nothing selected: open a machine or chest; on a pole, its electric network',
  },
  { keys: 'Click / shift-click', action: 'In a window: move a whole stack in or out' },
  { keys: 'Right click', action: 'In a window: move half a stack (rounded up)' },
  { keys: 'Ctrl-click / middle click', action: 'In a window: move one item' },
  { keys: 'Right click', action: 'Pick up the entity under the cursor' },
  { keys: 'Mouse wheel', action: 'Zoom' },
  { keys: 'Middle drag / arrows', action: 'Pan the camera; F follows the player again' },
  { keys: 'Esc', action: 'Close windows' },
];

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

  constructor(parent: HTMLElement) {
    const hint = document.createElement('button');
    hint.id = 'help-hint';
    hint.type = 'button';
    hint.textContent = 'H: controls';
    hint.title = 'Show the controls (H)';
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
    for (const { keys, action } of CONTROLS) {
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
    el.append(title, table);

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.close();
      } else if (e.code === 'KeyH' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this.toggle();
      }
    });
    parent.append(el, hint);
    this.hint = hint;
    this.element = el;
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

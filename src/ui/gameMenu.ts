/**
 * The game menu and the start screen (plain DOM, D39).
 *
 * - The game menu (`Esc` when no other window is open, or the corner
 *   button) saves the game under a name, lists the save slots (newest
 *   first) with Load, Export and Delete, imports a save file, starts a
 *   new game, and opens the settings (src/ui/settingsPanel.ts) or About
 *   (src/ui/about.ts) in its place (`Esc` there goes back to the menu).
 *   Deleting and starting over ask for a second click. The game pauses while it is open (`onToggle`;
 *   main.ts pauses the worker, single-player only).
 * - The title screen (titleScreen.ts) shares its styles.
 *
 * Neither knows about the worker or IndexedDB: main.ts passes the actions.
 */

import { formatPlayTime, sortSlots, type SaveSlot } from '../save/slots';
import { VERSION_LABEL } from '../version';
import type { AboutPanel } from './about';
import type { SettingsPanel } from './settingsPanel';

export interface GameMenuActions {
  /** Saves the game as `name`; resolves once it is stored. */
  save(name: string): Promise<void>;
  /** The save slots to list. */
  list(): Promise<SaveSlot[]>;
  load(slot: SaveSlot): void;
  export(slot: SaveSlot): Promise<void>;
  delete(slot: SaveSlot): Promise<void>;
  /** Imports a save file; resolves with a message for the status line. */
  import(file: File): Promise<string>;
  /** Leaves the game for the title screen (to start a new one with a seed). */
  newGame(): void;
  /** Starts the onboarding's objectives again (absent where there are none). */
  restartTutorial?(): void;
  /** Whether another window is open (Escape closes that one instead of opening the menu). */
  otherWindowOpen(): boolean;
}

export const OVERLAY_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'fixed',
  inset: '0',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'rgba(0, 0, 0, 0.45)',
  zIndex: '50',
};

export const PANEL_STYLE: Partial<CSSStyleDeclaration> = {
  minWidth: '420px',
  maxWidth: '640px',
  maxHeight: '80vh',
  overflowY: 'auto',
  padding: '14px 16px',
  color: '#e8e2d0',
  font: '13px/1.5 system-ui, sans-serif',
  background: 'rgba(20, 22, 26, 0.96)',
  border: '1px solid rgba(232, 226, 208, 0.25)',
  borderRadius: '8px',
};

const BUTTON_STYLE: Partial<CSSStyleDeclaration> = {
  padding: '3px 10px',
  margin: '0 6px 0 0',
  color: '#e8e2d0',
  font: 'inherit',
  background: 'rgba(255, 255, 255, 0.08)',
  border: '1px solid rgba(232, 226, 208, 0.3)',
  borderRadius: '4px',
  cursor: 'pointer',
};

export function button(label: string, id?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = label;
  if (id) b.id = id;
  Object.assign(b.style, BUTTON_STYLE);
  return b;
}

function heading(text: string): HTMLDivElement {
  const el = document.createElement('div');
  el.textContent = text;
  Object.assign(el.style, { fontWeight: '600', margin: '10px 0 4px' });
  return el;
}

/** "Saved 14:03" today, else the date and time. */
export function savedLabel(savedAt: number): string {
  const d = new Date(savedAt);
  const now = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === now.toDateString() ? time : `${d.toLocaleDateString()} ${time}`;
}

/**
 * Copies `text` to the clipboard; resolves with whether it worked. Falls
 * back to a selected text field and `execCommand` where the Clipboard API
 * is missing or refused (it needs a secure context: GitHub Pages and
 * localhost are).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    Object.assign(field.style, { position: 'fixed', opacity: '0' });
    document.body.append(field);
    field.select();
    let ok: boolean;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    field.remove();
    return ok;
  }
}

/** A "World seed: 123 [Copy]" row; `status` gets the copy's outcome. */
export function seedRow(
  id: string,
  seed: () => number,
  status: (message: string) => void,
): { row: HTMLElement; value: HTMLElement } {
  const row = document.createElement('div');
  Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '6px' });
  const label = document.createElement('span');
  label.textContent = 'World seed';
  label.style.opacity = '0.75';
  const value = document.createElement('code');
  value.id = id;
  Object.assign(value.style, { userSelect: 'all', font: '13px ui-monospace, monospace' });
  const copy = button('Copy', `${id}-copy`);
  copy.addEventListener('click', () => {
    const text = String(seed());
    void copyText(text).then((ok) => {
      status(ok ? `Copied seed ${text}.` : `Couldn't copy: select the seed and copy it.`);
    });
  });
  row.append(label, value, copy);
  return { row, value };
}

/**
 * Makes `b` ask for a second click within 3 s before running `action`
 * (deleting a save, abandoning the game).
 */
export function confirmTwice(b: HTMLButtonElement, action: () => void): void {
  const label = b.textContent;
  let armed: ReturnType<typeof setTimeout> | null = null;
  b.addEventListener('click', () => {
    if (armed !== null) {
      clearTimeout(armed);
      armed = null;
      b.textContent = label;
      action();
      return;
    }
    b.textContent = 'Sure?';
    armed = setTimeout(() => {
      armed = null;
      b.textContent = label;
    }, 3000);
  });
}

/**
 * Keeps key presses in `input` (a text field, or a whole panel of buttons
 * and fields) from reaching the game's key handlers (WASD, hotbar); Escape
 * still gets through.
 */
export function isolateKeys(input: HTMLElement): void {
  for (const type of ['keydown', 'keyup'] as const) {
    input.addEventListener(type, (e) => {
      if (e.key !== 'Escape') e.stopPropagation();
    });
  }
}

export class GameMenu {
  readonly element: HTMLElement;
  /** The "Menu" button in the top-right corner. */
  readonly button: HTMLButtonElement;
  private readonly toast: HTMLElement;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  /** The menu's panel (centered in the overlay). */
  readonly panel: HTMLElement;
  private readonly slotTable: HTMLTableElement;
  private readonly status: HTMLElement;
  /** Called when the menu opens (`true`) or closes (`false`): main.ts pauses the game behind it. */
  onToggle: ((open: boolean) => void) | null = null;
  private readonly seedValue: HTMLElement;
  private seed = 0;

  constructor(
    parent: HTMLElement,
    private readonly actions: GameMenuActions,
    private readonly settings: SettingsPanel | null = null,
    private readonly about: AboutPanel | null = null,
  ) {
    const overlay = document.createElement('div');
    overlay.id = 'game-menu';
    // `display: flex` would override the `hidden` attribute, so open and close set `display`.
    Object.assign(overlay.style, OVERLAY_STYLE, { display: 'none' });
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) this.close();
    });

    const panel = document.createElement('div');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Game menu');
    Object.assign(panel.style, PANEL_STYLE);
    const title = document.createElement('div');
    title.textContent = 'Game menu';
    Object.assign(title.style, { fontWeight: '600', fontSize: '15px', marginBottom: '8px' });

    const top = document.createElement('div');
    const resume = button('Resume', 'menu-resume');
    resume.addEventListener('click', () => {
      this.close();
    });
    const newGame = button('New game', 'menu-new-game');
    confirmTwice(newGame, () => {
      this.actions.newGame();
    });
    top.append(resume, newGame);
    if (actions.restartTutorial) {
      const tutorial = button('Tutorial', 'menu-tutorial');
      tutorial.title = 'Show the getting-started objectives again';
      tutorial.addEventListener('click', () => {
        actions.restartTutorial?.();
        this.close();
      });
      top.append(tutorial);
    }
    if (settings) {
      const open = button('Settings', 'menu-settings');
      open.addEventListener('click', () => {
        this.showSettings(true);
      });
      top.append(open);
      settings.onBack = () => {
        this.showSettings(false);
      };
    }
    if (about) {
      const open = button('About', 'menu-about');
      open.title = 'Controls, credits and licenses';
      open.addEventListener('click', () => {
        this.showAbout(true);
      });
      top.append(open);
      about.onBack = () => {
        this.showAbout(false);
      };
    }

    const seed = seedRow(
      'menu-seed',
      () => this.seed,
      (message) => {
        this.setStatus(message);
      },
    );
    seed.row.style.marginTop = '8px';
    this.seedValue = seed.value;

    const saveRow = document.createElement('div');
    Object.assign(saveRow.style, { display: 'flex', gap: '6px', marginTop: '6px' });
    const nameInput = document.createElement('input');
    nameInput.id = 'menu-save-name';
    nameInput.type = 'text';
    nameInput.maxLength = 60;
    nameInput.placeholder = 'Save name';
    Object.assign(nameInput.style, {
      flex: '1',
      padding: '3px 6px',
      color: '#e8e2d0',
      font: 'inherit',
      background: 'rgba(0, 0, 0, 0.35)',
      border: '1px solid rgba(232, 226, 208, 0.3)',
      borderRadius: '4px',
    });
    isolateKeys(nameInput);
    const save = button('Save', 'menu-save');
    const doSave = (): void => {
      const name = nameInput.value.trim() || `Save ${new Date().toLocaleString()}`;
      save.disabled = true;
      this.setStatus('Saving…');
      this.actions
        .save(name)
        .then(() => {
          this.setStatus(`Saved “${name}”.`);
          nameInput.value = '';
          return this.refresh();
        })
        .catch((err: unknown) => {
          this.setStatus(`Saving failed: ${err instanceof Error ? err.message : String(err)}`);
        })
        .finally(() => {
          save.disabled = false;
        });
    };
    save.addEventListener('click', doSave);
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') doSave();
    });
    saveRow.append(nameInput, save);

    const status = document.createElement('div');
    status.id = 'menu-status';
    Object.assign(status.style, { minHeight: '1.5em', marginTop: '4px', color: '#f2d36b' });

    const slotTable = document.createElement('table');
    slotTable.id = 'menu-slots';
    Object.assign(slotTable.style, { borderCollapse: 'collapse', width: '100%' });

    const importRow = document.createElement('div');
    Object.assign(importRow.style, { marginTop: '8px' });
    const file = document.createElement('input');
    file.type = 'file';
    file.id = 'menu-import-file';
    file.accept = '.bwsave,application/gzip,application/octet-stream';
    file.hidden = true;
    const importButton = button('Import save file…', 'menu-import');
    importButton.addEventListener('click', () => {
      file.click();
    });
    file.addEventListener('change', () => {
      const chosen = file.files?.[0];
      file.value = '';
      if (!chosen) return;
      this.setStatus('Importing…');
      this.actions
        .import(chosen)
        .then((message) => {
          this.setStatus(message);
          return this.refresh();
        })
        .catch((err: unknown) => {
          this.setStatus(err instanceof Error ? err.message : String(err));
        });
    });
    importRow.append(importButton, file);

    panel.append(title, top, seed.row, heading('Save'), saveRow, status, heading('Saves'));
    panel.append(slotTable);
    panel.append(importRow);
    const version = document.createElement('div');
    version.id = 'menu-version';
    version.textContent = `Beltworks ${VERSION_LABEL}`;
    Object.assign(version.style, { marginTop: '10px', fontSize: '11px', opacity: '0.5' });
    panel.append(version);
    overlay.append(panel);
    isolateKeys(panel);
    for (const sub of [settings, about]) {
      if (!sub) continue;
      Object.assign(sub.element.style, PANEL_STYLE, { display: 'none' });
      isolateKeys(sub.element);
      overlay.append(sub.element);
    }

    const corner = button('Menu (Esc)', 'menu-button');
    Object.assign(corner.style, {
      position: 'fixed',
      top: '8px',
      right: '8px',
      margin: '0',
      font: '12px/1.4 system-ui, sans-serif',
      background: 'rgba(0, 0, 0, 0.6)',
      border: 'none',
      zIndex: '30',
    });
    corner.addEventListener('click', () => {
      corner.blur();
      if (this.isOpen) this.close();
      else this.open();
    });
    const toast = document.createElement('div');
    toast.id = 'save-toast';
    toast.setAttribute('role', 'status');
    toast.hidden = true;
    Object.assign(toast.style, {
      position: 'fixed',
      top: '36px',
      right: '8px',
      maxWidth: '360px',
      padding: '4px 10px',
      color: '#e8e2d0',
      font: '12px/1.4 system-ui, sans-serif',
      background: 'rgba(0, 0, 0, 0.7)',
      borderRadius: '4px',
      pointerEvents: 'none',
      zIndex: '30',
    });

    parent.append(overlay, corner, toast);
    this.button = corner;
    this.toast = toast;
    this.element = overlay;
    this.panel = panel;
    this.slotTable = slotTable;
    this.status = status;

    // Capture phase: decide before the other windows close themselves on the
    // same key, and keep game keys (other than in the menu's own fields) from
    // opening windows behind the menu. Key releases still get through, so a
    // key held when the menu opened doesn't stay down.
    window.addEventListener(
      'keydown',
      (e) => {
        if (this.isOpen && this.settings?.capturing) {
          // The settings wait for a new key binding: the key is theirs alone.
          e.preventDefault();
          e.stopImmediatePropagation();
          if (!e.repeat) this.settings.captureKey(e);
          return;
        }
        if (e.key === 'Escape') {
          if (e.repeat) return;
          if (this.settingsOpen) this.showSettings(false);
          else if (this.aboutOpen) this.showAbout(false);
          else if (this.isOpen) this.close();
          else if (!this.actions.otherWindowOpen()) this.open();
          return;
        }
        if (this.isOpen && !(e.target instanceof Node && overlay.contains(e.target))) {
          e.stopImmediatePropagation();
        }
      },
      { capture: true },
    );
  }

  /** Shows the world seed of the game being played. */
  setSeed(seed: number): void {
    this.seed = seed >>> 0;
    this.seedValue.textContent = String(this.seed);
  }

  /** Shows `message` for a few seconds in the corner, whether the menu is open or not. */
  notify(message: string, ms = 5000): void {
    this.toast.textContent = message;
    this.toast.hidden = false;
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.toast.hidden = true;
      this.toastTimer = null;
    }, ms);
  }

  get isOpen(): boolean {
    return this.element.style.display !== 'none';
  }

  open(): void {
    const was = this.isOpen;
    this.element.style.display = 'flex';
    this.setStatus('');
    void this.refresh();
    if (!was) this.onToggle?.(true);
  }

  close(): void {
    const was = this.isOpen;
    this.showSettings(false);
    this.showAbout(false);
    this.element.style.display = 'none';
    if (was) this.onToggle?.(false);
    // Give the keyboard back to the game (keys in the menu don't reach it).
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && this.element.contains(focused)) focused.blur();
  }

  /** Whether the settings show in place of the menu. */
  get settingsOpen(): boolean {
    return this.settings !== null && this.settings.element.style.display !== 'none';
  }

  /** Opens the menu showing the settings. */
  openSettings(): void {
    if (!this.isOpen) this.open();
    this.showSettings(true);
  }

  /** Whether About shows in place of the menu. */
  get aboutOpen(): boolean {
    return this.about !== null && this.about.element.style.display !== 'none';
  }

  /** Shows About (`true`, with the keys as bound now) or the menu in the overlay. */
  private showAbout(on: boolean): void {
    if (!this.about) return;
    if (on) this.about.refresh();
    this.about.element.style.display = on ? 'block' : 'none';
    this.panel.style.display = on ? 'none' : 'block';
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  /** Shows the settings (`true`) or the menu in the overlay. */
  private showSettings(on: boolean): void {
    if (!this.settings) return;
    if (!on && this.settingsOpen) this.settings.hidden();
    this.settings.element.style.display = on ? 'block' : 'none';
    this.panel.style.display = on ? 'none' : 'block';
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  /** Shows `message` on the status line (also used for autosaves and load errors). */
  setStatus(message: string): void {
    this.status.textContent = message;
  }

  /** Redraws the slot list. */
  async refresh(): Promise<void> {
    const slots = sortSlots(await this.actions.list());
    const table = this.slotTable;
    table.replaceChildren();
    if (slots.length === 0) {
      const row = table.insertRow();
      const cell = row.insertCell();
      cell.textContent = 'No saves yet.';
      cell.style.opacity = '0.7';
      return;
    }
    for (const slot of slots) {
      const row = table.insertRow();
      row.dataset.slot = slot.id;
      row.className = 'save-slot';
      const name = row.insertCell();
      name.textContent = slot.name;
      name.className = 'save-slot-name';
      Object.assign(name.style, {
        padding: '2px 8px 2px 0',
        fontWeight: slot.autosave ? '400' : '600',
      });
      const info = row.insertCell();
      info.textContent = `${formatPlayTime(slot.tick)} played · ${savedLabel(slot.savedAt)}`;
      Object.assign(info.style, {
        padding: '2px 8px 2px 0',
        opacity: '0.75',
        whiteSpace: 'nowrap',
      });
      const buttons = row.insertCell();
      buttons.style.whiteSpace = 'nowrap';
      const load = button('Load');
      load.className = 'save-slot-load';
      load.addEventListener('click', () => {
        this.actions.load(slot);
      });
      const exp = button('Export');
      exp.className = 'save-slot-export';
      exp.addEventListener('click', () => {
        this.actions.export(slot).catch((err: unknown) => {
          this.setStatus(`Export failed: ${String(err)}`);
        });
      });
      const del = button('Delete');
      del.className = 'save-slot-delete';
      confirmTwice(del, () => {
        this.actions
          .delete(slot)
          .then(() => this.refresh())
          .catch((err: unknown) => {
            this.setStatus(`Delete failed: ${String(err)}`);
          });
      });
      buttons.append(load, exp, del);
    }
    this.panel.scrollTop = 0;
  }
}

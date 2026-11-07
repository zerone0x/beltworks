/**
 * The settings panel (plain DOM, D39), opened from the game menu: key
 * bindings (click a key, press the new one; a key another action had is
 * swapped with it; reset to defaults), graphics, UI scale, the lettered
 * icons option and the audio volumes (placeholders until there is sound).
 *
 * Every change goes straight to the settings store (src/ui/settings.ts),
 * which persists it; main.ts applies it. While it waits for a new key, the
 * game menu hands it every key press (`capturing`, `captureKey`).
 */

import { letterIcons, setLetterIcons } from '../render/itemIcons';
import {
  ACTIONS,
  DEFAULT_BINDINGS,
  actionLabel,
  conflicts,
  isBindable,
  keyLabel,
  rebind,
  type Action,
} from './keybindings';
import { UI_SCALES, type AudioSettings, type SettingsStore } from './settings';

const BUTTON_STYLE: Partial<CSSStyleDeclaration> = {
  padding: '2px 10px',
  color: '#e8e2d0',
  font: 'inherit',
  background: 'rgba(255, 255, 255, 0.08)',
  border: '1px solid rgba(232, 226, 208, 0.3)',
  borderRadius: '4px',
  cursor: 'pointer',
};

const FIELD_STYLE: Partial<CSSStyleDeclaration> = {
  color: '#e8e2d0',
  font: 'inherit',
  background: 'rgba(0, 0, 0, 0.35)',
  border: '1px solid rgba(232, 226, 208, 0.3)',
  borderRadius: '4px',
};

function button(label: string, id?: string): HTMLButtonElement {
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
  Object.assign(el.style, { fontWeight: '600', margin: '12px 0 4px' });
  return el;
}

/** A row with a label on the left and `control` on the right. */
function row(label: string, control: HTMLElement): HTMLLabelElement {
  const el = document.createElement('label');
  Object.assign(el.style, {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: '12px',
    margin: '3px 0',
  });
  const text = document.createElement('span');
  text.textContent = label;
  el.append(text, control);
  return el;
}

function select<T extends string | number>(
  id: string,
  options: readonly { value: T; label: string }[],
): HTMLSelectElement {
  const el = document.createElement('select');
  el.id = id;
  Object.assign(el.style, FIELD_STYLE, { padding: '1px 4px' });
  for (const o of options) {
    const opt = document.createElement('option');
    opt.value = String(o.value);
    opt.textContent = o.label;
    el.append(opt);
  }
  return el;
}

function checkbox(id: string): HTMLInputElement {
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.id = id;
  return el;
}

export class SettingsPanel {
  readonly element: HTMLElement;
  /** Called when the player asks to go back to the menu. */
  onBack: () => void = () => undefined;
  /** The action waiting for a new key, or `null`. */
  private waiting: Action | null = null;
  private readonly keyButtons = new Map<Action, HTMLButtonElement>();
  private readonly status: HTMLElement;
  private readonly refreshers: (() => void)[] = [];

  constructor(private readonly store: SettingsStore) {
    const el = document.createElement('div');
    el.id = 'settings-panel';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Settings');

    const top = document.createElement('div');
    Object.assign(top.style, { display: 'flex', alignItems: 'center', gap: '10px' });
    const back = button('Back', 'settings-back');
    back.addEventListener('click', () => {
      this.onBack();
    });
    const title = document.createElement('div');
    title.textContent = 'Settings';
    Object.assign(title.style, { fontWeight: '600', fontSize: '15px' });
    top.append(back, title);

    const status = document.createElement('div');
    status.id = 'settings-status';
    Object.assign(status.style, { minHeight: '1.5em', marginTop: '6px', color: '#f2d36b' });

    el.append(top, status);
    el.append(...this.graphicsSection(), ...this.interfaceSection(), ...this.audioSection());
    el.append(...this.keysSection());
    this.element = el;
    this.status = status;
    this.refresh();
    store.subscribe(() => {
      this.refresh();
    });
  }

  /** Whether a key button waits for a new key: the game menu passes every key press to `captureKey`. */
  get capturing(): boolean {
    return this.waiting !== null;
  }

  /** Handles a key press while capturing: Escape cancels, a bindable key is bound. */
  captureKey(e: KeyboardEvent): void {
    const action = this.waiting;
    if (action === null) return;
    if (e.key === 'Escape') {
      this.stopWaiting();
      this.setStatus('');
      return;
    }
    if (!isBindable(e.code)) {
      this.setStatus(`${keyLabel(e.code) || e.key} can't be bound; press another key or Esc.`);
      return;
    }
    const result = rebind(this.store.value.keys, action, e.code);
    this.stopWaiting();
    this.store.update((s) => ({ ...s, keys: result.bindings }));
    const key = keyLabel(e.code);
    this.setStatus(
      result.swapped
        ? `${actionLabel(action)}: ${key}. ${key} was on ${actionLabel(result.swapped)}, which is now ${keyLabel(result.bindings[result.swapped])}.`
        : `${actionLabel(action)}: ${key}.`,
    );
  }

  /** Called when the panel hides: stops waiting for a key and clears the status. */
  hidden(): void {
    this.stopWaiting();
    this.setStatus('');
  }

  private setStatus(message: string): void {
    this.status.textContent = message;
  }

  private stopWaiting(): void {
    const action = this.waiting;
    this.waiting = null;
    if (action) this.refresh();
  }

  /** Shows the current settings in every control. */
  private refresh(): void {
    for (const r of this.refreshers) r();
  }

  private graphicsSection(): HTMLElement[] {
    const terrain = select('setting-terrain', [
      { value: 'rendered', label: 'Rendered' },
      { value: 'flat', label: 'Flat colors' },
    ]);
    const detail = select('setting-terrain-detail', [
      { value: 'high', label: 'High' },
      { value: 'low', label: 'Low' },
    ]);
    const shadows = checkbox('setting-shadows');
    const animation = checkbox('setting-animation');
    terrain.addEventListener('change', () => {
      const value = terrain.value === 'flat' ? 'flat' : 'rendered';
      this.store.update((s) => ({ ...s, graphics: { ...s.graphics, terrain: value } }));
    });
    detail.addEventListener('change', () => {
      const value = detail.value === 'low' ? 'low' : 'high';
      this.store.update((s) => ({ ...s, graphics: { ...s.graphics, terrainDetail: value } }));
    });
    shadows.addEventListener('change', () => {
      this.store.update((s) => ({ ...s, graphics: { ...s.graphics, shadows: shadows.checked } }));
    });
    animation.addEventListener('change', () => {
      this.store.update((s) => ({
        ...s,
        graphics: { ...s.graphics, animation: animation.checked },
      }));
    });
    this.refreshers.push(() => {
      const g = this.store.value.graphics;
      terrain.value = g.terrain;
      detail.value = g.terrainDetail;
      detail.disabled = g.terrain === 'flat';
      shadows.checked = g.shadows;
      animation.checked = g.animation;
    });
    return [
      heading('Graphics'),
      row('Terrain', terrain),
      row('Terrain detail', detail),
      row('Shadows', shadows),
      row('Animations (belts, engines, machines)', animation),
    ];
  }

  private interfaceSection(): HTMLElement[] {
    const scale = select(
      'setting-ui-scale',
      UI_SCALES.map((s) => ({ value: s, label: `${String(Math.round(s * 100))}%` })),
    );
    scale.addEventListener('change', () => {
      const value = Number(scale.value);
      this.store.update((s) => ({ ...s, uiScale: value }));
    });
    // Lettered item icons instead of the rendered ones (src/render/itemIcons.ts).
    const letters = checkbox('letter-icons');
    letters.addEventListener('change', () => {
      setLetterIcons(letters.checked);
    });
    this.refreshers.push(() => {
      scale.value = String(this.store.value.uiScale);
      letters.checked = letterIcons();
    });
    return [
      heading('Interface'),
      row('UI scale', scale),
      row('Lettered item icons (FE, CU, ...) instead of pictures', letters),
    ];
  }

  private audioSection(): HTMLElement[] {
    const rows: HTMLElement[] = [heading('Audio')];
    const names: readonly [keyof AudioSettings, string][] = [
      ['master', 'Master volume'],
      ['sfx', 'Effects'],
      ['music', 'Music'],
    ];
    for (const [key, label] of names) {
      const range = document.createElement('input');
      range.type = 'range';
      range.id = `setting-volume-${key}`;
      range.min = '0';
      range.max = '100';
      range.step = '5';
      range.addEventListener('change', () => {
        const value = Number(range.value);
        this.store.update((s) => ({ ...s, audio: { ...s.audio, [key]: value } }));
      });
      this.refreshers.push(() => {
        range.value = String(this.store.value.audio[key]);
      });
      rows.push(row(label, range));
    }
    const note = document.createElement('div');
    note.textContent = 'The game has no sound yet; these volumes apply once it does.';
    Object.assign(note.style, { opacity: '0.6', fontSize: '12px' });
    rows.push(note);
    return rows;
  }

  private keysSection(): HTMLElement[] {
    const table = document.createElement('table');
    table.id = 'settings-keys';
    Object.assign(table.style, { borderCollapse: 'collapse', width: '100%' });
    for (const { id, label } of ACTIONS) {
      const tr = table.insertRow();
      tr.dataset.action = id;
      const name = tr.insertCell();
      name.textContent = label;
      name.style.padding = '1px 8px 1px 0';
      const cell = tr.insertCell();
      cell.style.textAlign = 'right';
      const key = button('', `key-${id}`);
      key.className = 'key-binding';
      Object.assign(key.style, { minWidth: '84px' });
      key.addEventListener('click', () => {
        this.waiting = id;
        this.refresh();
        this.setStatus(`Press a key for “${label}” (Esc cancels).`);
      });
      cell.append(key);
      this.keyButtons.set(id, key);
    }
    const reset = button('Reset keys to defaults', 'keys-reset');
    reset.style.marginTop = '6px';
    reset.addEventListener('click', () => {
      this.stopWaiting();
      this.store.update((s) => ({ ...s, keys: DEFAULT_BINDINGS }));
      this.setStatus('Keys reset to the defaults.');
    });
    this.refreshers.push(() => {
      const keys = this.store.value.keys;
      const clashing = new Set(conflicts(keys).flat());
      for (const [action, b] of this.keyButtons) {
        const waiting = this.waiting === action;
        b.textContent = waiting ? 'Press a key…' : keyLabel(keys[action]);
        b.dataset.key = keys[action];
        b.style.borderColor = waiting
          ? '#f2d36b'
          : clashing.has(action)
            ? '#e06060'
            : 'rgba(232, 226, 208, 0.3)';
      }
    });
    const hint = document.createElement('div');
    hint.textContent = 'Esc, the mouse buttons and Alt / Shift / Ctrl clicks are fixed.';
    Object.assign(hint.style, { opacity: '0.6', fontSize: '12px', marginTop: '4px' });
    return [heading('Keys'), table, reset, hint];
  }
}

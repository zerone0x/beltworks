/**
 * The title screen (plain DOM, D39), shown before the game starts: Continue
 * (the newest save), New game with a world seed (shown, editable, random or
 * copied), Load (any save slot), Settings (#98's settings panel in its
 * place; Esc goes back) and About (src/ui/about.ts, the same way), with the
 * version under them. It resolves with what to start; main.ts (through
 * `chooseStart` in saves.ts) does the rest. Nothing here touches the worker
 * or IndexedDB.
 */

import { formatPlayTime, type SaveSlot } from '../save/slots';
import { SAVE_VERSION } from '../sim/save/container';
import { VERSION_LABEL } from '../version';
import type { AboutPanel } from './about';
import { OVERLAY_STYLE, PANEL_STYLE, button, copyText, isolateKeys, savedLabel } from './gameMenu';
import { parseSeed, randomSeed } from './seed';
import type { SettingsPanel } from './settingsPanel';

/** What the player picked: a new game on a seed, or a save to load. */
export type TitleChoice = { kind: 'new'; seed: number } | { kind: 'load'; slot: SaveSlot };

export interface TitleScreenOptions {
  /** Save slots, newest first. */
  slots: readonly SaveSlot[];
  /** The seed the New game field suggests (random when absent). */
  seed?: number;
  settings?: SettingsPanel | null;
  about?: AboutPanel | null;
}

const BIG_BUTTON: Partial<CSSStyleDeclaration> = {
  display: 'block',
  width: '100%',
  margin: '6px 0 0',
  padding: '6px 18px',
  fontSize: '15px',
};

function slotInfo(slot: SaveSlot): string {
  return `${slot.name} · ${formatPlayTime(slot.tick)} played · ${savedLabel(slot.savedAt)}`;
}

/** Shows the title screen in `parent`; resolves once the player picks, and removes it. */
export function showTitleScreen(
  parent: HTMLElement,
  { slots, seed = randomSeed(), settings = null, about = null }: TitleScreenOptions,
): Promise<TitleChoice> {
  const overlay = document.createElement('div');
  overlay.id = 'start-screen';
  Object.assign(overlay.style, {
    ...OVERLAY_STYLE,
    background: 'radial-gradient(ellipse at 50% 35%, #2a2f36 0%, #111418 70%)',
  });
  const panel = document.createElement('div');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Beltworks');
  Object.assign(panel.style, { ...PANEL_STYLE, minWidth: '360px', maxWidth: '420px' });

  const title = document.createElement('div');
  title.textContent = 'Beltworks';
  Object.assign(title.style, {
    fontSize: '30px',
    fontWeight: '700',
    letterSpacing: '0.04em',
    textAlign: 'center',
    color: '#f2d36b',
  });
  const tagline = document.createElement('div');
  tagline.textContent = 'Mine, build, automate.';
  Object.assign(tagline.style, { textAlign: 'center', opacity: '0.7', marginBottom: '10px' });
  panel.append(title, tagline);

  const status = document.createElement('div');
  status.id = 'title-status';
  Object.assign(status.style, { minHeight: '1.5em', marginTop: '8px', color: '#f2d36b' });
  const say = (message: string): void => {
    status.textContent = message;
  };

  let resolvePick: (choice: TitleChoice) => void = () => undefined;
  const picked = new Promise<TitleChoice>((resolve) => {
    resolvePick = resolve;
  });
  const pick = (choice: TitleChoice): void => {
    if (choice.kind === 'load' && choice.slot.version > SAVE_VERSION) {
      say(
        `“${choice.slot.name}” was made by a newer version of Beltworks (save format ` +
          `${String(choice.slot.version)}); this one reads up to ${String(SAVE_VERSION)}.`,
      );
      return;
    }
    window.removeEventListener('keydown', onKey, { capture: true });
    if (settings) {
      settings.hidden();
      settings.element.remove();
    }
    about?.element.remove();
    overlay.remove();
    resolvePick(choice);
  };

  // Continue: the newest save.
  const latest = slots[0];
  let first: HTMLElement | null = null;
  if (latest) {
    const resume = button('Continue', 'start-continue');
    Object.assign(resume.style, BIG_BUTTON);
    resume.addEventListener('click', () => {
      pick({ kind: 'load', slot: latest });
    });
    const info = document.createElement('div');
    info.id = 'start-latest';
    info.textContent = slotInfo(latest);
    Object.assign(info.style, { margin: '2px 0 4px', opacity: '0.75', fontSize: '12px' });
    panel.append(resume, info);
    first = resume;
  }

  // New game, with its seed.
  const seedRow = document.createElement('div');
  Object.assign(seedRow.style, {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    marginTop: '10px',
  });
  const seedLabel = document.createElement('label');
  seedLabel.textContent = 'World seed';
  seedLabel.htmlFor = 'title-seed';
  seedLabel.style.opacity = '0.75';
  const seedInput = document.createElement('input');
  seedInput.id = 'title-seed';
  seedInput.type = 'text';
  seedInput.maxLength = 40;
  seedInput.value = String(seed >>> 0);
  seedInput.spellcheck = false;
  seedInput.title = 'A number, or any word or phrase: the same seed always makes the same world';
  Object.assign(seedInput.style, {
    flex: '1',
    minWidth: '0',
    padding: '3px 6px',
    color: '#e8e2d0',
    font: '13px ui-monospace, monospace',
    background: 'rgba(0, 0, 0, 0.35)',
    border: '1px solid rgba(232, 226, 208, 0.3)',
    borderRadius: '4px',
  });
  const random = button('Random', 'title-seed-random');
  random.addEventListener('click', () => {
    seedInput.value = String(randomSeed());
    say('');
  });
  const copy = button('Copy', 'title-seed-copy');
  copy.addEventListener('click', () => {
    // The resolved number, as the game menu shows it once the game runs.
    const value = parseSeed(seedInput.value);
    if (value === null) {
      say('Enter a seed (a number, or any word), or pick a random one.');
      return;
    }
    const text = String(value);
    void copyText(text).then((ok) => {
      say(ok ? `Copied seed ${text}.` : `Couldn't copy: select the seed and copy it.`);
    });
  });
  seedRow.append(seedLabel, seedInput, random, copy);
  const fresh = button('New game', 'start-new-game');
  Object.assign(fresh.style, BIG_BUTTON);
  const startNew = (): void => {
    const value = parseSeed(seedInput.value);
    if (value === null) {
      say('Enter a seed (a number, or any word), or pick a random one.');
      return;
    }
    pick({ kind: 'new', seed: value });
  };
  fresh.addEventListener('click', startNew);
  seedInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') startNew();
  });
  panel.append(seedRow, fresh);

  // Load: every save slot.
  const load = button('Load', 'title-load');
  Object.assign(load.style, BIG_BUTTON, { marginTop: '10px' });
  const table = document.createElement('table');
  table.id = 'title-slots';
  table.hidden = true;
  Object.assign(table.style, { borderCollapse: 'collapse', width: '100%', marginTop: '4px' });
  if (slots.length === 0) {
    load.disabled = true;
    load.title = 'No saves yet';
    load.style.opacity = '0.5';
    load.style.cursor = 'default';
  }
  for (const slot of slots) {
    const row = table.insertRow();
    row.className = 'title-slot';
    row.dataset.slot = slot.id;
    const name = row.insertCell();
    name.textContent = slot.name;
    Object.assign(name.style, {
      padding: '2px 8px 2px 0',
      fontWeight: slot.autosave ? '400' : '600',
    });
    const info = row.insertCell();
    info.textContent = `${formatPlayTime(slot.tick)} · ${savedLabel(slot.savedAt)}`;
    Object.assign(info.style, { padding: '2px 8px 2px 0', opacity: '0.75', whiteSpace: 'nowrap' });
    const cell = row.insertCell();
    const b = button('Load');
    b.className = 'title-slot-load';
    b.addEventListener('click', () => {
      pick({ kind: 'load', slot });
    });
    cell.append(b);
  }
  load.addEventListener('click', () => {
    table.hidden = !table.hidden;
  });
  panel.append(load, table);

  // Settings, in the panel's place.
  const showSettings = (on: boolean): void => {
    if (!settings) return;
    if (!on) settings.hidden();
    settings.element.style.display = on ? 'block' : 'none';
    panel.style.display = on ? 'none' : 'block';
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };
  if (settings) {
    const open = button('Settings', 'title-settings');
    Object.assign(open.style, BIG_BUTTON);
    open.addEventListener('click', () => {
      showSettings(true);
    });
    panel.append(open);
    Object.assign(settings.element.style, PANEL_STYLE, { display: 'none' });
    settings.onBack = () => {
      showSettings(false);
    };
  }
  // About, in the panel's place too.
  const showAbout = (on: boolean): void => {
    if (!about) return;
    if (on) about.refresh();
    about.element.style.display = on ? 'block' : 'none';
    panel.style.display = on ? 'none' : 'block';
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  };
  if (about) {
    const open = button('About', 'title-about');
    Object.assign(open.style, BIG_BUTTON);
    open.addEventListener('click', () => {
      showAbout(true);
    });
    panel.append(open);
    Object.assign(about.element.style, PANEL_STYLE, { display: 'none' });
    about.onBack = () => {
      showAbout(false);
    };
  }
  panel.append(status);
  const version = document.createElement('div');
  version.id = 'title-version';
  version.textContent = VERSION_LABEL;
  Object.assign(version.style, { textAlign: 'center', fontSize: '11px', opacity: '0.5' });
  panel.append(version);

  overlay.append(panel);
  if (settings) overlay.append(settings.element);
  if (about) overlay.append(about.element);
  isolateKeys(overlay);
  parent.append(overlay);
  (first ?? fresh).focus();

  // Capture phase: the settings may wait for a key binding; Escape leaves the settings.
  function onKey(e: KeyboardEvent): void {
    if (settings?.capturing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) settings.captureKey(e);
      return;
    }
    if (e.key === 'Escape' && settings && settings.element.style.display !== 'none') {
      showSettings(false);
    } else if (e.key === 'Escape' && about && about.element.style.display !== 'none') {
      showAbout(false);
    }
  }
  window.addEventListener('keydown', onKey, { capture: true });
  return picked;
}

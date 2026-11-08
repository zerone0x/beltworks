/**
 * The objective tracker of the onboarding (plain DOM, D39; the steps and
 * their conditions are in onboarding.ts): a small panel in the bottom-left
 * corner with the current objective, the keys it needs (as currently
 * bound), the way to the ore patch it needs, and the checklist. It points
 * out the hotbar slot of the item the step needs and the crafting recipe
 * (through `highlight`), and has Skip (closes it for good; the game menu
 * can start it again).
 *
 * Progress is stored in `localStorage` (D54), not in saves.
 */

import { keyFor, keyLabel } from './keybindings';
import {
  NEW_PROGRESS,
  OnboardingTracker,
  STEPS,
  directionText,
  isActive,
  parseProgress,
  unfuelled,
  type OnboardingProgress,
  type OnboardingState,
} from './onboarding';

/** The `localStorage` key of the onboarding progress (JSON). */
export const ONBOARDING_KEY = 'beltworks.onboarding';

const ACCENT = '#7fd4ff';

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Progress as stored in this browser. */
export function loadProgress(): OnboardingProgress {
  try {
    return parseProgress(JSON.parse(storage()?.getItem(ONBOARDING_KEY) ?? 'null'));
  } catch {
    return NEW_PROGRESS;
  }
}

function saveProgress(progress: OnboardingProgress): void {
  try {
    storage()?.setItem(ONBOARDING_KEY, JSON.stringify(progress));
  } catch {
    // Full or blocked storage: the tutorial still works for this session.
  }
}

/** What the panel points out for the current step. */
export interface OnboardingHighlight {
  /** Item to point out in the hotbar (0 for none). */
  item: number;
  /** Hand recipe to point out in the crafting panel (0 for none). */
  recipe: number;
}

export interface OnboardingPanelOptions {
  /** Points out (or, with zeros, stops pointing out) an item and a recipe. */
  highlight: (h: OnboardingHighlight) => void;
  /** The local player's position in tiles, or `null` before the first snapshot. */
  player: () => { x: number; y: number } | null;
  /** The center of the starting patch of resource `ore`, in tiles. */
  patch: (ore: number) => { x: number; y: number } | null;
}

export class OnboardingPanel {
  readonly element: HTMLElement;
  private readonly tracker: OnboardingTracker;
  private readonly objective: HTMLElement;
  private readonly text: HTMLElement;
  private readonly keys: HTMLElement;
  private readonly where: HTMLElement;
  private readonly list: HTMLOListElement;
  private readonly count: HTMLElement;
  private readonly skip: HTMLButtonElement;
  private shown = '';

  constructor(
    parent: HTMLElement,
    private readonly options: OnboardingPanelOptions,
    progress: OnboardingProgress = loadProgress(),
  ) {
    this.tracker = new OnboardingTracker(progress);
    const el = document.createElement('div');
    el.id = 'onboarding';
    el.setAttribute('role', 'complementary');
    el.setAttribute('aria-label', 'Getting started');
    Object.assign(el.style, {
      position: 'fixed',
      left: '8px',
      bottom: '44px',
      width: '280px',
      padding: '8px 10px',
      color: '#e8e2d0',
      font: '12px/1.45 system-ui, sans-serif',
      background: 'rgba(20, 22, 26, 0.88)',
      border: `1px solid ${ACCENT}66`,
      borderRadius: '6px',
      zIndex: '15',
    } satisfies Partial<CSSStyleDeclaration>);

    const head = document.createElement('div');
    Object.assign(head.style, { display: 'flex', alignItems: 'center', gap: '6px' });
    const heading = document.createElement('div');
    heading.textContent = 'Getting started';
    Object.assign(heading.style, { fontWeight: '600', flex: '1' });
    this.count = document.createElement('span');
    this.count.id = 'onboarding-count';
    this.count.style.opacity = '0.7';
    this.skip = document.createElement('button');
    this.skip.type = 'button';
    this.skip.id = 'onboarding-skip';
    Object.assign(this.skip.style, {
      padding: '1px 8px',
      color: '#e8e2d0',
      font: 'inherit',
      background: 'rgba(255, 255, 255, 0.08)',
      border: '1px solid rgba(232, 226, 208, 0.3)',
      borderRadius: '4px',
      cursor: 'pointer',
    } satisfies Partial<CSSStyleDeclaration>);
    this.skip.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    this.skip.addEventListener('click', () => {
      this.dismiss();
    });
    head.append(heading, this.count, this.skip);

    this.objective = document.createElement('div');
    this.objective.id = 'onboarding-objective';
    Object.assign(this.objective.style, { marginTop: '6px', fontWeight: '600', color: ACCENT });
    this.text = document.createElement('div');
    this.text.id = 'onboarding-text';
    this.keys = document.createElement('div');
    this.keys.id = 'onboarding-keys';
    this.keys.style.marginTop = '4px';
    this.where = document.createElement('div');
    this.where.id = 'onboarding-where';
    Object.assign(this.where.style, { marginTop: '2px', opacity: '0.8' });
    this.list = document.createElement('ol');
    this.list.id = 'onboarding-steps';
    Object.assign(this.list.style, {
      margin: '6px 0 0',
      padding: '0',
      listStyle: 'none',
      display: 'grid',
      gridTemplateColumns: '1fr 1fr',
      gridTemplateRows: `repeat(${String(Math.ceil(STEPS.length / 2))}, auto)`,
      gridAutoFlow: 'column',
      gap: '0 8px',
      fontSize: '11px',
    } satisfies Partial<CSSStyleDeclaration>);
    for (const step of STEPS) {
      const li = document.createElement('li');
      li.dataset.step = step.id;
      this.list.appendChild(li);
    }
    el.append(head, this.objective, this.text, this.keys, this.where, this.list);
    parent.appendChild(el);
    this.element = el;
    this.render(null);
  }

  get progress(): OnboardingProgress {
    return this.tracker.progress;
  }

  get isOpen(): boolean {
    return !this.element.hidden;
  }

  /** Starts again from the first step (a new game, or "Tutorial" in the game menu). */
  restart(): void {
    this.setProgress(NEW_PROGRESS);
  }

  /** Closes it until it is started again. */
  dismiss(): void {
    this.setProgress({ ...this.tracker.progress, dismissed: true });
  }

  private setProgress(progress: OnboardingProgress): void {
    this.tracker.progress = progress;
    saveProgress(progress);
    this.render(null);
  }

  /** Advances on the latest snapshot's state and redraws what changed. */
  update(state: OnboardingState): void {
    if (!isActive(this.tracker.progress)) return;
    if (!this.tracker.done && this.tracker.update(state)) saveProgress(this.tracker.progress);
    this.render(state);
  }

  /** Redraws the panel (only touching the DOM when what it shows changed). */
  private render(state: OnboardingState | null): void {
    const progress = this.tracker.progress;
    const active = isActive(progress);
    const done = this.tracker.done;
    const step = STEPS[progress.step];
    const where = active && step?.patch !== undefined ? this.patchText(step.patch) : '';
    const fuel = active && step?.id === 'power' && state ? unfuelled(state) : 0;
    const keys = step?.keys.map((a) => keyLabel(keyFor(a))).join(' ') ?? '';
    const key = `${String(active)}|${String(progress.step)}|${where}|${String(fuel)}|${keys}`;
    if (key === this.shown) return;
    this.shown = key;
    this.element.hidden = !active;
    this.element.dataset.step = done ? 'done' : (step?.id ?? '');
    this.options.highlight({
      item: active && step?.item !== undefined ? step.item : 0,
      recipe: active && step?.recipe !== undefined ? step.recipe : 0,
    });
    if (!active) return;
    this.count.textContent = done ? 'done' : `${String(progress.step + 1)}/${String(STEPS.length)}`;
    this.skip.textContent = done ? 'Close' : 'Skip';
    if (done || !step) {
      this.objective.textContent = 'Your iron plate line runs on its own!';
      this.text.textContent =
        'Next: a boiler, steam engines and small poles power electric drills and inserters. ' +
        'Press the help key for every control.';
      this.keys.replaceChildren(this.keyCap(keyLabel(keyFor('help'))));
      this.where.textContent = '';
    } else {
      this.objective.textContent = step.title;
      this.text.textContent = step.text;
      this.keys.replaceChildren(...step.keys.map((a) => this.keyCap(keyLabel(keyFor(a)))));
      if (step.item !== undefined) {
        const hint = document.createElement('span');
        hint.textContent =
          step.keys.length > 0 ? ' · hotbar slot marked in blue' : 'Hotbar slot marked in blue';
        hint.style.opacity = '0.8';
        this.keys.append(hint);
      }
      this.where.textContent =
        step.id === 'power' && fuel > 0
          ? `${String(fuel)} machine${fuel === 1 ? '' : 's'} waiting for fuel`
          : where;
    }
    STEPS.forEach((s, i) => {
      const li = this.list.children[i] as HTMLElement;
      const state = i < progress.step ? 'done' : i === progress.step ? 'current' : 'todo';
      li.dataset.state = state;
      li.textContent = `${state === 'done' ? '✓' : state === 'current' ? '▸' : '·'} ${s.title}`;
      li.style.opacity = state === 'todo' ? '0.55' : '1';
      li.style.color = state === 'current' ? ACCENT : '';
    });
  }

  private patchText(ore: number): string {
    const player = this.options.player();
    const patch = this.options.patch(ore);
    if (!player || !patch) return '';
    return `The patch: ${directionText(player.x, player.y, patch.x, patch.y)}`;
  }

  private keyCap(label: string): HTMLElement {
    const k = document.createElement('kbd');
    k.textContent = label;
    Object.assign(k.style, {
      display: 'inline-block',
      minWidth: '14px',
      margin: '0 3px 0 0',
      padding: '0 4px',
      textAlign: 'center',
      font: '11px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
      color: '#14161a',
      background: ACCENT,
      borderRadius: '3px',
    } satisfies Partial<CSSStyleDeclaration>);
    return k;
  }
}

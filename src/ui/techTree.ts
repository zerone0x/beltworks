/**
 * The research UI (plain DOM, docs/DECISIONS.md D39):
 * - the tech tree panel, toggled with `T`: every technology as a card in a
 *   column by its depth in the tree (`technologyDepth`), with lines from
 *   its prerequisites; each card shows its state (researched, being
 *   researched, available, locked), its cost (packs per unit × units, and
 *   the time per unit in one lab), what it unlocks, and its progress. A
 *   click on an available technology makes it the current research
 *   (`SetResearch`); a click on the current one stops researching.
 * - the research status above the screen's top edge: the current research
 *   and its progress (click to open the tree), hidden while nothing is
 *   being researched.
 *
 * Both redraw from the snapshot's research (`ResearchData`) and only send
 * commands; the simulation decides what happens. Progress counts the units
 * labs have finished plus the work done on the units under way.
 */

import { itemPrototype } from '../data/items';
import { recipePrototype } from '../data/recipes';
import {
  TECH_IDS,
  technologyDepth,
  technologyPrototype,
  type Technology,
} from '../data/technologies';
import type { CommandInput } from '../sim/commands';
import { NO_RESEARCH, isResearchedIn, type ResearchData } from '../sim/snapshot';
import { makeSlotIcon, setSlotIcon } from './inventory';

/** How a technology stands for the force. */
export type TechState = 'researched' | 'current' | 'available' | 'locked';

/** The state of technology `tech` in `research`. */
export function techState(research: ResearchData, tech: number): TechState {
  if (isResearchedIn(research, tech)) return 'researched';
  if (research.current === tech) return 'current';
  const t = technologyPrototype(tech);
  return t?.prerequisites.every((p) => isResearchedIn(research, p)) ? 'available' : 'locked';
}

/**
 * Progress on technology `tech` (0..1): its finished units plus the work
 * done on the units labs are researching, out of all its units.
 */
export function techProgress(research: ResearchData, tech: number): number {
  const t = technologyPrototype(tech);
  const r = research.techs.get(tech);
  if (!t || !r) return 0;
  const units = r.unitsDone + r.ticksInProgress / t.ticksPerUnit;
  return Math.min(1, units / t.units);
}

/** `ticks` (60 per second) as seconds: `10 s`, `2.5 s`. */
const seconds = (ticks: number): string => `${String(Math.round((ticks / 60) * 10) / 10)} s`;

/** A technology's cost as text: `10 × (1 Automation science pack) · 10 s each`. */
export function costText(t: Technology): string {
  const packs = t.packs.map((p) => itemPrototype(p)?.label ?? '?').join(' + ');
  return `${String(t.units)} × (${packs}), ${seconds(t.ticksPerUnit)} each`;
}

/** What a technology unlocks, as text: the labels of its recipes' products. */
export function unlocksText(t: Technology): string {
  if (t.unlocks.length === 0) return 'Leads on to further research';
  const names = t.unlocks.map((r) => {
    const out = recipePrototype(r)?.outputs[0];
    return out ? (itemPrototype(out[0])?.label ?? '?') : '?';
  });
  return `Unlocks: ${names.join(', ')}`;
}

/** Card size and spacing of the tree, in CSS pixels. */
const CARD_W = 184;
const CARD_H = 112;
const COL_GAP = 44;
const ROW_GAP = 14;

/** Card positions: column by depth, row by id within the column. */
export function treeLayout(): Map<number, { col: number; row: number }> {
  const out = new Map<number, { col: number; row: number }>();
  const rows = new Map<number, number>();
  for (const id of TECH_IDS) {
    const col = technologyDepth(id);
    const row = rows.get(col) ?? 0;
    rows.set(col, row + 1);
    out.set(id, { col, row });
  }
  return out;
}

/** Card colors per state; opaque, so the links behind the cards don't show through. */
const STATE_COLORS: Readonly<
  Record<TechState, { border: string; background: string; color: string }>
> = {
  researched: { border: '#6fbf73', background: '#203325', color: '#e8e2d0' },
  current: { border: '#f2d36b', background: '#3a3424', color: '#e8e2d0' },
  available: { border: '#8a8576', background: '#25282d', color: '#e8e2d0' },
  locked: { border: '#3a3c40', background: '#1b1d21', color: '#8d8878' },
};

const STATE_TEXT: Readonly<Record<TechState, string>> = {
  researched: 'Researched',
  current: 'Researching',
  available: 'Click to research',
  locked: 'Locked',
};

/** A thin progress bar. */
function makeBar(color: string): { element: HTMLElement; fill: HTMLElement } {
  const element = document.createElement('div');
  element.className = 'bar';
  Object.assign(element.style, {
    height: '5px',
    background: 'rgba(0, 0, 0, 0.55)',
    borderRadius: '3px',
    overflow: 'hidden',
  } satisfies Partial<CSSStyleDeclaration>);
  const fill = document.createElement('div');
  Object.assign(fill.style, { height: '100%', width: '0', background: color });
  element.appendChild(fill);
  return { element, fill };
}

/** An item icon `px` CSS pixels wide, inline with text. */
function smallIcon(item: number, px: number): HTMLElement {
  const icon = makeSlotIcon();
  setSlotIcon(icon, item);
  Object.assign(icon.style, {
    position: 'static',
    display: 'inline-block',
    width: `${String(px)}px`,
    height: `${String(px)}px`,
    inset: 'auto',
    verticalAlign: 'middle',
  } satisfies Partial<CSSStyleDeclaration>);
  icon.title = itemPrototype(item)?.label ?? '';
  return icon;
}

interface Card {
  root: HTMLButtonElement;
  status: HTMLElement;
  bar: { element: HTMLElement; fill: HTMLElement };
}

export interface TechTreeOptions {
  playerId: number;
  send: (commands: CommandInput[]) => void;
}

/** The tech tree panel and the research status line. */
export class TechTreePanel {
  readonly element: HTMLElement;
  /** The research status at the top of the screen. */
  readonly status: HTMLElement;
  private readonly statusText: HTMLElement;
  private readonly statusBar: { element: HTMLElement; fill: HTMLElement };
  private readonly cards = new Map<number, Card>();
  private research: ResearchData = NO_RESEARCH;
  private shown = '';

  constructor(
    parent: HTMLElement,
    private readonly options: TechTreeOptions,
  ) {
    const layout = treeLayout();
    const cols = Math.max(...[...layout.values()].map((p) => p.col)) + 1;
    const rows = Math.max(...[...layout.values()].map((p) => p.row)) + 1;
    const width = cols * CARD_W + (cols - 1) * COL_GAP;
    const height = rows * CARD_H + (rows - 1) * ROW_GAP;

    const el = document.createElement('div');
    el.id = 'tech-tree';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Research');
    el.hidden = true;
    Object.assign(el.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      padding: '10px 14px 14px',
      color: '#e8e2d0',
      font: '13px/1.35 system-ui, sans-serif',
      background: 'rgba(20, 22, 26, 0.94)',
      border: '1px solid rgba(232, 226, 208, 0.2)',
      borderRadius: '6px',
      zIndex: '25',
    } satisfies Partial<CSSStyleDeclaration>);
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
    });

    const header = document.createElement('div');
    Object.assign(header.style, {
      display: 'flex',
      alignItems: 'baseline',
      gap: '8px',
      marginBottom: '10px',
    } satisfies Partial<CSSStyleDeclaration>);
    const title = document.createElement('div');
    title.textContent = 'Research';
    Object.assign(title.style, { fontWeight: '600' });
    const hint = document.createElement('div');
    hint.textContent = 'Pick a technology; labs research it from science packs.';
    Object.assign(hint.style, { flex: '1', color: '#b9b29e', fontSize: '12px' });
    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Close (T or Esc)';
    Object.assign(close.style, {
      font: 'inherit',
      color: 'inherit',
      background: 'none',
      border: 'none',
      cursor: 'pointer',
      padding: '0 2px',
    } satisfies Partial<CSSStyleDeclaration>);
    close.addEventListener('click', () => {
      this.close();
    });
    header.append(title, hint, close);

    const tree = document.createElement('div');
    tree.className = 'tree';
    Object.assign(tree.style, {
      position: 'relative',
      width: `${String(width)}px`,
      height: `${String(height)}px`,
    } satisfies Partial<CSSStyleDeclaration>);
    tree.appendChild(this.buildLinks(layout, width, height));
    for (const id of TECH_IDS) {
      const pos = layout.get(id)!;
      const card = this.buildCard(technologyPrototype(id)!);
      Object.assign(card.root.style, {
        left: `${String(pos.col * (CARD_W + COL_GAP))}px`,
        top: `${String(pos.row * (CARD_H + ROW_GAP))}px`,
      });
      tree.appendChild(card.root);
      this.cards.set(id, card);
    }
    el.append(header, tree);

    // The status line: the current research and its progress.
    const status = document.createElement('button');
    status.id = 'research-status';
    status.type = 'button';
    status.hidden = true;
    status.title = 'Open the tech tree (T)';
    Object.assign(status.style, {
      position: 'fixed',
      top: '8px',
      left: '50%',
      transform: 'translateX(-50%)',
      minWidth: '200px',
      padding: '4px 10px 6px',
      color: '#e8e2d0',
      font: '12px/1.4 system-ui, sans-serif',
      background: 'rgba(0, 0, 0, 0.55)',
      border: '1px solid rgba(232, 226, 208, 0.2)',
      borderRadius: '4px',
      cursor: 'pointer',
      zIndex: '10',
    } satisfies Partial<CSSStyleDeclaration>);
    this.statusText = document.createElement('div');
    this.statusBar = makeBar('#f2d36b');
    status.append(this.statusText, this.statusBar.element);
    status.addEventListener('mousedown', (e) => {
      e.preventDefault();
    });
    status.addEventListener('click', () => {
      this.toggle();
    });

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.close();
      } else if (e.code === 'KeyT' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
        this.toggle();
      }
    });
    parent.append(el, status);
    this.element = el;
    this.status = status;
    this.update(NO_RESEARCH);
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

  /** Shows `research` (from the latest snapshot). */
  update(research: ResearchData): void {
    this.research = research;
    const states = TECH_IDS.map((id) => techState(research, id));
    // Progress in tenths of a percent, so the panel only changes when a bar does.
    const progress = TECH_IDS.map((id) => Math.floor(techProgress(research, id) * 1000));
    const key = `${String(research.current)}|${states.join(',')}|${progress.join(',')}`;
    if (key === this.shown) return;
    this.shown = key;
    TECH_IDS.forEach((id, i) => {
      const card = this.cards.get(id)!;
      const state = states[i]!;
      const t = technologyPrototype(id)!;
      const done = research.techs.get(id)?.unitsDone ?? 0;
      card.root.dataset.state = state;
      card.root.dataset.progress = String(progress[i]! / 10);
      card.root.disabled = state === 'researched' || state === 'locked';
      const colors = STATE_COLORS[state];
      Object.assign(card.root.style, {
        borderColor: colors.border,
        background: colors.background,
        color: colors.color,
        cursor: card.root.disabled ? 'default' : 'pointer',
      });
      const missing = t.prerequisites
        .filter((p) => !isResearchedIn(research, p))
        .map((p) => technologyPrototype(p)?.label ?? '?');
      card.status.textContent =
        state === 'locked'
          ? `Requires ${missing.join(', ')}`
          : state === 'researched'
            ? STATE_TEXT.researched
            : `${state === 'current' ? STATE_TEXT.current : STATE_TEXT.available} · ${String(done)}/${String(t.units)}`;
      card.bar.element.style.visibility = state === 'locked' ? 'hidden' : 'visible';
      card.bar.fill.style.width = `${String(progress[i]! / 10)}%`;
      card.bar.fill.style.background = state === 'researched' ? '#6fbf73' : '#f2d36b';
    });
    const current = technologyPrototype(research.current);
    this.status.hidden = !current;
    if (current) {
      const p = techProgress(research, current.id);
      this.status.dataset.tech = current.name;
      this.status.dataset.progress = String(Math.floor(p * 1000) / 10);
      this.statusText.textContent = `Researching ${current.label}: ${String(Math.floor(p * 100))}%`;
      this.statusBar.fill.style.width = `${String(Math.floor(p * 1000) / 10)}%`;
    } else {
      delete this.status.dataset.tech;
    }
  }

  /** The card of technology `t`: name, cost, unlocks, state line and progress bar. */
  private buildCard(t: Technology): Card {
    const root = document.createElement('button');
    root.type = 'button';
    root.className = 'tech';
    root.dataset.tech = t.name;
    Object.assign(root.style, {
      position: 'absolute',
      boxSizing: 'border-box',
      width: `${String(CARD_W)}px`,
      height: `${String(CARD_H)}px`,
      padding: '6px 8px',
      display: 'flex',
      flexDirection: 'column',
      gap: '3px',
      textAlign: 'left',
      font: 'inherit',
      color: 'inherit',
      border: '1px solid',
      borderRadius: '4px',
    } satisfies Partial<CSSStyleDeclaration>);
    root.title = `${t.label}: ${costText(t)}. ${unlocksText(t)}.`;
    const name = document.createElement('div');
    name.textContent = t.label;
    Object.assign(name.style, { fontWeight: '600' });

    const cost = document.createElement('div');
    cost.className = 'cost';
    Object.assign(cost.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '2px',
      fontSize: '12px',
      color: '#cfc8b4',
    } satisfies Partial<CSSStyleDeclaration>);
    for (const p of t.packs) cost.appendChild(smallIcon(p, 16));
    const units = document.createElement('span');
    units.textContent = ` × ${String(t.units)} · ${seconds(t.ticksPerUnit)}`;
    cost.appendChild(units);

    const unlocks = document.createElement('div');
    unlocks.className = 'unlocks';
    Object.assign(unlocks.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '2px',
      minHeight: '20px',
      fontSize: '11px',
      color: '#b9b29e',
    } satisfies Partial<CSSStyleDeclaration>);
    if (t.unlocks.length === 0) {
      unlocks.textContent = unlocksText(t);
    } else {
      for (const r of t.unlocks) {
        const out = recipePrototype(r)?.outputs[0];
        if (!out) continue;
        const icon = smallIcon(out[0], 20);
        icon.dataset.item = itemPrototype(out[0])?.name ?? '';
        unlocks.appendChild(icon);
      }
    }

    const status = document.createElement('div');
    status.className = 'state';
    Object.assign(status.style, { fontSize: '11px', color: '#b9b29e', marginTop: 'auto' });
    const bar = makeBar('#f2d36b');
    root.append(name, cost, unlocks, status, bar.element);
    root.addEventListener('mousedown', (e) => {
      // Keep keyboard focus on the game, so WASD and T keep working.
      e.preventDefault();
    });
    root.addEventListener('click', () => {
      const state = techState(this.research, t.id);
      if (state === 'available') this.send(t.id);
      else if (state === 'current') this.send(0);
    });
    return { root, status, bar };
  }

  /** SVG lines from each technology's prerequisites to it. */
  private buildLinks(
    layout: Map<number, { col: number; row: number }>,
    width: number,
    height: number,
  ): SVGSVGElement {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    Object.assign(svg.style, { position: 'absolute', left: '0', top: '0' });
    for (const id of TECH_IDS) {
      const to = layout.get(id)!;
      for (const p of technologyPrototype(id)!.prerequisites) {
        const from = layout.get(p)!;
        const x1 = from.col * (CARD_W + COL_GAP) + CARD_W;
        const y1 = from.row * (CARD_H + ROW_GAP) + CARD_H / 2;
        const x2 = to.col * (CARD_W + COL_GAP);
        const y2 = to.row * (CARD_H + ROW_GAP) + CARD_H / 2;
        const mid = (x1 + x2) / 2;
        const path = document.createElementNS(ns, 'path');
        path.setAttribute(
          'd',
          `M${String(x1)} ${String(y1)} C${String(mid)} ${String(y1)} ${String(mid)} ${String(y2)} ${String(x2)} ${String(y2)}`,
        );
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'rgba(232, 226, 208, 0.3)');
        path.setAttribute('stroke-width', '2');
        svg.appendChild(path);
      }
    }
    return svg;
  }

  private send(tech: number): void {
    this.options.send([{ playerId: this.options.playerId, type: 'SetResearch', tech }]);
  }
}

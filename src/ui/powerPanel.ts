/**
 * The electric network panel (plain DOM): opened by left-clicking an
 * electric pole with nothing to build in hand. It shows the pole's network
 * as of the latest snapshot:
 * - its satisfaction, production (delivered out of what the generators
 *   could deliver) and consumption (drawn out of what the consumers asked
 *   for), as watts;
 * - a graph of the last 60 s of demand, production and capacity, from a
 *   {@link PowerHistory} the main thread samples from snapshots (not state);
 * - its producers and consumers by entity type, with their count and totals.
 *
 * The data comes from the `networkDetail` of each snapshot, which the worker
 * sends while the pole is the inspected entity (the panel shares the
 * `inspect` channel with the entity panel, so only one of them is open). The
 * panel only reads, so unlike the entity panel it doesn't need the pole to
 * be in reach. It closes with `Escape` or its close button, and on its own
 * once the pole is gone.
 */

import { SAT_ONE, entityPrototype } from '../data/entities';
import type { NetworkDetailData, NetworkGroupData } from '../sim/snapshot';
import { formatPower } from './entityPanel';
import { HISTORY_SECONDS, type PowerHistory, type PowerSample } from './powerHistory';

/** Satisfaction (1/`SAT_ONE`) as a whole percentage, rounded down like the entity panel. */
export const satisfactionPercent = (satisfaction: number): number =>
  Math.floor((Math.min(satisfaction, SAT_ONE) * 100) / SAT_ONE);

/** One producer or consumer line of the panel. */
export interface GroupView {
  /** Prototype name (for tests and styling) and label. */
  name: string;
  label: string;
  count: number;
  color: number;
  /** `900 kW / 1.8 MW`: delivered of maximum (producers), drawn of wanted (consumers). */
  text: string;
}

/** What the panel shows about a network, as text. */
export interface NetworkView {
  satisfaction: number;
  satisfactionText: string;
  production: string;
  consumption: string;
  producers: GroupView[];
  consumers: GroupView[];
}

function groupView(g: NetworkGroupData): GroupView {
  const proto = entityPrototype(g.type);
  const of = g.producer ? g.maxOutput : g.demand;
  return {
    name: proto?.name ?? `entity#${String(g.type)}`,
    label: proto?.label ?? `Entity ${String(g.type)}`,
    count: g.count,
    color: proto?.color ?? 0x808080,
    text: `${formatPower(g.power)} / ${formatPower(of)}`,
  };
}

/** The panel's text for network detail `d`. */
export function networkView(d: NetworkDetailData): NetworkView {
  const consumed = d.groups.filter((g) => !g.producer).reduce((n, g) => n + g.power, 0);
  const satisfaction = satisfactionPercent(d.satisfaction);
  return {
    satisfaction,
    satisfactionText:
      d.demand === 0 ? 'No demand' : d.supply === 0 ? 'No power' : `${String(satisfaction)}%`,
    production: `${formatPower(d.load)} / ${formatPower(d.supply)}`,
    consumption: `${formatPower(consumed)} / ${formatPower(d.demand)}`,
    producers: d.groups.filter((g) => g.producer).map(groupView),
    consumers: d.groups.filter((g) => !g.producer).map(groupView),
  };
}

/**
 * The graph's vertical scale, in joules per tick, for a largest value of
 * `max` J/tick: the smallest power of `1`, `2` or `5 × 10^k` W that holds
 * it and at least 1 J/tick (60 W), so the label reads `2 MW`, `500 kW`.
 */
export function graphScale(max: number): number {
  const watts = Math.max(max, 1) * TICKS_PER_SECOND;
  for (let step = 1; ; step *= 10) {
    for (const m of [1, 2, 5]) {
      if (m * step >= watts) return (m * step) / TICKS_PER_SECOND;
    }
  }
}

/** A graph series as points in a `width` × `height` box (y down). */
export type Polyline = { x: number; y: number }[];

/**
 * The graph's three series over the `HISTORY_SECONDS` up to second `now`
 * (the newest sample at the right edge), scaled to `scale`: capacity
 * (supply), demand and production (load). A gap of missing seconds starts a
 * new polyline.
 */
export function graphSeries(
  samples: readonly PowerSample[],
  now: number,
  scale: number,
  width: number,
  height: number,
): { supply: Polyline[]; demand: Polyline[]; load: Polyline[] } {
  const out = { supply: [] as Polyline[], demand: [] as Polyline[], load: [] as Polyline[] };
  const xOf = (second: number): number =>
    width - ((now - 1 - second) * width) / (HISTORY_SECONDS - 1);
  const yOf = (v: number): number => height - (Math.min(v, scale) * height) / scale;
  let prev = Number.NaN;
  for (const s of samples) {
    if (s.second > now - 1 || s.second < now - HISTORY_SECONDS) continue;
    if (s.second !== prev + 1) {
      out.supply.push([]);
      out.demand.push([]);
      out.load.push([]);
    }
    prev = s.second;
    const x = xOf(s.second);
    out.supply.at(-1)!.push({ x, y: yOf(s.supply) });
    out.demand.at(-1)!.push({ x, y: yOf(s.demand) });
    out.load.at(-1)!.push({ x, y: yOf(s.load) });
  }
  return out;
}

/** A power of `j` joules per tick is `60 × j` watts. */
const TICKS_PER_SECOND = 60;
const GRAPH_W = 280;
const GRAPH_H = 90;
const COLORS = { supply: '#8d8a80', demand: '#ff9a2e', load: '#7ec8ff' } as const;
const hex = (c: number): string => `#${c.toString(16).padStart(6, '0')}`;

export class PowerPanel {
  readonly element: HTMLElement;
  /** The pole shown, or 0 while closed. */
  private poleId = 0;
  private network = 0;
  private readonly satisfactionText: HTMLElement;
  private readonly satisfactionFill: HTMLElement;
  private readonly production: HTMLElement;
  private readonly consumption: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly scaleLabel: HTMLElement;
  private readonly producers: HTMLElement;
  private readonly consumers: HTMLElement;
  /** Key of the lists last drawn, so they are rebuilt only when they change. */
  private listsKey = '';

  constructor(
    parent: HTMLElement,
    private readonly history: PowerHistory,
    /** The panel opened for pole `pole`, or closed (0): forward it to the worker (`inspect`). */
    private readonly inspect: (pole: number) => void,
  ) {
    const el = document.createElement('div');
    el.id = 'power-panel';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Electric network');
    el.hidden = true;
    Object.assign(el.style, {
      position: 'fixed',
      top: '64px',
      right: '8px',
      width: `${String(GRAPH_W)}px`,
      padding: '8px',
      color: '#e8e2d0',
      font: '13px/1.4 system-ui, sans-serif',
      background: 'rgba(20, 22, 26, 0.92)',
      border: '1px solid rgba(232, 226, 208, 0.2)',
      borderRadius: '6px',
      zIndex: '20',
    } satisfies Partial<CSSStyleDeclaration>);

    const header = document.createElement('div');
    Object.assign(header.style, { display: 'flex', alignItems: 'baseline', marginBottom: '6px' });
    const title = document.createElement('div');
    title.textContent = 'Electric network';
    Object.assign(title.style, { fontWeight: '600', flex: '1' });
    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Close (Esc)';
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
    header.append(title, close);

    const line = (role: string, label: string): HTMLElement => {
      const row = document.createElement('div');
      Object.assign(row.style, { display: 'flex', fontSize: '12px' });
      const name = document.createElement('span');
      name.textContent = label;
      Object.assign(name.style, { flex: '1', color: '#b9b29e' });
      const value = document.createElement('span');
      value.dataset.role = role;
      row.append(name, value);
      el.appendChild(row);
      return value;
    };

    el.append(header);
    this.satisfactionText = line('satisfaction', 'Satisfaction');
    const bar = document.createElement('div');
    Object.assign(bar.style, {
      height: '6px',
      margin: '2px 0 4px',
      background: 'rgba(0, 0, 0, 0.55)',
      borderRadius: '3px',
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);
    this.satisfactionFill = document.createElement('div');
    Object.assign(this.satisfactionFill.style, { height: '100%', width: '0' });
    bar.appendChild(this.satisfactionFill);
    el.appendChild(bar);
    this.production = line('production', 'Production');
    this.consumption = line('consumption', 'Consumption');

    const graph = document.createElement('div');
    Object.assign(graph.style, { position: 'relative', margin: '6px 0 2px' });
    this.canvas = document.createElement('canvas');
    this.canvas.dataset.role = 'graph';
    const dpr = Math.max(1, Math.round(window.devicePixelRatio || 1));
    this.canvas.width = GRAPH_W * dpr;
    this.canvas.height = GRAPH_H * dpr;
    Object.assign(this.canvas.style, {
      display: 'block',
      width: `${String(GRAPH_W)}px`,
      height: `${String(GRAPH_H)}px`,
      background: 'rgba(0, 0, 0, 0.45)',
      borderRadius: '3px',
    } satisfies Partial<CSSStyleDeclaration>);
    this.scaleLabel = document.createElement('div');
    this.scaleLabel.dataset.role = 'scale';
    Object.assign(this.scaleLabel.style, {
      position: 'absolute',
      top: '2px',
      left: '4px',
      fontSize: '10px',
      color: '#b9b29e',
    } satisfies Partial<CSSStyleDeclaration>);
    graph.append(this.canvas, this.scaleLabel);
    const legend = document.createElement('div');
    Object.assign(legend.style, {
      display: 'flex',
      gap: '8px',
      fontSize: '10px',
      color: '#b9b29e',
      marginBottom: '6px',
    } satisfies Partial<CSSStyleDeclaration>);
    const key = (color: string, text: string): HTMLElement => {
      const span = document.createElement('span');
      const swatch = document.createElement('span');
      Object.assign(swatch.style, {
        display: 'inline-block',
        width: '8px',
        height: '3px',
        margin: '0 3px 2px 0',
        background: color,
      } satisfies Partial<CSSStyleDeclaration>);
      span.append(swatch, text);
      return span;
    };
    const span = document.createElement('span');
    span.textContent = `last ${String(HISTORY_SECONDS)} s`;
    Object.assign(span.style, { flex: '1', textAlign: 'right' });
    legend.append(
      key(COLORS.demand, 'Demand'),
      key(COLORS.load, 'Production'),
      key(COLORS.supply, 'Capacity'),
      span,
    );
    el.append(graph, legend);

    const section = (label: string, role: string): HTMLElement => {
      const head = document.createElement('div');
      head.textContent = label;
      Object.assign(head.style, { fontWeight: '600', fontSize: '12px', marginTop: '4px' });
      const list = document.createElement('div');
      list.dataset.role = role;
      el.append(head, list);
      return list;
    };
    this.producers = section('Producers', 'producers');
    this.consumers = section('Consumers', 'consumers');

    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
    parent.appendChild(el);
    this.element = el;
  }

  /** The pole shown, or 0 while closed. */
  get pole(): number {
    return this.poleId;
  }

  get isOpen(): boolean {
    return this.poleId !== 0;
  }

  /** Opens the panel for pole `id`. */
  open(id: number): void {
    if (id === this.poleId) return;
    this.poleId = id;
    this.network = 0;
    this.listsKey = '';
    this.element.hidden = false;
    this.element.dataset.pole = String(id);
    delete this.element.dataset.network;
    this.inspect(id);
  }

  close(): void {
    if (this.poleId === 0) return;
    this.poleId = 0;
    this.element.hidden = true;
    delete this.element.dataset.pole;
    this.inspect(0);
  }

  /**
   * Shows the latest snapshot: `inspected` and `detail` as sent by the worker
   * (closing the panel once its pole is gone).
   */
  update(inspected: number, detail: NetworkDetailData | null): void {
    // Snapshots sent before the worker got our `inspect` are about something else.
    if (this.poleId === 0 || inspected !== this.poleId) return;
    if (detail?.pole !== this.poleId) {
      this.close();
      return;
    }
    const view = networkView(detail);
    this.network = detail.network;
    const el = this.element;
    el.dataset.network = String(detail.network);
    el.dataset.satisfaction = String(view.satisfaction);
    this.satisfactionText.textContent = view.satisfactionText;
    this.satisfactionFill.style.width = `${String(detail.supply === 0 ? 0 : view.satisfaction)}%`;
    this.satisfactionFill.style.background =
      view.satisfaction >= 100 ? '#7fc97f' : view.satisfaction >= 50 ? '#f2d36b' : '#e06c5a';
    this.production.textContent = view.production;
    this.consumption.textContent = view.consumption;
    const key = JSON.stringify([view.producers, view.consumers]);
    if (key !== this.listsKey) {
      this.listsKey = key;
      fillList(this.producers, view.producers);
      fillList(this.consumers, view.consumers);
    }
    this.drawGraph();
  }

  private drawGraph(): void {
    const samples = this.history.samples(this.network);
    const now = this.history.second;
    this.canvas.dataset.samples = String(samples.length);
    const max = samples.reduce((m, s) => Math.max(m, s.demand, s.supply), 0);
    const scale = graphScale(max);
    this.scaleLabel.textContent = formatPower(scale);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const dpr = this.canvas.width / GRAPH_W;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, GRAPH_W, GRAPH_H);
    ctx.strokeStyle = 'rgba(232, 226, 208, 0.12)';
    ctx.lineWidth = 1;
    for (const f of [0.25, 0.5, 0.75]) {
      ctx.beginPath();
      ctx.moveTo(0, Math.round(GRAPH_H * f) + 0.5);
      ctx.lineTo(GRAPH_W, Math.round(GRAPH_H * f) + 0.5);
      ctx.stroke();
    }
    const series = graphSeries(samples, now, scale, GRAPH_W, GRAPH_H);
    // Production as a filled area, then the capacity and demand lines.
    ctx.fillStyle = 'rgba(126, 200, 255, 0.35)';
    for (const line of series.load) {
      if (line.length === 0) continue;
      ctx.beginPath();
      ctx.moveTo(line[0]!.x, GRAPH_H);
      for (const p of line) ctx.lineTo(p.x, p.y);
      ctx.lineTo(line.at(-1)!.x, GRAPH_H);
      ctx.closePath();
      ctx.fill();
    }
    const stroke = (lines: readonly Polyline[], color: string, width: number): void => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      for (const line of lines) {
        ctx.beginPath();
        line.forEach((p, i) => {
          if (i === 0) ctx.moveTo(p.x, p.y);
          else ctx.lineTo(p.x, p.y);
        });
        if (line.length === 1) ctx.lineTo(line[0]!.x - 1, line[0]!.y);
        ctx.stroke();
      }
    };
    stroke(series.supply, COLORS.supply, 1.5);
    stroke(series.load, COLORS.load, 1.5);
    stroke(series.demand, COLORS.demand, 1.5);
  }
}

/** Replaces the rows of `list` with `groups` (or a "None" line). */
function fillList(list: HTMLElement, groups: readonly GroupView[]): void {
  list.replaceChildren();
  if (groups.length === 0) {
    const none = document.createElement('div');
    none.textContent = 'None';
    Object.assign(none.style, { fontSize: '12px', color: '#8d8a80' });
    list.appendChild(none);
    return;
  }
  for (const g of groups) {
    const row = document.createElement('div');
    row.className = 'group';
    row.dataset.type = g.name;
    row.dataset.count = String(g.count);
    Object.assign(row.style, {
      display: 'flex',
      alignItems: 'center',
      gap: '6px',
      fontSize: '12px',
    } satisfies Partial<CSSStyleDeclaration>);
    const swatch = document.createElement('span');
    Object.assign(swatch.style, {
      width: '10px',
      height: '10px',
      borderRadius: '2px',
      background: hex(g.color),
      flex: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    const name = document.createElement('span');
    name.textContent = `${g.label} ×${String(g.count)}`;
    Object.assign(name.style, { flex: '1' });
    const value = document.createElement('span');
    value.dataset.role = 'power';
    value.textContent = g.text;
    Object.assign(value.style, { color: '#b9b29e' });
    row.append(swatch, name, value);
    list.appendChild(row);
  }
}

/**
 * A small DOM overlay with simulation stats: tick count, updates per second
 * (measured on the main thread from `stats` messages), and mean tick time,
 * what each system stepped in the latest tick out of its entities (#73),
 * plus a readout of the tile under the mouse. Hidden unless the player
 * turns it on (F3 or the settings; test builds always show it, D61); it
 * keeps updating while hidden, so it is current the moment it shows.
 */

import { RESOURCES, type OreId } from '../data/resources';
import { TILES } from '../data/tiles';
import { ACTIVITY_SYSTEMS, type Activity, type ActivitySystem } from '../sim/activity';

export interface DebugStats {
  tick: number;
  ups: number;
  tickMs: number;
  /** Per system: entities, awake and stepped in the latest tick (see src/sim/activity.ts). */
  activity?: Activity;
}

/** Short names of the systems on the overlay's activity line. */
const ACTIVITY_LABELS: Record<ActivitySystem, string> = {
  power: 'power',
  drills: 'drill',
  belts: 'lane',
  inserters: 'ins',
  furnaces: 'furn',
  assemblers: 'asm',
  labs: 'lab',
};

/**
 * Formats the activity line: per system, what it stepped in the latest tick
 * out of how many it has (`ins 12/876`: 12 of 876 inserters; belts count
 * lanes, the power system the electric entities it asked), leaving out
 * systems with no entities: `stepped power 1/5 · ins 0/1`.
 */
export function formatActivity(activity: Activity): string {
  const parts: string[] = [];
  for (const system of ACTIVITY_SYSTEMS) {
    const { entities, stepped } = activity[system];
    if (entities === 0) continue;
    parts.push(`${ACTIVITY_LABELS[system]} ${groupDigits(stepped)}/${groupDigits(entities)}`);
  }
  return parts.length === 0 ? 'stepped -' : `stepped ${parts.join(' · ')}`;
}

/** The tile under the mouse, as shown in the overlay. */
export interface TileReadout {
  x: number;
  y: number;
  /** `null` while the tile's chunk hasn't been received from the worker yet. */
  info: { terrain: number; resource: number; amount: number; tree?: number } | null;
}

/** Groups the digits of a non-negative integer by thousands with spaces: `1594` → `1 594`. */
export function groupDigits(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+$)/g, ' ');
}

/**
 * Formats a tile readout line: the terrain, then what is on it, each after a
 * `·`: a tree (`tile (60, 4) grass · tree`) and the resource with how much is
 * left (`tile (12, -3) grass · iron ore 1 250`). A bare tile only shows its
 * terrain (`tile (0, 0) water`).
 */
export function formatTile(tile: TileReadout | null): string {
  if (!tile) {
    return 'tile -';
  }
  const where = `tile (${String(tile.x)}, ${String(tile.y)})`;
  if (!tile.info) {
    return `${where} loading`;
  }
  const { terrain, resource, amount, tree = 0 } = tile.info;
  const parts = [`${where} ${TILES[terrain]?.name ?? `tile#${String(terrain)}`}`];
  if (tree !== 0) {
    parts.push('tree');
  }
  if (resource !== 0) {
    const name = (RESOURCES[resource as OreId] as { name: string } | undefined)?.name;
    const ore = name?.replaceAll('-', ' ') ?? `resource#${String(resource)}`;
    parts.push(`${ore} ${groupDigits(amount)}`);
  }
  return parts.join(' · ');
}

export class DebugOverlay {
  readonly element: HTMLElement;
  private readonly statsLine: HTMLElement;
  private readonly activityLine: HTMLElement;
  private readonly tileLine: HTMLElement;

  constructor(parent: HTMLElement) {
    const el = document.createElement('div');
    el.id = 'debug-overlay';
    el.setAttribute('role', 'status');
    Object.assign(el.style, {
      position: 'fixed',
      top: '8px',
      left: '8px',
      padding: '4px 8px',
      font: '12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace',
      color: '#e8e2d0',
      background: 'rgba(0, 0, 0, 0.6)',
      borderRadius: '4px',
      pointerEvents: 'none',
      whiteSpace: 'pre',
      zIndex: '10',
    } satisfies Partial<CSSStyleDeclaration>);
    this.statsLine = document.createElement('div');
    this.statsLine.textContent = 'tick - | UPS - | tick - ms';
    this.activityLine = document.createElement('div');
    this.activityLine.className = 'activity';
    this.activityLine.hidden = true;
    this.tileLine = document.createElement('div');
    this.tileLine.className = 'tile-readout';
    this.tileLine.textContent = formatTile(null);
    el.append(this.statsLine, this.activityLine, this.tileLine);
    parent.appendChild(el);
    this.element = el;
  }

  get visible(): boolean {
    return !this.element.hidden;
  }

  set visible(on: boolean) {
    this.element.hidden = !on;
  }

  update(stats: DebugStats): void {
    this.element.dataset.tick = String(stats.tick);
    this.element.dataset.ups = stats.ups.toFixed(1);
    this.statsLine.textContent =
      `tick ${String(stats.tick)} | UPS ${stats.ups.toFixed(1)} | ` +
      `tick ${stats.tickMs.toFixed(3)} ms`;
    if (stats.activity) {
      this.activityLine.hidden = false;
      this.activityLine.textContent = formatActivity(stats.activity);
    }
  }

  /** Shows the tile under the mouse; cheap to call every frame. */
  updateTile(tile: TileReadout | null): void {
    const text = formatTile(tile);
    if (this.tileLine.textContent !== text) {
      this.tileLine.textContent = text;
    }
  }
}

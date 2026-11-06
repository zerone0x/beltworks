/**
 * A small DOM overlay with simulation stats: tick count, updates per second
 * (measured on the main thread from `stats` messages), and mean tick time,
 * plus a readout of the tile under the mouse.
 */

import { RESOURCES, type OreId } from '../data/resources';
import { TILES } from '../data/tiles';

export interface DebugStats {
  tick: number;
  ups: number;
  tickMs: number;
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
    this.tileLine = document.createElement('div');
    this.tileLine.className = 'tile-readout';
    this.tileLine.textContent = formatTile(null);
    el.append(this.statsLine, this.tileLine);
    parent.appendChild(el);
    this.element = el;
  }

  update(stats: DebugStats): void {
    this.element.dataset.tick = String(stats.tick);
    this.element.dataset.ups = stats.ups.toFixed(1);
    this.statsLine.textContent =
      `tick ${String(stats.tick)} | UPS ${stats.ups.toFixed(1)} | ` +
      `tick ${stats.tickMs.toFixed(3)} ms`;
  }

  /** Shows the tile under the mouse; cheap to call every frame. */
  updateTile(tile: TileReadout | null): void {
    const text = formatTile(tile);
    if (this.tileLine.textContent !== text) {
      this.tileLine.textContent = text;
    }
  }
}

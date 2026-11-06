/**
 * A small DOM overlay with simulation stats: tick count, updates per second
 * (measured on the main thread from `stats` messages), and mean tick time.
 */

export interface DebugStats {
  tick: number;
  ups: number;
  tickMs: number;
}

export class DebugOverlay {
  readonly element: HTMLElement;

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
    el.textContent = 'tick - | UPS - | tick - ms';
    parent.appendChild(el);
    this.element = el;
  }

  update(stats: DebugStats): void {
    this.element.dataset.tick = String(stats.tick);
    this.element.dataset.ups = stats.ups.toFixed(1);
    this.element.textContent =
      `tick ${String(stats.tick)} | UPS ${stats.ups.toFixed(1)} | ` +
      `tick ${stats.tickMs.toFixed(3)} ms`;
  }
}

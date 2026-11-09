/**
 * What the game checks before it starts, and the full-screen messages for
 * when it can't run (plain DOM, D39; D61):
 *
 * - `missingFeatures`: what this browser lacks of what the game needs. Hard
 *   requirements stop the start with a message: module workers (the
 *   simulation runs in one), WebGL (the PixiJS renderer the game asks for),
 *   `CompressionStream` and
 *   `DecompressionStream` (saves and blueprint strings are gzipped),
 *   `crypto.getRandomValues` (random seeds). IndexedDB is optional: without
 *   it the game runs and the menu says saves are off.
 * - `showFatal`: a message over the page with buttons (unsupported browser,
 *   a failed start, a crashed simulation).
 */

import { VERSION_LABEL } from '../version';
import { OVERLAY_STYLE, PANEL_STYLE, button } from './gameMenu';

/** One thing the game needs: what to tell the player when it's missing. */
export interface Missing {
  /** Short name for the list ("Web Workers"). */
  feature: string;
  /** Whether the game can't run without it (else it runs with less). */
  required: boolean;
}

/** The parts of the browser `missingFeatures` looks at (globalThis in the game, fakes in tests). */
export interface FeatureProbe {
  Worker?: unknown;
  CompressionStream?: unknown;
  DecompressionStream?: unknown;
  indexedDB?: unknown;
  crypto?: { getRandomValues?: unknown } | undefined;
  /** Whether a canvas gives a WebGL (1 or 2) context. */
  webgl: () => boolean;
  /** Whether workers can be ES modules (`new Worker(url, { type: 'module' })`). */
  moduleWorkers: () => boolean;
}

/** What this browser lacks of what the game needs, required things first. */
export function missingFeatures(probe: FeatureProbe): Missing[] {
  const out: Missing[] = [];
  const need = (ok: boolean, feature: string, required = true): void => {
    if (!ok) out.push({ feature, required });
  };
  const fn = (v: unknown): boolean => typeof v === 'function';
  need(fn(probe.Worker) && probe.moduleWorkers(), 'Web Workers (ES modules)');
  need(probe.webgl(), 'WebGL');
  need(fn(probe.CompressionStream) && fn(probe.DecompressionStream), 'Compression Streams (gzip)');
  need(fn(probe.crypto?.getRandomValues), 'Web Crypto');
  need(typeof probe.indexedDB === 'object' && probe.indexedDB !== null, 'IndexedDB', false);
  return out.sort((a, b) => Number(b.required) - Number(a.required));
}

/**
 * Whether `new Worker(url, { type: 'module' })` is understood: a browser
 * that reads the option's `type` supports module workers. The worker is
 * never started: the URL can't be parsed, so the constructor throws after
 * reading the options and nothing is fetched.
 */
function supportsModuleWorkers(): boolean {
  let read = false;
  const options = {
    get type(): 'module' {
      read = true;
      return 'module';
    },
  };
  try {
    new Worker('http://[', options).terminate();
  } catch {
    // Invalid URL: thrown after the options were read.
  }
  return read;
}

function supportsWebGl(): boolean {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    // Give the context back at once: browsers keep only a few alive.
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return gl !== null;
  } catch {
    return false;
  }
}

/** The browser's globals as a `FeatureProbe`. */
export function browserProbe(): FeatureProbe {
  const g = globalThis as unknown as Record<string, unknown>;
  return {
    Worker: g.Worker,
    CompressionStream: g.CompressionStream,
    DecompressionStream: g.DecompressionStream,
    indexedDB: g.indexedDB,
    crypto: g.crypto as FeatureProbe['crypto'],
    webgl: supportsWebGl,
    moduleWorkers: supportsModuleWorkers,
  };
}

/** A button on a fatal message: its label, element id and what it does. */
export interface FatalAction {
  label: string;
  id: string;
  run: () => void;
}

/**
 * Shows a message over the whole page (`id` on the overlay), with `details`
 * as a list and `actions` as buttons; replaces any earlier one. Returns the
 * overlay.
 */
export function showFatal(
  id: string,
  title: string,
  text: string,
  { details = [], actions = [] }: { details?: string[]; actions?: FatalAction[] } = {},
): HTMLElement {
  document.getElementById(id)?.remove();
  const overlay = document.createElement('div');
  overlay.id = id;
  overlay.className = 'fatal';
  Object.assign(overlay.style, OVERLAY_STYLE, { zIndex: '100', background: 'rgba(0, 0, 0, 0.7)' });
  const panel = document.createElement('div');
  panel.setAttribute('role', 'alertdialog');
  panel.setAttribute('aria-label', title);
  Object.assign(panel.style, PANEL_STYLE, { maxWidth: '520px' });
  const heading = document.createElement('div');
  heading.textContent = title;
  Object.assign(heading.style, { fontWeight: '600', fontSize: '16px', color: '#f2d36b' });
  const body = document.createElement('p');
  body.textContent = text;
  body.style.margin = '8px 0';
  panel.append(heading, body);
  if (details.length > 0) {
    const list = document.createElement('ul');
    list.className = 'fatal-details';
    Object.assign(list.style, { margin: '4px 0 8px', paddingLeft: '20px' });
    for (const d of details) {
      const li = document.createElement('li');
      li.textContent = d;
      list.append(li);
    }
    panel.append(list);
  }
  if (actions.length > 0) {
    const row = document.createElement('div');
    row.style.marginTop = '10px';
    for (const a of actions) {
      const b = button(a.label, a.id);
      b.addEventListener('click', a.run);
      row.append(b);
    }
    panel.append(row);
  }
  const version = document.createElement('div');
  version.textContent = `Beltworks ${VERSION_LABEL}`;
  Object.assign(version.style, { marginTop: '10px', fontSize: '11px', opacity: '0.5' });
  panel.append(version);
  overlay.append(panel);
  // Keys stay here: the game behind is stopped or never started.
  for (const type of ['keydown', 'keyup'] as const) {
    overlay.addEventListener(type, (e) => {
      e.stopPropagation();
    });
  }
  document.body.append(overlay);
  overlay.querySelector('button')?.focus();
  return overlay;
}

/** The message for a browser that lacks something the game needs (`missing`, required first). */
export function showUnsupported(missing: readonly Missing[]): void {
  showFatal(
    'unsupported-browser',
    "This browser can't run Beltworks",
    'Beltworks needs a recent desktop version of Chrome, Edge, Firefox or Safari (16.4 or ' +
      'later), with hardware acceleration (WebGL) turned on. This browser is missing:',
    { details: missing.filter((m) => m.required).map((m) => m.feature) },
  );
}

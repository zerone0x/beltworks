/**
 * Player settings (D50): key bindings, graphics, UI scale, audio volumes
 * and the debug overlay (D61),
 * kept in `localStorage` (per browser, not per save) and applied by main.ts
 * whenever they change. The lettered-icons option keeps its own key
 * (src/render/itemIcons.ts) and is only shown in the settings panel.
 *
 * Settings never reach the simulation: they change how the game is drawn,
 * heard and controlled, not what happens in it.
 */

import { DEFAULT_BINDINGS, parseBindings, setBindings, type Bindings } from './keybindings';

/** UI scales offered in the settings panel (1 is the default size). */
export const UI_SCALES = [0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

export interface GraphicsSettings {
  /** The terrain's rendered look (Blender textures, D41) or the flat placeholder colors. */
  terrain: 'rendered' | 'flat';
  /** Terrain texture density: `low` bakes at a quarter of the texels (and never the detail textures). */
  terrainDetail: 'high' | 'low';
  /** Shadows of buildings, poles, wires, underground hoods and trees. */
  shadows: boolean;
  /** Decorative animation (belt surfaces, flywheels, machines working). Items and arms always move. */
  animation: boolean;
}

/** Volumes in percent (0–100), applied by the audio engine (D55). */
export interface AudioSettings {
  master: number;
  sfx: number;
  music: number;
}

export interface Settings {
  keys: Bindings;
  graphics: GraphicsSettings;
  /** Scale of the DOM interface (panels, hotbar, menus): one of `UI_SCALES`. */
  uiScale: number;
  audio: AudioSettings;
  /** Whether the debug overlay (ticks, UPS, the tile under the cursor) shows (D61). */
  debugInfo: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  keys: DEFAULT_BINDINGS,
  graphics: { terrain: 'rendered', terrainDetail: 'high', shadows: true, animation: true },
  uiScale: 1,
  audio: { master: 80, sfx: 100, music: 60 },
  debugInfo: false,
};

/** The `localStorage` key of the settings (JSON). */
export const SETTINGS_KEY = 'beltworks.settings';

const record = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};

function oneOf<T>(v: unknown, options: readonly T[], fallback: T): T {
  return options.includes(v as T) ? (v as T) : fallback;
}

function flag(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function volume(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(100, Math.max(0, Math.round(v)))
    : fallback;
}

/**
 * Settings from stored data (anything, e.g. parsed JSON): every missing or
 * invalid field takes its default, so old or damaged settings still load.
 */
export function parseSettings(raw: unknown): Settings {
  const r = record(raw);
  const g = record(r.graphics);
  const a = record(r.audio);
  const d = DEFAULT_SETTINGS;
  return {
    keys: parseBindings(r.keys),
    graphics: {
      terrain: oneOf(g.terrain, ['rendered', 'flat'] as const, d.graphics.terrain),
      terrainDetail: oneOf(g.terrainDetail, ['high', 'low'] as const, d.graphics.terrainDetail),
      shadows: flag(g.shadows, d.graphics.shadows),
      animation: flag(g.animation, d.graphics.animation),
    },
    uiScale: oneOf(r.uiScale, UI_SCALES as readonly number[], d.uiScale),
    audio: {
      master: volume(a.master, d.audio.master),
      sfx: volume(a.sfx, d.audio.sfx),
      music: volume(a.music, d.audio.music),
    },
    debugInfo: flag(r.debugInfo, d.debugInfo),
  };
}

/** The storage settings live in: `localStorage`, or `null` where there is none (tests in Node, some private modes). */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/**
 * The settings in use, loaded from `localStorage` on creation; `update`
 * stores every change and tells the listeners. The key bindings are
 * applied to the input handlers (src/ui/keybindings.ts) as they change.
 */
export class SettingsStore {
  private current: Settings;
  private readonly listeners = new Set<(settings: Settings, previous: Settings) => void>();

  constructor() {
    let raw: unknown;
    try {
      raw = JSON.parse(storage()?.getItem(SETTINGS_KEY) ?? 'null');
    } catch {
      raw = null;
    }
    this.current = parseSettings(raw);
    setBindings(this.current.keys);
  }

  get value(): Settings {
    return this.current;
  }

  /** Applies `change` to a copy of the settings, stores it and tells the listeners. */
  update(change: (settings: Settings) => Settings): void {
    const previous = this.current;
    this.current = parseSettings(change(structuredClone(previous)));
    setBindings(this.current.keys);
    try {
      storage()?.setItem(SETTINGS_KEY, JSON.stringify(this.current));
    } catch {
      // Full or blocked storage: the settings still apply for this session.
    }
    for (const listener of this.listeners) listener(this.current, previous);
  }

  /** Calls `listener` after every change; returns a function that stops it. */
  subscribe(listener: (settings: Settings, previous: Settings) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

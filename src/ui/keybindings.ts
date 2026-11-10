/**
 * Key bindings (D50): every keyboard action of the game has one key, named
 * by its `KeyboardEvent.code` (so a binding stays in the same place on every
 * layout), rebindable in the settings panel. `Escape` (windows and the game
 * menu) and the mouse buttons are fixed; so are the numpad's `+` and `-`,
 * which zoom like the zoom actions' keys unless an action is bound to them
 * (`zoomStepFor` in src/render/cameraInput.ts).
 *
 * The bindings in use are module state, like the lettered-icons option
 * (src/render/itemIcons.ts): the input handlers ask `actionFor(code)` on
 * every key press, so a rebinding applies at once. The settings store
 * (src/ui/settings.ts) loads and persists them.
 *
 * No two actions ever share a key: `rebind` swaps keys with the action that
 * had the new one, and `parseBindings` falls back to the defaults for any
 * conflict in stored bindings.
 */

/** One rebindable action. */
export interface ActionInfo {
  readonly id: string;
  /** What it does, for the settings panel. */
  readonly label: string;
  /** The default key (`KeyboardEvent.code`). */
  readonly key: string;
}

/** Every rebindable action, in the order the settings panel lists them. */
export const ACTIONS = [
  { id: 'moveUp', label: 'Walk up', key: 'KeyW' },
  { id: 'moveLeft', label: 'Walk left', key: 'KeyA' },
  { id: 'moveDown', label: 'Walk down', key: 'KeyS' },
  { id: 'moveRight', label: 'Walk right', key: 'KeyD' },
  { id: 'inventory', label: 'Inventory and crafting', key: 'KeyE' },
  { id: 'techTree', label: 'Tech tree', key: 'KeyT' },
  { id: 'rotate', label: 'Rotate', key: 'KeyR' },
  { id: 'pipette', label: 'Pipette / put away the cursor', key: 'KeyQ' },
  { id: 'follow', label: 'Camera follows the player', key: 'KeyF' },
  { id: 'help', label: 'Controls help', key: 'KeyH' },
  { id: 'minimap', label: 'Minimap', key: 'KeyM' },
  { id: 'copy', label: 'Copy a blueprint (then drag a box)', key: 'KeyC' },
  { id: 'paste', label: 'Paste the copied blueprint', key: 'KeyV' },
  { id: 'blueprints', label: 'Blueprint library', key: 'KeyB' },
  { id: 'debugInfo', label: 'Debug info (ticks, UPS, tile)', key: 'F3' },
  { id: 'panUp', label: 'Pan up', key: 'ArrowUp' },
  { id: 'panLeft', label: 'Pan left', key: 'ArrowLeft' },
  { id: 'panDown', label: 'Pan down', key: 'ArrowDown' },
  { id: 'panRight', label: 'Pan right', key: 'ArrowRight' },
  { id: 'zoomIn', label: 'Zoom in (also numpad +)', key: 'Equal' },
  { id: 'zoomOut', label: 'Zoom out (also numpad -)', key: 'Minus' },
  { id: 'hotbar1', label: 'Hotbar slot 1', key: 'Digit1' },
  { id: 'hotbar2', label: 'Hotbar slot 2', key: 'Digit2' },
  { id: 'hotbar3', label: 'Hotbar slot 3', key: 'Digit3' },
  { id: 'hotbar4', label: 'Hotbar slot 4', key: 'Digit4' },
  { id: 'hotbar5', label: 'Hotbar slot 5', key: 'Digit5' },
  { id: 'hotbar6', label: 'Hotbar slot 6', key: 'Digit6' },
  { id: 'hotbar7', label: 'Hotbar slot 7', key: 'Digit7' },
  { id: 'hotbar8', label: 'Hotbar slot 8', key: 'Digit8' },
  { id: 'hotbar9', label: 'Hotbar slot 9', key: 'Digit9' },
  { id: 'hotbar10', label: 'Hotbar slot 10', key: 'Digit0' },
] as const satisfies readonly ActionInfo[];

export type Action = (typeof ACTIONS)[number]['id'];
/** A key (`KeyboardEvent.code`) per action. */
export type Bindings = Readonly<Record<Action, string>>;

export const ACTION_IDS: readonly Action[] = ACTIONS.map((a) => a.id);

/** The hotbar actions, by hotbar slot (0–9). */
export const HOTBAR_ACTIONS = ACTION_IDS.filter((a) => a.startsWith('hotbar'));

export const DEFAULT_BINDINGS: Bindings = Object.fromEntries(
  ACTIONS.map((a) => [a.id, a.key]),
) as Record<Action, string>;

/** Keys no action can take: Escape is the menu's, modifiers change clicks and keys. */
const RESERVED = /^(Escape|Shift|Control|Alt|Meta|OS|CapsLock|Fn|ContextMenu)/;

/** Whether `code` (a `KeyboardEvent.code`) can be bound to an action. */
export function isBindable(code: string): boolean {
  return code !== '' && code !== 'Unidentified' && !RESERVED.test(code);
}

export function actionLabel(action: Action): string {
  return ACTIONS.find((a) => a.id === action)!.label;
}

const NAMED_KEYS: Readonly<Record<string, string>> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
};

/** A short label for key `code`: `KeyW` is `W`, `Digit1` is `1`, `ArrowUp` is `↑`. */
export function keyLabel(code: string): string {
  const m = /^(?:Key|Digit)(.)$/.exec(code);
  if (m) return m[1]!;
  const numpad = /^Numpad(.+)$/.exec(code);
  if (numpad) return `Num ${numpad[1]!}`;
  return NAMED_KEYS[code] ?? code;
}

/** Groups of two or more actions bound to the same key (none in valid bindings). */
export function conflicts(bindings: Bindings): Action[][] {
  const byKey = new Map<string, Action[]>();
  for (const action of ACTION_IDS) {
    const key = bindings[action];
    const list = byKey.get(key);
    if (list) list.push(action);
    else byKey.set(key, [action]);
  }
  return [...byKey.values()].filter((list) => list.length > 1);
}

/**
 * Binds `action` to `code`. If another action had that key, the two swap
 * keys (that action is returned as `swapped`), so no key ever does two
 * things. Bindings are unchanged (and `swapped` null) for a key that can't
 * be bound.
 */
export function rebind(
  bindings: Bindings,
  action: Action,
  code: string,
): { bindings: Bindings; swapped: Action | null } {
  if (!isBindable(code) || bindings[action] === code) return { bindings, swapped: null };
  const other = ACTION_IDS.find((a) => a !== action && bindings[a] === code) ?? null;
  const next: Record<Action, string> = { ...bindings, [action]: code };
  if (other) next[other] = bindings[action];
  return { bindings: next, swapped: other };
}

/**
 * Bindings from stored data (anything, e.g. parsed JSON): the default key
 * for any action missing or invalid; if what is left binds one key twice,
 * the defaults altogether.
 *
 * An action missing from the stored bindings (one added since they were
 * saved, like `minimap`) whose default key a stored action has taken gets
 * that action's default key instead, as if the stored action had been
 * rebound after it existed (`rebind` swaps); if that key is taken too, the
 * swaps are followed until a free key is found, so a new action never resets
 * a player's bindings.
 */
export function parseBindings(raw: unknown): Bindings {
  const stored = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_BINDINGS } as Record<Action, string>;
  const missing: Action[] = [];
  for (const action of ACTION_IDS) {
    const key = stored[action];
    if (typeof key === 'string' && isBindable(key)) out[action] = key;
    else missing.push(action);
  }
  for (const action of missing) {
    // Follow the swaps until a key no stored action holds: each holder that
    // has the key is as if it had been rebound to it, so the new action takes
    // that holder's default key, and so on down the chain. The holders' default
    // keys are distinct, so chains from different actions never meet and end.
    let key = DEFAULT_BINDINGS[action];
    for (;;) {
      const holder = ACTION_IDS.find((a) => !missing.includes(a) && out[a] === key);
      if (holder === undefined) break;
      key = DEFAULT_BINDINGS[holder];
    }
    out[action] = key;
  }
  return conflicts(out).length > 0 ? DEFAULT_BINDINGS : out;
}

let current: Bindings = DEFAULT_BINDINGS;
let byCode = new Map<string, Action>(ACTION_IDS.map((a) => [current[a], a]));

/** The bindings in use. */
export function bindings(): Bindings {
  return current;
}

/** Uses `next` from now on (the settings store calls this). */
export function setBindings(next: Bindings): void {
  current = next;
  byCode = new Map(ACTION_IDS.map((a) => [next[a], a]));
}

/** The action bound to key `code`, or `null`. */
export function actionFor(code: string): Action | null {
  return byCode.get(code) ?? null;
}

/** The key bound to `action`. */
export function keyFor(action: Action): string {
  return current[action];
}

/** Hotbar slot (0–9) whose key is `code`, or `null`. */
export function hotbarSlotForCode(code: string): number | null {
  const action = actionFor(code);
  if (action === null) return null;
  const i = HOTBAR_ACTIONS.indexOf(action);
  return i < 0 ? null : i;
}

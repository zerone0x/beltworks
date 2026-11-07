import { afterEach, describe, expect, it } from 'vitest';
import { hotbarSlotForKey } from '../../src/render/buildInput';
import { moveAxes } from '../../src/render/playerInput';
import { controls } from '../../src/ui/help';
import {
  ACTION_IDS,
  DEFAULT_BINDINGS,
  actionFor,
  conflicts,
  isBindable,
  keyLabel,
  parseBindings,
  rebind,
  setBindings,
} from '../../src/ui/keybindings';
import { DEFAULT_SETTINGS, parseSettings } from '../../src/ui/settings';
import { scaledTransform } from '../../src/ui/uiScale';

afterEach(() => {
  setBindings(DEFAULT_BINDINGS);
});

describe('key bindings', () => {
  it('have a distinct default key for every action', () => {
    expect(conflicts(DEFAULT_BINDINGS)).toEqual([]);
    expect(new Set(ACTION_IDS).size).toBe(ACTION_IDS.length);
    expect(actionFor('KeyE')).toBe('inventory');
    expect(actionFor('Escape')).toBeNull();
  });

  it('label keys briefly', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('Digit0')).toBe('0');
    expect(keyLabel('ArrowLeft')).toBe('←');
    expect(keyLabel('Numpad7')).toBe('Num 7');
    expect(keyLabel('F2')).toBe('F2');
  });

  it('never bind Escape or modifier keys', () => {
    for (const code of ['Escape', 'ShiftLeft', 'ControlRight', 'AltLeft', 'MetaLeft', '']) {
      expect(isBindable(code)).toBe(false);
      expect(rebind(DEFAULT_BINDINGS, 'inventory', code).bindings).toBe(DEFAULT_BINDINGS);
    }
    expect(isBindable('KeyI')).toBe(true);
  });

  it('swap keys with the action that had the new key, so none clash', () => {
    const free = rebind(DEFAULT_BINDINGS, 'inventory', 'KeyI');
    expect(free.swapped).toBeNull();
    expect(free.bindings.inventory).toBe('KeyI');
    const taken = rebind(DEFAULT_BINDINGS, 'inventory', 'KeyR');
    expect(taken.swapped).toBe('rotate');
    expect(taken.bindings.inventory).toBe('KeyR');
    expect(taken.bindings.rotate).toBe('KeyE');
    expect(conflicts(taken.bindings)).toEqual([]);
  });

  it('load stored bindings, falling back to the defaults for bad or clashing ones', () => {
    expect(parseBindings(null)).toEqual(DEFAULT_BINDINGS);
    const stored = parseBindings({ inventory: 'KeyI', rotate: 'Escape', bogus: 'KeyZ' });
    expect(stored.inventory).toBe('KeyI');
    expect(stored.rotate).toBe('KeyR');
    expect(stored).not.toHaveProperty('bogus');
    // Two actions on one key: the defaults altogether.
    expect(parseBindings({ inventory: 'KeyR' })).toEqual(DEFAULT_BINDINGS);
  });

  it('drive the input handlers', () => {
    setBindings({ ...DEFAULT_BINDINGS, moveUp: 'KeyI', hotbar1: 'KeyZ', hotbar2: 'Digit1' });
    expect(moveAxes(['KeyI'])).toEqual([0, -1]);
    expect(moveAxes(['KeyW'])).toEqual([0, 0]);
    expect(hotbarSlotForKey('KeyZ')).toBe(0);
    expect(hotbarSlotForKey('Digit1')).toBe(1);
    expect(hotbarSlotForKey('Digit2')).toBeNull();
  });

  it('show in the controls help', () => {
    const help = controls();
    expect(help[0]).toEqual({ keys: 'WASD', action: 'Walk' });
    expect(help.some((c) => c.keys === 'Middle drag / arrows')).toBe(true);
    const rebound = controls({ ...DEFAULT_BINDINGS, inventory: 'KeyI', moveUp: 'ArrowUp' });
    expect(rebound.some((c) => c.keys === 'I' && c.action.startsWith('Inventory'))).toBe(true);
    expect(rebound[0]!.keys).toBe('↑ASD');
  });
});

describe('settings', () => {
  it('load with defaults for anything missing or invalid', () => {
    expect(parseSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('nonsense')).toEqual(DEFAULT_SETTINGS);
    const s = parseSettings({
      graphics: { terrain: 'flat', shadows: false, animation: 'yes', terrainDetail: 'ultra' },
      uiScale: 1.5,
      audio: { master: 140, sfx: -3, music: 33.4 },
    });
    expect(s.graphics).toEqual({
      terrain: 'flat',
      terrainDetail: 'high',
      shadows: false,
      animation: true,
    });
    expect(s.uiScale).toBe(1.5);
    expect(s.audio).toEqual({ master: 100, sfx: 0, music: 33 });
    expect(parseSettings({ uiScale: 3 }).uiScale).toBe(1);
  });

  it('round-trip through JSON', () => {
    const s = parseSettings({
      keys: { ...DEFAULT_BINDINGS, techTree: 'KeyY' },
      graphics: { ...DEFAULT_SETTINGS.graphics, terrainDetail: 'low' },
      uiScale: 0.75,
    });
    expect(parseSettings(JSON.parse(JSON.stringify(s)))).toEqual(s);
  });
});

describe('UI scale', () => {
  it('scales after an element’s own transform, and adds nothing at 1', () => {
    expect(scaledTransform('', 1)).toBe('');
    expect(scaledTransform('translate(-50%, -50%)', 1)).toBe('translate(-50%, -50%)');
    expect(scaledTransform('', 1.5)).toBe('scale(1.5)');
    expect(scaledTransform('translateX(-50%)', 2)).toBe('translateX(-50%) scale(2)');
  });
});

/**
 * Blueprint input (D59): a paste click waits for the snapshot that shows the
 * previous paste, and keys are left alone behind the open game menu. The
 * input listens on `window`; these tests run in Node, so `window` is a bare
 * `EventTarget` that also stands in for the canvas.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalize } from '../../src/blueprint/blueprint';
import { ENTITIES, EntityTypeId } from '../../src/data/entities';
import { ItemId } from '../../src/data/items';
import { BlueprintInput, type BlueprintInputOptions } from '../../src/render/blueprintInput';
import { UndergroundMode } from '../../src/sim/belts/underground';
import type { CommandInput } from '../../src/sim/commands';
import { Direction } from '../../src/sim/entities/direction';

let win: EventTarget;

beforeEach(() => {
  win = new EventTarget();
  vi.stubGlobal('window', win);
  // Only `instanceof` checks need these.
  vi.stubGlobal('HTMLInputElement', class {});
  vi.stubGlobal('HTMLTextAreaElement', class {});
  vi.stubGlobal('HTMLSelectElement', class {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A blueprint input over an empty world where everything fits, and the batches it sent. */
function setup(extra: Partial<BlueprintInputOptions> = {}) {
  const sent: CommandInput[][] = [];
  const input = new BlueprintInput({
    element: win as unknown as HTMLElement,
    playerId: 1,
    send: (commands) => sent.push(commands),
    commandsSent: () => sent.length,
    pointer: () => ({ x: 0, y: 0 }),
    screenToWorld: (sx, sy) => ({ x: sx, y: sy }),
    entities: () => [],
    entityAt: () => null,
    undergroundAt: () => null,
    canPlace: () => true,
    inventory: () => [{ item: ItemId.UndergroundBelt, count: 10 }],
    notify: () => undefined,
    ...extra,
  });
  return { input, sent };
}

const click = () => {
  win.dispatchEvent(Object.assign(new Event('pointerdown'), { button: 0 }));
};
const key = (code: string, k: string) => {
  win.dispatchEvent(Object.assign(new Event('keydown'), { code, key: k }));
};

describe('blueprint input', () => {
  it('ignores a second paste click until a snapshot shows the first paste', () => {
    // A lone underground exit pastes as a reversed Place and a Rotate: sent
    // twice, the second Place fails but the Rotate turns the exit back into
    // an entrance.
    const exit = normalize('', [
      {
        proto: ENTITIES[EntityTypeId.UndergroundBelt],
        x: 0,
        y: 0,
        dir: Direction.East,
        recipe: 0,
        mode: UndergroundMode.Exit,
      },
    ])!;
    const { input, sent } = setup();
    input.hold(exit);
    click();
    input.update();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.map((c) => c.type)).toEqual(['Place', 'Rotate']);
    // A double click: the next frame still plans from the old snapshot.
    click();
    input.update();
    // A snapshot from before the worker got the paste.
    input.onSnapshot(0);
    click();
    input.update();
    expect(sent).toHaveLength(1);
    // The snapshot that shows the paste: clicks paste again.
    input.onSnapshot(1);
    click();
    input.update();
    expect(sent).toHaveLength(2);
    input.destroy();
  });

  it('leaves the blueprint keys alone while the game menu is open', () => {
    let menuOpen = true;
    const { input } = setup({ blocked: () => menuOpen });
    key('KeyC', 'c');
    expect(input.mode).toBe('idle');
    menuOpen = false;
    key('KeyC', 'c');
    expect(input.mode).toBe('select');
    input.destroy();
  });
});

/**
 * Public beta readiness (#92, D61): what the browser check asks for, the
 * version's single source, and the save controller's autosave count and
 * crash offer.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { SaveSlot } from '../../src/save/slots';
import type { SaveStore } from '../../src/save/store';
import { SAVE_VERSION } from '../../src/sim/save/container';
import { missingFeatures, type FeatureProbe } from '../../src/ui/fatal';
import { SaveController } from '../../src/ui/saves';
import { VERSION, VERSION_LABEL } from '../../src/version';
import type { SimClient } from '../../src/worker/client';

const fn = (): void => undefined;
const FULL: FeatureProbe = {
  Worker: fn,
  CompressionStream: fn,
  DecompressionStream: fn,
  indexedDB: {},
  crypto: { getRandomValues: fn },
  webgl: () => true,
  moduleWorkers: () => true,
};

describe('browser check', () => {
  it('finds nothing missing in a browser with everything', () => {
    expect(missingFeatures(FULL)).toEqual([]);
  });

  it('requires module workers, WebGL, compression streams and crypto', () => {
    const missing = missingFeatures({
      ...FULL,
      moduleWorkers: () => false,
      webgl: () => false,
      DecompressionStream: undefined,
      crypto: undefined,
    });
    expect(missing.every((m) => m.required)).toBe(true);
    expect(missing.map((m) => m.feature)).toEqual([
      'Web Workers (ES modules)',
      'WebGL',
      'Compression Streams (gzip)',
      'Web Crypto',
    ]);
    expect(missingFeatures({ ...FULL, Worker: undefined })[0]?.feature).toBe(
      'Web Workers (ES modules)',
    );
  });

  it('runs without IndexedDB (saves are off), listing it after the required things', () => {
    expect(missingFeatures({ ...FULL, indexedDB: undefined })).toEqual([
      { feature: 'IndexedDB', required: false },
    ]);
    const both = missingFeatures({ ...FULL, indexedDB: null, webgl: () => false });
    expect(both.map((m) => m.required)).toEqual([true, false]);
  });
});

describe('version', () => {
  it('comes from package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
    expect(VERSION_LABEL).toBe(`v${pkg.version}`);
  });
});

function slot(id: string, savedAt: number, extra: Partial<SaveSlot> = {}): SaveSlot {
  return {
    id,
    name: id,
    autosave: false,
    savedAt,
    tick: 0,
    entities: 0,
    bytes: 1,
    version: SAVE_VERSION,
    ...extra,
  };
}

/** A save controller over an in-memory store and a client whose saves are at `tick()`. */
function controller(tick: () => number, slots: SaveSlot[] = []) {
  const written: SaveSlot[] = [];
  const store = {
    list: () => Promise.resolve([...slots, ...written]),
    write: (s: SaveSlot) => {
      written.push(s);
      return Promise.resolve();
    },
  } as unknown as SaveStore;
  const client = {
    save: () =>
      Promise.resolve({
        data: new Uint8Array(1),
        meta: { tick: tick(), seed: 1, players: 1, entities: 0 },
      }),
  } as unknown as SimClient;
  return { saves: new SaveController(store, client, () => undefined), written };
}

describe('save controller', () => {
  it('restarts the autosave count on a manual save', async () => {
    (globalThis as { document?: unknown }).document = { hidden: false };
    let now = 0;
    const { saves, written } = controller(() => now, []);
    saves.startAutosave(100);
    saves.onTick(0);
    now = 90;
    saves.onTick(90);
    await saves.save('Mine');
    expect(written.map((s) => s.name)).toEqual(['Mine']);
    // 100 ticks after the start, but only 10 after the manual save: no autosave yet.
    saves.onTick(100);
    await new Promise((r) => setTimeout(r, 0));
    expect(written).toHaveLength(1);
    now = 190;
    saves.onTick(190);
    await new Promise((r) => setTimeout(r, 0));
    expect(written.map((s) => s.autosave)).toEqual([false, true]);
  });

  it('offers the newest save it can load after a crash, and none without saves', async () => {
    const { saves } = controller(
      () => 0,
      [
        slot('old', 1),
        slot('auto', 3, { autosave: true }),
        slot('future', 5, { version: SAVE_VERSION + 1 }),
      ],
    );
    expect((await saves.latest())?.id).toBe('auto');
    expect(await controller(() => 0).saves.latest()).toBeNull();
  });
});

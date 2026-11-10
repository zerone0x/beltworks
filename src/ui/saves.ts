/**
 * Saving and loading on the main thread: picks what to start with (the
 * title screen: a save to continue, or a new game on a seed), stores the
 * worker's saves in IndexedDB, autosaves, exports and imports save files,
 * and backs the game menu (src/ui/gameMenu.ts).
 *
 * Loading a save (or starting a new game) from the menu reloads the page
 * with the choice in `sessionStorage`, so every part of the main thread
 * (renderer caches, panels, histories) starts fresh; the startup then reads
 * the save and hands it to the worker with `init` (src/worker/protocol.ts),
 * which loads it. Serializing and gzipping happen in the worker.
 */

import { gunzipSave, gzip, isGzip } from '../save/compress';
import {
  AUTOSAVE_TICKS,
  AutosaveClock,
  exportFileName,
  importedName,
  newSlotId,
  nextAutosaveSlot,
  sortSlots,
  type SaveSlot,
} from '../save/slots';
import { SaveStore } from '../save/store';
import { SAVE_VERSION, readSaveMeta } from '../sim/save/container';
import type { SimClient } from '../worker/client';
import type { GameMenuActions } from './gameMenu';
import type { AboutPanel } from './about';
import type { SettingsPanel } from './settingsPanel';
import { showTitleScreen } from './titleScreen';

/** What the page reload after "Load" or "New game" in the menu should start with. */
const NEXT_KEY = 'beltworks.next';

/**
 * What a page starts with: a save to continue (and its slot), or a new game
 * (no `save`); and the world seed. A new game's onboarding starts at its
 * first step, a save's at its slot's (D60).
 */
export interface StartChoice {
  save?: Uint8Array;
  slot?: SaveSlot;
  /** The world seed: the new game's, or the save's. */
  seed: number;
}

/**
 * When the title screen shows: `always` (production and dev builds), only
 * when there are saves to continue (`saves`: test builds, so the e2e specs
 * start straight in a new game on the default seed), or `never`.
 */
export type TitleMode = 'always' | 'saves' | 'never';

function newerVersionMessage(version: number): string {
  return (
    `This save was made by a newer version of Beltworks (save format ${String(version)}); ` +
    `this version reads save formats up to ${String(SAVE_VERSION)}.`
  );
}

/** The world seed of save `save` (gzipped or not), or `fallback` if it can't be read. */
async function seedOf(save: Uint8Array, fallback: number): Promise<number> {
  try {
    return readSaveMeta(isGzip(save) ? await gunzipSave(save) : save).seed >>> 0;
  } catch {
    return fallback;
  }
}

/**
 * Decides what this page starts with: the save the menu's Load left before
 * reloading, else what the player picks on the title screen (`mode` says
 * when it shows; the menu's New game always shows it), else a new game on
 * `defaultSeed`.
 */
export async function chooseStart(
  store: SaveStore | null,
  {
    mode = 'always',
    defaultSeed,
    settings = null,
    about = null,
  }: {
    mode?: TitleMode;
    defaultSeed: number;
    settings?: SettingsPanel | null;
    about?: AboutPanel | null;
  },
): Promise<StartChoice> {
  const next = sessionStorage.getItem(NEXT_KEY);
  sessionStorage.removeItem(NEXT_KEY);
  const slots = store ? sortSlots(await store.list()) : [];
  let slot = next?.startsWith('load:') ? (slots.find((s) => s.id === next.slice(5)) ?? null) : null;
  if (!slot) {
    const show = next === 'title' || mode === 'always' || (mode === 'saves' && slots.length > 0);
    if (!show) return { seed: defaultSeed };
    const choice = await showTitleScreen(document.body, {
      slots,
      ...(mode !== 'always' && { seed: defaultSeed }),
      settings,
      about,
    });
    if (choice.kind === 'new') return { seed: choice.seed };
    slot = choice.slot;
  }
  const save = await store?.read(slot.id);
  if (!save) return { seed: defaultSeed };
  return { save, slot, seed: await seedOf(save, defaultSeed) };
}

export class SaveController implements Omit<
  GameMenuActions,
  'otherWindowOpen' | 'restartTutorial'
> {
  private autosaveClock: AutosaveClock | null = null;
  private busy = false;

  constructor(
    private readonly store: SaveStore | null,
    private readonly client: SimClient,
    /** Status messages for the player (autosaves, failures). */
    private readonly notify: (message: string) => void,
    /** Item names pinned to the hotbar slots, stored with each save (D51). */
    private readonly hotbar: () => string[] = () => [],
    /** The onboarding objective the game is at, stored with each save (`undefined`: none). */
    private readonly onboarding: () => number | undefined = () => undefined,
  ) {}

  /**
   * Starts autosaving every `ticks` ticks of play: time paused behind the
   * menu runs no ticks, so it doesn't count (`onTick` feeds the ticks in).
   */
  startAutosave(ticks = AUTOSAVE_TICKS): void {
    if (!this.store || this.autosaveClock) return;
    this.autosaveClock = new AutosaveClock(ticks);
  }

  /** The tick of the latest snapshot: autosaves once enough play has passed (not while the tab is hidden). */
  onTick(tick: number): void {
    const clock = this.autosaveClock;
    if (!clock?.due(tick) || this.busy || document.hidden) return;
    clock.restart(tick);
    // Count from the tick the save holds (the worker saves a few ticks later).
    void this.autosave().then((slot) => {
      if (slot) clock.restart(slot.tick);
    });
  }

  /** Saves into the next autosave slot (the oldest of the rotation). */
  async autosave(): Promise<SaveSlot | null> {
    if (!this.store || this.busy) return null;
    const target = nextAutosaveSlot(await this.store.list());
    try {
      const slot = await this.write(target.id, target.name, true);
      this.notify(`Autosaved (${target.name}).`);
      return slot;
    } catch (err) {
      this.notify(`Autosave failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  async save(name: string): Promise<void> {
    if (!this.store) throw new Error('saves need IndexedDB, which this browser does not offer');
    const slots = await this.store.list();
    // Saving under the name of an existing save replaces it.
    const same = slots.find((s) => !s.autosave && s.name === name);
    const slot = await this.write(same?.id ?? newSlotId(Date.now(), slots), name, false);
    // A save the player just made is as good as an autosave: the next one is a full interval later.
    this.autosaveClock?.restart(slot.tick);
  }

  /** Stops autosaving for good (the simulation crashed: there is nothing safe left to save). */
  stopAutosave(): void {
    this.autosaveClock = null;
  }

  /** The newest save of any kind (what a crash offers to load), or `null` if there is none. */
  async latest(): Promise<SaveSlot | null> {
    const slots = sortSlots(await this.list()).filter((s) => s.version <= SAVE_VERSION);
    return slots[0] ?? null;
  }

  async list(): Promise<SaveSlot[]> {
    return this.store ? this.store.list() : [];
  }

  load(slot: SaveSlot): void {
    if (slot.version > SAVE_VERSION) {
      this.notify(newerVersionMessage(slot.version));
      return;
    }
    sessionStorage.setItem(NEXT_KEY, `load:${slot.id}`);
    window.location.reload();
  }

  /** Reloads the page into the title screen, where the player picks a seed. */
  newGame(): void {
    sessionStorage.setItem(NEXT_KEY, 'title');
    window.location.reload();
  }

  async delete(slot: SaveSlot): Promise<void> {
    await this.store?.delete(slot.id);
  }

  /** Downloads the slot's save as a file (gzipped, as stored). */
  async export(slot: SaveSlot): Promise<void> {
    const data = await this.store?.read(slot.id);
    if (!data) throw new Error('the save is gone');
    const url = URL.createObjectURL(
      new Blob([data as Uint8Array<ArrayBuffer>], { type: 'application/octet-stream' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFileName(slot.name);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 10_000);
  }

  /**
   * Stores a save file as a new slot after checking it is one this version
   * can load (format, checksum, version).
   */
  async import(file: File): Promise<string> {
    if (!this.store) throw new Error('saves need IndexedDB, which this browser does not offer');
    const raw = new Uint8Array(await file.arrayBuffer());
    let meta;
    try {
      meta = readSaveMeta(await gunzipSave(raw));
    } catch (err) {
      throw new Error(`${file.name}: ${err instanceof Error ? err.message : String(err)}`, {
        cause: err,
      });
    }
    if (meta.version > SAVE_VERSION) throw new Error(newerVersionMessage(meta.version));
    const data = isGzip(raw) ? raw : await gzip(raw);
    const name = importedName(file.name);
    const slot: SaveSlot = {
      id: newSlotId(Date.now(), await this.store.list()),
      name,
      autosave: false,
      savedAt: Date.now(),
      tick: meta.tick,
      entities: meta.entities,
      bytes: data.length,
      version: meta.version,
    };
    await this.store.write(slot, data);
    return `Imported “${name}”.`;
  }

  /** Asks the worker for a save and stores it in slot `id`. */
  private async write(id: string, name: string, autosave: boolean): Promise<SaveSlot> {
    if (!this.store) throw new Error('saves need IndexedDB');
    this.busy = true;
    try {
      const { data, meta } = await this.client.save();
      const slot: SaveSlot = {
        id,
        name,
        autosave,
        savedAt: Date.now(),
        tick: meta.tick,
        entities: meta.entities,
        bytes: data.length,
        version: SAVE_VERSION,
        hotbar: this.hotbar(),
      };
      const step = this.onboarding();
      if (step !== undefined) slot.onboarding = step;
      await this.store.write(slot, data);
      return slot;
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Save slots: what the game menu lists for each save, and the autosave
 * rotation. Pure functions, shared by the IndexedDB store (store.ts) and the
 * menu (src/ui/gameMenu.ts), and unit-tested.
 */

/** One save slot as listed (the save's bytes are stored separately). */
export interface SaveSlot {
  /** `autosave-1` … `autosave-N` for autosaves, `save-<time>-<n>` for the rest. */
  id: string;
  /** The name the player gave it (or `Autosave N`). */
  name: string;
  autosave: boolean;
  /** When it was saved: milliseconds since 1970 (wall clock, never simulation state). */
  savedAt: number;
  /** Ticks the game had run. */
  tick: number;
  /** Entities on the map. */
  entities: number;
  /** Size of the stored (gzipped) save, in bytes. */
  bytes: number;
  /** The save format version (src/sim/save/container.ts). */
  version: number;
  /**
   * Item names pinned to the hotbar slots (`''` for none) when it was saved:
   * UI state kept next to the save, not in it (D51). Missing for imported
   * saves and saves made before hotbar pins.
   */
  hotbar?: string[];
}

/** Autosave slots, used in rotation. */
export const AUTOSAVE_SLOTS = 3;
/** Minutes of play between autosaves. */
export const AUTOSAVE_MINUTES = 5;

/** Slots newest first. */
export function sortSlots(slots: readonly SaveSlot[]): SaveSlot[] {
  return slots.slice().sort((a, b) => b.savedAt - a.savedAt || a.id.localeCompare(b.id));
}

/** The slot the next autosave goes into: a free one, else the oldest autosave. */
export function nextAutosaveSlot(slots: readonly SaveSlot[]): { id: string; name: string } {
  let oldest: SaveSlot | null = null;
  for (let n = 1; n <= AUTOSAVE_SLOTS; n++) {
    const id = `autosave-${String(n)}`;
    const slot = slots.find((s) => s.id === id);
    if (!slot) return { id, name: `Autosave ${String(n)}` };
    if (!oldest || slot.savedAt < oldest.savedAt) oldest = slot;
  }
  return { id: oldest!.id, name: oldest!.name };
}

/** A fresh id for a save the player makes (or imports). */
export function newSlotId(now: number, slots: readonly SaveSlot[]): string {
  let n = 0;
  let id = `save-${String(now)}`;
  while (slots.some((s) => s.id === id)) id = `save-${String(now)}-${String(++n)}`;
  return id;
}

/** Game time of `tick` ticks (60 per second) as `h:mm:ss`. */
export function formatPlayTime(tick: number): string {
  const seconds = Math.floor(tick / 60);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = seconds % 60;
  return `${String(h)}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** A file name for exporting a save named `name`. */
export function exportFileName(name: string): string {
  const base =
    name
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '-') || 'save';
  return `beltworks-${base}.bwsave`;
}

/** The slot name for an imported file (its name without the extension). */
export function importedName(fileName: string): string {
  return fileName.replace(/\.(bwsave|gz)$/i, '').replace(/^beltworks-/, '') || 'Imported save';
}

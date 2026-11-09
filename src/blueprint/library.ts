/**
 * The blueprint library (D59): blueprints the player keeps, as blueprint
 * strings (src/blueprint/string.ts) with a name, in one JSON object in
 * `localStorage`, per browser and never in a save, like the settings (D50).
 * Entries keep the string, not the decoded blueprint, so the library is
 * exactly what an export would share and older strings migrate when used.
 */

/** The `localStorage` key of the library (JSON). */
export const LIBRARY_KEY = 'beltworks.blueprints';
/** Format of the stored object. */
const LIBRARY_VERSION = 1;

export interface LibraryEntry {
  /** Unique within the library. */
  readonly id: string;
  readonly name: string;
  /** Entities in the blueprint (shown in the list without decoding it). */
  readonly entities: number;
  /** The blueprint string. */
  readonly text: string;
}

/** The storage the library lives in, or `null` where there is none (Node, some private modes). */
export type LibraryStorage = Pick<Storage, 'getItem' | 'setItem'> | null;

function defaultStorage(): LibraryStorage {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Entries from stored data (anything, e.g. parsed JSON); malformed entries are dropped. */
export function parseLibrary(raw: unknown): LibraryEntry[] {
  const doc = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  if (doc.version !== LIBRARY_VERSION || !Array.isArray(doc.entries)) return [];
  const seen = new Set<string>();
  const out: LibraryEntry[] = [];
  for (const e of doc.entries as unknown[]) {
    if (typeof e !== 'object' || e === null) continue;
    const { id, name, entities, text } = e as Record<string, unknown>;
    if (
      typeof id !== 'string' ||
      seen.has(id) ||
      typeof name !== 'string' ||
      typeof entities !== 'number' ||
      typeof text !== 'string'
    ) {
      continue;
    }
    seen.add(id);
    out.push({ id, name, entities, text });
  }
  return out;
}

export class BlueprintLibrary {
  private list: LibraryEntry[];
  private nextId: number;

  constructor(private readonly storage: LibraryStorage = defaultStorage()) {
    let raw: unknown;
    try {
      raw = JSON.parse(storage?.getItem(LIBRARY_KEY) ?? 'null');
    } catch {
      raw = null;
    }
    this.list = parseLibrary(raw);
    this.nextId = 1 + Math.max(0, ...this.list.map((e) => Number(/^b(\d+)$/.exec(e.id)?.[1] ?? 0)));
  }

  /** The entries, oldest first. */
  get entries(): readonly LibraryEntry[] {
    return this.list;
  }

  /** Adds a blueprint string under `name`; returns the new entry. */
  add(name: string, text: string, entities: number): LibraryEntry {
    const entry = { id: `b${String(this.nextId++)}`, name, entities, text };
    this.list = [...this.list, entry];
    this.persist();
    return entry;
  }

  /** Removes entry `id` (nothing if there is none). */
  remove(id: string): void {
    this.list = this.list.filter((e) => e.id !== id);
    this.persist();
  }

  get(id: string): LibraryEntry | undefined {
    return this.list.find((e) => e.id === id);
  }

  private persist(): void {
    try {
      this.storage?.setItem(
        LIBRARY_KEY,
        JSON.stringify({ version: LIBRARY_VERSION, entries: this.list }),
      );
    } catch (err) {
      // Full or blocked storage: the library still works for this session.
      console.warn('blueprint library: could not store it:', err);
    }
  }
}

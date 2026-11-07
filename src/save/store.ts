/**
 * Save storage in IndexedDB (static hosting, no server): database
 * `beltworks`, with the slot list (`slots`, small records the menu lists)
 * and the gzipped saves (`data`, by slot id) in separate object stores, so
 * listing never reads the saves themselves.
 */

import type { SaveSlot } from './slots';

const DB_NAME = 'beltworks';
const DB_VERSION = 1;
const SLOTS = 'slots';
const DATA = 'data';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      resolve(req.result);
    };
    req.onerror = () => {
      reject(req.error ?? new Error('IndexedDB request failed'));
    };
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => {
      resolve();
    };
    tx.onerror = () => {
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    };
    tx.onabort = () => {
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    };
  });
}

export class SaveStore {
  private constructor(private readonly db: IDBDatabase) {}

  /** Opens (creating if need be) the save database; `null` where IndexedDB isn't available. */
  static async open(): Promise<SaveStore | null> {
    if (typeof indexedDB === 'undefined') return null;
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SLOTS)) db.createObjectStore(SLOTS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(DATA)) db.createObjectStore(DATA);
      };
      return new SaveStore(await request(req));
    } catch (err) {
      console.warn('Saves are unavailable (IndexedDB failed to open):', err);
      return null;
    }
  }

  /** Every slot, in no particular order. */
  async list(): Promise<SaveSlot[]> {
    const tx = this.db.transaction(SLOTS, 'readonly');
    return request(tx.objectStore(SLOTS).getAll() as IDBRequest<SaveSlot[]>);
  }

  /** The stored save of slot `id`, or `null`. */
  async read(id: string): Promise<Uint8Array | null> {
    const tx = this.db.transaction(DATA, 'readonly');
    const data = (await request(tx.objectStore(DATA).get(id))) as ArrayBuffer | undefined;
    return data ? new Uint8Array(data) : null;
  }

  /** Stores `data` in slot `slot.id` (replacing what was there), with its listing. */
  async write(slot: SaveSlot, data: Uint8Array): Promise<void> {
    const tx = this.db.transaction([SLOTS, DATA], 'readwrite');
    tx.objectStore(DATA).put(data.slice().buffer, slot.id);
    tx.objectStore(SLOTS).put(slot);
    await done(tx);
  }

  async delete(id: string): Promise<void> {
    const tx = this.db.transaction([SLOTS, DATA], 'readwrite');
    tx.objectStore(DATA).delete(id);
    tx.objectStore(SLOTS).delete(id);
    await done(tx);
  }
}

/**
 * The generic entity table: one row per placed entity with the fields every
 * entity has (type, position, direction), keyed by a stable entity id through
 * a sparse set. Type-specific state lives in per-type SoA tables (see
 * table.ts) keyed by the same ids.
 *
 * Entity ids are uint32s handed out in increasing order from 1 and never
 * reused, so a stale id held by another entity (an inserter's target, say)
 * can never point at a different entity later. 0 means "no entity".
 */

import type { EntityPrototype } from '../../data/entities';
import { fnv1a32 } from '../hash';
import { SaveError, type SaveReader, type SaveWriter } from '../save/codec';
import type { Direction } from './direction';
import { SparseSet, growTo } from './sparseSet';

/** Footprint size in tiles of `proto` facing `dir`: width and height swap for east and west. */
export function footprintSize(proto: EntityPrototype, dir: Direction): { w: number; h: number } {
  return (dir & 1) === 1
    ? { w: proto.height, h: proto.width }
    : { w: proto.width, h: proto.height };
}

export class EntityStore {
  private readonly set = new SparseSet();
  /** Entity type id (src/data/entities.ts) per row. */
  private typeCol = new Uint8Array(0);
  /** Top-left tile of the footprint per row. */
  private xCol = new Int32Array(0);
  private yCol = new Int32Array(0);
  /** Direction per row. */
  private dirCol = new Uint8Array(0);
  private next = 1;

  /** Number of entities. */
  get count(): number {
    return this.set.size;
  }

  /** The id the next entity will get. */
  get nextId(): number {
    return this.next;
  }

  /** Entity ids in row order. */
  get ids(): Uint32Array {
    return this.set.dense;
  }

  has(id: number): boolean {
    return this.set.has(id);
  }

  /** Adds an entity and returns its new id. */
  add(type: number, x: number, y: number, dir: Direction): number {
    if (this.next > 0xffff_ffff) {
      throw new RangeError('out of entity ids');
    }
    const id = this.next++;
    const row = this.set.add(id);
    const min = row + 1;
    this.typeCol = growTo(this.typeCol, min);
    this.xCol = growTo(this.xCol, min);
    this.yCol = growTo(this.yCol, min);
    this.dirCol = growTo(this.dirCol, min);
    this.typeCol[row] = type;
    this.xCol[row] = x;
    this.yCol[row] = y;
    this.dirCol[row] = dir;
    return id;
  }

  /** Removes entity `id`; returns false if there is no such entity. */
  remove(id: number): boolean {
    const row = this.set.remove(id);
    if (row < 0) {
      return false;
    }
    const last = this.set.size;
    if (row !== last) {
      this.typeCol[row] = this.typeCol[last]!;
      this.xCol[row] = this.xCol[last]!;
      this.yCol[row] = this.yCol[last]!;
      this.dirCol[row] = this.dirCol[last]!;
    }
    this.typeCol[last] = 0;
    this.xCol[last] = 0;
    this.yCol[last] = 0;
    this.dirCol[last] = 0;
    return true;
  }

  /** Type id of entity `id`, or 0 if there is no such entity. */
  type(id: number): number {
    const row = this.set.indexOf(id);
    return row < 0 ? 0 : this.typeCol[row]!;
  }

  /** Top-left tile of entity `id`'s footprint. The entity must exist. */
  x(id: number): number {
    return this.xCol[this.row(id)]!;
  }

  y(id: number): number {
    return this.yCol[this.row(id)]!;
  }

  dir(id: number): Direction {
    return this.dirCol[this.row(id)]! as Direction;
  }

  setDir(id: number, dir: Direction): void {
    this.dirCol[this.row(id)] = dir;
  }

  /** Folds every row into a running FNV-1a hash. */
  hashInto(h: number): number {
    const n = this.count;
    h = fnv1a32(Uint32Array.of(n, this.next), h);
    h = fnv1a32(this.set.dense, h);
    h = fnv1a32(this.typeCol.subarray(0, n), h);
    h = fnv1a32(this.xCol.subarray(0, n), h);
    h = fnv1a32(this.yCol.subarray(0, n), h);
    h = fnv1a32(this.dirCol.subarray(0, n), h);
    return h;
  }

  save(w: SaveWriter): void {
    const n = this.count;
    w.u32(this.next);
    w.sparseSet(this.set);
    w.column(this.typeCol, n);
    w.column(this.xCol, n);
    w.column(this.yCol, n);
    w.column(this.dirCol, n);
  }

  /** Restores what `save` wrote into this empty store. */
  load(r: SaveReader): void {
    this.next = r.u32();
    r.sparseSet(this.set);
    const n = this.count;
    this.typeCol = r.column(this.typeCol, n);
    this.xCol = r.column(this.xCol, n);
    this.yCol = r.column(this.yCol, n);
    this.dirCol = r.column(this.dirCol, n);
    for (const id of this.set.dense) {
      if (id >= this.next) throw new SaveError(`entities: id ${String(id)} not below the next id`);
    }
  }

  private row(id: number): number {
    const row = this.set.indexOf(id);
    if (row < 0) {
      throw new RangeError(`no entity ${String(id)}`);
    }
    return row;
  }
}

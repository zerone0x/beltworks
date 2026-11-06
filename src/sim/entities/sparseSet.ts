/**
 * A sparse set of uint32 ids: O(1) add, remove, and id → dense index lookup,
 * with the members packed at the front of a dense array so a system can walk
 * them as a compact range.
 *
 * Every entity table (the generic one in `EntityStore` and each per-type SoA
 * table) keeps its rows in the order of such a set: row `i` belongs to the
 * member at dense index `i`. Removal moves the last member into the freed
 * slot, so tables move their last row the same way (see
 * {@link SparseSet.remove}).
 */

type GrowableArray = Uint8Array | Int8Array | Uint16Array | Int32Array | Uint32Array;

/** Grows a typed array to at least `min` elements (doubling), keeping its contents. */
export function growTo<T extends GrowableArray>(array: T, min: number): T {
  if (array.length >= min) {
    return array;
  }
  let length = Math.max(array.length, 8);
  while (length < min) length *= 2;
  const next = new (array.constructor as new (length: number) => T)(length);
  next.set(array);
  return next;
}

export class SparseSet {
  /** `index + 1` per id, 0 where the id is absent. */
  private sparse = new Uint32Array(0);
  /** Member ids; only `[0, size)` is meaningful. */
  private ids = new Uint32Array(0);
  private count = 0;

  /** Number of members. */
  get size(): number {
    return this.count;
  }

  /** Member ids in dense order (a view of `[0, size)`; invalidated by `add`). */
  get dense(): Uint32Array {
    return this.ids.subarray(0, this.count);
  }

  /** The member at dense index `index`. */
  idAt(index: number): number {
    return this.ids[index]!;
  }

  has(id: number): boolean {
    return this.indexOf(id) >= 0;
  }

  /** Dense index of `id`, or -1 if it is not a member. */
  indexOf(id: number): number {
    return Number.isInteger(id) && id >= 0 && id < this.sparse.length ? this.sparse[id]! - 1 : -1;
  }

  /**
   * Adds `id` (a positive uint32 that isn't a member yet) at the end and
   * returns its dense index, which is always the previous `size`.
   */
  add(id: number): number {
    if (!Number.isInteger(id) || id <= 0 || id > 0xffff_ffff) {
      throw new RangeError(`sparse set ids must be positive uint32s, got ${String(id)}`);
    }
    if (this.has(id)) {
      throw new RangeError(`id ${String(id)} is already in the set`);
    }
    this.sparse = growTo(this.sparse, id + 1);
    this.ids = growTo(this.ids, this.count + 1);
    const index = this.count++;
    this.ids[index] = id;
    this.sparse[id] = index + 1;
    return index;
  }

  /**
   * Removes `id` and returns the dense index it had, or -1 if it wasn't a
   * member. Unless it was the last member, the last member (at the new
   * `size`) moves into that index: tables mirroring the set must move their
   * row `size` to the returned index too.
   */
  remove(id: number): number {
    const index = this.indexOf(id);
    if (index < 0) {
      return -1;
    }
    const last = --this.count;
    if (index !== last) {
      const moved = this.ids[last]!;
      this.ids[index] = moved;
      this.sparse[moved] = index + 1;
    }
    this.ids[last] = 0;
    this.sparse[id] = 0;
    return index;
  }
}

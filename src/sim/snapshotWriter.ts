/**
 * A growable int32 buffer the snapshot encoders write into (src/sim/snapshot.ts).
 *
 * The worker keeps one per snapshot section and reuses it every tick. With
 * the encoders' other scratch (a reused id list, `ScratchSet`s, typed
 * arrays) that means, once everything has grown to the scene's size, an
 * encoder call allocates only the small `Int32Array` view it returns
 * (`view`), whatever the number of entities; `npm run bench -- --snapshot`
 * measures it per section. What goes to the main thread is copied out of
 * the writer (see src/worker/snapshotDelta.ts). Read-only with respect to
 * the simulation.
 */
export class SnapshotWriter {
  private buf: Int32Array<ArrayBuffer>;
  /** Words written since the last `reset`. */
  length = 0;

  constructor(capacity = 256) {
    this.buf = new Int32Array(Math.max(16, capacity));
  }

  /** Starts over (keeps the memory). */
  reset(): this {
    this.length = 0;
    return this;
  }

  /** Makes room for `n` more words. */
  reserve(n: number): void {
    const need = this.length + n;
    if (need <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    const next = new Int32Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  /** Appends one word. */
  push(v: number): void {
    if (this.length === this.buf.length) this.reserve(1);
    this.buf[this.length++] = v;
  }

  /** Appends `count` zeros and returns the index of the first (to fill in with `set`). */
  skip(count: number): number {
    this.reserve(count);
    const at = this.length;
    this.buf.fill(0, at, at + count);
    this.length += count;
    return at;
  }

  /** Overwrites word `index` (already written). */
  set(index: number, v: number): void {
    this.buf[index] = v;
  }

  /** The words written so far: a view into the writer's memory, valid until it is written to again. */
  view(): Int32Array<ArrayBuffer> {
    return this.buf.subarray(0, this.length);
  }

  /** The words written so far, copied into a buffer of their own. */
  take(): Int32Array<ArrayBuffer> {
    return this.buf.slice(0, this.length);
  }
}

/**
 * A set of int32s that empties and refills without allocating once grown
 * (a sparse set): `values` lists them densely in the order added, and a map
 * from value to index confirms membership only where `values` still holds
 * the value there. The map keeps stale keys between uses and is emptied only
 * when they far outnumber the values.
 */
export class ScratchSet {
  values: Int32Array<ArrayBuffer> = new Int32Array(64);
  size = 0;
  private readonly at = new Map<number, number>();

  clear(): void {
    if (this.at.size > 4 * this.size + 1024) this.at.clear();
    this.size = 0;
  }

  /** Where `v` is in `values`, or -1. */
  indexOf(v: number): number {
    const i = this.at.get(v);
    return i !== undefined && i < this.size && this.values[i] === v ? i : -1;
  }

  has(v: number): boolean {
    return this.indexOf(v) >= 0;
  }

  /** Adds `v` (if it isn't in yet) and returns its index in `values`. */
  add(v: number): number {
    const i = this.indexOf(v);
    if (i >= 0) return i;
    if (this.size === this.values.length) {
      const next = new Int32Array(this.size * 2);
      next.set(this.values);
      this.values = next;
    }
    this.values[this.size] = v;
    this.at.set(v, this.size);
    return this.size++;
  }

  /** Sorts `values` ascending in place (insertion sort: meant for a few dozen values). */
  sort(): void {
    const v = this.values;
    for (let i = 1; i < this.size; i++) {
      const x = v[i]!;
      let j = i - 1;
      while (j >= 0 && v[j]! > x) {
        v[j + 1] = v[j]!;
        this.at.set(v[j + 1]!, j + 1);
        j--;
      }
      v[j + 1] = x;
      this.at.set(x, j + 1);
    }
  }
}

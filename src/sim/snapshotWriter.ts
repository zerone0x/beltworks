/**
 * A growable int32 buffer the snapshot encoders write into (src/sim/snapshot.ts).
 *
 * The worker keeps one per snapshot section and reuses it every tick, so
 * encoding allocates nothing once the buffers have grown to the scene's
 * size; what goes to the main thread is copied out of it (see
 * src/worker/snapshotDelta.ts). Read-only with respect to the simulation.
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

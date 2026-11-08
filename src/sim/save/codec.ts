/**
 * The binary codec of saves: a writer and a reader of little-endian
 * integers, strings, JSON and typed arrays, plus helpers for the sparse sets
 * and columns every entity table is made of (docs/ARCHITECTURE.md, "Saves").
 *
 * Every part of the simulation state serializes itself next to its
 * `hashInto` hook (`save(w)` / `load(r)`), into a section of its own (see
 * save.ts); this module only knows bytes.
 *
 * Typed arrays are written as their raw bytes in platform byte order, like
 * the state hash (src/sim/hash.ts): every supported browser and Node.js runs
 * on little-endian hardware. Integers written one at a time are explicitly
 * little-endian.
 */

import type { SparseSet } from '../entities/sparseSet';

/** The typed arrays the simulation keeps its state in. */
export type SaveColumn =
  Uint8Array | Int8Array | Uint16Array | Int16Array | Uint32Array | Int32Array;

type ColumnConstructor<T extends SaveColumn> = new (length: number) => T;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Thrown when a save can't be read: corrupt, truncated, or from an unknown version. */
export class SaveError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SaveError';
  }
}

export class SaveWriter {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private pos = 0;

  /** Bytes written so far. */
  get length(): number {
    return this.pos;
  }

  /** The bytes written so far (a copy). */
  bytes(): Uint8Array {
    return this.buf.slice(0, this.pos);
  }

  u8(v: number): void {
    this.reserve(1);
    this.view.setUint8(this.pos, v);
    this.pos += 1;
  }

  bool(v: boolean): void {
    this.u8(v ? 1 : 0);
  }

  u16(v: number): void {
    this.reserve(2);
    this.view.setUint16(this.pos, v, true);
    this.pos += 2;
  }

  u32(v: number): void {
    this.reserve(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }

  i32(v: number): void {
    this.reserve(4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
  }

  /** A non-negative safe integer (a tick counter), as two uint32 words. */
  u53(v: number): void {
    if (!Number.isSafeInteger(v) || v < 0) {
      throw new RangeError(`not a non-negative safe integer: ${String(v)}`);
    }
    const lo = v % 0x1_0000_0000;
    this.u32(lo);
    this.u32((v - lo) / 0x1_0000_0000);
  }

  /** A UTF-8 string, length-prefixed. */
  str(v: string): void {
    this.blob(encoder.encode(v));
  }

  /** Any JSON value (for small, irregular data such as queued commands). */
  json(v: unknown): void {
    this.str(JSON.stringify(v));
  }

  /** Raw bytes, length-prefixed. */
  blob(bytes: Uint8Array): void {
    this.u32(bytes.length);
    this.raw(bytes);
  }

  /** Raw bytes, no length. */
  raw(bytes: Uint8Array): void {
    this.reserve(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  /** The first `length` elements of `column` (all of it by default), length-prefixed. */
  column(column: SaveColumn, length: number = column.length): void {
    this.u32(length);
    this.raw(new Uint8Array(column.buffer, column.byteOffset, length * column.BYTES_PER_ELEMENT));
  }

  /** The members of `set` in dense order (the row order of the table it keys). */
  sparseSet(set: SparseSet): void {
    this.column(set.dense);
  }

  /** A list of uint32s (ids), length-prefixed. */
  ids(list: readonly number[]): void {
    this.u32(list.length);
    for (const id of list) this.u32(id);
  }

  private reserve(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
}

export class SaveReader {
  private readonly view: DataView;
  private pos = 0;

  constructor(
    private readonly bytes: Uint8Array,
    /** What is being read, for error messages (a section name). */
    private readonly what = 'save',
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  /** Whether every byte has been read. */
  get done(): boolean {
    return this.pos === this.bytes.length;
  }

  /** Throws unless every byte has been read (a section longer than its reader expects). */
  end(): void {
    if (!this.done) {
      throw new SaveError(
        `${this.what}: ${String(this.bytes.length - this.pos)} unread bytes (wrong save version?)`,
      );
    }
  }

  u8(): number {
    this.need(1);
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  u53(): number {
    const lo = this.u32();
    const hi = this.u32();
    const v = hi * 0x1_0000_0000 + lo;
    if (!Number.isSafeInteger(v)) throw new SaveError(`${this.what}: integer out of range`);
    return v;
  }

  str(): string {
    return decoder.decode(this.blob());
  }

  json(): unknown {
    const text = this.str();
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new SaveError(`${this.what}: invalid JSON`);
    }
  }

  /** Length-prefixed raw bytes (a copy). */
  blob(): Uint8Array {
    return this.raw(this.u32());
  }

  /** `n` raw bytes (a copy). */
  raw(n: number): Uint8Array {
    this.need(n);
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /**
   * A column written by `SaveWriter.column`, as a new array of the same type
   * as `like` (a table passes its current, empty column). Pass `length` to
   * check the element count (rows times slots per row).
   */
  column<T extends SaveColumn>(like: T, length?: number): T {
    const n = this.u32();
    if (length !== undefined && n !== length) {
      throw new SaveError(
        `${this.what}: expected ${String(length)} elements, found ${String(n)} (wrong save version?)`,
      );
    }
    const ctor = like.constructor as ColumnConstructor<T>;
    const out = new ctor(n);
    new Uint8Array(out.buffer).set(this.raw(n * out.BYTES_PER_ELEMENT));
    return out;
  }

  /** Reads a column into an existing fixed-size array (`target.length` elements). */
  columnInto(target: SaveColumn): void {
    target.set(this.column(target, target.length));
  }

  /** Adds the ids written by `SaveWriter.sparseSet` to `set`, which must be empty. */
  sparseSet(set: SparseSet): void {
    if (set.size !== 0) throw new Error('loading into a sparse set that is not empty');
    const ids = this.column(new Uint32Array(0));
    try {
      for (const id of ids) set.add(id);
    } catch (err) {
      throw new SaveError(`${this.what}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  ids(): number[] {
    const n = this.u32();
    this.need(4 * n);
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(this.u32());
    return out;
  }

  private need(n: number): void {
    if (this.pos + n > this.bytes.length) {
      throw new SaveError(`${this.what}: unexpected end of data (truncated or corrupt save)`);
    }
  }
}

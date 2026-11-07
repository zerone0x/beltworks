/**
 * Delta snapshots: the worker sends each int32 section of a snapshot (players,
 * research, entities, belts, inserters, power) as the whole section, as a
 * patch on the one it sent before, or not at all when it didn't change; the
 * main thread rebuilds the whole section from that (docs/ARCHITECTURE.md,
 * "Snapshot transfer"; docs/DECISIONS.md, D49).
 *
 * A patch is int32s: `[length, then runs of [start, count, ...count words]]`,
 * runs in ascending order and apart: the new section is the previous one
 * cut or grown to `length` words, with each run's words written at `start`.
 * Words past the previous section's end are always inside a run.
 *
 * Both sides keep the previous section of every kind, and snapshots are
 * applied in order, so they always agree on what a patch applies to (like
 * the chunk cache, src/worker/chunkStream.ts). A new game starts both over
 * (`SnapshotEncoder.reset`): its first snapshot carries every section whole.
 *
 * Nothing here touches the simulation; it only compares encoded snapshots.
 */

import { SnapshotWriter } from '../sim/snapshotWriter';
import { DELTA_SECTIONS, type DeltaSection, type SnapshotWireMessage } from './protocol';

/**
 * Equal words between two changed ones that still go into one run: a new
 * run costs two words (`start`, `count`), so gaps up to this long are
 * cheaper to resend.
 */
const RUN_JOIN = 2;

/** A growable int32 scratch buffer for building patches. */
export class Words {
  buf = new Int32Array(256);
  length = 0;

  push(v: number): void {
    if (this.length === this.buf.length) this.grow(this.length + 1);
    this.buf[this.length++] = v;
  }

  copy(from: Int32Array, start: number, end: number): void {
    const n = end - start;
    if (this.length + n > this.buf.length) this.grow(this.length + n);
    this.buf.set(from.subarray(start, end), this.length);
    this.length += n;
  }

  private grow(need: number): void {
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    const next = new Int32Array(size);
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }
}

/**
 * The patch that turns `prev` into `next`, written into `out` (from its
 * start), or `null` if `next` equals `prev`. Stops early and returns
 * `undefined` once the patch would be at least as long as `next` itself, as
 * the whole section is then the cheaper message.
 */
export function diffWords(prev: Int32Array, next: Int32Array, out: Words): true | null | undefined {
  const n = next.length;
  const common = Math.min(prev.length, n);
  out.length = 0;
  out.push(n);
  // Stop as soon as the patch is no shorter than the section.
  const limit = n;
  let i = 0;
  let changed = prev.length !== n;
  while (i < common) {
    if (prev[i] === next[i]) {
      i++;
      continue;
    }
    // A run from `i` up to the last differing word followed by more than
    // `RUN_JOIN` equal ones (or the end of the common part).
    const start = i;
    let end = i + 1;
    let j = end;
    while (j < common) {
      if (prev[j] !== next[j]) {
        end = ++j;
      } else if (j - end >= RUN_JOIN) {
        break;
      } else {
        j++;
      }
    }
    // A run that reaches the end of the common part continues with the tail.
    if (end >= common && n > common) end = n;
    out.push(start);
    out.push(end - start);
    out.copy(next, start, end);
    changed = true;
    if (out.length >= limit) return undefined;
    i = end;
  }
  if (i < n) {
    // Words past the previous section's end.
    out.push(i);
    out.push(n - i);
    out.copy(next, i, n);
  }
  if (!changed) return null;
  return out.length >= limit ? undefined : true;
}

/**
 * Applies a patch made by `diffWords` to `prev`, into a new array (`prev`
 * stays as it was: the renderer may still hold it). Throws on a malformed
 * patch.
 */
export function applyPatch(prev: Int32Array, patch: Int32Array): Int32Array<ArrayBuffer> {
  const n = patch[0];
  if (n === undefined || n < 0) throw new RangeError('snapshot patch without a length');
  const out = new Int32Array(n);
  out.set(prev.length > n ? prev.subarray(0, n) : prev);
  let covered = Math.min(prev.length, n);
  let last = 0;
  let o = 1;
  while (o < patch.length) {
    const start = patch[o]!;
    const count = patch[o + 1]!;
    o += 2;
    if (
      count === undefined ||
      start < last ||
      count <= 0 ||
      start > covered ||
      start + count > n ||
      o + count > patch.length
    ) {
      throw new RangeError('malformed snapshot patch');
    }
    out.set(patch.subarray(o, o + count), start);
    o += count;
    last = start + count;
    covered = Math.max(covered, last);
  }
  if (covered < n) throw new RangeError('snapshot patch leaves words unset');
  return out;
}

/** What `SectionEncoder.encode` sends for a section. */
export interface SectionUpdate {
  /** The whole section or a patch (transferable, the encoder keeps no reference), or `null`: unchanged. */
  buffer: ArrayBuffer | null;
  patch: boolean;
}

/** The worker's side of one section: what it sent last, and how to send the next one. */
export class SectionEncoder {
  /** The section as last sent (the main thread's copy), in `prev[0, prevLength)`. */
  private prev = new Int32Array(0);
  private prevLength = -1;
  private readonly scratch = new Words();

  /** Forgets what was sent: the next section goes whole. */
  reset(): void {
    this.prevLength = -1;
  }

  /** What to send for `next` (which may be a view of a reused buffer; it is copied). */
  encode(next: Int32Array): SectionUpdate {
    let update: SectionUpdate;
    if (this.prevLength < 0) {
      update = { buffer: next.slice().buffer, patch: false };
    } else {
      const prev = this.prev.subarray(0, this.prevLength);
      const diff = diffWords(prev, next, this.scratch);
      if (diff === null) return { buffer: null, patch: false };
      update =
        diff === undefined
          ? { buffer: next.slice().buffer, patch: false }
          : { buffer: this.scratch.buf.slice(0, this.scratch.length).buffer, patch: true };
    }
    if (this.prev.length < next.length) {
      this.prev = new Int32Array(Math.max(next.length, this.prev.length * 2));
    }
    this.prev.set(next);
    this.prevLength = next.length;
    return update;
  }
}

/** The main thread's side of one section: the latest whole section, rebuilt from each update. */
export class SectionDecoder {
  private current: ArrayBuffer | null = null;

  /** Forgets the section (a new worker stream). */
  reset(): void {
    this.current = null;
  }

  /**
   * The whole section after `buffer` (as `SectionEncoder.encode` sent it):
   * the same `ArrayBuffer` as last time when it didn't change, so consumers
   * can skip it by identity.
   */
  decode(buffer: ArrayBuffer | null, patch: boolean): ArrayBuffer {
    if (buffer === null) {
      if (!this.current) throw new Error('unchanged snapshot section before the first one');
      return this.current;
    }
    if (patch) {
      if (!this.current) throw new Error('snapshot patch before the first section');
      this.current = applyPatch(new Int32Array(this.current), new Int32Array(buffer)).buffer;
    } else {
      this.current = buffer;
    }
    return this.current;
  }
}

/** The worker's side of the delta sections: a reused writer and an encoder per section. */
export class SnapshotEncoder {
  /** Writers for the section encoders (src/sim/snapshot.ts), reused every snapshot. */
  readonly writers = sectionRecord(() => new SnapshotWriter(1024));
  private readonly sections = sectionRecord(() => new SectionEncoder());

  /** Forgets what was sent (a new game): the next snapshot carries every section whole. */
  reset(): void {
    for (const name of DELTA_SECTIONS) this.sections[name].reset();
  }

  /**
   * The wire fields for the sections `next` (whole sections, possibly views
   * of `writers`), with their buffers to transfer.
   */
  encode(next: Record<DeltaSection, Int32Array>): {
    sections: Record<DeltaSection, ArrayBuffer | null>;
    patched: number;
    transfer: ArrayBuffer[];
  } {
    const sections = {} as Record<DeltaSection, ArrayBuffer | null>;
    const transfer: ArrayBuffer[] = [];
    let patched = 0;
    DELTA_SECTIONS.forEach((name, bit) => {
      const update = this.sections[name].encode(next[name]);
      sections[name] = update.buffer;
      if (update.buffer) transfer.push(update.buffer);
      if (update.patch) patched |= 1 << bit;
    });
    return { sections, patched, transfer };
  }
}

/** The main thread's side of the delta sections. */
export class SnapshotDecoder {
  private readonly sections = sectionRecord(() => new SectionDecoder());

  /** The whole sections after `msg`; an unchanged one is the same `ArrayBuffer` as last time. */
  decode(msg: SnapshotWireMessage): Record<DeltaSection, ArrayBuffer> {
    const out = {} as Record<DeltaSection, ArrayBuffer>;
    DELTA_SECTIONS.forEach((name, bit) => {
      out[name] = this.sections[name].decode(msg[name], (msg.patched & (1 << bit)) !== 0);
    });
    return out;
  }
}

function sectionRecord<T>(make: () => T): Record<DeltaSection, T> {
  const out = {} as Record<DeltaSection, T>;
  for (const name of DELTA_SECTIONS) out[name] = make();
  return out;
}

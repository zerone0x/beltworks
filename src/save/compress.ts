/**
 * Gzip for save files (`CompressionStream`, in every supported browser,
 * their workers and Node.js). Saves are stored and exported gzipped; a save
 * that isn't (no gzip header) is read as it is, so the codec works without
 * compression too.
 */

import { SaveError } from '../sim/save/codec';

/**
 * What `gunzip` says about a file whose gzip stream is damaged (corrupt or
 * cut off), instead of the stream's own error ("Failed to fetch" in Chromium).
 */
export const DAMAGED_SAVE_MESSAGE = "The save file is damaged (its compressed data can't be read)";

/**
 * What `gunzip` throws when the data would inflate to more than its
 * `maxBytes`: a small string or file can hold a "decompression bomb" that
 * inflates to gigabytes, so readers of untrusted data set a cap.
 */
export class TooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super(`The compressed data inflates to more than ${String(maxBytes)} bytes`);
    this.name = 'TooLargeError';
  }
}

/** Whether `bytes` start with the gzip magic number. */
export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/** Whether this environment can compress (`CompressionStream` exists). */
export function canCompress(): boolean {
  return typeof CompressionStream === 'function';
}

async function pipe(
  bytes: Uint8Array,
  stream: GenericTransformStream,
): Promise<Uint8Array<ArrayBuffer>> {
  const body = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

/** Gzips `bytes`, or returns them as they are where compression is unavailable. */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return canCompress() ? pipe(bytes, new CompressionStream('gzip')) : bytes.slice();
}

/**
 * Inflates gzip `bytes` chunk by chunk, giving up (and cancelling the
 * stream, so nothing more is inflated) as soon as the output passes
 * `maxBytes`: a bomb never takes more memory than the cap and one chunk.
 */
async function inflateCapped(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const reader = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new DecompressionStream('gzip'))
    .getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new TooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Undoes `gzip`: bytes without a gzip header are returned as they are. A
 * damaged gzip stream throws a `SaveError` with `DAMAGED_SAVE_MESSAGE`.
 * With `maxBytes`, data that inflates to more than that many bytes throws a
 * `TooLargeError` instead, without inflating the rest (saves pass no cap: a
 * save can legitimately be large; blueprint strings do, src/blueprint/string.ts).
 */
export async function gunzip(bytes: Uint8Array, maxBytes?: number): Promise<Uint8Array> {
  if (!isGzip(bytes)) return bytes;
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot read compressed saves (no DecompressionStream)');
  }
  try {
    return maxBytes === undefined
      ? await pipe(bytes, new DecompressionStream('gzip'))
      : await inflateCapped(bytes, maxBytes);
  } catch (err) {
    if (err instanceof TooLargeError) throw err;
    throw new SaveError(DAMAGED_SAVE_MESSAGE, { cause: err });
  }
}

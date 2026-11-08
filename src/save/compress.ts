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
 * Undoes `gzip`: bytes without a gzip header are returned as they are. A
 * damaged gzip stream throws a `SaveError` with `DAMAGED_SAVE_MESSAGE`.
 */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isGzip(bytes)) return bytes;
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser cannot read compressed saves (no DecompressionStream)');
  }
  try {
    return await pipe(bytes, new DecompressionStream('gzip'));
  } catch (err) {
    throw new SaveError(DAMAGED_SAVE_MESSAGE, { cause: err });
  }
}

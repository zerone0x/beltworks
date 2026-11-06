/**
 * Deterministic 32-bit FNV-1a hash, used for simulation state hashes
 * (determinism tests, desync detection).
 *
 * Typed arrays are hashed over their raw bytes in platform byte order. Every
 * supported browser and Node.js runs on little-endian hardware, so hashes are
 * stable across them.
 */

export const FNV1A32_OFFSET_BASIS = 0x811c9dc5;
const FNV1A32_PRIME = 0x01000193;

/**
 * Hashes the bytes of `data`. Pass a previous result as `seed` to hash several
 * buffers as if they were concatenated:
 * `fnv1a32(b, fnv1a32(a)) === fnv1a32(concat(a, b))`.
 */
export function fnv1a32(data: ArrayBufferView, seed: number = FNV1A32_OFFSET_BASIS): number {
  const bytes =
    data instanceof Uint8Array
      ? data
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i]!, FNV1A32_PRIME);
  }
  return h >>> 0;
}

/** Hashes several buffers in order, equivalent to hashing their concatenation. */
export function hashBuffers(buffers: readonly ArrayBufferView[]): number {
  let h = FNV1A32_OFFSET_BASIS;
  for (const b of buffers) {
    h = fnv1a32(b, h);
  }
  return h;
}

import { describe, expect, it } from 'vitest';
import { FNV1A32_OFFSET_BASIS, fnv1a32, hashBuffers } from '../../src/sim/hash';

const ascii = (s: string): Uint8Array => new TextEncoder().encode(s);

describe('fnv1a32', () => {
  it.each([
    ['', 0x811c9dc5],
    ['a', 0xe40c292c],
    ['foobar', 0xbf9cf968],
  ])('matches the reference value for %j', (input, expected) => {
    expect(fnv1a32(ascii(input))).toBe(expected);
  });

  it('hashes all byte values', () => {
    const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fnv1a32(bytes)).toBe(0x90a458c5);
  });

  it('hashes the little-endian bytes of other typed arrays', () => {
    expect(fnv1a32(Uint32Array.of(1, 2, 3))).toBe(0x794671b5);
    expect(fnv1a32(Int32Array.of(-1, 0x12345678))).toBe(0x55de7241);
  });

  it('respects byteOffset and byteLength of views', () => {
    const backing = ascii('xxfoobarxx');
    expect(fnv1a32(backing.subarray(2, 8))).toBe(0xbf9cf968);
    expect(fnv1a32(new DataView(backing.buffer, 2, 6))).toBe(0xbf9cf968);
  });

  it('can be chained to hash a concatenation', () => {
    expect(fnv1a32(ascii('bar'), fnv1a32(ascii('foo')))).toBe(fnv1a32(ascii('foobar')));
    expect(hashBuffers([ascii('fo'), ascii('ob'), ascii('ar')])).toBe(0xbf9cf968);
    expect(hashBuffers([])).toBe(FNV1A32_OFFSET_BASIS);
  });

  it('always returns a uint32', () => {
    const h = fnv1a32(Float64Array.of(Math.PI, -0, 1e300));
    expect(Number.isInteger(h) && h >= 0 && h <= 0xffffffff).toBe(true);
  });
});

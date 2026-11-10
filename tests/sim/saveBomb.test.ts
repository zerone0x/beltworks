/**
 * Reading a save is capped (D69): a gzip bomb is refused with the normal
 * "can't load this save" error, and the largest real save still loads.
 */

import { describe, expect, it } from 'vitest';
import { SCENES } from '../../tools/bench/scenes';
import { MAX_SAVE_BYTES, SAVE_TOO_LARGE_MESSAGE, gunzipSave, gzip } from '../../src/save/compress';
import { SaveError } from '../../src/sim/save/codec';
import { loadSim, saveSim } from '../../src/sim/save/save';

/** Gzip of `bytes` zero bytes, fed through the compressor 1 MiB at a time (the input is never in memory). */
async function zeroBomb(bytes: number): Promise<Uint8Array> {
  const chunk = new Uint8Array(1 << 20);
  let left = bytes;
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    pull(controller) {
      if (left <= 0) return controller.close();
      const n = Math.min(left, chunk.length);
      left -= n;
      controller.enqueue(n === chunk.length ? chunk : chunk.subarray(0, n));
    },
  });
  const body = source.pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(body).arrayBuffer());
}

describe('save decompression cap', () => {
  it('refuses a gzip bomb over the cap with a SaveError', async () => {
    const bomb = await zeroBomb(MAX_SAVE_BYTES * 4);
    expect(bomb.length).toBeLessThan(2 << 20);
    const err: unknown = await gunzipSave(bomb).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SaveError);
    expect((err as SaveError).message).toBe(SAVE_TOO_LARGE_MESSAGE);
  }, 60000);

  it('reads a save just under the cap', async () => {
    const zeros = await gzip(new Uint8Array(1 << 20));
    expect((await gunzipSave(zeros)).length).toBe(1 << 20);
  });

  it('still round-trips the largest bench scene (50k)', async () => {
    const scene = SCENES[SCENES.length - 1];
    if (!scene) throw new Error('no bench scenes');
    const raw = saveSim(scene.build().sim);
    expect(raw.length).toBeLessThan(MAX_SAVE_BYTES / 16);
    const back = await gunzipSave(await gzip(raw));
    expect(back).toEqual(raw);
    expect(saveSim(loadSim(back))).toEqual(raw);
  }, 300000);
});

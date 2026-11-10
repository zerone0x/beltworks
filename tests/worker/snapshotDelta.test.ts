import { describe, expect, it } from 'vitest';
import {
  encodeBelts,
  encodeEntities,
  encodeInserters,
  encodePlayers,
  encodePower,
  encodeResearch,
} from '../../src/sim/snapshot';
import { ScratchSet, SnapshotWriter } from '../../src/sim/snapshotWriter';
import { DELTA_SECTIONS, type SnapshotWireMessage } from '../../src/worker/protocol';
import {
  SectionDecoder,
  SectionEncoder,
  SnapshotDecoder,
  SnapshotEncoder,
  Words,
  applyPatch,
  diffWords,
} from '../../src/worker/snapshotDelta';
import { factory1k } from '../../tools/bench/scenes/factory1k';
import { sceneRange } from '../../tools/bench/snapshot';

/** A small deterministic generator for test data. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

/** The patch from `prev` to `next`, as an array (`null`: equal, `undefined`: whole is shorter). */
function diff(prev: number[], next: number[]): Int32Array | null | undefined {
  const out = new Words();
  const r = diffWords(Int32Array.from(prev), Int32Array.from(next), out);
  return r === true ? out.buf.slice(0, out.length) : r;
}

describe('diffWords and applyPatch', () => {
  it('turn one section into the next', () => {
    const prev = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
    const next = prev.slice();
    next[1] = 20;
    next[12] = 130;
    const patch = diff(prev, next)!;
    // Two runs of one word each, far apart.
    expect(Array.from(patch)).toEqual([16, 1, 1, 20, 12, 1, 130]);
    expect(Array.from(applyPatch(Int32Array.from(prev), patch))).toEqual(next);
  });

  it('joins changes close together into one run', () => {
    const prev = Array.from({ length: 32 }, (_, i) => i);
    const next = prev.slice();
    next[4] = -1;
    next[7] = -1; // two equal words between: cheaper in the same run
    const patch = diff(prev, next)!;
    expect(Array.from(patch)).toEqual([32, 4, 4, -1, 5, 6, -1]);
  });

  it('grows and shrinks sections', () => {
    const prev = Array.from({ length: 40 }, (_, i) => i);
    const grown = [...prev, 100, 101];
    const p1 = diff(prev, grown)!;
    expect(Array.from(p1)).toEqual([42, 40, 2, 100, 101]);
    expect(Array.from(applyPatch(Int32Array.from(prev), p1))).toEqual(grown);
    const shrunk = prev.slice(0, 30);
    const p2 = diff(prev, shrunk)!;
    expect(Array.from(p2)).toEqual([30]);
    expect(Array.from(applyPatch(Int32Array.from(prev), p2))).toEqual(shrunk);
    // A change at the end of the common part runs on into the new words.
    const tail = [...prev.slice(0, 39), -5, 7, 8];
    const p3 = diff(prev, tail)!;
    expect(Array.from(p3)).toEqual([42, 39, 3, -5, 7, 8]);
  });

  it('says when nothing changed, and when the whole section is cheaper', () => {
    expect(diff([1, 2, 3], [1, 2, 3])).toBeNull();
    expect(diff([], [])).toBeNull();
    expect(diff([1, 2, 3, 4], [5, 6, 7, 8])).toBeUndefined();
    expect(diff([], [1])).toBeUndefined();
  });

  it('round-trips random edits', () => {
    const rand = lcg(75);
    for (let round = 0; round < 500; round++) {
      const n = rand() % 200;
      const prev = Array.from({ length: n }, () => rand() % 7);
      const next = prev.slice(0, n + (rand() % 21) - 10);
      while (next.length < n + 5 && rand() % 2) next.push(rand() % 7);
      const edits = rand() % 12;
      for (let e = 0; e < edits && next.length > 0; e++) next[rand() % next.length] = rand() % 7;
      const out = new Words();
      const r = diffWords(Int32Array.from(prev), Int32Array.from(next), out);
      if (r === null) {
        expect(next).toEqual(prev);
      } else if (r === true) {
        expect(out.length).toBeLessThan(Math.max(1, next.length));
        const patch = out.buf.slice(0, out.length);
        expect(Array.from(applyPatch(Int32Array.from(prev), patch))).toEqual(next);
      }
    }
  });

  it('leaves the previous section as it was', () => {
    const prev = Int32Array.from([1, 2, 3, 4, 5, 6, 7, 8]);
    applyPatch(prev, Int32Array.from([8, 7, 1, 70]));
    expect(Array.from(prev)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('rejects malformed patches', () => {
    const prev = Int32Array.from([1, 2, 3, 4]);
    const bad = [
      [], // no length
      [-1],
      [4, 3, 2, 9], // run past the end of the section
      [4, 2, 1, 9, 1, 1, 9], // runs out of order
      [4, 0, 0], // empty run
      [6, 5, 1, 9], // words 4 left unset
      [4, 0, 3, 9], // run longer than the patch
    ];
    for (const p of bad) expect(() => applyPatch(prev, Int32Array.from(p))).toThrow(RangeError);
  });
});

describe('section encoder and decoder', () => {
  it('send a section whole, then patches, then nothing while it stays the same', () => {
    const enc = new SectionEncoder();
    const dec = new SectionDecoder();
    const a = Int32Array.from({ length: 64 }, (_, i) => i);
    const first = enc.encode(a);
    expect(first.patch).toBe(false);
    const whole = dec.decode(first.buffer, first.patch);
    expect(Array.from(new Int32Array(whole))).toEqual(Array.from(a));
    // The encoder copied it: changing the source doesn't change what it remembers.
    a[3] = 99;
    const second = enc.encode(a);
    expect(second.patch).toBe(true);
    expect(second.buffer!.byteLength).toBeLessThan(a.byteLength);
    const patched = dec.decode(second.buffer, second.patch);
    expect(patched).not.toBe(whole);
    expect(new Int32Array(patched)[3]).toBe(99);
    expect(new Int32Array(whole)[3]).toBe(3);
    const third = enc.encode(a);
    expect(third.buffer).toBeNull();
    // Unchanged: the very same buffer.
    expect(dec.decode(third.buffer, third.patch)).toBe(patched);
    enc.reset();
    expect(enc.encode(a).patch).toBe(false);
  });

  it('refuses updates without a section to apply them to', () => {
    const dec = new SectionDecoder();
    expect(() => dec.decode(null, false)).toThrow();
    expect(() => dec.decode(new Int32Array([1]).buffer, true)).toThrow();
  });
});

describe('snapshot deltas on a running factory', () => {
  it('rebuild exactly the sections the worker encoded, tick after tick', () => {
    const { sim } = factory1k.build();
    const range = sceneRange(sim);
    const encoder = new SnapshotEncoder();
    const decoder = new SnapshotDecoder();
    const w = encoder.writers;
    const kinds = { whole: 0, patch: 0, same: 0 };
    let sent = 0;
    let whole = 0;
    for (let tick = 0; tick < 120; tick++) {
      sim.step();
      const wire = encoder.encode({
        players: encodePlayers(sim.state, w.players),
        research: encodeResearch(sim.state, 0, w.research),
        entities: encodeEntities(sim.state, range, w.entities),
        belts: encodeBelts(sim.state, range, w.belts),
        inserters: encodeInserters(sim.state, range, w.inserters),
        power: encodePower(sim.state, range, w.power),
      });
      for (const b of wire.transfer) sent += b.byteLength;
      const msg = structuredClone(
        { ...wire.sections, patched: wire.patched },
        { transfer: wire.transfer },
      );
      const sections = decoder.decode(msg as unknown as SnapshotWireMessage);
      // What a fresh, whole encoding of the same tick gives.
      const expected = {
        players: encodePlayers(sim.state),
        research: encodeResearch(sim.state, 0),
        entities: encodeEntities(sim.state, range),
        belts: encodeBelts(sim.state, range),
        inserters: encodeInserters(sim.state, range),
        power: encodePower(sim.state, range),
      };
      DELTA_SECTIONS.forEach((name, bit) => {
        expect(new Int32Array(sections[name]), `${name} at tick ${String(sim.tick)}`).toEqual(
          expected[name],
        );
        whole += sections[name].byteLength;
        if (wire.sections[name] === null) kinds.same++;
        else if (wire.patched & (1 << bit)) kinds.patch++;
        else kinds.whole++;
      });
    }
    // Only the first snapshot is whole; most of what follows is patches or nothing.
    expect(kinds.whole).toBe(DELTA_SECTIONS.length);
    expect(kinds.patch).toBeGreaterThan(0);
    expect(kinds.same).toBeGreaterThan(0);
    expect(sent).toBeLessThan(whole / 4);
  });
});

describe('SnapshotWriter', () => {
  it('grows, fills in skipped words and keeps its memory across resets', () => {
    const w = new SnapshotWriter(16);
    const at = w.skip(1);
    for (let i = 0; i < 100; i++) w.push(i);
    w.set(at, 100);
    expect(w.length).toBe(101);
    const view = w.view();
    expect(view[0]).toBe(100);
    expect(view[100]).toBe(99);
    const copy = w.take();
    expect(copy.buffer.byteLength).toBe(101 * 4);
    w.reset();
    w.push(7);
    expect(Array.from(w.view())).toEqual([7]);
    // The view shares the writer's memory; `take` doesn't.
    expect(view.buffer).toBe(w.view().buffer);
    expect(copy[0]).toBe(100);
  });
});

describe('ScratchSet', () => {
  it('adds, finds, sorts and empties without forgetting stale entries wrongly', () => {
    const set = new ScratchSet();
    for (let i = 0; i < 100; i++) expect(set.add(1000 - i * 7)).toBe(i);
    expect(set.add(1000)).toBe(0);
    expect(set.size).toBe(100);
    expect(set.has(993)).toBe(true);
    expect(set.has(994)).toBe(false);
    set.sort();
    const sorted = Array.from(set.values.subarray(0, set.size));
    expect(sorted).toEqual([...sorted].sort((a, b) => a - b));
    expect(set.indexOf(307)).toBe(0);
    expect(set.indexOf(1000)).toBe(99);
    // Emptied, the old values are gone even though the map still has them.
    set.clear();
    expect(set.size).toBe(0);
    expect(set.has(1000)).toBe(false);
    expect(set.add(5)).toBe(0);
    expect(set.add(1000)).toBe(1);
    expect(set.has(307)).toBe(false);
    expect(Array.from(set.values.subarray(0, set.size))).toEqual([5, 1000]);
  });

  it('sorts any number of values, keeping every index right', () => {
    const next = lcg(7);
    for (const size of [0, 1, 2, 3, 17, 64, 65, 1000]) {
      const set = new ScratchSet();
      const added: number[] = [];
      while (set.size < size) {
        const v = (next() % 100_000) - 50_000;
        if (!set.has(v)) added.push(v);
        set.add(v);
      }
      set.sort();
      const sorted = Array.from(set.values.subarray(0, set.size));
      expect(sorted).toEqual(added.sort((a, b) => a - b));
      sorted.forEach((v, i) => expect(set.indexOf(v)).toBe(i));
    }
  });
});

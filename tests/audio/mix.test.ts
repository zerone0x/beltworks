import { describe, expect, it } from 'vitest';
import {
  MAX_DISTANCE,
  MAX_LOOP_VOICES,
  MAX_ONE_SHOTS,
  ONE_SHOT_LIMITS,
  OneShotLimiter,
  REF_DISTANCE,
  attenuation,
  beltHum,
  panFor,
  positional,
  selectLoopVoices,
  zoomGain,
} from '../../src/audio/mix';
import type { LoopSource } from '../../src/audio/events';
import { COMPRESSOR, OUTPUT_TRIM } from '../../src/audio/engine';
import { peakOf, scheduleLoudestMix, seededRandom } from '../../src/audio/loudestMix';
import { FakeAudioContext, FakeSource, type FakeNode, type FakeParam } from './fakeAudioContext';

const listener = { x: 0, y: 0, zoom: 1 };

describe('distance attenuation', () => {
  it('is full near the listener and silent past the maximum distance', () => {
    expect(attenuation(0)).toBe(1);
    expect(attenuation(REF_DISTANCE)).toBe(1);
    expect(attenuation(MAX_DISTANCE)).toBe(0);
    expect(attenuation(MAX_DISTANCE * 3)).toBe(0);
  });

  it('never gets louder further away', () => {
    let last = 1;
    for (let d = 0; d <= MAX_DISTANCE + 1; d += 0.25) {
      const g = attenuation(d);
      expect(g).toBeLessThanOrEqual(last);
      expect(g).toBeGreaterThanOrEqual(0);
      last = g;
    }
    expect(attenuation(2 * REF_DISTANCE)).toBeCloseTo(0.5);
  });

  it('is a little quieter zoomed out, and pans with the horizontal offset', () => {
    expect(zoomGain(1)).toBe(1);
    expect(zoomGain(4)).toBe(1);
    expect(zoomGain(0.25)).toBe(0.5);
    expect(panFor(0)).toBe(0);
    expect(panFor(12)).toBeGreaterThan(0);
    expect(panFor(-1000)).toBe(-0.7);
    const right = positional(listener, 8, 0);
    const far = positional(listener, 0, 30);
    expect(right.pan).toBeGreaterThan(0);
    expect(far.gain).toBeLessThan(right.gain);
  });
});

describe('loop voice selection', () => {
  const machines: LoopSource[] = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    kind: 'assembler',
    x: 24 - i, // id 20 is nearest, all past REF_DISTANCE
    y: 0,
  }));

  it(`gives at most ${String(MAX_LOOP_VOICES)} voices to the nearest machines, loudest first`, () => {
    const voices = selectLoopVoices(machines, listener);
    expect(voices).toHaveLength(MAX_LOOP_VOICES);
    expect(voices.map((v) => v.id)).toEqual([20, 19, 18, 17, 16, 15, 14, 13]);
    for (let i = 1; i < voices.length; i++) {
      expect(voices[i]!.gain).toBeLessThanOrEqual(voices[i - 1]!.gain);
    }
  });

  it('drops inaudible machines and breaks ties by id', () => {
    expect(
      selectLoopVoices([{ id: 1, kind: 'drill', x: MAX_DISTANCE + 5, y: 0 }], listener),
    ).toEqual([]);
    const tied = selectLoopVoices(
      [
        { id: 9, kind: 'lab', x: 1, y: 0 },
        { id: 3, kind: 'lab', x: -1, y: 0 },
      ],
      listener,
      1,
    );
    expect(tied.map((v) => v.id)).toEqual([3]);
  });

  it('makes the belts hum louder with more belts nearby, but never above 1', () => {
    const near = (n: number) => Array.from({ length: n }, (_, i) => ({ x: i % 3, y: 0 }));
    const one = beltHum(near(1), listener)!.gain;
    const many = beltHum(near(50), listener)!.gain;
    expect(many).toBeGreaterThan(one);
    expect(many).toBeLessThanOrEqual(1);
    expect(beltHum([], listener)).toBeNull();
    expect(beltHum([{ x: 100, y: 100 }], listener)).toBeNull();
  });
});

describe('OneShotLimiter', () => {
  it('spaces repeats of a kind and caps them', () => {
    const l = new OneShotLimiter(12);
    expect(l.tryStart('inserter', 0, 0.3)).toBe(true);
    expect(l.tryStart('inserter', 0.01, 0.3)).toBe(false); // too soon
    const gap = ONE_SHOT_LIMITS.inserter.minGap;
    let t = gap;
    for (let i = 1; i < ONE_SHOT_LIMITS.inserter.maxActive; i++, t += gap) {
      expect(l.tryStart('inserter', t, 0.3)).toBe(true);
    }
    expect(l.tryStart('inserter', t, 0.3)).toBe(false); // all its voices busy
    expect(l.tryStart('place', t, 0.3)).toBe(true); // other kinds still play
    expect(l.tryStart('inserter', t + 1, 0.3)).toBe(true); // the earlier ones ended
  });

  it('caps all kinds together', () => {
    const l = new OneShotLimiter(2);
    expect(l.tryStart('place', 0, 1)).toBe(true);
    expect(l.tryStart('remove', 0, 1)).toBe(true);
    expect(l.tryStart('ui-click', 0, 1)).toBe(false);
    expect(l.activeAt(0.5)).toBe(2);
  });
});

describe('the output stage (no clipping at 100%)', () => {
  it('sends the loudest mix through the compressor and the trim, at 100% on every bus', () => {
    const ctx = new FakeAudioContext();
    const started = scheduleLoudestMix(ctx.asReal, seededRandom(7));
    // Every burst starts as many one-shots as the limiter allows: the cap.
    expect(started).toBe(3 * MAX_ONE_SHOTS);
    const [compressor] = ctx.nodesOf('compressor');
    const c = compressor as unknown as Record<keyof typeof COMPRESSOR, FakeParam>;
    for (const key of Object.keys(COMPRESSOR) as (keyof typeof COMPRESSOR)[]) {
      expect(c[key].value).toBe(COMPRESSOR[key]);
    }
    expect(compressor!.connections).toHaveLength(1);
    const trim = compressor!.connections[0] as FakeNode & { gain: FakeParam };
    expect(trim.gain.value).toBe(OUTPUT_TRIM);
    expect(trim.connections).toEqual([ctx.destination]);
    // Nothing reaches the speakers but through the trim.
    expect(ctx.nodes.filter((n) => n.connections.includes(ctx.destination))).toEqual([trim]);
    const [master, sfx, music] = ctx.nodesOf('gain') as (FakeNode & { gain: FakeParam })[];
    expect([master!.gain.value, sfx!.gain.value, music!.gain.value]).toEqual([1, 1, 1]);
    // The loops keep playing to the end.
    const running = [...ctx.nodesOf('oscillator'), ...ctx.nodesOf('buffer-source')].filter(
      (n) => (n as FakeSource).startedAt === 0 && (n as FakeSource).stoppedAt === null,
    );
    expect(running.length).toBeGreaterThan(MAX_LOOP_VOICES);
    // Rendered for real (tests/e2e/audio.spec.ts) this peaks at 0.75: 1.53 before the trim.
    expect(OUTPUT_TRIM).toBeLessThan(1);
  });

  it('measures the peak over every channel', () => {
    const channels = [new Float32Array([0.1, -0.4, 0.2]), new Float32Array([0.3, 0.95, -0.97])];
    const buffer = {
      numberOfChannels: 2,
      getChannelData: (i: number) => channels[i]!,
    } as unknown as AudioBuffer;
    expect(peakOf(buffer)).toBeCloseTo(0.97, 6);
  });
});

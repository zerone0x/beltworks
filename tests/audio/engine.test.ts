import { describe, expect, it } from 'vitest';
import { AudioEngine } from '../../src/audio/engine';
import type { LoopSource, SoundEventKind } from '../../src/audio/events';
import { MAX_LOOP_VOICES } from '../../src/audio/mix';
import { FADE_IN, FADE_OUT, MusicDirector } from '../../src/audio/music';
import { createLoop, playOneShot } from '../../src/audio/synth';
import { DEFAULT_AUDIO_SETTINGS, followVolumeSettings, volumeToGain } from '../../src/audio/volume';
import { DEFAULT_SETTINGS, SettingsStore } from '../../src/ui/settings';
import {
  FakeAudioContext,
  FakeSource,
  reaches,
  type FakeNode,
  type FakeParam,
} from './fakeAudioContext';

const listener = { x: 0, y: 0, zoom: 1 };

/** A fixed sequence of pseudo-random numbers. */
function seeded(seed = 1): () => number {
  let s = seed;
  return () => {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    return s / 2 ** 32;
  };
}

function setup() {
  const ctx = new FakeAudioContext();
  let made = 0;
  const engine = new AudioEngine({
    createContext: () => {
      made++;
      return ctx.asReal;
    },
    random: seeded(),
  });
  return { ctx, engine, made: () => made };
}

const gainOf = (n: FakeNode) => (n as unknown as { gain: FakeParam }).gain;

describe('AudioEngine', () => {
  it('makes no context and plays nothing before a gesture unlocks it', () => {
    const { engine, made } = setup();
    expect(engine.play({ kind: 'place', x: 0, y: 0 }, listener)).toBe(false);
    engine.updateLoops([{ id: 1, kind: 'furnace', x: 0, y: 0 }], [], listener);
    engine.update();
    expect(made()).toBe(0);
    expect(engine.debugState()).toMatchObject({
      unlocked: false,
      contextState: null,
      wired: false,
    });
  });

  it('builds the buses on unlock, wired to the destination, with the volumes as gains', () => {
    const { ctx, engine, made } = setup();
    engine.setVolumes({ master: 50, sfx: 100, music: 0 });
    expect(engine.unlock()).toBe(true);
    expect(engine.unlock()).toBe(true);
    expect(made()).toBe(1);
    const gains = ctx.nodesOf('gain');
    const [master, sfx, music] = gains;
    for (const bus of [master!, sfx!, music!]) expect(reaches(bus, ctx.destination)).toBe(true);
    expect(reaches(sfx!, master!)).toBe(true);
    expect(reaches(music!, master!)).toBe(true);
    expect(gainOf(master!).value).toBe(volumeToGain(50));
    expect(gainOf(music!).value).toBe(0);
    expect(engine.debugState()).toMatchObject({
      unlocked: true,
      contextState: 'running',
      wired: true,
      gains: { master: 0.25, sfx: 1, music: 0 },
    });
  });

  it('stays silent where there is no WebAudio', () => {
    const engine = new AudioEngine({ createContext: () => null });
    expect(engine.unlock()).toBe(false);
    expect(engine.play({ kind: 'ui-click' }, listener)).toBe(false);
  });

  it('mutes and suspends while the tab is hidden, and comes back when it shows', () => {
    const { ctx, engine } = setup();
    engine.unlock();
    const master = ctx.nodesOf('gain')[0]!;
    engine.setHidden(true);
    expect(ctx.state).toBe('suspended');
    expect(gainOf(master).value).toBe(0);
    expect(engine.play({ kind: 'ui-click' }, listener)).toBe(false);
    engine.setHidden(false);
    expect(ctx.state).toBe('running');
    expect(gainOf(master).value).toBe(volumeToGain(DEFAULT_AUDIO_SETTINGS.master));
    expect(engine.play({ kind: 'ui-click' }, listener)).toBe(true);
  });

  it('starts suspended when unlocked in a hidden tab', () => {
    const { ctx, engine } = setup();
    engine.setHidden(true);
    engine.unlock();
    expect(ctx.state).toBe('suspended');
  });

  it('plays positional one-shots into the effects bus, skipping inaudible ones', () => {
    const { ctx, engine } = setup();
    engine.unlock();
    const sfx = ctx.nodesOf('gain')[1]!;
    const before = ctx.nodes.length;
    expect(engine.play({ kind: 'place', x: 500, y: 0 }, listener)).toBe(false);
    expect(ctx.nodes.length).toBe(before);
    expect(engine.play({ kind: 'place', x: 6, y: 0 }, listener)).toBe(true);
    const made = ctx.nodes.slice(before);
    const sources = made.filter((n): n is FakeSource => n instanceof FakeSource);
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      expect(reaches(s, sfx)).toBe(true);
      expect(s.stoppedAt).toBeGreaterThan(s.startedAt!);
    }
    // Off to the right: panned right.
    const panner = made.find((n) => n.kind === 'panner') as unknown as { pan: FakeParam };
    expect(panner.pan.value).toBeGreaterThan(0);
    expect(engine.debugState().played).toEqual({ place: 1 });
  });

  it('plays no effects with the effects volume at 0', () => {
    const { engine } = setup();
    engine.unlock();
    engine.setVolumes({ master: 100, sfx: 0, music: 100 });
    expect(engine.play({ kind: 'craft-done' }, listener)).toBe(false);
  });

  it('caps machine loops to the nearest ones, quieter with distance, and fades out the rest', () => {
    const { ctx, engine } = setup();
    engine.unlock();
    const machines: LoopSource[] = Array.from({ length: 20 }, (_, i) => ({
      id: i + 1,
      kind: 'drill',
      x: 5 + i * 2, // past REF_DISTANCE, further and further
      y: 0,
    }));
    engine.updateLoops(machines, [{ x: 1, y: 1 }], listener);
    expect(engine.loopCount).toBe(MAX_LOOP_VOICES + 1);
    expect(engine.debugState().loops).toEqual({ drill: MAX_LOOP_VOICES, belts: 1 });

    // The loop voices' gains: the node right before each panner.
    const panners = ctx.nodesOf('panner');
    const voiceGains = ctx.nodes
      .filter((n) => n.kind === 'gain' && panners.includes(n.connections[0] as FakeNode))
      .map((n) => gainOf(n).value);
    const drills = voiceGains.slice(0, MAX_LOOP_VOICES);
    for (let i = 1; i < drills.length; i++) expect(drills[i]!).toBeLessThan(drills[i - 1]!);

    // Everything moves away: all voices stop (fade out, then the sources end).
    const sourcesBefore = ctx.nodes.filter((n): n is FakeSource => n instanceof FakeSource);
    engine.updateLoops([], [], listener);
    expect(engine.loopCount).toBe(0);
    for (const s of sourcesBefore.filter((s) => s.loop || s.kind === 'oscillator')) {
      expect(s.stoppedAt).not.toBeNull();
    }
  });

  it('keeps the same voice for a machine across updates', () => {
    const { ctx, engine } = setup();
    engine.unlock();
    const furnace: LoopSource = { id: 7, kind: 'furnace', x: 3, y: 0 };
    engine.updateLoops([furnace], [], listener);
    const n = ctx.nodes.length;
    engine.updateLoops([{ ...furnace, x: 5 }], [], listener);
    expect(ctx.nodes.length).toBe(n);
    expect(engine.loopCount).toBe(1);
  });
});

describe('synth', () => {
  const kinds: SoundEventKind[] = [
    'place',
    'remove',
    'mine-hit',
    'mined',
    'craft-done',
    'inserter',
    'research-complete',
    'low-power',
    'ui-click',
  ];

  it.each(kinds)('%s: every node reaches the output and stops by the returned length', (kind) => {
    const ctx = new FakeAudioContext();
    const out = ctx.createGain();
    const len = playOneShot(ctx.asReal, out as unknown as AudioNode, kind, 1, 1, seeded());
    expect(len).toBeGreaterThan(0);
    expect(len).toBeLessThan(2);
    const sources = ctx.nodes.filter((n): n is FakeSource => n instanceof FakeSource);
    expect(sources.length).toBeGreaterThan(0);
    for (const s of sources) {
      expect(reaches(s, out)).toBe(true);
      expect(s.startedAt).toBeGreaterThanOrEqual(1);
      expect(s.stoppedAt!).toBeLessThanOrEqual(1 + len + 1e-9);
    }
  });

  it.each(['furnace', 'drill', 'assembler', 'lab', 'boiler', 'engine', 'belts'] as const)(
    '%s loop starts silent and runs until stopped',
    (kind) => {
      const ctx = new FakeAudioContext();
      const out = ctx.createGain();
      const voice = createLoop(ctx.asReal, out as unknown as AudioNode, kind, 0);
      const sources = ctx.nodes.filter((n): n is FakeSource => n instanceof FakeSource);
      expect(sources.length).toBeGreaterThan(0);
      for (const s of sources) {
        expect(s.startedAt).toBe(0);
        expect(s.stoppedAt).toBeNull();
      }
      expect((voice.gain as unknown as { gain: FakeParam }).gain.value).toBe(0);
      expect(reaches(voice.pan as unknown as FakeNode, out)).toBe(true);
      voice.stop(2);
      for (const s of sources) expect(s.stoppedAt).toBeGreaterThan(2);
    },
  );
});

describe('MusicDirector', () => {
  it('waits, fades a track in and out, then leaves a silent gap before the next', () => {
    const ctx = new FakeAudioContext();
    const out = ctx.createGain();
    const music = new MusicDirector(ctx.asReal, out as unknown as AudioNode, seeded(3));
    expect(music.phase).toBe('gap');
    const start = music.nextChange;
    expect(start).toBeGreaterThan(0);

    const run = (until: number) => {
      for (; ctx.currentTime < until; ctx.currentTime += 1 / 30) music.update(ctx.currentTime);
    };
    run(start - 2);
    expect(music.tracksStarted).toBe(0);
    run(start + 0.5);
    expect(music.phase).toBe('playing');
    expect(music.tracksStarted).toBe(1);
    const first = music.track;
    const end = music.nextChange;
    expect(end - start).toBeGreaterThan(60);

    // The track's gain: up from silence over FADE_IN, down to silence over FADE_OUT.
    const trackGain = ctx.nodes.find(
      (n) => n.kind === 'gain' && gainOf(n).events.some((e) => e.type === 'exp' && e.value === 1),
    )!;
    const events = gainOf(trackGain).events;
    expect(events[0]).toMatchObject({ type: 'set', time: start });
    expect(events[1]).toMatchObject({ type: 'exp', value: 1, time: start + FADE_IN });
    expect(events.at(-1)).toMatchObject({ type: 'exp', time: end });
    expect(events.at(-1)!.value).toBeLessThan(0.001);
    expect(events.at(-2)).toMatchObject({ type: 'set', value: 1, time: end - FADE_OUT });

    run(end + 1);
    expect(music.phase).toBe('gap');
    // Notes only inside the track.
    const notes = ctx.nodes.filter((n): n is FakeSource => n instanceof FakeSource);
    expect(notes.length).toBeGreaterThan(50);
    for (const n of notes) {
      expect(n.startedAt!).toBeGreaterThanOrEqual(start);
      expect(n.startedAt!).toBeLessThan(end);
    }

    const next = music.nextChange;
    expect(next - end).toBeGreaterThanOrEqual(30);
    const count = ctx.nodes.length;
    run(next - 2);
    expect(ctx.nodes.length).toBe(count); // silence
    run(next + 1);
    expect(music.tracksStarted).toBe(2);
    expect(music.track).not.toBe(first);
  });

  it('skips chords it missed instead of playing them all at once', () => {
    const ctx = new FakeAudioContext();
    const out = ctx.createGain();
    const music = new MusicDirector(ctx.asReal, out as unknown as AudioNode, seeded(5));
    ctx.currentTime = music.nextChange + 0.1;
    music.update();
    ctx.currentTime += 40; // no frames for 40 s
    const before = ctx.nodes.filter((n) => n instanceof FakeSource).length;
    music.update();
    const played = ctx.nodes.filter((n) => n instanceof FakeSource).length - before;
    // At most a chord or two (pads, bass, bells), not five.
    expect(played).toBeLessThan(25);
  });
});

describe('volumes from the settings', () => {
  it('applies the settings’ volumes at start and every change to them, live', () => {
    const { ctx, engine } = setup();
    const settings = new SettingsStore();
    settings.update((s) => ({ ...s, audio: { master: 40, sfx: 100, music: 60 } }));
    const stop = followVolumeSettings(engine, settings);
    engine.unlock();
    expect(engine.debugState().gains).toEqual({
      master: volumeToGain(40),
      sfx: 1,
      music: volumeToGain(60),
    });
    const [master, sfx, music] = ctx.nodesOf('gain');
    const bus = { master: master!, sfx: sfx!, music: music! };
    for (const [key, value] of [
      ['master', 100],
      ['sfx', 25],
      ['music', 0],
    ] as const) {
      settings.update((s) => ({ ...s, audio: { ...s.audio, [key]: value } }));
      // The bus glides to the new gain on the audio clock.
      expect(gainOf(bus[key]).events.at(-1)).toMatchObject({
        type: 'target',
        value: volumeToGain(value),
      });
      expect(engine.debugState().gains[key]).toBe(volumeToGain(value));
    }
    // Other settings leave the volumes alone; unsubscribing stops following.
    const before = gainOf(bus.master).events.length;
    settings.update((s) => ({ ...s, uiScale: 2 }));
    expect(gainOf(bus.master).events.length).toBe(before);
    stop();
    settings.update((s) => ({ ...s, audio: DEFAULT_SETTINGS.audio }));
    expect(engine.debugState().gains.master).toBe(1);
  });

  it('starts from the settings’ default volumes', () => {
    expect(DEFAULT_AUDIO_SETTINGS).toEqual(DEFAULT_SETTINGS.audio);
  });

  it('maps volume to gain on a squared curve', () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(50)).toBe(0.25);
    expect(volumeToGain(100)).toBe(1);
    expect(volumeToGain(150)).toBe(1);
  });
});

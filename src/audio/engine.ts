/**
 * The audio engine (D55): owns the `AudioContext` and the mixing graph,
 *
 * ```
 * one-shots ─┐
 * loops ─────┴► sfx ─┐
 * music ──────► music┴► master ─► compressor ─► trim ─► destination
 * ```
 *
 * and plays what the game asks for. There is no context, and so no sound,
 * until `unlock()` is called from a user gesture (browsers' autoplay rules);
 * `setHidden(true)` mutes and suspends it while the tab is hidden. The
 * volumes come from the settings (`setVolumes`, see src/audio/volume.ts).
 */

import type { LoopSource, SoundEvent, SoundEventKind } from './events';
import {
  MAX_LOOP_VOICES,
  OneShotLimiter,
  beltHum,
  positional,
  selectLoopVoices,
  type Listener,
  MIN_AUDIBLE_GAIN,
} from './mix';
import { MusicDirector, type MusicPhase } from './music';
import { createLoop, playOneShot, type LoopVoice, type Random } from './synth';
import { DEFAULT_AUDIO_SETTINGS, volumeToGain, type AudioSettings } from './volume';

/** Each machine loop's volume at full gain (eight of them shouldn't drown everything else). */
export const LOOP_LEVEL = 0.3;
/** The belts' hum at full gain. */
export const BELT_LEVEL = 0.25;
/**
 * The output compressor. A 12 dB knee (WebAudio's default is 30) leaves
 * quiet sounds alone, and a 1 ms attack (default 3 ms) catches the onsets of
 * many one-shots at once, which the default let through.
 */
export const COMPRESSOR = { threshold: -12, knee: 12, ratio: 4, attack: 0.001 } as const;
/**
 * Gain after the compressor, which adds makeup gain of its own: without it
 * the loudest mix (every voice at once at 100%, src/audio/loudestMix.ts)
 * peaked at 1.53 and clipped; with it, at 0.75.
 */
export const OUTPUT_TRIM = 0.75;
/** Time constant of gain and pan changes (s): smooth, but quick to follow the camera. */
const GLIDE = 0.08;
/** One-shots start this far ahead, so their envelopes never begin in the past. */
const START_AHEAD = 0.01;

export interface AudioEngineOptions {
  /** Makes the context; `null` (or throwing) where there is no WebAudio: the game stays silent. */
  createContext: () => AudioContext | null;
  random?: Random;
}

/** What the test hook and the e2e spec look at (no audio output is asserted). */
export interface AudioDebugState {
  unlocked: boolean;
  /** The context's state (`running`, `suspended`, …), or `null` before `unlock`. */
  contextState: string | null;
  hidden: boolean;
  /** Bus gains as set (target values). */
  gains: { master: number; sfx: number; music: number };
  /** Whether the buses have been built and connected to the destination. */
  wired: boolean;
  /** Machine loops playing, by kind (the belts' hum as `belts`). */
  loops: Record<string, number>;
  /** One-shots played since the start, by kind. */
  played: Partial<Record<SoundEventKind, number>>;
  music: { phase: MusicPhase; track: string | null; tracksStarted: number } | null;
}

/** The engine's buses, as {@link createBuses} wires them. */
export interface Buses {
  master: GainNode;
  sfx: GainNode;
  music: GainNode;
}

/**
 * Builds the mixing graph into `ctx`'s destination: effects and music into
 * master, then a compressor (so many sounds at once don't pile up) and a
 * fixed trim ({@link OUTPUT_TRIM}) so the result stays below 1.0.
 */
export function createBuses(ctx: BaseAudioContext): Buses {
  const master = ctx.createGain();
  const sfx = ctx.createGain();
  const music = ctx.createGain();
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = COMPRESSOR.threshold;
  compressor.knee.value = COMPRESSOR.knee;
  compressor.ratio.value = COMPRESSOR.ratio;
  compressor.attack.value = COMPRESSOR.attack;
  const trim = ctx.createGain();
  trim.gain.value = OUTPUT_TRIM;
  sfx.connect(master);
  music.connect(master);
  master.connect(compressor).connect(trim).connect(ctx.destination);
  return { master, sfx, music };
}

interface Graph {
  ctx: AudioContext;
  master: GainNode;
  sfx: GainNode;
  music: GainNode;
  director: MusicDirector;
}

export class AudioEngine {
  private graph: Graph | null = null;
  private failed = false;
  private volumes: AudioSettings = { ...DEFAULT_AUDIO_SETTINGS };
  private hidden = false;
  private readonly loops = new Map<string, LoopVoice>();
  private readonly limiter = new OneShotLimiter();
  private readonly played: Partial<Record<SoundEventKind, number>> = {};
  private readonly random: Random;

  constructor(private readonly options: AudioEngineOptions) {
    this.random = options.random ?? Math.random;
  }

  /** Whether the context exists (a user gesture has unlocked audio). */
  get unlocked(): boolean {
    return this.graph !== null;
  }

  /**
   * Whether sounds should be made now: unlocked, visible and running. Callers
   * can skip their work (diffing snapshots, picking voices) otherwise.
   */
  get active(): boolean {
    return this.graph !== null && !this.hidden && this.graph.ctx.state === 'running';
  }

  /** Whether effects are audible at all (unlocked, visible, effects and master above 0). */
  get effectsOn(): boolean {
    return this.active && this.volumes.master > 0 && this.volumes.sfx > 0;
  }

  /**
   * Creates the context and the graph; call it from a user gesture. Later
   * calls only resume a suspended context. Returns whether audio is unlocked.
   */
  unlock(): boolean {
    if (this.graph) {
      if (!this.hidden && this.graph.ctx.state === 'suspended') void this.graph.ctx.resume();
      return true;
    }
    if (this.failed) return false;
    let ctx: AudioContext | null;
    try {
      ctx = this.options.createContext();
    } catch {
      ctx = null;
    }
    if (!ctx) {
      this.failed = true;
      return false;
    }
    const { master, sfx, music } = createBuses(ctx);
    const director = new MusicDirector(ctx, music, this.random);
    this.graph = { ctx, master, sfx, music, director };
    this.applyGains(0);
    if (this.hidden) void ctx.suspend();
    else if (ctx.state === 'suspended') void ctx.resume();
    return true;
  }

  /** Sets the volumes (percent, from the settings). */
  setVolumes(volumes: AudioSettings): void {
    this.volumes = { ...volumes };
    this.applyGains(GLIDE);
  }

  /** Mutes and suspends audio while the tab is hidden; resumes when it shows again. */
  setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return;
    this.hidden = hidden;
    this.applyGains(hidden ? 0 : GLIDE);
    const g = this.graph;
    if (!g) return;
    if (hidden) void g.ctx.suspend();
    else void g.ctx.resume();
  }

  private applyGains(glide: number): void {
    const g = this.graph;
    if (!g) return;
    const t = g.ctx.currentTime;
    const set = (node: GainNode, value: number) => {
      node.gain.cancelScheduledValues(t);
      if (glide > 0) node.gain.setTargetAtTime(value, t, glide);
      else node.gain.setValueAtTime(value, t);
    };
    set(g.master, this.hidden ? 0 : volumeToGain(this.volumes.master));
    set(g.sfx, volumeToGain(this.volumes.sfx));
    set(g.music, volumeToGain(this.volumes.music));
  }

  /** Plays one-shot `event` (positional ones as heard from `listener`), if the voice limits allow. */
  play(event: SoundEvent, listener: Listener): boolean {
    const g = this.graph;
    if (!g || !this.effectsOn) return false;
    let gain = 1;
    let pan = 0;
    if (event.x !== undefined && event.y !== undefined) {
      ({ gain, pan } = positional(listener, event.x, event.y));
      if (gain < MIN_AUDIBLE_GAIN) return false;
    }
    const t = g.ctx.currentTime + START_AHEAD;
    if (!this.limiter.tryStart(event.kind, t, 0.3)) return false;
    let out: AudioNode = g.sfx;
    if (pan !== 0) {
      const panner = g.ctx.createStereoPanner();
      panner.pan.value = pan;
      panner.connect(g.sfx);
      out = panner;
    }
    playOneShot(g.ctx, out, event.kind, t, gain, this.random);
    this.played[event.kind] = (this.played[event.kind] ?? 0) + 1;
    return true;
  }

  /**
   * Sets the machine loops: the nearest `MAX_LOOP_VOICES` working machines
   * play (others are dropped), each at its distance's volume and stereo
   * position, plus one hum for the moving belts. Voices that are no longer
   * chosen fade out.
   */
  updateLoops(
    machines: readonly LoopSource[],
    belts: readonly { x: number; y: number }[],
    listener: Listener,
  ): void {
    const g = this.graph;
    const wanted = new Map<string, { source: LoopSource; gain: number; pan: number }>();
    if (g && this.effectsOn) {
      for (const plan of selectLoopVoices(machines, listener, MAX_LOOP_VOICES)) {
        wanted.set(`${plan.kind}:${String(plan.id)}`, {
          source: plan,
          gain: plan.gain * LOOP_LEVEL,
          pan: plan.pan,
        });
      }
      const hum = beltHum(belts, listener);
      if (hum) {
        wanted.set('belts', {
          source: { id: 0, kind: 'belts', x: listener.x, y: listener.y },
          gain: hum.gain * BELT_LEVEL,
          pan: hum.pan,
        });
      }
    }
    const t = g?.ctx.currentTime ?? 0;
    for (const [key, voice] of this.loops) {
      if (!wanted.has(key)) {
        voice.stop(t);
        this.loops.delete(key);
      }
    }
    if (!g) return;
    for (const [key, { source, gain, pan }] of wanted) {
      let voice = this.loops.get(key);
      if (!voice) {
        voice = createLoop(g.ctx, g.sfx, source.kind, t);
        this.loops.set(key, voice);
      }
      voice.gain.gain.setTargetAtTime(gain, t, GLIDE);
      voice.pan.pan.setTargetAtTime(pan, t, GLIDE);
    }
  }

  /** Advances the music; call it every frame. */
  update(): void {
    const g = this.graph;
    if (!g || !this.active || this.volumes.music <= 0 || this.volumes.master <= 0) return;
    g.director.update(g.ctx.currentTime);
  }

  /** Loop voices playing now (for tests). */
  get loopCount(): number {
    return this.loops.size;
  }

  debugState(): AudioDebugState {
    const g = this.graph;
    const loops: Record<string, number> = {};
    for (const v of this.loops.values()) loops[v.kind] = (loops[v.kind] ?? 0) + 1;
    return {
      unlocked: g !== null,
      contextState: g ? g.ctx.state : null,
      hidden: this.hidden,
      gains: {
        master: this.hidden ? 0 : volumeToGain(this.volumes.master),
        sfx: volumeToGain(this.volumes.sfx),
        music: volumeToGain(this.volumes.music),
      },
      wired: g !== null,
      loops,
      played: { ...this.played },
      music: g
        ? {
            phase: g.director.phase,
            track: g.director.track?.name ?? null,
            tracksStarted: g.director.tracksStarted,
          }
        : null,
    };
  }
}

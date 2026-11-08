/**
 * Connects the audio engine to the game (D55), on the main thread only:
 *
 * - unlocks audio on the first user gesture (pointer, key or touch), never before;
 * - mutes it while the tab is hidden (`visibilitychange`);
 * - turns each snapshot into sound events (src/audio/events.ts);
 * - places the machine loops around the camera a few times a second;
 * - clicks for buttons and slots in the DOM interface.
 *
 * It reads the renderer's mirror of the snapshot through `GameAudioSources`
 * and never sends anything to the simulation.
 */

import type { CraftQueueData, InserterData, NetworkData, ResearchData } from '../sim/snapshot';
import type { SnapshotMessage } from '../worker/protocol';
import type { AudioEngine } from './engine';
import {
  SoundEventDiffer,
  beltSources,
  machineSources,
  type AudioEntity,
  type AudioPlayer,
} from './events';
import type { Listener } from './mix';

/** What the audio reads from the renderer, as of the latest snapshot. */
export interface GameAudioSources {
  /** The camera's center (tiles) and zoom. */
  listener(): Listener;
  entities(): readonly AudioEntity[];
  inserters(): readonly InserterData[];
  networks(): readonly NetworkData[];
  player(): AudioPlayer | null;
}

/** How often the loops are placed again (ms). */
const LOOP_INTERVAL_MS = 100;
/** Events that unlock audio (they count as user activation in browsers). */
const GESTURES = ['pointerdown', 'keydown', 'touchend'] as const;
/** DOM elements that click. */
const CLICKABLE = 'button, .slot, [role="button"], input[type="range"], input[type="checkbox"]';

export class GameAudio {
  private readonly differ = new SoundEventDiffer();
  private lastLoops = -Infinity;
  /** The latest snapshot's belt buffer (scanned for moving belts a few times a second). */
  private belts = new ArrayBuffer(0);
  private readonly onGesture = (): void => {
    if (this.engine.unlock()) {
      for (const type of GESTURES) window.removeEventListener(type, this.onGesture, true);
    }
  };

  constructor(
    readonly engine: AudioEngine,
    private readonly sources: GameAudioSources,
    doc: Document = document,
  ) {
    for (const type of GESTURES) window.addEventListener(type, this.onGesture, true);
    const visibility = () => {
      engine.setHidden(doc.visibilityState === 'hidden');
    };
    doc.addEventListener('visibilitychange', visibility);
    visibility();
    doc.addEventListener(
      'click',
      (e) => {
        const target = e.target;
        if (target instanceof Element && target.closest(CLICKABLE)) {
          engine.play({ kind: 'ui-click' }, sources.listener());
        }
      },
      true,
    );
  }

  /** Feeds a snapshot (after the view has applied it) with its decoded craft queue and research. */
  onSnapshot(snapshot: SnapshotMessage, craftQueue: CraftQueueData, research: ResearchData): void {
    this.belts = snapshot.belts;
    if (!this.engine.effectsOn) {
      // Nothing to hear: start from a fresh baseline when sound comes back.
      this.differ.reset();
      return;
    }
    const events = this.differ.next({
      tick: snapshot.tick,
      ticksRun: snapshot.ticksRun,
      chunkWindow: snapshot.chunkWindow,
      entities: this.sources.entities(),
      inserters: this.sources.inserters(),
      player: this.sources.player(),
      craftQueue,
      research,
      networks: this.sources.networks(),
    });
    if (events.length === 0) return;
    const listener = this.sources.listener();
    for (const event of events) this.engine.play(event, listener);
  }

  /** Call every rendered frame: music, and the loops a few times a second. */
  frame(nowMs: number = performance.now()): void {
    this.engine.update();
    if (nowMs - this.lastLoops < LOOP_INTERVAL_MS) return;
    this.lastLoops = nowMs;
    if (!this.engine.effectsOn) {
      if (this.engine.loopCount > 0) this.engine.updateLoops([], [], this.sources.listener());
      return;
    }
    this.engine.updateLoops(
      machineSources(this.sources.entities()),
      beltSources(this.belts),
      this.sources.listener(),
    );
  }
}

/** A new `AudioContext`, or `null` where the browser has none. */
export function createAudioContext(): AudioContext | null {
  const Ctor =
    globalThis.AudioContext ??
    (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctor ? new Ctor({ latencyHint: 'interactive' }) : null;
}

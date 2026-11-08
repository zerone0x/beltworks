/**
 * Sound events from snapshots (D55): the simulation sends no events, so the
 * main thread compares each snapshot with the one before and turns the
 * differences into sounds. Pure and DOM-free, so it is unit tested.
 *
 * - `place` / `remove`: an entity id that appears or disappears while its
 *   origin chunk stays inside the chunk window (entities that scroll in or
 *   out of view make no sound).
 * - `mine-hit` / `mined`: the local player's hand-mining progress crossing
 *   a stroke, and a unit finishing.
 * - `craft-done`: the front hand craft finishing (its count goes down after
 *   its progress reached the recipe's time; cancelling makes no sound).
 * - `inserter`: an arm starting a swing towards its drop end.
 * - `research-complete`: a technology becoming researched.
 * - `low-power`: a network in view drawing below full satisfaction, when it
 *   starts and again every {@link LOW_POWER_REPEAT_TICKS} while it lasts.
 *
 * Working machines and moving belts are states, not events: see
 * {@link machineSources} and {@link beltSources}, which the engine plays as
 * positional loops.
 */

import { EntityTypeId, SAT_ONE } from '../data/entities';
import { recipePrototype } from '../data/recipes';
import { MachineState } from '../sim/entities/machine';
import { CHUNK_SIZE } from '../sim/world/chunk';
import {
  BELT_ITEM_STRIDE,
  BELT_RECORD_HEADER,
  isResearchedIn,
  type CraftQueueData,
  type InserterData,
  type NetworkData,
  type ResearchData,
} from '../sim/snapshot';
import type { ChunkRect } from '../worker/protocol';

export type SoundEventKind =
  | 'place'
  | 'remove'
  | 'mine-hit'
  | 'mined'
  | 'craft-done'
  | 'inserter'
  | 'research-complete'
  | 'low-power'
  | 'ui-click';

/** A one-shot sound; positional when it has a position (tile coordinates, centers). */
export interface SoundEvent {
  kind: SoundEventKind;
  x?: number;
  y?: number;
}

/** What a frame needs to know about an entity (a subset of the renderer's `EntityView`). */
export interface AudioEntity {
  id: number;
  type: number;
  x: number;
  y: number;
  w: number;
  h: number;
  status: number;
}

/** The local player's hand mining, positions in tiles. */
export interface AudioPlayer {
  mining: boolean;
  mineX: number;
  mineY: number;
  mineProgress: number;
}

/** Everything the sound events are derived from, as of one snapshot. */
export interface AudioFrame {
  tick: number;
  ticksRun: number;
  chunkWindow: ChunkRect | null;
  entities: readonly AudioEntity[];
  inserters: readonly InserterData[];
  player: AudioPlayer | null;
  craftQueue: CraftQueueData;
  research: ResearchData;
  networks: readonly NetworkData[];
}

/** Hand-mining progress ticks per pick stroke (two strokes per 30-tick unit). */
export const MINE_STROKE_TICKS = 15;
/** How often the low-power warning repeats while a network stays short, in ticks. */
export const LOW_POWER_REPEAT_TICKS = 600;

const inWindow = (w: ChunkRect, x: number, y: number): boolean => {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cy = Math.floor(y / CHUNK_SIZE);
  return cx >= w.cx0 && cx <= w.cx1 && cy >= w.cy0 && cy <= w.cy1;
};

const center = (e: AudioEntity): { x: number; y: number } => ({
  x: e.x + e.w / 2,
  y: e.y + e.h / 2,
});

const inserterKey = (i: InserterData): number => (i.x + 0x20_0000) * 0x40_0000 + (i.y + 0x20_0000);

/** Whether any network in `networks` draws power but gets less than it asks for. */
export function powerShort(networks: readonly NetworkData[]): boolean {
  return networks.some((n) => n.demand > 0 && n.satisfaction < SAT_ONE);
}

/**
 * Turns consecutive frames into sound events. Feed it every snapshot in
 * order; `reset` forgets the previous frame (after a pause, so the next
 * frame only sets a baseline instead of replaying everything that changed).
 */
export class SoundEventDiffer {
  private prev: AudioFrame | null = null;
  private prevEntities = new Map<number, AudioEntity>();
  private prevEntityList: readonly AudioEntity[] | null = null;
  private prevSwing = new Map<number, number>();
  private lowPowerSince = -1;
  private lowPowerWarned = -Infinity;

  reset(): void {
    this.prev = null;
    this.prevEntities = new Map();
    this.prevEntityList = null;
    this.prevSwing = new Map();
    this.lowPowerSince = -1;
    this.lowPowerWarned = -Infinity;
  }

  /** The events between the previous frame and `frame` (none for the first frame). */
  next(frame: AudioFrame): SoundEvent[] {
    const events: SoundEvent[] = [];
    const prev = this.prev;
    const entities = this.indexEntities(frame.entities);
    const swings = new Map<number, number>();
    for (const i of frame.inserters) swings.set(inserterKey(i), i.swing);

    if (prev) {
      this.diffEntities(prev, frame, entities, events);
      this.diffInserters(frame, events);
      diffMining(prev.player, frame.player, events);
      if (craftFinished(prev.craftQueue, frame.craftQueue, frame.ticksRun)) {
        events.push({ kind: 'craft-done' });
      }
      for (const [tech] of frame.research.techs) {
        if (!isResearchedIn(prev.research, tech) && isResearchedIn(frame.research, tech)) {
          events.push({ kind: 'research-complete' });
          break;
        }
      }
    }
    this.diffPower(frame, prev !== null, events);

    this.prev = frame;
    this.prevEntities = entities;
    this.prevSwing = swings;
    return events;
  }

  private indexEntities(list: readonly AudioEntity[]): Map<number, AudioEntity> {
    // The renderer keeps the same list object while the entity records don't change.
    if (list === this.prevEntityList) return this.prevEntities;
    this.prevEntityList = list;
    const map = new Map<number, AudioEntity>();
    for (const e of list) map.set(e.id, e);
    return map;
  }

  private diffEntities(
    prev: AudioFrame,
    frame: AudioFrame,
    entities: Map<number, AudioEntity>,
    events: SoundEvent[],
  ): void {
    if (entities === this.prevEntities) return;
    const before = prev.chunkWindow;
    const now = frame.chunkWindow;
    if (!before || !now) return;
    const visible = (e: AudioEntity) => inWindow(before, e.x, e.y) && inWindow(now, e.x, e.y);
    for (const [id, e] of entities) {
      if (!this.prevEntities.has(id) && visible(e)) events.push({ kind: 'place', ...center(e) });
    }
    for (const [id, e] of this.prevEntities) {
      if (!entities.has(id) && visible(e)) events.push({ kind: 'remove', ...center(e) });
    }
  }

  private diffInserters(frame: AudioFrame, events: SoundEvent[]): void {
    for (const i of frame.inserters) {
      const before = this.prevSwing.get(inserterKey(i));
      if (before !== undefined && before <= 0 && i.swing > 0) {
        events.push({ kind: 'inserter', x: i.x + 0.5, y: i.y + 0.5 });
      }
    }
  }

  private diffPower(frame: AudioFrame, hasPrev: boolean, events: SoundEvent[]): void {
    if (!powerShort(frame.networks)) {
      this.lowPowerSince = -1;
      return;
    }
    if (this.lowPowerSince < 0) this.lowPowerSince = frame.tick;
    // Not on the first frame: a factory that was short before a pause or a load isn't news.
    if (!hasPrev) {
      this.lowPowerWarned = frame.tick;
      return;
    }
    if (
      frame.tick - this.lowPowerWarned >= LOW_POWER_REPEAT_TICKS ||
      this.lowPowerSince === frame.tick
    ) {
      this.lowPowerWarned = frame.tick;
      events.push({ kind: 'low-power' });
    }
  }
}

function diffMining(prev: AudioPlayer | null, now: AudioPlayer | null, events: SoundEvent[]): void {
  if (!now?.mining) return;
  const at = { x: now.mineX + 0.5, y: now.mineY + 0.5 };
  const sameTarget = prev?.mining === true && prev.mineX === now.mineX && prev.mineY === now.mineY;
  if (sameTarget && now.mineProgress < prev.mineProgress) {
    // The progress wrapped: a unit came off.
    events.push({ kind: 'mined', ...at });
    if (now.mineProgress >= MINE_STROKE_TICKS) events.push({ kind: 'mine-hit', ...at });
    return;
  }
  const before = sameTarget ? Math.floor(prev.mineProgress / MINE_STROKE_TICKS) : -1;
  if (Math.floor(now.mineProgress / MINE_STROKE_TICKS) > before) {
    events.push({ kind: 'mine-hit', ...at });
  }
}

/** Whether the front hand craft of `prev` finished by `now` (`ticksRun` ticks later). */
export function craftFinished(
  prev: CraftQueueData,
  now: CraftQueueData,
  ticksRun: number,
): boolean {
  const front = prev.entries[0];
  if (!front) return false;
  const total = (q: CraftQueueData) => q.entries.reduce((n, e) => n + e.crafts, 0);
  if (total(now) >= total(prev)) return false;
  const ticks = recipePrototype(front.recipe)?.ticks ?? Infinity;
  return prev.progress + ticksRun >= ticks;
}

/** The kinds of machine loop. */
export type LoopKind = 'furnace' | 'drill' | 'assembler' | 'lab' | 'boiler' | 'engine' | 'belts';

/** A working machine (or the belts) as a positional sound source, in tiles. */
export interface LoopSource {
  /** Stable key: the entity id (0 for the belts' combined hum). */
  id: number;
  kind: LoopKind;
  x: number;
  y: number;
}

const LOOP_KINDS: Partial<Record<number, LoopKind>> = {
  [EntityTypeId.StoneFurnace]: 'furnace',
  [EntityTypeId.BurnerMiningDrill]: 'drill',
  [EntityTypeId.ElectricMiningDrill]: 'drill',
  [EntityTypeId.AssemblingMachine1]: 'assembler',
  [EntityTypeId.AssemblingMachine2]: 'assembler',
  [EntityTypeId.Lab]: 'lab',
  [EntityTypeId.Boiler]: 'boiler',
  [EntityTypeId.SteamEngine]: 'engine',
};

/** The loop kind of entity type `type`, or `undefined` for entities that make no loop. */
export function loopKindOf(type: number): LoopKind | undefined {
  return LOOP_KINDS[type];
}

/** Working machines (`Working`, or `LowPower`: they work, slower) as loop sources. */
export function machineSources(entities: readonly AudioEntity[]): LoopSource[] {
  const out: LoopSource[] = [];
  for (const e of entities) {
    if (e.status !== MachineState.Working && e.status !== MachineState.LowPower) continue;
    const kind = LOOP_KINDS[e.type];
    if (kind) out.push({ id: e.id, kind, ...center(e) });
  }
  return out;
}

/**
 * Centers of the belts whose items moved on the last tick, read straight
 * from a snapshot's belt buffer (see `encodeBelts`): the renderer decodes
 * belts into objects only when it must, and the audio doesn't make it.
 */
export function beltSources(buffer: ArrayBuffer): { x: number; y: number }[] {
  const v = new Int32Array(buffer);
  const out: { x: number; y: number }[] = [];
  const count = v[0] ?? 0;
  let o = 1;
  for (let b = 0; b < count && o + BELT_RECORD_HEADER <= v.length; b++) {
    const x = v[o]!;
    const y = v[o + 1]!;
    const n = v[o + 4]!;
    o += BELT_RECORD_HEADER;
    let moving = false;
    for (let i = 0; i < n && o + BELT_ITEM_STRIDE <= v.length; i++, o += BELT_ITEM_STRIDE) {
      if (v[o + 2]! > 0) moving = true;
    }
    if (moving) out.push({ x: x + 0.5, y: y + 0.5 });
  }
  return out;
}

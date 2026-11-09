/**
 * Transport lines: runs of belts that continue each other (straight on, or
 * through a curve), with two lanes of items each (see lane.ts and belts.ts).
 */

import { SUBTILES_PER_TILE } from '../fixed';
import type { SaveReader, SaveWriter } from '../save/codec';
import { Lane } from './lane';

/** Lane indices, relative to the direction the belts move. */
export const BeltLane = {
  Left: 0,
  Right: 1,
} as const;

export type BeltLane = (typeof BeltLane)[keyof typeof BeltLane];

/** Length of one belt along its line, in subtiles. */
export const BELT_LENGTH = SUBTILES_PER_TILE;

/** A lane that knows its line, so the belt system can find where its items go. */
export class LineLane extends Lane {
  constructor(
    readonly line: TransportLine,
    readonly index: BeltLane,
    spacing: number,
  ) {
    super(spacing);
  }

  /** The belt system's tick on which the lane last moved or handed an item on. */
  changedAt = -2;

  /**
   * The belt system's tick while this (splitter half) lane is yet to step
   * on it: set as the tick's first pass goes by it, cleared when it steps.
   * Lasts one tick at most, so it isn't saved.
   */
  due = -1;

  override save(w: SaveWriter): void {
    super.save(w);
    w.u53(this.changedAt + 2);
  }

  override load(r: SaveReader): void {
    super.load(r);
    this.changedAt = r.u53() - 2;
  }
}

export class TransportLine {
  readonly lanes: readonly [LineLane, LineLane];
  /**
   * Where items leave the end of the line: the line they move onto, or
   * `null` when they stop at the end.
   */
  out: TransportLine | null = null;
  /**
   * The lane of `out` they move onto: -1 when the next belt continues this
   * line (each lane goes on as the same lane; only loops do this, as lines
   * otherwise merge), or the near lane of a belt this line side-loads.
   */
  outLane = -1;
  /** Distance from the end of `out` at which they enter it. */
  outPos = 0;
  /**
   * The only lane of this line that hands items on, or -1 for both: a line
   * side-loading an underground belt only gets the lane on the belt's open
   * half through (the other one is up against the hood).
   */
  outOnly = -1;
  /** Lines whose end feeds this one (their `out` is this line). */
  readonly feeders: TransportLine[] = [];
  /** Side-loading: the lane whose turn it is to move onto `out` when both are waiting. */
  turn: BeltLane = BeltLane.Left;
  /**
   * Belts of this line that something subscribed to (see wake.ts), notified
   * whenever a lane of the line changes. Entries whose subscriptions ended
   * are dropped the next time they would be notified.
   */
  readonly watched: number[] = [];
  /**
   * Scratch for the belt step (`BeltTable.notifyWatchers`): the stretch of
   * the line whose watched belts were notified during the step of tick
   * `notifiedStep`. Lives within one step, so it isn't saved.
   */
  notifiedStep = -1;
  notifiedLo = 0;
  notifiedHi = -1;
  /** Set once the line has been taken apart by a rebuild. */
  dead = false;
  /**
   * A splitter half (see splitter.ts): the splitter's entity id (0 for other
   * lines), which half (0 left, 1 right), its tile, and the other half's
   * line. A half is a line of its own, one belt long, that never merges with
   * the belts around it; `out` is the line in front of it.
   */
  splitter = 0;
  half = 0;
  tileX = 0;
  tileY = 0;
  sibling: TransportLine | null = null;

  constructor(
    /** Line ids are handed out in increasing order and never reused. */
    readonly id: number,
    /**
     * Entity ids of the belts, from the one at the end of the line (index 0)
     * back to its start. The tiles an underground belt pair passes under are
     * entries of 0 between the exit and its entrance: they count as belt
     * length, but no belt is there.
     */
    readonly belts: readonly number[],
    spacing: number,
    /** How far items move per tick, in subtiles: the tier of every belt on the line. */
    readonly speed: number,
  ) {
    this.lanes = [
      new LineLane(this, BeltLane.Left, spacing),
      new LineLane(this, BeltLane.Right, spacing),
    ];
  }

  /** Length of the line in subtiles. */
  get length(): number {
    return this.belts.length * BELT_LENGTH;
  }

  /** Index of the belt holding distance `pos` from the end (clamped to the line). */
  beltIndexAt(pos: number): number {
    return Math.max(0, Math.min(this.belts.length - 1, Math.floor(pos / BELT_LENGTH)));
  }
}

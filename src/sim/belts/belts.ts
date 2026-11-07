/**
 * Transport belts: the belt entity table and the belt system
 * (docs/ARCHITECTURE.md, "Belts: transport lines").
 *
 * One table holds every belt type: transport belts of each tier,
 * underground belts and splitters (`BELT_TYPE_IDS`); a type's `beltSpeed`
 * is its tier.
 *
 * Topology. Every belt moves items towards the tile in front of it, except
 * an underground entrance, which sends them under the ground to its exit
 * (underground.ts has the pairing rule). Belt B feeds belt F when B points
 * into F and either sits right behind F facing the same way, or is the only
 * belt pointing into one of F's sides while nothing feeds F from behind (F
 * is then a curve); an exit is fed by its entrance only, an entrance only
 * from behind (never as a curve), and an entrance feeds nothing in front of
 * it. Where B feeds F and both are of the same tier, F continues B (B is
 * F's predecessor). A belt pointing into the side of any other belt
 * side-loads it instead (into the back of an exit it does nothing), and two
 * belts pointing into each other don't connect. Runs of belts that continue
 * each other form one `TransportLine` (line.ts) with a left and a right
 * lane; a closed loop is cut at its belt with the smallest id. Where a line
 * feeds a belt of another tier, its end hands items on to the start of that
 * belt's line, lane by lane, like a loop's end hands them to its own start.
 *
 * Positions on a line are distances from its end in subtiles: the belt at
 * index `k` of `line.belts` spans `[k * 256, (k + 1) * 256)`. Curves count
 * as a full tile on both lanes, and the tiles an underground pair passes
 * under count as belt length too (entries of 0 in `line.belts`, right behind
 * the exit). Items there belong to the exit (removing it refunds them).
 *
 * Each tick, every awake lane (belt system, src/sim/tick.ts) moves by its
 * line's speed (see lane.ts); whenever its first item is at the end with
 * movement left and the line ends in another line, the item is handed on
 * and the next one moves on with what is left: to the next line's start for
 * a loop or a tier boundary, to the middle of the belt's near lane for a
 * side-load (both lanes of a side-loading line take turns when both are
 * waiting; onto an underground belt, only the lane on its open half gets
 * through, onto the middle of that half). Otherwise items stop at the end.
 * A lane that neither moved nor handed an item on goes to sleep: it leaves the active list until it
 * gets an item, loses one, or the lane it feeds changes (it then wakes the
 * lanes feeding it). Empty lanes sleep too. A lane waiting at its end for
 * room on a lane that moved on this tick or the last one stays awake, so it
 * hands on as soon as there is room (lanes stuck in a jammed cycle stop
 * moving, so they all go to sleep); and an item handed on may enter up to
 * one tick of the target's movement behind the hand-over point
 * (`Lane.fitNear`). Together they make every boundary and side-load run at
 * exactly the slower lane's rate.
 *
 * Rebuilds. Placing, rotating or removing a belt can only change the links
 * of belts within two tiles of it, and the pairing of the nearest
 * underground belts of its tier on its row and column (and their partners),
 * so the lines through those belts are
 * taken apart (keeping every item's belt, lane and position on its belt) and
 * rebuilt from their belts; other lines keep their ids and items. Items that
 * end up closer than the minimum spacing where two lines join are pushed back
 * towards the start of the line, past it if need be (they move on once there
 * is room). Where a rebuilt line hands on to another line's start, the items
 * pushed past that start move into the feeding lane, which is pushed back to
 * keep the spacing across the boundary (`settle`). A removed belt's items
 * are refunded with it (removeEntity in src/sim/entities/build.ts), and the
 * removal is refused if they don't fit.
 *
 * Splitters (splitter.ts; docs/ARCHITECTURE.md, "Belts: splitters"). Each
 * half of a splitter is a line of its own, one belt long, that nothing
 * continues: fed at its start by the belt behind it (like a tier boundary),
 * handing on to the start of the line in front of it. Its first item goes
 * straight on or across onto the other half's lane (marked, so it goes
 * straight on from there), by a per-lane alternation (`splitHandOn`): all
 * that leaves by one side passes through that half, at the splitter's
 * speed. Halves step after every other lane (`stepHalf`), and a half that
 * the other one merges into closes up to `MERGE_SPACING` so they take
 * turns (`refreshMerge`).
 *
 * Other systems move items with `insertAt`, `takeAt`, `peekAt` and `peekEnd`
 * on a line and lane, and `beltLine`/`beltOffset`/`beltEnd` find a belt's
 * line and its stretch of it. The generic item hooks put items onto the
 * middle of a belt (see `insert`). Notifications (`entities.notify`): every tick a lane of a
 * line changes (items move, arrive or leave), the line notifies those of its
 * watched belts, the ones something subscribed to (the `watched` hook keeps
 * that list per line), that the change could affect: the stretch of the lane
 * that changed (from the first item that moved to where the last one was,
 * O(1) to find, or the position of an item put on or taken off) must come
 * within `BELT_ITEM_SPACING` of the belt. So a drill blocked on a full belt,
 * or an inserter waiting for an item, sleeps while the lanes there sleep or
 * only move elsewhere on the line, and is woken while items move near it;
 * lines nobody watches pay nothing for it.
 */

import {
  BELT_ITEM_SPACING,
  BELT_TYPE_IDS,
  ENTITIES,
  EntityTypeId,
  entityPrototype,
} from '../../data/entities';
import { itemPrototype, type ItemStack, type RealItemId } from '../../data/items';
import { DIRECTION_DX, DIRECTION_DY, type Direction } from '../entities/direction';
import type { Entities } from '../entities/entities';
import { SparseSet, growTo } from '../entities/sparseSet';
import type { EntityTypeTable } from '../entities/table';
import { fnv1a32 } from '../hash';
import type { Lane, LaneOutlet } from './lane';
import { BELT_LENGTH, BeltLane, LineLane, TransportLine } from './line';
import { splitterHalfTile } from './splitter';
import { UndergroundMode, findPartner, placedMode, type UndergroundInfo } from './underground';

/**
 * Spacing a splitter half's lane closes up to while the other half merges
 * into it (see `refreshMerge`): one free slot for the other half's item
 * behind each of its own.
 */
export const MERGE_SPACING = 2 * BELT_ITEM_SPACING;

/**
 * How far behind the other half's `minFront` an item crossing over inside
 * a splitter may land, in subtiles: far enough to reach the free slot a
 * merging half keeps (`MERGE_SPACING`) behind its first item.
 */
export const CROSS_REACH = MERGE_SPACING;

/** How far items on a (yellow) transport belt move per tick, in subtiles. */
export const BELT_SPEED = ENTITIES[EntityTypeId.TransportBelt].beltSpeed ?? 0;

/** Belt speed of entity type `type` (its tier), or 0 if it isn't a belt. */
export function beltSpeedOf(type: number): number {
  return entityPrototype(type)?.beltSpeed ?? 0;
}

/** How a belt is drawn: straight, or curving in from its left or right side. */
export const BeltShape = {
  Straight: 0,
  CurveFromLeft: 1,
  CurveFromRight: 2,
} as const;

export type BeltShape = (typeof BeltShape)[keyof typeof BeltShape];

/** One item on a belt: lane, distance from the belt's end edge (0..256), and how far it moved last tick. */
export interface BeltItem {
  lane: BeltLane;
  offset: number;
  moved: number;
  item: number;
}

/** Tile offsets within two steps (Manhattan distance), in a fixed order. */
const NEAR: readonly (readonly [number, number])[] = (() => {
  const out: [number, number][] = [];
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      if (Math.abs(dx) + Math.abs(dy) <= 2) out.push([dx, dy]);
    }
  }
  return out;
})();

const cw = (d: Direction): Direction => ((d + 1) & 3) as Direction;
const ccw = (d: Direction): Direction => ((d + 3) & 3) as Direction;

/** An item saved while its line is rebuilt: lane and distance from its belt's end edge. */
interface SavedItem {
  lane: BeltLane;
  offset: number;
  item: number;
}

const Output = {
  Blocked: 0,
  Moved: 1,
  /** Side-loading: the other lane's turn. */
  Yielded: 2,
} as const;

export class BeltTable implements EntityTypeTable, LaneOutlet {
  readonly type = EntityTypeId.TransportBelt;
  readonly types = BELT_TYPE_IDS;
  private readonly set = new SparseSet();
  /** Line id per belt row. */
  private lineCol = new Uint32Array(0);
  /** Index of the belt in its line (0 is the belt at the line's end). */
  private indexCol = new Uint32Array(0);
  /** `BeltShape` per row. */
  private shapeCol = new Uint8Array(0);
  /** Belt speed (tier) per row, from the type. */
  private speedCol = new Uint8Array(0);
  /** `UndergroundMode` per row (`None` for transport belts). */
  private modeCol = new Uint8Array(0);
  /** The paired underground belt per row, or 0. */
  private partnerCol = new Uint32Array(0);
  /** 1 for a splitter row. */
  private splitCol = new Uint8Array(0);
  /** A splitter's right half's line per row (`lineCol` holds the left half's), else 0. */
  private line2Col = new Uint32Array(0);
  /**
   * A splitter's alternation per row: bit `i` is the half whose output lane
   * `i`'s next item goes to (it flips each time one goes to the preferred
   * output; an item that can't goes to the other one and leaves it as is).
   */
  private nextCol = new Uint8Array(0);
  /**
   * Direction per row as of the last change (equal to the store's outside of
   * `rotated`, so not hashed): tells `rotated` whether an underground was reversed.
   */
  private dirCol = new Uint8Array(0);
  /** Set while `rotated` turns an underground's partner along with it. */
  private flipping = false;
  /** What the lane being stepped did at its end this tick (see `handOn`). */
  private handed = false;
  private yielded = false;
  /**
   * The lane being stepped found no room on the lane it feeds, which moved
   * this tick or the last one: it stays awake to try again next tick (a lane
   * woken during `update` only runs from the next tick, so sleeping and
   * being woken would lose a tick per hand-over). Only lanes that move keep
   * their feeders awake, so a jammed cycle of lines falls asleep.
   */
  private waiting = false;
  /** Ticks the belt system has run (see `LineLane.changedAt`). */
  private tick = 0;
  /** Lines by id, in creation (= id) order. */
  private readonly lineMap = new Map<number, TransportLine>();
  private nextLine = 1;
  /** Lanes the belt system steps, in the order they woke up. */
  private active: LineLane[] = [];
  private entities: Entities | null = null;

  /** Number of belts. */
  get count(): number {
    return this.set.size;
  }

  /** Number of lines. */
  get lineCount(): number {
    return this.lineMap.size;
  }

  /** Number of lanes on the active list. */
  get activeLanes(): number {
    return this.active.length;
  }

  /** Every line, in id order. */
  lines(): IterableIterator<TransportLine> {
    return this.lineMap.values();
  }

  /** Line `id`, if it exists. */
  line(id: number): TransportLine | undefined {
    return this.lineMap.get(id);
  }

  /** Id of the line belt `belt` is on, or 0 if it isn't a belt (a splitter's left half's). */
  beltLine(belt: number): number {
    const row = this.set.indexOf(belt);
    return row < 0 ? 0 : this.lineCol[row]!;
  }

  /**
   * Id of the line through tile `(x, y)` of belt `belt`: its line, or for a
   * splitter the line of the half on that tile. 0 if it isn't a belt.
   */
  beltLineAt(belt: number, x: number, y: number): number {
    const row = this.set.indexOf(belt);
    if (row < 0) return 0;
    if (!this.splitCol[row]) return this.lineCol[row]!;
    const half = this.halfLines(belt)[1];
    return half.tileX === x && half.tileY === y ? half.id : this.lineCol[row]!;
  }

  /** Whether belt `belt` is a splitter. */
  isSplitter(belt: number): boolean {
    const row = this.set.indexOf(belt);
    return row >= 0 && this.splitCol[row] === 1;
  }

  /** The lines of splitter `belt`'s left and right halves. */
  halfLines(belt: number): readonly [TransportLine, TransportLine] {
    const row = this.row(belt);
    const a = this.lineMap.get(this.lineCol[row]!);
    const b = this.lineMap.get(this.line2Col[row]!);
    if (!a || !b) throw new RangeError(`belt ${String(belt)} is no splitter`);
    return [a, b];
  }

  /** The half (0 left, 1 right) whose output lane `lane` of splitter `belt` sends its next item to. */
  splitterNext(belt: number, lane: number): number {
    return (this.nextCol[this.row(belt)]! >> lane) & 1;
  }

  /** Index of belt `belt` in its line (0 is the belt at the line's end). */
  beltIndex(belt: number): number {
    return this.indexCol[this.row(belt)]!;
  }

  /** Distance from the end of belt `belt`'s line to the belt's end edge (it spans 256 from there). */
  beltOffset(belt: number): number {
    return this.beltIndex(belt) * BELT_LENGTH;
  }

  /**
   * The farthest distance from the end of belt `belt`'s line that still
   * counts as on the belt: `beltOffset + 255`, except for the belt at the
   * line's start, which also holds everything at or past its start edge
   * (`pos == line.length`, where a loop hands items on to its own start and
   * `insertAt` may put them, or further back, where a rebuild may push them).
   * That is where the renderer draws them too (`TransportLine.beltIndexAt`).
   */
  beltEnd(belt: number): number {
    const row = this.row(belt);
    return this.rowEnd(this.lineMap.get(this.lineCol[row]!), this.indexCol[row]!);
  }

  /** How belt `belt` is drawn. */
  shape(belt: number): BeltShape {
    return this.shapeCol[this.row(belt)]! as BeltShape;
  }

  /** Whether entity `id` is a belt (any tier, underground or not). */
  isBelt(id: number): boolean {
    return this.set.has(id);
  }

  /** Whether belt `belt` is an underground entrance, exit, or neither (`None`). */
  mode(belt: number): UndergroundMode {
    return this.modeCol[this.row(belt)]! as UndergroundMode;
  }

  /** The underground belt paired with `belt`, or 0. */
  partner(belt: number): number {
    return this.partnerCol[this.row(belt)]!;
  }

  /** How far items on belt `belt` move per tick, in subtiles (its tier). */
  speed(belt: number): number {
    return this.speedCol[this.row(belt)]!;
  }

  // Entity hooks.

  add(id: number, entities: Entities): void {
    this.entities = entities;
    const row = this.set.add(id);
    const min = row + 1;
    this.lineCol = growTo(this.lineCol, min);
    this.indexCol = growTo(this.indexCol, min);
    this.shapeCol = growTo(this.shapeCol, min);
    this.speedCol = growTo(this.speedCol, min);
    this.modeCol = growTo(this.modeCol, min);
    this.partnerCol = growTo(this.partnerCol, min);
    this.splitCol = growTo(this.splitCol, min);
    this.line2Col = growTo(this.line2Col, min);
    this.nextCol = growTo(this.nextCol, min);
    this.dirCol = growTo(this.dirCol, min);
    const { store } = entities;
    const type = store.type(id);
    const dir = store.dir(id);
    const speed = beltSpeedOf(type);
    this.speedCol[row] = speed;
    this.dirCol[row] = dir;
    this.partnerCol[row] = 0;
    this.splitCol[row] = entityPrototype(type)?.splitter ? 1 : 0;
    this.line2Col[row] = 0;
    this.nextCol[row] = 0;
    const gap = entityPrototype(type)?.undergroundMaxGap;
    // A new underground is an exit when an entrance behind it would pair with it.
    this.modeCol[row] =
      gap === undefined
        ? UndergroundMode.None
        : placedMode(this.lookup, store.x(id), store.y(id), dir, speed, gap);
    this.relink([id], 0);
  }

  remove(id: number): void {
    if (!this.set.has(id)) return;
    this.relink([id], id);
  }

  /**
   * Underground belts reverse (and swap entrance and exit) instead of
   * turning; splitters reverse too (on the same two tiles).
   */
  rotation(id: number, entities: Entities): Direction {
    const dir = entities.store.dir(id);
    const row = this.row(id);
    const turn = this.modeCol[row] !== UndergroundMode.None || this.splitCol[row] ? 2 : 1;
    return ((dir + turn) & 3) as Direction;
  }

  /**
   * A belt turned. An underground belt that was reversed swaps entrance and
   * exit, and its partner is reversed with it, so the pair keeps carrying
   * items between the same two tiles, the other way. Turned any other way,
   * it keeps its mode.
   */
  rotated(id: number, entities: Entities): void {
    const row = this.row(id);
    const dir = entities.store.dir(id);
    const prev = this.dirCol[row]! as Direction;
    const reversed = dir === ((prev + 2) & 3);
    this.dirCol[row] = dir;
    const mode = this.modeCol[row]!;
    if (this.splitCol[row]) {
      // Turned across, a splitter covers other tiles: rebuild around the old ones too.
      const before =
        (prev & 1) === (dir & 1)
          ? []
          : this.footprintTiles(
              entities.store.x(id),
              entities.store.y(id),
              entities.prototypeOf(id)!,
              prev,
            );
      this.relink([id], 0, before);
      return;
    }
    if (mode === UndergroundMode.None) {
      this.relink([id], 0);
      return;
    }
    if (reversed) this.modeCol[row] = 3 - mode;
    if (this.flipping) return;
    const partner = this.partnerCol[row]!;
    if (reversed && partner !== 0) {
      this.flipping = true;
      entities.setDirection(partner, ((entities.store.dir(partner) + 2) & 3) as Direction);
      this.flipping = false;
    }
    this.relink(partner !== 0 ? [id, partner] : [id], 0);
  }

  watched(id: number): void {
    for (const line of this.linesOf(id)) {
      if (!line.watched.includes(id)) line.watched.push(id);
    }
  }

  /** The lines belt `id` is on: one, or a splitter's two halves. */
  private linesOf(id: number): TransportLine[] {
    const row = this.set.indexOf(id);
    if (row < 0) return [];
    const out: TransportLine[] = [];
    for (const lineId of this.splitCol[row]
      ? [this.lineCol[row]!, this.line2Col[row]!]
      : [this.lineCol[row]!]) {
      const line = this.lineMap.get(lineId);
      if (line) out.push(line);
    }
    return out;
  }

  /** The items on the belt, and for an underground exit those under the ground behind it. */
  contents(id: number): readonly ItemStack[] {
    const out: ItemStack[] = [];
    for (const { item } of this.itemsOwnedBy(id)) {
      const stack = out.find((s) => s.item === item);
      if (stack) {
        out[out.indexOf(stack)] = { item: stack.item, count: stack.count + 1 };
      } else {
        out.push({ item: item as RealItemId, count: 1 });
      }
    }
    return out;
  }

  /** A belt carries any item. */
  accepts(_id: number, item: number): boolean {
    return itemPrototype(item) !== undefined;
  }

  /**
   * How many units of `item` `insert` would put on the belt now: one per
   * lane with room at the middle of the belt.
   */
  insertable(id: number, item: number): number {
    if (!itemPrototype(item)) return 0;
    const pos = this.beltOffset(id) + BELT_LENGTH / 2;
    let n = 0;
    for (const line of this.linesOf(id)) {
      n += (line.lanes[0].canInsert(pos) ? 1 : 0) + (line.lanes[1].canInsert(pos) ? 1 : 0);
    }
    return Math.min(2, n);
  }

  /**
   * Puts items onto the middle of the belt, the way a drill or a player's
   * hand drops them: one unit on the right lane, then one on the left lane,
   * as far as they have room (so at most two per call).
   */
  insert(id: number, item: number, count: number): number {
    if (!itemPrototype(item)) return 0;
    const pos = this.beltOffset(id) + BELT_LENGTH / 2;
    let n = 0;
    // A splitter: its left half first, then its right half, at most two in all.
    for (const line of this.linesOf(id)) {
      for (const lane of [BeltLane.Right, BeltLane.Left]) {
        if (n < Math.min(count, 2) && this.insertAt(line.id, lane, pos, item)) n++;
      }
    }
    return n;
  }

  hashInto(h: number): number {
    const n = this.set.size;
    h = fnv1a32(Uint32Array.of(n, this.lineMap.size, this.nextLine, this.active.length), h);
    h = fnv1a32(this.set.dense, h);
    h = fnv1a32(this.lineCol.subarray(0, n), h);
    h = fnv1a32(this.indexCol.subarray(0, n), h);
    h = fnv1a32(this.shapeCol.subarray(0, n), h);
    h = fnv1a32(this.modeCol.subarray(0, n), h);
    h = fnv1a32(this.partnerCol.subarray(0, n), h);
    h = fnv1a32(this.line2Col.subarray(0, n), h);
    h = fnv1a32(this.nextCol.subarray(0, n), h);
    for (const line of this.lineMap.values()) {
      h = fnv1a32(
        Uint32Array.of(
          line.id,
          line.belts.length,
          line.speed,
          line.out?.id ?? 0,
          line.outLane + 1,
          line.outPos,
          line.outOnly + 1,
          line.turn,
          line.splitter,
          line.half,
        ),
        h,
      );
      h = fnv1a32(Uint32Array.from(line.belts), h);
      for (const lane of line.lanes) {
        // Whether the lane moved this tick or the last (all `changedAt` is used for).
        const recent = lane.changedAt >= this.tick - 1 ? 1 : 0;
        h = fnv1a32(
          Uint32Array.of(lane.count, lane.total, lane.active ? 1 : 0, recent, lane.spacing),
          h,
        );
        h = fnv1a32(lane.gaps(), h);
        h = fnv1a32(lane.items(), h);
        if (line.splitter !== 0) h = fnv1a32(lane.marks(), h);
      }
    }
    const order = new Uint32Array(2 * this.active.length);
    this.active.forEach((lane, i) => {
      order[2 * i] = lane.line.id;
      order[2 * i + 1] = lane.index;
    });
    return fnv1a32(order, h);
  }

  // The API for other systems (drills, inserters).

  /**
   * Puts `item` on lane `lane` of line `lineId` at distance `pos` from its
   * end. Returns false (and changes nothing) if there is no such line or
   * item, `pos` is off the line, or the item would come closer than
   * `BELT_ITEM_SPACING` to another one.
   */
  insertAt(lineId: number, lane: number, pos: number, item: number): boolean {
    const line = this.lineMap.get(lineId);
    if (!line || (lane !== 0 && lane !== 1) || !itemPrototype(item)) return false;
    if (!Number.isInteger(pos) || pos < 0 || pos > line.length) return false;
    const l = line.lanes[lane];
    if (!l.insert(pos, item)) return false;
    this.wakeLane(l);
    this.halfChanged(line, lane);
    this.notifyWatchers(line, pos, pos);
    return true;
  }

  /**
   * Takes the item closest to the end among those on lane `lane` of line
   * `lineId` at a distance in `[from, to]` from the end. Returns its item
   * id, or 0 if there is none.
   */
  takeAt(lineId: number, lane: number, from: number, to: number): number {
    const line = this.lineMap.get(lineId);
    if (!line || (lane !== 0 && lane !== 1)) return 0;
    const l = line.lanes[lane];
    const i = l.find(from, to);
    if (i < 0) return 0;
    const item = l.removeAt(i);
    this.wakeLane(l);
    this.wakeFeeders(line, lane);
    this.halfChanged(line, lane);
    this.notifyWatchers(line, from, to);
    return item;
  }

  /** Like `takeAt` without taking: the item id, or 0. */
  peekAt(lineId: number, lane: number, from: number, to: number): number {
    const l = this.lineMap.get(lineId)?.lanes[lane];
    if (!l) return 0;
    const i = l.find(from, to);
    return i < 0 ? 0 : l.item(i);
  }

  /** The item waiting at the very end of the lane, or 0 if none has reached it. */
  peekEnd(lineId: number, lane: number): number {
    const l = this.lineMap.get(lineId)?.lanes[lane];
    return l && l.count > 0 && l.gap(0) === 0 ? l.item(0) : 0;
  }

  /** Whether the lane is awake: its items may move on their own, without notifying. */
  laneAwake(lineId: number, lane: number): boolean {
    return this.lineMap.get(lineId)?.lanes[lane]?.active ?? false;
  }

  /** The items on belt `belt`, lane by lane, each from the belt's end backwards. */
  itemsOn(belt: number): BeltItem[] {
    const line = this.lineOfBelt(belt);
    const k = this.indexCol[this.row(belt)]!;
    const out: BeltItem[] = [];
    this.forEachItem(line, (index, lane, offset, moved, item) => {
      if (index === k) out.push({ lane, offset, moved, item });
    });
    return out;
  }

  /**
   * The items `belt` owns: those on it (`itemsOn`), and for an underground
   * exit also those under the ground behind it, with offsets past 256.
   */
  itemsOwnedBy(belt: number): BeltItem[] {
    if (this.isSplitter(belt)) {
      const out: BeltItem[] = [];
      for (const line of this.halfLines(belt)) {
        this.forEachItem(line, (_k, lane, offset, moved, item) =>
          out.push({ lane, offset, moved, item }),
        );
      }
      return out;
    }
    const line = this.lineOfBelt(belt);
    const k = this.indexCol[this.row(belt)]!;
    let last = k;
    while (last + 1 < line.belts.length && line.belts[last + 1] === 0) last++;
    const out: BeltItem[] = [];
    this.forEachItem(line, (index, lane, offset, moved, item) => {
      if (index >= k && index <= last) {
        out.push({ lane, offset: offset + (index - k) * BELT_LENGTH, moved, item });
      }
    });
    return out;
  }

  /**
   * Calls `fn` for every item on `line`, lane by lane from the end
   * backwards, with the index of its belt and its distance from that belt's
   * end edge.
   */
  forEachItem(
    line: TransportLine,
    fn: (beltIndex: number, lane: BeltLane, offset: number, moved: number, item: number) => void,
  ): void {
    for (const l of line.lanes) {
      let d = 0;
      for (let i = 0; i < l.count; i++) {
        d += l.gap(i);
        const k = line.beltIndexAt(d);
        fn(k, l.index, d - k * BELT_LENGTH, l.moved(i), l.item(i));
      }
    }
  }

  // The belt system.

  /** Steps every awake lane by one tick. */
  update(): void {
    this.tick++;
    const list = this.active;
    const n = list.length;
    const keep = this.keep;
    keep.length = n;
    // Splitter halves step after every other lane (see `stepHalf`), in list order.
    for (let i = 0; i < n; i++) {
      const lane = list[i]!;
      if (lane.line.splitter !== 0) continue;
      keep[i] = this.step(lane);
      if (!keep[i]) {
        lane.active = false;
        lane.clearMoved();
      }
    }
    for (let i = 0; i < n; i++) {
      const lane = list[i]!;
      if (lane.line.splitter === 0) continue;
      keep[i] = !lane.line.dead && this.stepHalf(lane);
      if (!keep[i]) {
        lane.active = false;
        lane.clearMoved();
      }
    }
    let w = 0;
    for (let i = 0; i < n; i++) if (keep[i]) list[w++] = list[i]!;
    // Lanes woken during the loops were appended after the first `n`.
    for (let i = n; i < list.length; i++) list[w++] = list[i]!;
    list.length = w;
  }

  /** Scratch for `update`: whether each lane of the active list stays on it. */
  private readonly keep: boolean[] = [];

  /**
   * One tick of a splitter half's lane; returns whether it stays awake.
   * Halves step after every other lane, so the lanes in front of them (and
   * the other half) are where they will be at the end of the tick when a
   * half decides where its first item goes (see `splitHandOn`). It moves up
   * to the spacing behind the last item of the belt in front (`minFront`),
   * like any lane handing on to another line's start; a blocked half stays
   * awake while either output or the other half moved this tick or the last.
   */
  private stepHalf(lane: LineLane): boolean {
    const { line } = lane;
    this.refreshMerge(line);
    if (lane.count === 0) return false;
    this.handed = false;
    const moved = lane.move(line.speed, this.splitOutlet) > 0;
    if (moved || this.handed) {
      lane.changedAt = this.tick;
      const lo = this.handed ? 0 : lane.firstMovedPosition();
      const hi = lane.total + lane.movedAll + lane.movedRest;
      this.wakeFeeders(line, lane.index);
      this.halfChanged(line, lane.index);
      this.notifyWatchers(line, lo, hi);
      return true;
    }
    const recent = (l: LineLane | undefined): boolean =>
      l !== undefined && l.changedAt >= this.tick - 1;
    const sib = line.sibling!;
    return (
      recent(line.out?.lanes[lane.index]) ||
      recent(sib.out?.lanes[lane.index]) ||
      recent(sib.lanes[lane.index])
    );
  }

  /** The outlet of a splitter half's lanes: straight on, or across to the other half's output. */
  private readonly splitOutlet: LaneOutlet = {
    early: true,
    minFront: (l) => this.splitMinFront(l as LineLane),
    handOn: (l, rem) => this.splitHandOn(l as LineLane, rem),
  };

  /**
   * How close to its end a splitter half's first item may come: the
   * spacing behind the last item of the belt in front of it, counted
   * across, as for any hand-over onto another line's start. An item headed
   * across to the other half is offered there too (`early`), from wherever
   * this holds it.
   */
  private splitMinFront(lane: LineLane): number {
    const out = lane.line.out;
    if (!out) return 0;
    const target = out.lanes[lane.index];
    if (target.count === 0) return 0;
    const floor = BELT_ITEM_SPACING - (out.length - target.total);
    return floor > 0 ? floor : 0;
  }

  /**
   * A splitter half's first item, held at `minFront` or at the end with
   * `rem` of the tick's movement left. An item the other half sent across
   * (marked) goes straight on, or back across if its output got blocked
   * meanwhile (so it never waits on a blocked output). Any other goes to the output its lane's
   * alternation picks (the next bit of `nextCol`), else to the other one;
   * going to the picked output flips the bit, going to the other leaves it.
   *
   * Straight on (onto the start of the line in front, only from the end) is
   * the ordinary hand-over: the item keeps its leftover movement, scaled to
   * the target's speed, but lands no closer than the target lane's spacing
   * to its last item. Across, it moves over onto the other half's lane, as
   * close to that lane's end as the spacing allows (from the other half's
   * `minFront`, at most `CROSS_REACH` further back, and no closer than the
   * spacing to the first item of the lane feeding that half), marked, so it
   * goes straight on from there: everything bound for an output passes
   * through the half in front of it, at the splitter's speed and with the
   * spacing across both boundaries kept by the ordinary rules. An item only
   * goes across while the other half's output is open (`outputOpen`), so
   * none waits on a blocked output's half.
   */
  private splitHandOn(lane: LineLane, rem: number): boolean {
    const { line } = lane;
    const i = lane.index;
    const sib = line.sibling!;
    const row = this.row(line.splitter);
    // Sent across already: straight on, unless its output is blocked by now.
    const marked = lane.marked(0);
    const pref = marked ? line.half : (this.nextCol[row]! >> i) & 1;
    const tries = marked && this.outputOpen(line, i) ? 1 : 2;
    for (let n = 0; n < tries; n++) {
      const t = n === 0 ? pref : 1 - pref;
      if (t === line.half) {
        const out = line.out;
        if (lane.gap(0) !== 0 || !out) continue;
        const target = out.lanes[i];
        const carry = Math.floor((rem * out.speed) / line.speed);
        let pos = out.length - carry;
        if (target.count > 0) pos = Math.max(pos, target.total + target.spacing);
        if (pos > out.length) continue;
        target.insert(pos, lane.removeAt(0));
        this.wakeLane(target);
        this.notifyWatchers(out, pos, pos);
      } else {
        if (!this.outputOpen(sib, i)) continue;
        const target = sib.lanes[i];
        const start = this.splitMinFront(target);
        // Into the slot a merging half keeps: the plain spacing, not the lane's.
        const pos = target.fitNear(start, CROSS_REACH, BELT_ITEM_SPACING);
        // Behind the half's last item, it keeps the half's own spacing ahead of
        // the item feeding in from behind, so that one isn't held up.
        if (pos < 0 || pos > this.backLimit(sib, target, target.spacing)) continue;
        target.insert(pos, lane.removeAt(0), true, BELT_ITEM_SPACING);
        this.wakeLane(target);
        this.notifyWatchers(sib, pos, pos);
      }
      if (!marked && t === pref) this.nextCol[row] = this.nextCol[row]! ^ (1 << i);
      this.handed = true;
      return true;
    }
    return false;
  }

  /**
   * Whether splitter half `half`'s output lane `lane` can take items: there
   * is one, and it has room at its start or moved this tick or the last
   * (an output backed up to its start that stopped is blocked).
   */
  private outputOpen(half: TransportLine, lane: number): boolean {
    const out = half.out;
    if (!out) return false;
    const t = out.lanes[lane as BeltLane];
    return t.count === 0 || out.length - t.total >= t.spacing || t.changedAt >= this.tick - 1;
  }

  /**
   * Lane `lane` of `line` changed: if `line` is a splitter half, wakes the
   * other half's lane (its items may now go across) and refreshes the
   * splitter's merging (`refreshMerge`).
   */
  private halfChanged(line: TransportLine, lane: number): void {
    if (line.splitter === 0) return;
    this.wakeLane(line.sibling!.lanes[lane as BeltLane]);
    this.refreshMerge(line);
  }

  /**
   * Fair merging: while a splitter half has items that can't go straight on
   * (its output isn't open, `outputOpen`), the other half's lane closes up
   * only to `MERGE_SPACING`, and the line feeding it hands on that far
   * apart, so a slot stays free behind each of its own items for one sent
   * across (the lanes only ever close gaps, so the slot has to be kept from
   * the start). Everything bound for that output passes through that half,
   * so the two inputs take turns at the rate of the half or the output,
   * whichever is slower. Set per lane on both halves; a lane opening up
   * again wakes, with the lane feeding it. O(1).
   */
  private refreshMerge(line: TransportLine): void {
    if (line.splitter === 0 || line.dead) return;
    const sib = line.sibling!;
    for (const [x, y] of [
      [line, sib],
      [sib, line],
    ] as const) {
      for (const lane of x.lanes) {
        const other = y.lanes[lane.index];
        const merging = x.out !== null && other.count > 0 && !this.outputOpen(y, lane.index);
        const spacing = merging ? MERGE_SPACING : BELT_ITEM_SPACING;
        if (spacing === lane.spacing) continue;
        lane.setSpacing(spacing);
        if (spacing < MERGE_SPACING) {
          this.wakeLane(lane);
          this.wakeFeeders(x, lane.index);
        }
      }
    }
  }

  /** One tick of one lane; returns whether it stays awake. */
  private step(lane: LineLane): boolean {
    if (lane.count === 0) return false;
    const { line } = lane;
    this.handed = false;
    this.yielded = false;
    this.waiting = false;
    const moved = lane.move(line.speed, line.out ? this : null) > 0;
    const changed = moved || this.handed;
    if (changed) {
      lane.changedAt = this.tick;
      // The stretch of the lane that changed, as distances from the end:
      // from the end (an item left) or the first item that moved, to where
      // the last item was before the move.
      const lo = this.handed ? 0 : lane.firstMovedPosition();
      const hi = lane.total + lane.movedAll + lane.movedRest;
      this.wakeFeeders(line, lane.index);
      this.notifyWatchers(line, lo, hi);
    }
    return changed || this.yielded || this.waiting;
  }

  /**
   * `LaneOutlet`: where a line hands on to the start of another line (a
   * tier boundary, or a loop of several lines), the first item of a lane
   * stays the spacing behind the last item of the lane it feeds, counting
   * across the boundary, so the spacing holds across lines too. (A loop of
   * one line needs no limit: its first and last items move together.) A lane
   * held back like this by a lane that is moving stays awake (see `waiting`).
   */
  minFront(l: Lane): number {
    const lane = l as LineLane;
    const { line } = lane;
    const out = line.out!;
    if (line.outLane >= 0) return 0;
    const target = out.lanes[lane.index];
    if (target === lane || target.count === 0) return 0;
    // Counted across the boundary: where a rebuild pushed the target's last
    // item past its start edge (onto this lane's own belt), this lane stops
    // the spacing behind it, more than the spacing from its end, until that
    // item has moved on into its line.
    const floor = BELT_ITEM_SPACING - (out.length - target.total);
    if (floor <= 0) return 0;
    if (target.changedAt >= this.tick - 1) this.waiting = true;
    return floor;
  }

  /** `LaneOutlet`: the lane being stepped offers its first item, at the end, to `line.out`. */
  handOn(l: Lane, rem: number): boolean {
    const lane = l as LineLane;
    const r = this.output(lane.line, lane, rem);
    if (r === Output.Moved) this.handed = true;
    else if (r === Output.Yielded) this.yielded = true;
    return r === Output.Moved;
  }

  /**
   * Hands the lane's first item (at the very end) on to `line.out`, with
   * `rem` subtiles of the lane's movement left this tick.
   */
  private output(line: TransportLine, lane: LineLane, rem: number): number {
    const out = line.out!;
    if (line.outOnly >= 0 && lane.index !== line.outOnly) return Output.Blocked;
    const target = out.lanes[line.outLane < 0 ? lane.index : line.outLane]!;
    let pos: number;
    if (line.outLane >= 0) {
      // A side-load may land up to one tick of the target's movement behind
      // the side-load point (further up the same lane, where the spacing is
      // checked), so a lane fed at a fixed point fills at exactly the
      // spacing even when the spacing isn't a multiple of its speed (the
      // express belt's 24). Near the target's start (an underground
      // entrance's rear half) it also keeps the spacing from the first item
      // of the lane that hands on to that start from another line.
      pos = target.fitNear(line.outPos, out.speed - 1);
      if (pos > this.backLimit(out, target)) pos = -1;
    } else if (target === lane) {
      // A loop of one line: onto its own start edge (the lane moves on as a whole).
      pos = target.fitNear(line.outPos, 0);
    } else {
      // Onto the start of another line (a tier boundary, or a loop of
      // several lines): the item goes on with what is left of this tick's
      // movement, at the target's speed, but no closer than the spacing to
      // the target's last item (`minFront` kept it that far behind). Behind
      // the start edge is this lane's own belt, so it can't land there.
      const carry = Math.floor((rem * out.speed) / line.speed);
      pos = line.outPos - carry;
      if (target.count > 0) pos = Math.max(pos, target.total + target.spacing);
      if (pos > line.outPos) pos = -1;
    }
    if (pos < 0) {
      if (target !== lane && target.changedAt >= this.tick - 1) this.waiting = true;
      return Output.Blocked;
    }
    if (line.outLane >= 0 && line.outOnly < 0 && line.turn !== lane.index) {
      const other = line.lanes[1 - lane.index]!;
      if (other.count > 0 && other.gap(0) === 0) {
        this.wakeLane(other);
        return Output.Yielded;
      }
    }
    const item = lane.removeAt(0);
    target.insert(pos, item);
    line.turn = (1 - lane.index) as BeltLane;
    this.wakeLane(target);
    this.notifyWatchers(out, pos, pos);
    return Output.Moved;
  }

  /**
   * The farthest distance from the end of `line` at which an item may join
   * lane `lane` and stay the spacing ahead of the first item of the lane
   * that hands on to the line's start from another line (if there is one).
   * O(1): a line has at most three feeders.
   */
  private backLimit(line: TransportLine, lane: LineLane, spacing = BELT_ITEM_SPACING): number {
    for (const f of line.feeders) {
      if (f.outLane >= 0 || f === line) continue;
      const from = f.lanes[lane.index];
      if (from.count === 0) break;
      return line.length + from.gap(0) - spacing;
    }
    return Number.MAX_SAFE_INTEGER;
  }

  private wakeLane(lane: LineLane): void {
    if (lane.active || lane.count === 0 || lane.line.dead) return;
    lane.active = true;
    this.active.push(lane);
  }

  /** Lane `lane` of `line` changed: wake the lanes that feed it. */
  private wakeFeeders(line: TransportLine, lane: number): void {
    for (const f of line.feeders) {
      if (f.outLane < 0) {
        this.wakeLane(f.lanes[lane as BeltLane]);
        // A splitter half: the other half may send items across onto `line` too.
        if (f.splitter !== 0) this.halfChanged(f, lane);
      } else if (f.outLane === lane) {
        if (f.outOnly !== BeltLane.Right) this.wakeLane(f.lanes[0]);
        if (f.outOnly !== BeltLane.Left) this.wakeLane(f.lanes[1]);
      }
    }
  }

  /**
   * Lane items of `line` changed between distances `lo` and `hi` from its
   * end: notifies the watched belts that come within `BELT_ITEM_SPACING` of
   * that stretch (what an inserter picks up from, or whether something fits
   * on the belt, can only have changed there), dropping those nothing
   * watches any more.
   */
  private notifyWatchers(line: TransportLine, lo: number, hi: number): void {
    const list = line.watched;
    if (list.length === 0) return;
    const entities = this.entities!;
    let n = 0;
    for (const belt of list) {
      if (entities.wake.isWatched(belt)) list[n++] = belt;
    }
    list.length = n;
    // Waking may subscribe again (appending to `list`); only the first `n` were there before.
    for (let i = 0; i < n; i++) {
      const belt = list[i]!;
      const index = this.indexCol[this.row(belt)]!;
      const start = index * BELT_LENGTH;
      const end = this.rowEnd(line, index);
      if (hi >= start - BELT_ITEM_SPACING && lo <= end + 1 + BELT_ITEM_SPACING) {
        entities.notify(belt);
      }
    }
  }

  /** See `beltEnd`: the last distance the belt at `index` of `line` holds. */
  private rowEnd(line: TransportLine | undefined, index: number): number {
    return line && index === line.belts.length - 1
      ? Number.MAX_SAFE_INTEGER
      : index * BELT_LENGTH + BELT_LENGTH - 1;
  }

  private notifyBelt(belt: number): void {
    const entities = this.entities;
    if (entities?.wake.isWatched(belt)) entities.notify(belt);
  }

  // Topology.

  /** The belt on tile `(x, y)`, or 0. */
  private beltAt(x: number, y: number): number {
    const id = this.entities!.at(x, y);
    return id !== 0 && this.set.has(id) ? id : 0;
  }

  private dir(id: number): Direction {
    return this.entities!.store.dir(id);
  }

  private modeOf(id: number): number {
    return this.modeCol[this.row(id)]!;
  }

  private speedOf(id: number): number {
    return this.speedCol[this.row(id)]!;
  }

  /** The pairing's view of the undergrounds (see underground.ts). */
  private readonly lookup = (x: number, y: number): UndergroundInfo | null => {
    const b = this.beltAt(x, y);
    if (b === 0) return null;
    const row = this.row(b);
    const mode = this.modeCol[row]! as UndergroundMode;
    if (mode === UndergroundMode.None) return null;
    return { speed: this.speedCol[row]!, dir: this.dir(b), mode };
  };

  /** Most tiles between underground belt `id` and its partner. */
  private maxGap(id: number): number {
    return this.entities!.prototypeOf(id)?.undergroundMaxGap ?? 0;
  }

  /** Whether `id` moves items on into the tile in front of it (every belt but an entrance). */
  private feedsFront(id: number): boolean {
    return this.modeOf(id) !== UndergroundMode.Entrance;
  }

  /**
   * The belt whose items move on into `id` (see the file comment), of any
   * tier, or 0: an exit's entrance; the belt right behind facing the same
   * way; for a transport belt with nothing behind it feeding it, the only
   * belt pointing into one of its sides (a curve).
   */
  private feederOf(id: number): number {
    const mode = this.modeOf(id);
    if (mode === UndergroundMode.Exit) return this.partnerCol[this.row(id)]!;
    const { store } = this.entities!;
    const d = store.dir(id);
    const x = store.x(id);
    const y = store.y(id);
    const behind = this.beltAt(x - DIRECTION_DX[d]!, y - DIRECTION_DY[d]!);
    if (behind !== 0 && this.dir(behind) === d && this.feedsFront(behind)) return behind;
    if (mode === UndergroundMode.Entrance) return 0;
    // Sides: the left one must point clockwise of `d` to point into this belt.
    const l = ccw(d);
    const left = this.beltAt(x + DIRECTION_DX[l]!, y + DIRECTION_DY[l]!);
    const r = cw(d);
    const right = this.beltAt(x + DIRECTION_DX[r]!, y + DIRECTION_DY[r]!);
    const fromLeft = left !== 0 && this.dir(left) === r && this.feedsFront(left);
    const fromRight = right !== 0 && this.dir(right) === l && this.feedsFront(right);
    if (fromLeft === fromRight) return 0;
    return fromLeft ? left : right;
  }

  /** The belt that `id` continues (its feeder, if of the same tier), or 0. Splitters continue nothing, and nothing continues them. */
  private predecessor(id: number): number {
    if (this.splitCol[this.row(id)]) return 0;
    const f = this.feederOf(id);
    return f !== 0 && this.speedOf(f) === this.speedOf(id) && !this.splitCol[this.row(f)] ? f : 0;
  }

  /** The tiles of a `proto` footprint with its top-left tile at `(x, y)` facing `dir`. */
  private footprintTiles(
    x: number,
    y: number,
    proto: { width: number; height: number },
    dir: Direction,
  ): [number, number][] {
    const [w, h] = (dir & 1) === 1 ? [proto.height, proto.width] : [proto.width, proto.height];
    const out: [number, number][] = [];
    for (let ty = y; ty < y + h; ty++) for (let tx = x; tx < x + w; tx++) out.push([tx, ty]);
    return out;
  }

  /**
   * The line through tile `(x, y)` that belt `id` (just found there) starts,
   * for a line ending right behind that tile and facing `dir`: a splitter's
   * half there if the splitter faces `dir` too (items only enter a splitter
   * from behind), else `undefined` for a splitter, and `null` for other belts
   * (the caller decides).
   */
  private splitterInput(
    id: number,
    x: number,
    y: number,
    dir: Direction,
  ): TransportLine | null | undefined {
    if (!this.splitCol[this.row(id)]) return null;
    if (this.dir(id) !== dir) return undefined;
    return this.lineMap.get(this.beltLineAt(id, x, y));
  }

  /**
   * Where the items at the end of `id` go: an entrance's partner, or the belt
   * `id` points into, unless that one points straight back or `id` points
   * into the closed back of an exit. 0 for none.
   */
  private nextBelt(id: number): number {
    if (this.modeOf(id) === UndergroundMode.Entrance) return this.partnerCol[this.row(id)]!;
    const { store } = this.entities!;
    const d = store.dir(id);
    const f = this.beltAt(store.x(id) + DIRECTION_DX[d]!, store.y(id) + DIRECTION_DY[d]!);
    if (f === 0) return 0;
    const fd = this.dir(f);
    if (fd === ((d + 2) & 3)) return 0;
    if (fd === d && this.modeOf(f) === UndergroundMode.Exit) return 0;
    return f;
  }

  /**
   * Adds to `out` the underground belts whose pairing a change to belt `id`
   * can affect: its partner, and on each of the four sides the nearest
   * underground of its tier on that axis within reach, with its partner.
   */
  private pairingNeighbours(id: number, out: Set<number>): void {
    const row = this.set.indexOf(id);
    if (row < 0 || this.modeCol[row] === UndergroundMode.None) return;
    const partner = this.partnerCol[row]!;
    if (partner !== 0) out.add(partner);
    const { store } = this.entities!;
    const x = store.x(id);
    const y = store.y(id);
    const speed = this.speedCol[row]!;
    const reach = this.maxGap(id) + 1;
    for (let d = 0; d < 4; d++) {
      for (let k = 1; k <= reach; k++) {
        const b = this.beltAt(x + k * DIRECTION_DX[d]!, y + k * DIRECTION_DY[d]!);
        if (b === 0) continue;
        const r = this.row(b);
        if (this.modeCol[r] === UndergroundMode.None || this.speedCol[r] !== speed) continue;
        if ((this.dir(b) & 1) !== (d & 1)) continue;
        out.add(b);
        if (this.partnerCol[r] !== 0) out.add(this.partnerCol[r]!);
        break;
      }
    }
  }

  /**
   * Rebuilds the lines around belts `seeds`, which were just placed or
   * rotated, or (with `removed`, one of them) is about to be removed.
   */
  private relink(
    seeds: readonly number[],
    removed: number,
    /** More tiles to rebuild around (a splitter turned across covered them). */
    extra: readonly (readonly [number, number])[] = [],
  ): void {
    const { store } = this.entities!;

    // 1. Take apart every line through a belt within two tiles of a seed, or
    //    through an underground whose pairing may change.
    const pairing = new Set<number>();
    for (const s of seeds) this.pairingNeighbours(s, pairing);
    const dissolved: TransportLine[] = [];
    const dissolve = (b: number): void => {
      if (b === 0) return;
      for (const line of this.linesOf(b)) {
        if (!line.dead) {
          line.dead = true;
          dissolved.push(line);
        }
      }
    };
    const tiles: (readonly [number, number])[] = [...extra];
    for (const s of seeds) {
      const proto = this.entities!.prototypeOf(s)!;
      tiles.push(...this.footprintTiles(store.x(s), store.y(s), proto, store.dir(s)));
    }
    for (const [x, y] of tiles) {
      for (const [dx, dy] of NEAR) dissolve(this.beltAt(x + dx, y + dy));
    }
    for (const b of pairing) dissolve(b);
    const saved = new Map<number, SavedItem[]>();
    const savedHalves = new Map<string, SavedItem[]>();
    const belts: number[] = [];
    const feeders: TransportLine[] = [];
    for (const line of dissolved) {
      this.lineMap.delete(line.id);
      if (line.splitter !== 0) {
        // A splitter half's items stay on its tile (and lane, and offset).
        const list: SavedItem[] = [];
        this.forEachItem(line, (k, lane, offset, _moved, item) => {
          list.push({ lane, offset: offset + k * BELT_LENGTH, item });
        });
        savedHalves.set(halfKey(line.splitter, line.tileX, line.tileY), list);
      }
      this.forEachItem(line, (k, lane, offset, _moved, item) => {
        if (line.splitter !== 0) return;
        // Items under the ground belong to the exit in front of them.
        let at = k;
        while (at > 0 && line.belts[at] === 0) at--;
        const belt = line.belts[at]!;
        let list = saved.get(belt);
        if (!list) saved.set(belt, (list = []));
        list.push({ lane, offset: offset + (k - at) * BELT_LENGTH, item });
      });
      for (const b of line.belts) if (b !== 0) belts.push(b);
      for (const f of line.feeders) {
        if (!f.dead && !feeders.includes(f)) feeders.push(f);
      }
      const out = line.out;
      if (out && !out.dead) out.feeders.splice(out.feeders.indexOf(line), 1);
    }
    if (dissolved.length > 0) {
      this.active = this.active.filter((lane) => !lane.line.dead);
    }
    if (removed !== 0) this.dropRow(removed);
    for (const s of seeds) {
      if (s !== removed && !belts.includes(s)) belts.push(s);
    }
    const members = new Set(belts.filter((b) => b !== removed));
    const sorted = Array.from(members).sort((a, b) => a - b);

    // 2. Pairs and links among those belts.
    for (const b of sorted) {
      if (this.modeOf(b) !== UndergroundMode.None) this.partnerCol[this.row(b)] = 0;
    }
    for (const b of sorted) {
      const row = this.row(b);
      if (this.modeCol[row] !== UndergroundMode.Entrance) continue;
      const p = findPartner(
        this.lookup,
        store.x(b),
        store.y(b),
        this.dir(b),
        UndergroundMode.Entrance,
        this.speedCol[row]!,
        this.maxGap(b),
      );
      const exit = p ? this.beltAt(p.x, p.y) : 0;
      if (exit !== 0 && members.has(exit)) {
        this.partnerCol[row] = exit;
        this.partnerCol[this.row(exit)] = b;
      }
    }
    const pred = new Map<number, number>();
    const hasSucc = new Set<number>();
    for (const b of sorted) {
      const p = this.predecessor(b);
      if (p !== 0 && members.has(p)) {
        pred.set(b, p);
        hasSucc.add(p);
      }
    }

    // 3. New lines: chains from each belt nothing continues, then loops.
    //    Behind an exit come the tiles under the ground, then its entrance.
    const created: TransportLine[] = [];
    const visited = new Set<number>();
    const chain = (head: number): void => {
      const list: number[] = [];
      for (let b = head; b !== 0 && !visited.has(b); b = pred.get(b) ?? 0) {
        visited.add(b);
        list.push(b);
        const p = pred.get(b) ?? 0;
        if (p !== 0 && this.modeOf(b) === UndergroundMode.Exit) {
          const hidden = Math.abs(store.x(b) - store.x(p)) + Math.abs(store.y(b) - store.y(p)) - 1;
          for (let i = 0; i < hidden; i++) list.push(0);
        }
      }
      created.push(this.createLine(list, saved));
    };
    for (const b of sorted) {
      if (!hasSucc.has(b) && !this.splitCol[this.row(b)]) chain(b);
    }
    for (const b of sorted) {
      if (!visited.has(b) && !this.splitCol[this.row(b)]) chain(b);
    }
    for (const b of sorted) {
      if (this.splitCol[this.row(b)]) created.push(...this.createHalves(b, savedHalves));
    }

    // 4. Where the new lines, and the old lines that fed the old ones, now end.
    for (const line of [...created, ...feeders]) this.computeOutput(line);
    // 5. The spacing across the hand-overs onto other lines' starts there.
    for (const line of [...created, ...feeders]) this.settle(line, new Set());
    for (const line of [...created, ...feeders]) {
      this.wakeLane(line.lanes[0]);
      this.wakeLane(line.lanes[1]);
      this.refreshMerge(line);
    }
    for (const b of sorted) this.notifyBelt(b);
  }

  /**
   * After a rebuild, where `line` hands on to the start of another line
   * (lane by lane): the items of the target lane that were pushed past its
   * start edge are on this line's end belt, so they move into this lane at
   * that distance from its end, and this lane's items are pushed back (past
   * its start if need be) to keep the spacing, counting across the boundary
   * from the target's last item. When that pushes this lane's last item
   * further back, the line handing on to this one's start settles in turn
   * (each line once, so it ends in a loop of lines).
   */
  private settle(line: TransportLine, seen: Set<TransportLine>): void {
    const out = line.out;
    if (!out || line.outLane >= 0 || out === line || seen.has(line)) return;
    seen.add(line);
    let grew = false;
    for (const lane of line.lanes) {
      const target = out.lanes[lane.index];
      const floor = (): number =>
        target.count > 0 ? BELT_ITEM_SPACING - (out.length - target.total) : 0;
      if (target.total <= out.length && (lane.count === 0 || lane.gap(0) >= floor())) continue;
      // [position, item, mark]: a splitter half's items keep their marks.
      const entries: [number, number, boolean][] = [];
      while (target.count > 0 && target.total > out.length) {
        const pos = target.total - out.length;
        entries.push([pos, target.removeAt(target.count - 1), false]);
      }
      let d = 0;
      for (let i = 0; i < lane.count; i++) {
        entries.push([(d += lane.gap(i)), lane.item(i), lane.marked(i)]);
      }
      const total = lane.total;
      while (lane.count > 0) lane.removeAt(lane.count - 1);
      entries.sort((a, b) => a[0] - b[0]);
      let prev = 0;
      for (const [pos, item, mark] of entries) {
        const at =
          lane.count === 0 ? Math.max(pos, floor()) : Math.max(pos, prev + BELT_ITEM_SPACING);
        lane.pushBack(at - prev, item, mark);
        prev = at;
      }
      if (lane.total > total) grew = true;
      this.wakeLane(lane);
      this.wakeLane(target);
      this.wakeFeeders(out, lane.index);
      this.wakeFeeders(line, lane.index);
      this.notifyWatchers(line, 0, Number.MAX_SAFE_INTEGER);
      this.notifyWatchers(out, 0, Number.MAX_SAFE_INTEGER);
    }
    if (!grew) return;
    for (const f of line.feeders) if (f.outLane < 0) this.settle(f, seen);
  }

  private createLine(belts: number[], saved: Map<number, SavedItem[]>): TransportLine {
    const line = new TransportLine(
      this.nextLine++,
      belts,
      BELT_ITEM_SPACING,
      this.speedOf(belts[0]!),
    );
    this.lineMap.set(line.id, line);
    const entries: [number, number][][] = [[], []];
    belts.forEach((belt, k) => {
      if (belt === 0) return;
      const row = this.row(belt);
      this.lineCol[row] = line.id;
      this.indexCol[row] = k;
      // The shape follows the feeder, whatever its tier.
      const p = this.modeCol[row] === UndergroundMode.None ? this.feederOf(belt) : 0;
      const d = this.dir(belt);
      this.shapeCol[row] =
        p === 0 || this.dir(p) === d
          ? BeltShape.Straight
          : this.dir(p) === cw(d)
            ? BeltShape.CurveFromLeft
            : BeltShape.CurveFromRight;
      if (this.entities!.wake.isWatched(belt)) line.watched.push(belt);
      for (const s of saved.get(belt) ?? []) {
        entries[s.lane]!.push([k * BELT_LENGTH + s.offset, s.item]);
      }
    });
    entries.forEach((list, lane) => {
      list.sort((a, b) => a[0] - b[0]);
      const l = line.lanes[lane]!;
      let prev = 0;
      for (const [pos, item] of list) {
        const at = l.count === 0 ? pos : Math.max(pos, prev + BELT_ITEM_SPACING);
        l.pushBack(at - prev, item);
        prev = at;
      }
    });
    return line;
  }

  /** Recomputes where `line` hands its items on (see `TransportLine.out`). */
  private computeOutput(line: TransportLine): void {
    const old = line.out;
    if (old && !old.dead) old.feeders.splice(old.feeders.indexOf(line), 1);
    line.out = null;
    line.outLane = -1;
    line.outPos = 0;
    line.outOnly = -1;
    const head = line.belts[0]!;
    if (line.splitter !== 0) {
      this.computeHalfOutput(line);
      return;
    }
    const f = this.nextBelt(head);
    if (f !== 0) {
      const { store } = this.entities!;
      const d = store.dir(head);
      const into = this.splitterInput(
        f,
        store.x(head) + DIRECTION_DX[d]!,
        store.y(head) + DIRECTION_DY[d]!,
        d,
      );
      if (into !== null) {
        // Into the back of a splitter half: onto its start. Into its side or front: nothing.
        if (into) this.handOnto(line, into);
        return;
      }
    }
    const target = f !== 0 ? this.lineMap.get(this.lineCol[this.row(f)]!) : undefined;
    if (!target) return;
    const k = this.indexCol[this.row(f)]!;
    if (this.feederOf(f) === head) {
      // A loop, or a belt of another tier: `f` starts its line (everything
      // else that continues merged into one line). Lane by lane onto its start.
      line.outPos = target.length;
    } else {
      // Side-load onto the middle of the near lane.
      const fd = this.dir(f);
      const hd = this.dir(head);
      line.outLane = hd === cw(fd) ? BeltLane.Left : BeltLane.Right;
      const mode = this.modeOf(f);
      if (mode === UndergroundMode.None) {
        line.outPos = k * BELT_LENGTH + BELT_LENGTH / 2;
      } else {
        // Only the open half of an underground takes items: an entrance's
        // rear half, an exit's front half. The lane of this line on that
        // side gets through, onto the middle of that half.
        const open = mode === UndergroundMode.Entrance ? (fd + 2) & 3 : fd;
        line.outOnly = ccw(hd) === open ? BeltLane.Left : BeltLane.Right;
        line.outPos =
          k * BELT_LENGTH + (mode === UndergroundMode.Entrance ? 3 : 1) * (BELT_LENGTH / 4);
      }
    }
    line.out = target;
    target.feeders.push(line);
  }

  /** `line` hands its items on lane by lane onto the start of `target`. */
  private handOnto(line: TransportLine, target: TransportLine): void {
    line.outPos = target.length;
    line.out = target;
    target.feeders.push(line);
  }

  /**
   * Where a splitter half hands its items on: the line the belt in front of
   * it starts, when that belt continues it (straight on, or as a curve), or
   * the half of a splitter in front facing the same way. A splitter never
   * side-loads: a belt in front that it would side-load (one fed from
   * behind), or one facing it, gets nothing.
   */
  private computeHalfOutput(line: TransportLine): void {
    const id = line.splitter;
    const d = this.dir(id);
    const x = line.tileX + DIRECTION_DX[d]!;
    const y = line.tileY + DIRECTION_DY[d]!;
    const f = this.beltAt(x, y);
    if (f === 0) return;
    const into = this.splitterInput(f, x, y, d);
    if (into !== null) {
      if (into) this.handOnto(line, into);
      return;
    }
    const fd = this.dir(f);
    if (fd === ((d + 2) & 3)) return;
    if (fd === d && this.modeOf(f) === UndergroundMode.Exit) return;
    if (this.feederOf(f) !== id) return;
    const target = this.lineMap.get(this.lineCol[this.row(f)]!);
    if (target) this.handOnto(line, target);
  }

  /**
   * The two half lines of splitter `id`, with the items saved for its tiles
   * (`saved`, by `halfKey`); items saved for a tile it no longer covers (it
   * was turned across) go onto the half on the tile it newly covers.
   */
  private createHalves(id: number, saved: Map<string, SavedItem[]>): TransportLine[] {
    const { store } = this.entities!;
    const row = this.row(id);
    const speed = this.speedCol[row]!;
    const dir = this.dir(id);
    const lines = [0, 1].map((half) => {
      const line = new TransportLine(this.nextLine++, [id], BELT_ITEM_SPACING, speed);
      const tile = splitterHalfTile(store.x(id), store.y(id), dir, half);
      line.splitter = id;
      line.half = half;
      line.tileX = tile.x;
      line.tileY = tile.y;
      this.lineMap.set(line.id, line);
      if (this.entities!.wake.isWatched(id)) line.watched.push(id);
      return line;
    });
    const [a, b] = lines as [TransportLine, TransportLine];
    a.sibling = b;
    b.sibling = a;
    this.lineCol[row] = a.id;
    this.line2Col[row] = b.id;
    this.indexCol[row] = 0;
    this.shapeCol[row] = BeltShape.Straight;
    const had = new Set(saved.keys());
    const lists = lines.map((line) => {
      const key = halfKey(id, line.tileX, line.tileY);
      const list = saved.get(key) ?? [];
      saved.delete(key);
      return list;
    });
    // Turned across, it covers one of its old tiles and a new one: the items
    // of the tile it left go onto the half on the new tile.
    const fresh = lines.findIndex((line) => !had.has(halfKey(id, line.tileX, line.tileY)));
    const prefix = `${String(id)}:`;
    for (const [key, list] of saved) {
      if (key.startsWith(prefix)) {
        lists[fresh < 0 ? 0 : fresh]!.push(...list);
        saved.delete(key);
      }
    }
    lines.forEach((line, half) => {
      for (const lane of line.lanes) {
        const list = lists[half]!.filter((s) => s.lane === lane.index)
          .map((s) => [s.offset, s.item] as const)
          .sort((p, q) => p[0] - q[0]);
        let prev = 0;
        for (const [pos, item] of list) {
          const at = lane.count === 0 ? pos : Math.max(pos, prev + BELT_ITEM_SPACING);
          lane.pushBack(at - prev, item);
          prev = at;
        }
      }
    });
    return lines;
  }

  private dropRow(id: number): void {
    const row = this.set.remove(id);
    if (row < 0) return;
    const last = this.set.size;
    if (row !== last) {
      this.lineCol[row] = this.lineCol[last]!;
      this.indexCol[row] = this.indexCol[last]!;
      this.shapeCol[row] = this.shapeCol[last]!;
      this.speedCol[row] = this.speedCol[last]!;
      this.modeCol[row] = this.modeCol[last]!;
      this.partnerCol[row] = this.partnerCol[last]!;
      this.splitCol[row] = this.splitCol[last]!;
      this.line2Col[row] = this.line2Col[last]!;
      this.nextCol[row] = this.nextCol[last]!;
      this.dirCol[row] = this.dirCol[last]!;
    }
    this.lineCol[last] = 0;
    this.indexCol[last] = 0;
    this.shapeCol[last] = 0;
    this.speedCol[last] = 0;
    this.modeCol[last] = 0;
    this.partnerCol[last] = 0;
    this.splitCol[last] = 0;
    this.line2Col[last] = 0;
    this.nextCol[last] = 0;
    this.dirCol[last] = 0;
  }

  private lineOfBelt(belt: number): TransportLine {
    const line = this.lineMap.get(this.lineCol[this.row(belt)]!);
    if (!line) throw new RangeError(`belt ${String(belt)} is on no line`);
    return line;
  }

  private row(id: number): number {
    const row = this.set.indexOf(id);
    if (row < 0) {
      throw new RangeError(`no belt ${String(id)}`);
    }
    return row;
  }
}

/** The key of the items saved for splitter `id`'s half on tile `(x, y)` during a rebuild. */
function halfKey(id: number, x: number, y: number): string {
  return `${String(id)}:${String(x)}:${String(y)}`;
}

/** The belt table of `entities`, if one is registered. */
export function beltTable(entities: Entities): BeltTable | undefined {
  const table = entities.table(EntityTypeId.TransportBelt);
  return table instanceof BeltTable ? table : undefined;
}

/**
 * Transport belts: the belt entity table and the belt system
 * (docs/ARCHITECTURE.md, "Belts: transport lines").
 *
 * Topology. Every belt moves items towards the tile in front of it. Belt F
 * continues belt B (B is F's predecessor) when B points into F and either
 * sits right behind F facing the same way, or is the only belt pointing into
 * one of F's sides while nothing feeds F from behind (F is then a curve). A
 * belt pointing into the side of any other belt side-loads it instead, and
 * two belts pointing into each other don't connect. Runs of belts that
 * continue each other form one `TransportLine` (line.ts) with a left and a
 * right lane; a closed loop is cut at its belt with the smallest id.
 *
 * Positions on a line are distances from its end in subtiles: the belt at
 * index `k` of `line.belts` spans `[k * 256, (k + 1) * 256)`. Curves count
 * as a full tile on both lanes.
 *
 * Each tick, every awake lane (belt system, src/sim/tick.ts):
 * 1. hands its first item on if it has reached the end and the line ends in
 *    another line: the next line's start for a loop, the middle of the
 *    belt's near lane for a side-load (both lanes of a side-loading line take
 *    turns when both are waiting). Otherwise items stop at the end.
 * 2. moves by `BELT_SPEED` (see lane.ts).
 * A lane that did neither goes to sleep: it leaves the active list until it
 * gets an item, loses one, or the lane it feeds changes (it then wakes the
 * lanes feeding it). Empty lanes sleep too.
 *
 * Rebuilds. Placing, rotating or removing a belt can only change the links
 * of belts within two tiles of it, so the lines through those belts are
 * taken apart (keeping every item's belt, lane and position on its belt) and
 * rebuilt from their belts; other lines keep their ids and items. Items that
 * end up closer than the minimum spacing where two lines join are pushed back
 * towards the start of the line, past it if need be (they move on once there
 * is room). A removed belt's items are refunded with it (removeEntity in
 * src/sim/entities/build.ts), and the removal is refused if they don't fit.
 *
 * Other systems move items with `insertAt`, `takeAt`, `peekAt` and `peekEnd`
 * on a line and lane, and `beltLine`/`beltOffset` find a belt's line and its
 * stretch of it. The generic item hooks put items onto the middle of a belt
 * (see `insert`). Notifications (`entities.notify`): every tick a lane of a
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

import { ENTITIES, EntityTypeId, BELT_ITEM_SPACING } from '../../data/entities';
import { itemPrototype, type ItemStack, type RealItemId } from '../../data/items';
import { DIRECTION_DX, DIRECTION_DY, type Direction } from '../entities/direction';
import type { Entities } from '../entities/entities';
import { SparseSet, growTo } from '../entities/sparseSet';
import type { EntityTypeTable } from '../entities/table';
import { fnv1a32 } from '../hash';
import { BELT_LENGTH, BeltLane, LineLane, TransportLine } from './line';

/** How far items on a belt move per tick, in subtiles. */
export const BELT_SPEED = ENTITIES[EntityTypeId.TransportBelt].beltSpeed ?? 0;

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

export class BeltTable implements EntityTypeTable {
  readonly type = EntityTypeId.TransportBelt;
  private readonly set = new SparseSet();
  /** Line id per belt row. */
  private lineCol = new Uint32Array(0);
  /** Index of the belt in its line (0 is the belt at the line's end). */
  private indexCol = new Uint32Array(0);
  /** `BeltShape` per row. */
  private shapeCol = new Uint8Array(0);
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

  /** Id of the line belt `belt` is on, or 0 if it isn't a belt. */
  beltLine(belt: number): number {
    const row = this.set.indexOf(belt);
    return row < 0 ? 0 : this.lineCol[row]!;
  }

  /** Index of belt `belt` in its line (0 is the belt at the line's end). */
  beltIndex(belt: number): number {
    return this.indexCol[this.row(belt)]!;
  }

  /** Distance from the end of belt `belt`'s line to the belt's end edge (it spans 256 from there). */
  beltOffset(belt: number): number {
    return this.beltIndex(belt) * BELT_LENGTH;
  }

  /** How belt `belt` is drawn. */
  shape(belt: number): BeltShape {
    return this.shapeCol[this.row(belt)]! as BeltShape;
  }

  // Entity hooks.

  add(id: number, entities: Entities): void {
    this.entities = entities;
    const row = this.set.add(id);
    const min = row + 1;
    this.lineCol = growTo(this.lineCol, min);
    this.indexCol = growTo(this.indexCol, min);
    this.shapeCol = growTo(this.shapeCol, min);
    this.relink(id, 0);
  }

  remove(id: number): void {
    if (!this.set.has(id)) return;
    this.relink(id, id);
  }

  rotated(id: number): void {
    this.relink(id, 0);
  }

  watched(id: number): void {
    const line = this.lineMap.get(this.beltLine(id));
    if (line && !line.watched.includes(id)) line.watched.push(id);
  }

  contents(id: number): readonly ItemStack[] {
    const out: ItemStack[] = [];
    for (const { item } of this.itemsOn(id)) {
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
    const line = this.lineOfBelt(id);
    const pos = this.beltOffset(id) + BELT_LENGTH / 2;
    return (line.lanes[0].canInsert(pos) ? 1 : 0) + (line.lanes[1].canInsert(pos) ? 1 : 0);
  }

  /**
   * Puts items onto the middle of the belt, the way a drill or a player's
   * hand drops them: one unit on the right lane, then one on the left lane,
   * as far as they have room (so at most two per call).
   */
  insert(id: number, item: number, count: number): number {
    if (!itemPrototype(item)) return 0;
    const lineId = this.beltLine(id);
    const pos = this.beltOffset(id) + BELT_LENGTH / 2;
    let n = 0;
    for (const lane of [BeltLane.Right, BeltLane.Left]) {
      if (n < count && this.insertAt(lineId, lane, pos, item)) n++;
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
    for (const line of this.lineMap.values()) {
      h = fnv1a32(
        Uint32Array.of(
          line.id,
          line.belts.length,
          line.out?.id ?? 0,
          line.outLane + 1,
          line.outPos,
          line.turn,
        ),
        h,
      );
      for (const lane of line.lanes) {
        h = fnv1a32(Uint32Array.of(lane.count, lane.total, lane.active ? 1 : 0), h);
        h = fnv1a32(lane.gaps(), h);
        h = fnv1a32(lane.items(), h);
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
    const list = this.active;
    const n = list.length;
    let w = 0;
    for (let i = 0; i < n; i++) {
      const lane = list[i]!;
      if (this.step(lane)) {
        list[w++] = lane;
      } else {
        lane.active = false;
        lane.clearMoved();
      }
    }
    // Lanes woken during the loop were appended after the first `n`.
    for (let i = n; i < list.length; i++) list[w++] = list[i]!;
    list.length = w;
  }

  /** One tick of one lane; returns whether it stays awake. */
  private step(lane: LineLane): boolean {
    if (lane.count === 0) return false;
    const { line } = lane;
    let busy = false;
    let changed = false;
    // The stretch of the lane that changed, as distances from the end.
    let lo = 0;
    let hi = 0;
    if (line.out && lane.gap(0) === 0) {
      const r = this.output(line, lane);
      busy = r !== Output.Blocked;
      changed = r === Output.Moved;
    }
    if (lane.move(BELT_SPEED) > 0) {
      if (!changed) lo = lane.firstMovedPosition();
      hi = lane.total + lane.movedAll + lane.movedRest;
      busy = changed = true;
    }
    if (changed) {
      this.wakeFeeders(line, lane.index);
      this.notifyWatchers(line, lo, hi);
    }
    return busy;
  }

  /** Hands the lane's first item (at the very end) on to `line.out`. */
  private output(line: TransportLine, lane: LineLane): number {
    const out = line.out!;
    const target = out.lanes[line.outLane < 0 ? lane.index : line.outLane]!;
    if (!target.canInsert(line.outPos)) return Output.Blocked;
    if (line.outLane >= 0 && line.turn !== lane.index) {
      const other = line.lanes[1 - lane.index]!;
      if (other.count > 0 && other.gap(0) === 0) {
        this.wakeLane(other);
        return Output.Yielded;
      }
    }
    const item = lane.removeAt(0);
    target.insert(line.outPos, item);
    line.turn = (1 - lane.index) as BeltLane;
    this.wakeLane(target);
    this.notifyWatchers(out, line.outPos, line.outPos);
    return Output.Moved;
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
      } else if (f.outLane === lane) {
        this.wakeLane(f.lanes[0]);
        this.wakeLane(f.lanes[1]);
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
      const start = this.indexCol[this.row(belt)]! * BELT_LENGTH;
      if (hi >= start - BELT_ITEM_SPACING && lo <= start + BELT_LENGTH + BELT_ITEM_SPACING) {
        entities.notify(belt);
      }
    }
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

  /** The belt `id` points into, unless that one points straight back. */
  private frontBelt(id: number): number {
    const { store } = this.entities!;
    const d = store.dir(id);
    const f = this.beltAt(store.x(id) + DIRECTION_DX[d]!, store.y(id) + DIRECTION_DY[d]!);
    return f !== 0 && this.dir(f) === ((d + 2) & 3) ? 0 : f;
  }

  /** The belt that `id` continues (see the file comment), or 0. */
  private predecessor(id: number): number {
    const { store } = this.entities!;
    const d = store.dir(id);
    const x = store.x(id);
    const y = store.y(id);
    const behind = this.beltAt(x - DIRECTION_DX[d]!, y - DIRECTION_DY[d]!);
    if (behind !== 0 && this.dir(behind) === d) return behind;
    // Sides: the left one must point clockwise of `d` to point into this belt.
    const l = ccw(d);
    const left = this.beltAt(x + DIRECTION_DX[l]!, y + DIRECTION_DY[l]!);
    const r = cw(d);
    const right = this.beltAt(x + DIRECTION_DX[r]!, y + DIRECTION_DY[r]!);
    const fromLeft = left !== 0 && this.dir(left) === r;
    const fromRight = right !== 0 && this.dir(right) === l;
    if (fromLeft === fromRight) return 0;
    return fromLeft ? left : right;
  }

  /**
   * Rebuilds the lines around belt `id`, which was just placed or rotated,
   * or (with `removed === id`) is about to be removed.
   */
  private relink(id: number, removed: number): void {
    const { store } = this.entities!;
    const x = store.x(id);
    const y = store.y(id);

    // 1. Take apart every line through a belt within two tiles.
    const dissolved: TransportLine[] = [];
    for (const [dx, dy] of NEAR) {
      const b = this.beltAt(x + dx, y + dy);
      const line = b !== 0 ? this.lineMap.get(this.lineCol[this.row(b)]!) : undefined;
      if (line && !line.dead) {
        line.dead = true;
        dissolved.push(line);
      }
    }
    const saved = new Map<number, SavedItem[]>();
    const belts: number[] = [];
    const feeders: TransportLine[] = [];
    for (const line of dissolved) {
      this.lineMap.delete(line.id);
      this.forEachItem(line, (k, lane, offset, _moved, item) => {
        const belt = line.belts[k]!;
        let list = saved.get(belt);
        if (!list) saved.set(belt, (list = []));
        list.push({ lane, offset, item });
      });
      belts.push(...line.belts);
      for (const f of line.feeders) {
        if (!f.dead && !feeders.includes(f)) feeders.push(f);
      }
      const out = line.out;
      if (out && !out.dead) out.feeders.splice(out.feeders.indexOf(line), 1);
    }
    if (dissolved.length > 0) {
      this.active = this.active.filter((lane) => !lane.line.dead);
    }
    if (removed !== 0) {
      this.dropRow(removed);
    } else if (!belts.includes(id)) {
      belts.push(id);
    }
    const members = new Set(belts.filter((b) => b !== removed));
    const sorted = Array.from(members).sort((a, b) => a - b);

    // 2. Links among those belts.
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
    const created: TransportLine[] = [];
    const visited = new Set<number>();
    const chain = (head: number): void => {
      const list: number[] = [];
      for (let b = head; b !== 0 && !visited.has(b); b = pred.get(b) ?? 0) {
        visited.add(b);
        list.push(b);
      }
      created.push(this.createLine(list, pred, saved));
    };
    for (const b of sorted) {
      if (!hasSucc.has(b)) chain(b);
    }
    for (const b of sorted) {
      if (!visited.has(b)) chain(b);
    }

    // 4. Where the new lines, and the old lines that fed the old ones, now end.
    for (const line of [...created, ...feeders]) this.computeOutput(line);
    for (const line of [...created, ...feeders]) {
      this.wakeLane(line.lanes[0]);
      this.wakeLane(line.lanes[1]);
    }
    for (const b of sorted) this.notifyBelt(b);
  }

  private createLine(
    belts: number[],
    pred: Map<number, number>,
    saved: Map<number, SavedItem[]>,
  ): TransportLine {
    const line = new TransportLine(this.nextLine++, belts, BELT_ITEM_SPACING);
    this.lineMap.set(line.id, line);
    const entries: [number, number][][] = [[], []];
    belts.forEach((belt, k) => {
      const row = this.row(belt);
      this.lineCol[row] = line.id;
      this.indexCol[row] = k;
      const p = pred.get(belt) ?? 0;
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
    const head = line.belts[0]!;
    const f = this.frontBelt(head);
    const target = f !== 0 ? this.lineMap.get(this.lineCol[this.row(f)]!) : undefined;
    if (!target) return;
    const k = this.indexCol[this.row(f)]!;
    if (this.predecessor(f) === head) {
      // Only a loop gets here: everything else that continues merged into one line.
      line.outPos = (k + 1) * BELT_LENGTH;
    } else {
      // Side-load onto the middle of the near lane.
      line.outLane = this.dir(head) === cw(this.dir(f)) ? BeltLane.Left : BeltLane.Right;
      line.outPos = k * BELT_LENGTH + BELT_LENGTH / 2;
    }
    line.out = target;
    target.feeders.push(line);
  }

  private dropRow(id: number): void {
    const row = this.set.remove(id);
    if (row < 0) return;
    const last = this.set.size;
    if (row !== last) {
      this.lineCol[row] = this.lineCol[last]!;
      this.indexCol[row] = this.indexCol[last]!;
      this.shapeCol[row] = this.shapeCol[last]!;
    }
    this.lineCol[last] = 0;
    this.indexCol[last] = 0;
    this.shapeCol[last] = 0;
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

/** The belt table of `entities`, if one is registered. */
export function beltTable(entities: Entities): BeltTable | undefined {
  const table = entities.table(EntityTypeId.TransportBelt);
  return table instanceof BeltTable ? table : undefined;
}

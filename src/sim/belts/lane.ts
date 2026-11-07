/**
 * One lane of a transport line: its items stored as gaps (docs/ARCHITECTURE.md,
 * "Belts: transport lines"; the idea is Factorio's, Friday Facts #176).
 *
 * Positions are distances from the end of the line in subtiles (1/256 tile),
 * so the item at index 0 is the one closest to the end. `gap(0)` is the
 * distance from the end to that item, and `gap(i)` for `i > 0` the distance
 * from item `i - 1` to item `i`. Consecutive items are never closer than
 * `spacing`; the first item can sit right at the end (`gap(0) === 0`).
 *
 * Moving the lane only touches one or two gaps: while the first item hasn't
 * reached the end, `gap(0)` shrinks and every item moves with it; once it
 * has, the items packed behind it (at exactly `spacing`) stay put and the
 * first gap behind them that is wider than `spacing` shrinks instead. The
 * length of that packed run (`run`) is cached and only ever grows while
 * items close up, so a step costs O(1) amortized however long the lane is.
 *
 * Gaps and items live in two ring buffers, so items leave the front and
 * join the back in O(1); inserting or taking in the middle shifts the items
 * behind that point.
 */

import { SaveError, type SaveReader, type SaveWriter } from '../save/codec';

/** The bits of a stored item that hold its id; the top bit is its mark (`Lane.marked`). */
const ITEM_BITS = 0x7fff;
const MARK = 0x8000;

/** Where the items reaching the end of a lane can go (see `Lane.move`). */
export interface LaneOutlet {
  /**
   * How close to the end item 0 of `lane` may come right now (0: all the
   * way). Where the lane hands on to the start of another lane, item 0 has
   * to stay the spacing behind that lane's last item, so the limit is more
   * than the spacing while that item sits past the lane's start edge.
   */
  minFront(lane: Lane): number;
  /**
   * Tries to hand item 0, at the end of `lane`, on, with `rem` subtiles of
   * this tick's movement left; returns whether it did (and removed it).
   */
  handOn(lane: Lane, rem: number): boolean;
  /**
   * Whether item 0 is also offered (`handOn`) when it is held short of the
   * end by `minFront` and can't move further this tick, not only at the
   * end: a splitter's half can send it across to the other output from
   * there.
   */
  readonly early?: boolean;
}

export class Lane {
  private gapBuf: Int32Array;
  private itemBuf: Uint16Array;
  /** Ring index of item 0. */
  private head = 0;
  private mask: number;
  /** Number of items. */
  count = 0;
  /** Sum of the gaps: the distance from the end of the line to the last item. */
  total = 0;
  /**
   * A lower bound on the packed run behind the first item: gaps `1 .. run - 1`
   * are exactly `spacing`. `move` extends it lazily.
   */
  private run = 1;
  /** Whether the lane is on its table's active list (see BeltTable). */
  active = false;
  /**
   * How far the items moved on the lane's last step, for drawing them between
   * ticks: every item by `movedAll`, and items from index `movedFrom` on by a
   * further `movedRest`. Zero for a lane that didn't move.
   */
  movedAll = 0;
  movedFrom = 0;
  movedRest = 0;

  /**
   * Distance consecutive items close up to: `minSpacing`, or more while the
   * lane is held open for items joining it (a splitter half that the other
   * half merges into, see `setSpacing`). Gaps already narrower stay as they
   * are, but never below `minSpacing`.
   */
  spacing: number;

  constructor(
    /** Minimum distance between consecutive items. */
    readonly minSpacing: number,
    capacity = 4,
  ) {
    this.spacing = minSpacing;
    let cap = 4;
    while (cap < capacity) cap *= 2;
    this.gapBuf = new Int32Array(cap);
    this.itemBuf = new Uint16Array(cap);
    this.mask = cap - 1;
  }

  /**
   * Sets the distance items close up to (at least `minSpacing`). The packed
   * run is recounted from the front, since gaps that were packed at the old
   * spacing may be movable at the new one.
   */
  setSpacing(spacing: number): void {
    if (spacing === this.spacing) return;
    this.spacing = Math.max(this.minSpacing, spacing);
    this.run = 1;
  }

  /** Gap in front of item `i` (see the class comment). */
  gap(i: number): number {
    return this.gapBuf[(this.head + i) & this.mask]!;
  }

  /** Item id at index `i` (0 is closest to the end). */
  item(i: number): number {
    return this.itemBuf[(this.head + i) & this.mask]! & ITEM_BITS;
  }

  /**
   * Whether item `i` is marked: a flag that travels with the item while it
   * stays on the lane (a splitter half marks the items the other half sent
   * across, which go straight on; see belts.ts). Items leave a lane unmarked.
   */
  marked(i: number): boolean {
    return (this.itemBuf[(this.head + i) & this.mask]! & MARK) !== 0;
  }

  /** Distance from the end of the line to item `i` (O(i)). */
  position(i: number): number {
    let d = 0;
    for (let k = 0; k <= i; k++) d += this.gap(k);
    return d;
  }

  /** Appends an item `gap` behind the current last item (or `gap` from the end of an empty lane). */
  pushBack(gap: number, item: number, mark = false): void {
    this.reserve(this.count + 1);
    const at = (this.head + this.count) & this.mask;
    this.gapBuf[at] = gap;
    this.itemBuf[at] = mark ? item | MARK : item;
    this.count++;
    this.total += gap;
  }

  /**
   * Where an item at distance `pos` from the end would go: the index it
   * would get and the distance of the item in front of it (0 for index 0),
   * or `null` when it would come closer than `spacing` to a neighbour.
   */
  private slotFor(pos: number, spacing: number): { index: number; before: number } | null {
    let d = 0;
    for (let i = 0; i < this.count; i++) {
      const next = d + this.gap(i);
      if (next >= pos) {
        if (next - pos < spacing) return null;
        if (i > 0 && pos - d < spacing) return null;
        return { index: i, before: d };
      }
      d = next;
    }
    if (this.count > 0 && pos - d < spacing) return null;
    return { index: this.count, before: d };
  }

  /** Whether an item fits at distance `pos` from the end (`pos >= 0`). */
  canInsert(pos: number): boolean {
    return pos >= 0 && this.slotFor(pos, this.spacing) !== null;
  }

  /**
   * The nearest distance from the end in `[pos, pos + slack]` where an item
   * fits (`spacing`, by default the lane's, from the items on both sides of
   * it), or -1.
   */
  fitNear(pos: number, slack: number, spacing = this.spacing): number {
    if (pos < 0) return -1;
    let p = pos;
    let d = 0;
    for (let i = 0; i < this.count; i++) {
      d += this.gap(i);
      if (d + spacing <= p) continue;
      if (d >= p + spacing) break;
      // Too close: try right behind this item.
      p = d + spacing;
      if (p > pos + slack) return -1;
    }
    return p;
  }

  /**
   * Puts `item` (marked with `mark`) at distance `pos` from the end if it
   * fits (`spacing`, by default the lane's, from its neighbours); returns
   * whether it did.
   */
  insert(pos: number, item: number, mark = false, spacing = this.spacing): boolean {
    if (pos < 0) return false;
    const slot = this.slotFor(pos, spacing);
    if (!slot) return false;
    const { index, before } = slot;
    if (index === this.count) {
      this.pushBack(pos - before, item, mark);
      return true;
    }
    const gapNew = pos - before;
    const gapAfter = this.gap(index) - gapNew;
    this.insertAt(index, gapNew, mark ? item | MARK : item);
    this.setGap(index + 1, gapAfter);
    // The new gap came out of the old one: the lane's total length is unchanged.
    this.total -= gapNew;
    // Keep `run` a valid lower bound (an insert can't land inside the packed run).
    if (index === 0) {
      this.run = gapAfter === this.spacing ? this.run + 1 : 1;
    } else if (index === this.run && gapNew === this.spacing) {
      this.run++;
    } else if (index < this.run) {
      this.run = index;
    }
    return true;
  }

  /** Removes item `i` and returns its id; the gap it leaves goes to the item behind it. */
  removeAt(i: number): number {
    const item = this.item(i);
    const g = this.gap(i);
    if (i + 1 < this.count) {
      this.setGap(i + 1, this.gap(i + 1) + g);
    } else {
      this.total -= g;
    }
    if (i === 0) {
      this.head = (this.head + 1) & this.mask;
      this.run = Math.max(1, this.run - 1);
    } else {
      for (let k = i; k + 1 < this.count; k++) {
        const to = (this.head + k) & this.mask;
        const from = (this.head + k + 1) & this.mask;
        this.gapBuf[to] = this.gapBuf[from]!;
        this.itemBuf[to] = this.itemBuf[from]!;
      }
      if (i < this.run) this.run = i;
    }
    this.count--;
    if (this.count === 0) {
      this.head = 0;
      this.total = 0;
      this.run = 1;
    }
    return item;
  }

  /**
   * Index of the first item (closest to the end) at a distance in
   * `[from, to]` from the end, or -1. With `accept`, the first such item
   * it accepts.
   */
  find(from: number, to: number, accept?: (item: number) => boolean): number {
    let d = 0;
    for (let i = 0; i < this.count; i++) {
      d += this.gap(i);
      if (d > to) return -1;
      if (d >= from && (!accept || accept(this.item(i)))) return i;
    }
    return -1;
  }

  /**
   * Moves the lane by up to `speed`; returns how far its items went in all
   * (0 if nothing could move).
   *
   * With an `outlet`, the first item only comes as close to the end as the
   * outlet allows (`minFront`), and is offered to it whenever it is at the
   * end with movement left this tick (at once, if it was already waiting
   * there): when the outlet takes it (removing it from the lane), the next
   * item moves on with what is left. So items leave the end of a lane at
   * exactly `speed / spacing` per tick even where the spacing isn't a
   * multiple of the speed (the express belt's 24).
   */
  move(speed: number, outlet: LaneOutlet | null = null): number {
    this.movedAll = 0;
    this.movedFrom = 0;
    this.movedRest = 0;
    if (this.count === 0) return 0;
    let rem = speed;
    for (;;) {
      const g0 = this.gap(0);
      // Asked every time (O(1)): the limit may lie more than the spacing from
      // the end, where a rebuild pushed the target's last item past its start.
      const floor = outlet !== null ? outlet.minFront(this) : 0;
      if (g0 > floor) {
        const a = Math.min(rem, g0 - floor);
        this.setGap(0, g0 - a);
        this.total -= a;
        rem -= a;
        this.movedAll += a;
      }
      if (rem === 0 || outlet === null) break;
      const at = this.gap(0);
      if (at !== 0 && !(outlet.early === true && at <= floor)) break;
      if (!outlet.handOn(this, rem)) break;
      if (this.count === 0) return speed - rem;
    }
    if (rem > 0) {
      const { spacing } = this;
      while (rem > 0) {
        while (this.run < this.count && this.gap(this.run) <= spacing) this.run++;
        if (this.run >= this.count) break;
        if (this.movedRest === 0) this.movedFrom = this.run;
        const g = this.gap(this.run);
        const a = Math.min(rem, g - spacing);
        this.setGap(this.run, g - a);
        this.total -= a;
        rem -= a;
        this.movedRest += a;
      }
    }
    return speed - rem;
  }

  /**
   * Distance from the end of the first item that moved on the last step
   * (after it moved), or a lower bound on it. O(1): the items between item
   * 0 and it are packed (at exactly `spacing`, or closer but at least
   * `minSpacing` after a `setSpacing`), or it is item 0. Only meaningful
   * after a step that moved something.
   */
  firstMovedPosition(): number {
    if (this.movedAll > 0 || this.movedFrom === 0) return this.gap(0);
    return this.gap(0) + (this.movedFrom - 1) * this.minSpacing + this.gap(this.movedFrom);
  }

  /** Clears the movement record (the lane didn't step this tick). */
  clearMoved(): void {
    this.movedAll = 0;
    this.movedFrom = 0;
    this.movedRest = 0;
  }

  /** How far item `i` moved on the last step (see `movedAll`). */
  moved(i: number): number {
    return this.movedAll + (this.movedRest > 0 && i >= this.movedFrom ? this.movedRest : 0);
  }

  /** Gaps and items in order, as fresh arrays (for hashing and tests). */
  gaps(): Int32Array {
    const out = new Int32Array(this.count);
    for (let i = 0; i < this.count; i++) out[i] = this.gap(i);
    return out;
  }

  items(): Uint16Array {
    const out = new Uint16Array(this.count);
    for (let i = 0; i < this.count; i++) out[i] = this.item(i);
    return out;
  }

  /** The indices of the marked items, in order (for hashing and tests). */
  marks(): Uint32Array {
    const out: number[] = [];
    for (let i = 0; i < this.count; i++) if (this.marked(i)) out.push(i);
    return Uint32Array.from(out);
  }

  /**
   * Writes the lane to a save: its items (gaps, ids and marks) and
   * everything that steers its next steps (spacing, the cached packed run,
   * whether it is awake, the last step's movement).
   */
  save(w: SaveWriter): void {
    w.u32(this.spacing);
    w.u32(this.run);
    w.bool(this.active);
    w.u32(this.movedAll);
    w.u32(this.movedFrom);
    w.u32(this.movedRest);
    w.column(this.gaps());
    const items = new Uint16Array(this.count);
    for (let i = 0; i < this.count; i++) items[i] = this.itemBuf[(this.head + i) & this.mask]!;
    w.column(items);
  }

  /** Restores what `save` wrote into this new, empty lane. */
  load(r: SaveReader): void {
    if (this.count !== 0) throw new Error('loading into a lane that is not empty');
    this.spacing = r.u32();
    const run = r.u32();
    this.active = r.bool();
    this.movedAll = r.u32();
    this.movedFrom = r.u32();
    this.movedRest = r.u32();
    const gaps = r.column(new Int32Array(0));
    const items = r.column(new Uint16Array(0), gaps.length);
    for (let i = 0; i < gaps.length; i++) {
      if (gaps[i]! < 0) throw new SaveError('belt lane: negative gap');
      const stored = items[i]!;
      this.pushBack(gaps[i]!, stored & ITEM_BITS, (stored & MARK) !== 0);
    }
    this.run = run;
  }

  private setGap(i: number, gap: number): void {
    this.gapBuf[(this.head + i) & this.mask] = gap;
  }

  /** Opens index `i` for a new item, shifting the items from `i` on one place back. */
  private insertAt(i: number, gap: number, item: number): void {
    this.reserve(this.count + 1);
    for (let k = this.count; k > i; k--) {
      const to = (this.head + k) & this.mask;
      const from = (this.head + k - 1) & this.mask;
      this.gapBuf[to] = this.gapBuf[from]!;
      this.itemBuf[to] = this.itemBuf[from]!;
    }
    const at = (this.head + i) & this.mask;
    this.gapBuf[at] = gap;
    this.itemBuf[at] = item;
    this.count++;
    this.total += gap;
  }

  private reserve(n: number): void {
    if (n <= this.gapBuf.length) return;
    let cap = this.gapBuf.length * 2;
    while (cap < n) cap *= 2;
    const gaps = new Int32Array(cap);
    const items = new Uint16Array(cap);
    for (let i = 0; i < this.count; i++) {
      gaps[i] = this.gap(i);
      items[i] = this.itemBuf[(this.head + i) & this.mask]!;
    }
    this.gapBuf = gaps;
    this.itemBuf = items;
    this.head = 0;
    this.mask = cap - 1;
  }
}

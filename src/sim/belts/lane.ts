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

  constructor(
    /** Minimum distance between consecutive items. */
    readonly spacing: number,
    capacity = 4,
  ) {
    let cap = 4;
    while (cap < capacity) cap *= 2;
    this.gapBuf = new Int32Array(cap);
    this.itemBuf = new Uint16Array(cap);
    this.mask = cap - 1;
  }

  /** Gap in front of item `i` (see the class comment). */
  gap(i: number): number {
    return this.gapBuf[(this.head + i) & this.mask]!;
  }

  /** Item id at index `i` (0 is closest to the end). */
  item(i: number): number {
    return this.itemBuf[(this.head + i) & this.mask]!;
  }

  /** Distance from the end of the line to item `i` (O(i)). */
  position(i: number): number {
    let d = 0;
    for (let k = 0; k <= i; k++) d += this.gap(k);
    return d;
  }

  /** Appends an item `gap` behind the current last item (or `gap` from the end of an empty lane). */
  pushBack(gap: number, item: number): void {
    this.reserve(this.count + 1);
    const at = (this.head + this.count) & this.mask;
    this.gapBuf[at] = gap;
    this.itemBuf[at] = item;
    this.count++;
    this.total += gap;
  }

  /**
   * Where an item at distance `pos` from the end would go: the index it
   * would get and the distance of the item in front of it (0 for index 0),
   * or `null` when it would come closer than `spacing` to a neighbour.
   */
  private slotFor(pos: number): { index: number; before: number } | null {
    let d = 0;
    for (let i = 0; i < this.count; i++) {
      const next = d + this.gap(i);
      if (next >= pos) {
        if (next - pos < this.spacing) return null;
        if (i > 0 && pos - d < this.spacing) return null;
        return { index: i, before: d };
      }
      d = next;
    }
    if (this.count > 0 && pos - d < this.spacing) return null;
    return { index: this.count, before: d };
  }

  /** Whether an item fits at distance `pos` from the end (`pos >= 0`). */
  canInsert(pos: number): boolean {
    return pos >= 0 && this.slotFor(pos) !== null;
  }

  /** Puts `item` at distance `pos` from the end if it fits; returns whether it did. */
  insert(pos: number, item: number): boolean {
    if (pos < 0) return false;
    const slot = this.slotFor(pos);
    if (!slot) return false;
    const { index, before } = slot;
    if (index === this.count) {
      this.pushBack(pos - before, item);
      return true;
    }
    const gapNew = pos - before;
    const gapAfter = this.gap(index) - gapNew;
    this.insertAt(index, gapNew, item);
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
   * `[from, to]` from the end, or -1.
   */
  find(from: number, to: number): number {
    let d = 0;
    for (let i = 0; i < this.count; i++) {
      d += this.gap(i);
      if (d > to) return -1;
      if (d >= from) return i;
    }
    return -1;
  }

  /**
   * Moves the lane by up to `speed`; returns how far its first movable item
   * went (0 if nothing could move).
   */
  move(speed: number): number {
    this.movedAll = 0;
    this.movedFrom = 0;
    this.movedRest = 0;
    if (this.count === 0) return 0;
    let rem = speed;
    const g0 = this.gap(0);
    if (g0 > 0) {
      const a = Math.min(rem, g0);
      this.setGap(0, g0 - a);
      this.total -= a;
      rem -= a;
      this.movedAll = a;
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
   * (after it moved). O(1): the items between item 0 and it are packed at
   * exactly `spacing`, or it is item 0. Only meaningful after a step that
   * moved something.
   */
  firstMovedPosition(): number {
    if (this.movedAll > 0 || this.movedFrom === 0) return this.gap(0);
    return this.gap(0) + (this.movedFrom - 1) * this.spacing + this.gap(this.movedFrom);
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
      items[i] = this.item(i);
    }
    this.gapBuf = gaps;
    this.itemBuf = items;
    this.head = 0;
    this.mask = cap - 1;
  }
}

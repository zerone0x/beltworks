/**
 * Belt editing for the demo (README.md, "Belt editing"): a network with room
 * for more segments, and the click rule that places a belt on an empty tile
 * or rotates the belt on a tile. An edit says which segments changed, and the
 * page writes just those into the GPU's segment buffer (`GpuBeltSim.
 * updateSegments`) between two steps: the simulation is not restarted, and
 * the item buffers and the tick are left as they are.
 */

import {
  DIRS,
  NO_SEGMENT,
  SEGMENT_WORDS,
  SPEED,
  SegmentField as F,
  Group,
  type Network,
} from './network';

/** Segment slots kept free for placed belts. */
export const EXTRA_SEGMENTS = 256;

/** What a click did. `changed`: the segments whose words changed (to upload). */
export type EditResult =
  | {
      readonly kind: 'placed' | 'rotated';
      readonly segment: number;
      readonly changed: readonly number[];
    }
  | { readonly kind: 'refused'; readonly reason: string; readonly changed: readonly number[] };

/**
 * A `Network` that can grow by up to `capacity - count` segments. `segments`
 * is a view of the first `count` segments; `data` holds all `capacity`.
 */
export class EditableNetwork implements Network {
  readonly data: Uint32Array;
  readonly capacity: number;
  readonly width: number;
  readonly height: number;
  count: number;

  constructor(net: Network, extra = EXTRA_SEGMENTS) {
    this.capacity = net.count + extra;
    this.data = new Uint32Array(this.capacity * SEGMENT_WORDS);
    this.data.set(net.segments.subarray(0, net.count * SEGMENT_WORDS));
    this.count = net.count;
    this.width = net.width;
    this.height = net.height;
  }

  get segments(): Uint32Array {
    return this.data.subarray(0, this.count * SEGMENT_WORDS);
  }

  get(s: number, f: number): number {
    return this.data[s * SEGMENT_WORDS + f]!;
  }

  private set(s: number, f: number, value: number): void {
    this.data[s * SEGMENT_WORDS + f] = value;
  }

  /** The segments on tile `(x, y)`. */
  segmentsAt(x: number, y: number): number[] {
    const out: number[] = [];
    for (let s = 0; s < this.count; s++) {
      if (this.get(s, F.x) === x && this.get(s, F.y) === y) out.push(s);
    }
    return out;
  }

  /** The segment an item leaving `s` enters: on the next tile, entered in `s`'s exit direction. */
  private successor(s: number): number {
    const out = this.get(s, F.outDir);
    const [dx, dy] = DIRS[out]!;
    const x = this.get(s, F.x) + dx;
    const y = this.get(s, F.y) + dy;
    return this.segmentsAt(x, y).find((t) => this.get(t, F.inDir) === out) ?? NO_SEGMENT;
  }

  private link(s: number, to: number): void {
    this.set(s, F.next0, to);
    this.set(s, F.next1, to);
  }

  /**
   * A click on tile `(x, y)`. On an empty tile it places a straight belt that
   * continues a belt ending there (else one heading east), and links every
   * belt that ended into it. On a tile with one belt it rotates that belt's
   * exit: straight, then a right turn, then a left turn, then straight again,
   * and relinks it to whatever the new exit leads into, or to nothing (a dead
   * end, where items wait). The splitter and the merge and splitter output
   * tiles (two belts on one tile) can't be edited.
   */
  edit(x: number, y: number): EditResult {
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      return { kind: 'refused', reason: 'not a tile', changed: [] };
    }
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) {
      return { kind: 'refused', reason: 'outside the grid', changed: [] };
    }
    const here = this.segmentsAt(x, y);
    if (here.length > 1) {
      return { kind: 'refused', reason: 'a splitter output or merge tile', changed: [] };
    }
    if (here.length === 1) {
      const s = here[0]!;
      if (this.get(s, F.next0) !== this.get(s, F.next1)) {
        return { kind: 'refused', reason: 'the splitter', changed: [] };
      }
      const inDir = this.get(s, F.inDir);
      const turn = (this.get(s, F.outDir) - inDir + 4) % 4;
      // Straight (0) -> right (1) -> left (3) -> straight.
      const nextTurn = turn === 0 ? 1 : turn === 1 ? 3 : 0;
      this.set(s, F.outDir, (inDir + nextTurn) % 4);
      this.link(s, this.successor(s));
      return { kind: 'rotated', segment: s, changed: [s] };
    }
    if (this.count >= this.capacity) {
      return { kind: 'refused', reason: 'no free segment slots', changed: [] };
    }
    // Belts whose exit leads into this tile, dead ends first.
    const feeders: number[] = [];
    for (let s = 0; s < this.count; s++) {
      const [dx, dy] = DIRS[this.get(s, F.outDir)]!;
      if (this.get(s, F.x) + dx === x && this.get(s, F.y) + dy === y) feeders.push(s);
    }
    const from = feeders.find((s) => this.get(s, F.next0) === NO_SEGMENT) ?? feeders[0];
    const dir = from === undefined ? 0 : this.get(from, F.outDir);
    const s = this.count++;
    this.set(s, F.x, x);
    this.set(s, F.y, y);
    this.set(s, F.inDir, dir);
    this.set(s, F.outDir, dir);
    this.set(s, F.speed, from === undefined ? SPEED.fast : this.get(from, F.speed));
    this.set(s, F.group, from === undefined ? Group.branchA : this.get(from, F.group));
    this.link(s, this.successor(s));
    const changed = [s];
    for (const f of feeders) {
      if (this.get(f, F.outDir) === dir && this.get(f, F.next0) === NO_SEGMENT) {
        this.link(f, s);
        changed.push(f);
      }
    }
    return { kind: 'placed', segment: s, changed };
  }
}

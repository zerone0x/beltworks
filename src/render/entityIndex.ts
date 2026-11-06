/**
 * The main thread's copy of the entities around the view, rebuilt from each
 * snapshot's entity records: a list for drawing and a per-tile index for
 * "what is under the cursor" and the ghost preview's collision check.
 *
 * Read-only mirror data; nothing here flows back into the simulation.
 */

import { entityPrototype, type EntityPrototype } from '../data/entities';
import type { Direction } from '../sim/entities/direction';
import { footprintSize } from '../sim/entities/store';
import { ENTITY_STRIDE, EntityField } from '../sim/snapshot';

/** One entity as received from the worker. */
export interface EntityView {
  id: number;
  type: number;
  /** `undefined` for an unknown type id. */
  proto: EntityPrototype | undefined;
  /** Top-left tile of the footprint. */
  x: number;
  y: number;
  w: number;
  h: number;
  dir: Direction;
  /** Machine state (`MachineState` in src/sim/entities/machine.ts). */
  status: number;
  /** The recipe an assembling machine is set to (0 for none and other types). */
  recipe: number;
}

/**
 * Packs a tile into one number key; unique for tiles in the supported map
 * range (about ±1M tiles per axis, see `isTileInMap`).
 */
const tileKey = (x: number, y: number): number => (x + 0x20_0000) * 0x40_0000 + (y + 0x20_0000);

export class EntityIndex {
  private records = new Int32Array(0);
  private list: EntityView[] = [];
  private readonly byTile = new Map<number, EntityView>();
  /** Bumped whenever the entities change, so layers know when to redraw. */
  version = 0;

  /** Entities from the latest snapshot. */
  get entities(): readonly EntityView[] {
    return this.list;
  }

  /** Replaces the contents with the records of a snapshot; returns whether anything changed. */
  apply(buffer: ArrayBuffer): boolean {
    const records = new Int32Array(buffer);
    if (sameRecords(records, this.records)) {
      return false;
    }
    this.records = records;
    this.list = [];
    this.byTile.clear();
    for (let o = 0; o + ENTITY_STRIDE <= records.length; o += ENTITY_STRIDE) {
      const type = records[o + EntityField.type]!;
      const proto = entityPrototype(type);
      const dir = (records[o + EntityField.dir]! & 3) as Direction;
      const { w, h } = proto ? footprintSize(proto, dir) : { w: 1, h: 1 };
      const entity: EntityView = {
        id: records[o + EntityField.id]! >>> 0,
        type,
        proto,
        x: records[o + EntityField.x]!,
        y: records[o + EntityField.y]!,
        w,
        h,
        dir,
        status: records[o + EntityField.status]!,
        recipe: records[o + EntityField.recipe]!,
      };
      this.list.push(entity);
      for (let ty = entity.y; ty < entity.y + h; ty++) {
        for (let tx = entity.x; tx < entity.x + w; tx++) {
          this.byTile.set(tileKey(tx, ty), entity);
        }
      }
    }
    this.version++;
    return true;
  }

  /** The entity with id `id`, or `null` if it isn't around the view. */
  byId(id: number): EntityView | null {
    return this.list.find((e) => e.id === id) ?? null;
  }

  /** The entity covering tile `(x, y)`, or `null`. */
  at(x: number, y: number): EntityView | null {
    return this.byTile.get(tileKey(x, y)) ?? null;
  }
}

function sameRecords(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

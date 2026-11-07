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
  /** `byId`'s index, built when first needed after a structural change. */
  private ids: Map<number, EntityView> | null = null;
  /** Bumped whenever the entities change (their states and recipes too), so layers know when to redraw. */
  version = 0;
  /**
   * Bumped only when entities come, go, move or turn (not when only their
   * states or recipes change, which `apply` writes into the existing views):
   * layers that sort or place sprites rebuild on this one.
   */
  structureVersion = 0;

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
    if (sameStructure(records, this.records)) {
      // Only states or recipes changed (a busy factory does that every tick):
      // update the views in place, so sorted sprite layers stay as they are.
      for (let i = 0, o = 0; i < this.list.length; i++, o += ENTITY_STRIDE) {
        const entity = this.list[i]!;
        entity.status = records[o + EntityField.status]!;
        entity.recipe = records[o + EntityField.recipe]!;
      }
      this.records = records;
      this.version++;
      return true;
    }
    this.records = records;
    this.structureVersion++;
    this.ids = null;
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
    if (!this.ids) {
      this.ids = new Map(this.list.map((e) => [e.id, e]));
    }
    return this.ids.get(id) ?? null;
  }

  /** The entity covering tile `(x, y)`, or `null`. */
  at(x: number, y: number): EntityView | null {
    return this.byTile.get(tileKey(x, y)) ?? null;
  }
}

/** Whether `a` and `b` list the same entities at the same places, facing the same way. */
function sameStructure(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let o = 0; o < a.length; o += ENTITY_STRIDE) {
    if (
      a[o + EntityField.id] !== b[o + EntityField.id] ||
      a[o + EntityField.type] !== b[o + EntityField.type] ||
      a[o + EntityField.x] !== b[o + EntityField.x] ||
      a[o + EntityField.y] !== b[o + EntityField.y] ||
      a[o + EntityField.dir] !== b[o + EntityField.dir]
    ) {
      return false;
    }
  }
  return true;
}

function sameRecords(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

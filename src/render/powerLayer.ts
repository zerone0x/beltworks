/**
 * Draws the electric grid from the snapshot's power records (`encodePower`
 * in src/sim/snapshot.ts): the wires between connected poles (above the
 * buildings), sagging between the insulators of the poles' sprites (their
 * `wire-west` / `wire-east` points, docs/ART.md) or the placeholder poles'
 * crossbars, with their shadows on the ground (below the buildings, like
 * the sprites' shadows), and an overlay for the pole in focus (below the ghost):
 * - while a pole ghost is held: every pole's supply area faintly, the
 *   ghost's supply area and wire reach, and a preview of the wires it would
 *   get (the poles it would connect to, judged with the simulation's own
 *   `polesConnect`);
 * - with nothing held, while the pointer is over a pole: its supply area,
 *   its wire reach, and its wires highlighted.
 *
 * Read-only: nothing here flows back into the simulation.
 */

import { Container, Graphics } from 'pixi.js';
import { entityPrototype, type EntityPrototype } from '../data/entities';
import { isPolePrototypeOf, polesConnect, supplyRect } from '../sim/power/geometry';
import { decodePower, type PoleData, type PowerData } from '../sim/snapshot';
import { TILE_PX, type Point } from './camera';
import { EVERYWHERE, overlaps, sameRect, type TileRect } from './cull';
import type { EntityView } from './entityIndex';
import type { Ghost } from './entityLayer';
import { HEIGHT_ON_SCREEN, SHADOW_ALPHA, SHADOW_OFFSET, type SpriteAtlas } from './sprites';

/** Height of a pole's crossbar above its center, in tiles: where the wires hang. */
export const POLE_TOP = 0.3;
const WIRE_COLOR = 0x2a1d14;
const WIRE_HIGHLIGHT = 0xffc35a;
const WIRE_PREVIEW = 0x7ee07e;
const SUPPLY_COLOR = 0x4aa8ff;
const REACH_COLOR = 0xe8e2d0;

/** The pole the overlay is about. */
export interface PowerFocus {
  /** A pole ghost about to be placed, or a placed pole under the pointer. */
  kind: 'ghost' | 'pole';
  proto: EntityPrototype;
  /** Top-left tile. */
  x: number;
  y: number;
  /** The pole's id (0 for a ghost). */
  id: number;
  /** The poles it is wired to (or, for a ghost, would be), ascending ids. */
  connects: number[];
}

/** Where wires attach to a placeholder pole with its top-left tile at `(x, y)`, in world pixels. */
export function poleTop(proto: EntityPrototype, x: number, y: number): Point {
  return {
    x: (x + proto.width / 2) * TILE_PX,
    y: (y + proto.height / 2 - POLE_TOP) * TILE_PX,
  };
}

/**
 * A wire's end: the point on the ground under it and how high above the
 * ground it shows on screen (world pixels).
 */
export interface WireEnd {
  x: number;
  y: number;
  lift: number;
}

/**
 * Where a wire leaving a pole of `proto` at `(x, y)` (top-left tile)
 * towards `toward` (world x) attaches: the insulator on that side of the
 * pole's sprite in `atlas` (east when straight above or below), or the
 * placeholder's crossbar.
 */
export function wireEnd(
  atlas: SpriteAtlas | null,
  proto: EntityPrototype,
  x: number,
  y: number,
  toward: number,
): WireEnd {
  const cx = (x + proto.width / 2) * TILE_PX;
  const cy = (y + proto.height / 2) * TILE_PX;
  const model = atlas?.model(proto.name) ?? null;
  const point = model?.points[toward < cx ? 'wire-west' : 'wire-east']?.[0];
  if (model && point) {
    // Pole points sit on the pole's east-west axis: x is along the ground, y all height.
    return { x: cx + point[0] * model.scale, y: cy, lift: -point[1] * model.scale };
  }
  return { x: cx, y: cy, lift: POLE_TOP * TILE_PX };
}

/** Opacity of the wires' shadows (half the buildings' `SHADOW_ALPHA`). */
const WIRE_SHADOW_ALPHA = SHADOW_ALPHA / 2;
/** Segments of a drawn wire. */
const WIRE_STEPS = 12;
/** How far a wire sags in its middle, per tile it spans (tiles of height). */
export const WIRE_SAG = 0.05;

/**
 * Points along a wire from `a` to `b` hanging in a parabola (a catenary this
 * shallow is one), on screen and, with `shadow`, its shadow on the ground
 * (world pixels, flattened `[x0, y0, x1, y1, ...]`).
 */
export function wirePath(a: WireEnd, b: WireEnd, shadow = false): number[] {
  const span = Math.hypot(b.x - a.x, b.y - a.y);
  const sag = WIRE_SAG * span * HEIGHT_ON_SCREEN;
  const out: number[] = [];
  for (let i = 0; i <= WIRE_STEPS; i++) {
    const s = i / WIRE_STEPS;
    const gx = a.x + (b.x - a.x) * s;
    const gy = a.y + (b.y - a.y) * s;
    const lift = a.lift + (b.lift - a.lift) * s - sag * 4 * s * (1 - s);
    if (shadow) {
      const height = lift / HEIGHT_ON_SCREEN;
      out.push(gx + height * SHADOW_OFFSET.x, gy + height * SHADOW_OFFSET.y);
    } else {
      out.push(gx, gy - lift);
    }
  }
  return out;
}

/**
 * The pole the overlay shows: a pole ghost if one is held, else the pole
 * under the pointer when nothing is held; `null` otherwise.
 */
export function powerFocus(
  ghost: Ghost | null,
  hovered: EntityView | null,
  power: PowerData,
): PowerFocus | null {
  if (ghost) {
    if (!isPolePrototypeOf(ghost.proto)) return null;
    const connects = power.poles
      .filter((p) => {
        const proto = entityPrototype(p.type);
        return proto !== undefined && polesConnect(ghost.proto, ghost.x, ghost.y, proto, p.x, p.y);
      })
      .map((p) => p.id)
      .sort((a, b) => a - b);
    return { kind: 'ghost', proto: ghost.proto, x: ghost.x, y: ghost.y, id: 0, connects };
  }
  if (!hovered?.proto || !isPolePrototypeOf(hovered.proto)) return null;
  const connects = power.wires
    .filter(([a, b]) => a === hovered.id || b === hovered.id)
    .map(([a, b]) => (a === hovered.id ? b : a))
    .sort((a, b) => a - b);
  return {
    kind: 'pole',
    proto: hovered.proto,
    x: hovered.x,
    y: hovered.y,
    id: hovered.id,
    connects,
  };
}

const EMPTY: PowerData = { poles: [], wires: [], networks: [], members: [] };

export class PowerLayer {
  /** Wires, above the buildings. */
  readonly container = new Container({ label: 'wires' });
  /** Supply areas, reach and wire previews, below the ghost. */
  readonly overlayContainer = new Container({ label: 'power-overlay' });
  /** The wires' shadows on the ground; goes with the buildings' shadows. */
  readonly shadowContainer = new Container({ label: 'wire-shadows' });
  private readonly wireGraphics = new Graphics({ label: 'wires' });
  private readonly shadowGraphics = new Graphics({ label: 'wire-shadows' });
  private atlas: SpriteAtlas | null = null;
  private readonly overlayGraphics = new Graphics({ label: 'power-overlay' });
  private records = new Int32Array(0);
  private power: PowerData = EMPTY;
  private byId = new Map<number, PoleData>();
  private version = 0;
  /** Bumped when poles or wires change (not just the networks' figures). */
  private gridVersion = 0;
  private drawnVersion = -1;
  private cull: TileRect | null = null;
  private overlayKey = '';
  private focusNow: PowerFocus | null = null;

  constructor() {
    this.container.addChild(this.wireGraphics);
    this.overlayContainer.addChild(this.overlayGraphics);
    this.shadowContainer.addChild(this.shadowGraphics);
    // A thin wire's shadow is soft: fainter than the buildings'.
    this.shadowContainer.alpha = WIRE_SHADOW_ALPHA;
  }

  /** Hangs wires from the insulators of the poles' sprites in `atlas` from now on. */
  setAtlas(atlas: SpriteAtlas | null): void {
    this.atlas = atlas;
    this.drawnVersion = -1;
    this.overlayKey = '';
  }

  /** The grid around the view from the latest snapshot. */
  get data(): PowerData {
    return this.power;
  }

  /** The pole the overlay last showed, or `null`. */
  get focus(): PowerFocus | null {
    return this.focusNow;
  }

  /** Takes the power records of a snapshot. */
  apply(buffer: ArrayBuffer): void {
    const records = new Int32Array(buffer);
    if (sameRecords(records, this.records)) return;
    this.records = records;
    const power = decodePower(buffer);
    // Networks' figures change every tick; the wires only when poles do.
    if (!sameGrid(power, this.power)) this.gridVersion++;
    this.power = power;
    this.byId = new Map(this.power.poles.map((p) => [p.id, p]));
    this.version++;
  }

  /**
   * Redraws the wires (and their shadows) with an end in the cull rectangle
   * `cull` if the poles, their wires or the rectangle changed.
   */
  drawWires(cull: TileRect = EVERYWHERE): void {
    if (this.gridVersion === this.drawnVersion && this.cull && sameRect(this.cull, cull)) return;
    this.drawnVersion = this.gridVersion;
    this.cull = cull;
    const g = this.wireGraphics;
    g.clear();
    this.shadowGraphics.clear();
    for (const [a, b] of this.power.wires) {
      const pa = this.byId.get(a);
      const pb = this.byId.get(b);
      if (!(pa && overlaps(cull, pa.x, pa.y)) && !(pb && overlaps(cull, pb.x, pb.y))) continue;
      this.wire(g, a, b, WIRE_COLOR, 1.5);
      const ends = this.ends(a, b);
      if (ends) {
        this.shadowGraphics.poly(wirePath(ends[0], ends[1], true), false).stroke({
          width: 1.2,
          color: 0x000000,
        });
      }
    }
  }

  /** Shows the overlay for `focus` (nothing for `null`). Cheap when nothing changed. */
  drawOverlay(focus: PowerFocus | null): void {
    this.focusNow = focus;
    const key = focus
      ? `${focus.kind}:${String(focus.proto.id)}:${String(focus.x)}:${String(focus.y)}:${focus.connects.join(',')}:${String(this.version)}`
      : '';
    if (key === this.overlayKey) return;
    this.overlayKey = key;
    const g = this.overlayGraphics;
    g.clear();
    if (!focus) return;
    if (focus.kind === 'ghost') {
      // Where power already reaches, to help place the next pole.
      for (const p of this.power.poles) {
        const proto = entityPrototype(p.type);
        if (proto) this.supplyArea(g, proto, p.x, p.y, 0.07, 0.25);
      }
    }
    this.supplyArea(g, focus.proto, focus.x, focus.y, 0.18, 0.8);
    const center = {
      x: (focus.x + focus.proto.width / 2) * TILE_PX,
      y: (focus.y + focus.proto.height / 2) * TILE_PX,
    };
    g.circle(center.x, center.y, (focus.proto.wireReach ?? 0) * TILE_PX).stroke({
      width: 1.5,
      color: REACH_COLOR,
      alpha: 0.55,
    });
    for (const id of focus.connects) {
      const other = this.byId.get(id);
      const proto = other && entityPrototype(other.type);
      if (!other || !proto) continue;
      if (focus.kind === 'ghost') {
        const otherCenter = (other.x + proto.width / 2) * TILE_PX;
        const from = wireEnd(this.atlas, focus.proto, focus.x, focus.y, otherCenter);
        const to = wireEnd(this.atlas, proto, other.x, other.y, center.x);
        g.poly(wirePath(from, to), false).stroke({
          width: 2.5,
          color: WIRE_PREVIEW,
          alpha: 0.9,
        });
      } else {
        this.wire(g, focus.id, id, WIRE_HIGHLIGHT, 2.5);
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.overlayContainer.destroy({ children: true });
  }

  /** The ends of the wire between poles `a` and `b`, or `null` if one isn't around. */
  private ends(a: number, b: number): [WireEnd, WireEnd] | null {
    const pa = this.byId.get(a);
    const pb = this.byId.get(b);
    const protoA = pa && entityPrototype(pa.type);
    const protoB = pb && entityPrototype(pb.type);
    if (!pa || !pb || !protoA || !protoB) return null;
    const ax = (pa.x + protoA.width / 2) * TILE_PX;
    const bx = (pb.x + protoB.width / 2) * TILE_PX;
    return [
      wireEnd(this.atlas, protoA, pa.x, pa.y, bx === ax ? ax + 1 : bx),
      wireEnd(this.atlas, protoB, pb.x, pb.y, bx === ax ? bx + 1 : ax),
    ];
  }

  /** A wire between poles `a` and `b`, sagging between their insulators. */
  private wire(g: Graphics, a: number, b: number, color: number, width: number): void {
    const ends = this.ends(a, b);
    if (!ends) return;
    g.poly(wirePath(ends[0], ends[1]), false).stroke({ width, color, alpha: 0.95, join: 'round' });
  }

  private supplyArea(
    g: Graphics,
    proto: EntityPrototype,
    x: number,
    y: number,
    fill: number,
    stroke: number,
  ): void {
    const r = supplyRect(proto, x, y);
    g.rect(r.x0 * TILE_PX, r.y0 * TILE_PX, (r.x1 - r.x0 + 1) * TILE_PX, (r.y1 - r.y0 + 1) * TILE_PX)
      .fill({ color: SUPPLY_COLOR, alpha: fill })
      .stroke({ width: 1.5, color: SUPPLY_COLOR, alpha: stroke });
  }
}

/** Whether `a` and `b` have the same poles at the same places, wired the same way. */
function sameGrid(a: PowerData, b: PowerData): boolean {
  if (a.poles.length !== b.poles.length || a.wires.length !== b.wires.length) return false;
  for (let i = 0; i < a.poles.length; i++) {
    const p = a.poles[i]!;
    const q = b.poles[i]!;
    if (p.id !== q.id || p.type !== q.type || p.x !== q.x || p.y !== q.y) return false;
  }
  for (let i = 0; i < a.wires.length; i++) {
    if (a.wires[i]![0] !== b.wires[i]![0] || a.wires[i]![1] !== b.wires[i]![1]) return false;
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

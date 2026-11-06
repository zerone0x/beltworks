/**
 * Draws the electric grid from the snapshot's power records (`encodePower`
 * in src/sim/snapshot.ts): the wires between connected poles (above the
 * buildings), and an overlay for the pole in focus (below the ghost):
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
import type { EntityView } from './entityIndex';
import type { Ghost } from './entityLayer';

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

/** Where wires attach to a pole with its top-left tile at `(x, y)`, in world pixels. */
export function poleTop(proto: EntityPrototype, x: number, y: number): Point {
  return {
    x: (x + proto.width / 2) * TILE_PX,
    y: (y + proto.height / 2 - POLE_TOP) * TILE_PX,
  };
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

const EMPTY: PowerData = { poles: [], wires: [], networks: [] };

export class PowerLayer {
  /** Wires, above the buildings. */
  readonly container = new Container({ label: 'wires' });
  /** Supply areas, reach and wire previews, below the ghost. */
  readonly overlayContainer = new Container({ label: 'power-overlay' });
  private readonly wireGraphics = new Graphics({ label: 'wires' });
  private readonly overlayGraphics = new Graphics({ label: 'power-overlay' });
  private records = new Int32Array(0);
  private power: PowerData = EMPTY;
  private byId = new Map<number, PoleData>();
  private version = 0;
  private drawnVersion = -1;
  private overlayKey = '';
  private focusNow: PowerFocus | null = null;

  constructor() {
    this.container.addChild(this.wireGraphics);
    this.overlayContainer.addChild(this.overlayGraphics);
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
    this.power = decodePower(buffer);
    this.byId = new Map(this.power.poles.map((p) => [p.id, p]));
    this.version++;
  }

  /** Redraws the wires if the grid changed. */
  drawWires(): void {
    if (this.version === this.drawnVersion) return;
    this.drawnVersion = this.version;
    const g = this.wireGraphics;
    g.clear();
    for (const [a, b] of this.power.wires) {
      this.wire(g, a, b, WIRE_COLOR, 1.5);
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
    const top = poleTop(focus.proto, focus.x, focus.y);
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
      const end = poleTop(proto, other.x, other.y);
      if (focus.kind === 'ghost') {
        g.moveTo(top.x, top.y).lineTo(end.x, end.y).stroke({
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

  /** A wire between poles `a` and `b`, sagging a little. */
  private wire(g: Graphics, a: number, b: number, color: number, width: number): void {
    const pa = this.byId.get(a);
    const pb = this.byId.get(b);
    const protoA = pa && entityPrototype(pa.type);
    const protoB = pb && entityPrototype(pb.type);
    if (!pa || !pb || !protoA || !protoB) return;
    const s = poleTop(protoA, pa.x, pa.y);
    const e = poleTop(protoB, pb.x, pb.y);
    const sag = Math.hypot(e.x - s.x, e.y - s.y) * 0.08;
    g.moveTo(s.x, s.y)
      .quadraticCurveTo((s.x + e.x) / 2, (s.y + e.y) / 2 + sag, e.x, e.y)
      .stroke({ width, color, alpha: 0.95 });
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

function sameRecords(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

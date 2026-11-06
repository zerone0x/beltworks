/**
 * Draws the entities (placeholder shapes in each prototype's color, with a
 * direction marker on rotatable ones, a firebox on furnaces that glows while
 * they work, a drill head on mining drills that lights up while they work,
 * a small platform for inserters, and a post with a crossbar for electric
 * poles) and the ghost preview of the entity
 * about to be placed. Placed belts are drawn by the belt layer (beltLayer.ts)
 * instead, and inserter arms by the inserter layer (inserterLayer.ts).
 */

import { Container, Graphics } from 'pixi.js';
import { EntityTypeId, type EntityPrototype } from '../data/entities';
import type { Direction } from '../sim/entities/direction';
import { MachineState } from '../sim/entities/machine';
import { footprintSize } from '../sim/entities/store';
import { TILE_PX } from './camera';
import type { EntityIndex } from './entityIndex';
import { POLE_TOP } from './powerLayer';

/** Ghost tint when the entity can be placed, and when it can't. */
export const GHOST_OK = 0x5ad15a;
export const GHOST_BLOCKED = 0xe0574f;
const MISSING_COLOR = 0xff00ff;
/** Furnace firebox when cold, and the glow of a working one. */
const FIREBOX_COLD = 0x2a2420;
const FIREBOX_GLOW = 0xff9a2e;
const FIREBOX_CORE = 0xffe08a;
/** Drill head when idle, and while the drill mines. */
const DRILL_HEAD_IDLE = 0x3a3c42;
const DRILL_HEAD_WORKING = 0xd8d2bf;

/** Multiplies each channel of a 0xRRGGBB color by `f` (0..1). */
function shade(rgb: number, f: number): number {
  const r = Math.round(((rgb >> 16) & 0xff) * f);
  const g = Math.round(((rgb >> 8) & 0xff) * f);
  const b = Math.round((rgb & 0xff) * f);
  return (r << 16) | (g << 8) | b;
}

/**
 * Draws one entity with its top-left tile at `(x, y)`: a rounded block in
 * the prototype color, and for rotatable entities a triangle pointing the way
 * the entity faces.
 */
export function drawEntity(
  g: Graphics,
  proto: EntityPrototype | undefined,
  x: number,
  y: number,
  dir: Direction,
  alpha: number = 1,
  status: number = MachineState.Idle,
): void {
  if (proto?.id === EntityTypeId.SmallElectricPole) {
    drawPole(g, proto.color, x, y, alpha);
    return;
  }
  const { w, h } = proto ? footprintSize(proto, dir) : { w: 1, h: 1 };
  const color = proto?.color ?? MISSING_COLOR;
  // Inserters stand on a small platform, leaving room to see their arm swing.
  const inset = proto?.id === EntityTypeId.BurnerInserter ? 7 : 2;
  const left = x * TILE_PX + inset;
  const top = y * TILE_PX + inset;
  const width = w * TILE_PX - 2 * inset;
  const height = h * TILE_PX - 2 * inset;
  g.roundRect(left, top, width, height, 3)
    .fill({ color, alpha })
    .stroke({ width: 2, color: shade(color, 0.45), alpha });
  if (proto?.id === EntityTypeId.StoneFurnace) {
    drawFirebox(g, left, top, width, height, alpha, status === MachineState.Working);
  }
  if (proto?.id === EntityTypeId.BurnerMiningDrill) {
    // A ring around the direction marker.
    const radius = Math.min(width, height) * 0.4;
    const working = status === MachineState.Working;
    g.circle(left + width / 2, top + height / 2, radius).stroke({
      width: 3,
      color: working ? DRILL_HEAD_WORKING : DRILL_HEAD_IDLE,
      alpha,
    });
  }
  if (!proto?.rotatable) {
    return;
  }
  // A triangle in the front half, tip towards the facing edge.
  const cx = left + width / 2;
  const cy = top + height / 2;
  const r = Math.min(width, height) * 0.3;
  const ux = [0, 1, 0, -1][dir]!;
  const uy = [-1, 0, 1, 0][dir]!;
  g.poly([
    cx + ux * r,
    cy + uy * r,
    cx - uy * r * 0.8 - ux * r * 0.3,
    cy + ux * r * 0.8 - uy * r * 0.3,
    cx + uy * r * 0.8 - ux * r * 0.3,
    cy - ux * r * 0.8 - uy * r * 0.3,
  ]).fill({ color: shade(color, 0.35), alpha });
}

/**
 * A small electric pole on tile `(x, y)`: a footing, a post, and a crossbar
 * with two insulators where the wires attach (`POLE_TOP` above the center).
 */
function drawPole(g: Graphics, color: number, x: number, y: number, alpha: number): void {
  const cx = (x + 0.5) * TILE_PX;
  const cy = (y + 0.5) * TILE_PX;
  const top = cy - POLE_TOP * TILE_PX;
  const dark = shade(color, 0.45);
  g.roundRect(cx - 7, cy + 2, 14, 9, 2).fill({ color: 0x5a554c, alpha });
  g.rect(cx - 2.5, top - 1, 5, cy + 6 - top)
    .fill({ color, alpha })
    .stroke({ width: 1, color: dark, alpha });
  g.rect(cx - 10, top - 2, 20, 4)
    .fill({ color, alpha })
    .stroke({ width: 1, color: dark, alpha });
  for (const dx of [-8, 8]) {
    g.circle(cx + dx, top - 3, 2.2).fill({ color: 0xd8dde0, alpha });
  }
}

/** The furnace's firebox: an opening in the lower half, lit while the furnace works. */
function drawFirebox(
  g: Graphics,
  left: number,
  top: number,
  width: number,
  height: number,
  alpha: number,
  lit: boolean,
): void {
  const w = width * 0.5;
  const h = height * 0.3;
  const x = left + (width - w) / 2;
  const y = top + height * 0.55;
  if (lit) {
    // A soft halo around the opening, then the fire itself.
    g.roundRect(x - 4, y - 4, w + 8, h + 8, 6).fill({ color: FIREBOX_GLOW, alpha: 0.35 * alpha });
    g.roundRect(x, y, w, h, 3).fill({ color: FIREBOX_GLOW, alpha });
    g.roundRect(x + w * 0.2, y + h * 0.3, w * 0.6, h * 0.5, 2).fill({
      color: FIREBOX_CORE,
      alpha,
    });
  } else {
    g.roundRect(x, y, w, h, 3).fill({ color: FIREBOX_COLD, alpha });
  }
}

export class EntityLayer {
  readonly container = new Container({ label: 'entities' });
  private readonly graphics = new Graphics({ label: 'buildings' });
  private drawn = -1;

  constructor() {
    this.container.addChild(this.graphics);
  }

  /** Redraws the entities if they changed since the last call. */
  draw(index: EntityIndex): void {
    if (index.version === this.drawn) {
      return;
    }
    this.drawn = index.version;
    const g = this.graphics;
    g.clear();
    for (const e of index.entities) {
      if (e.type === EntityTypeId.TransportBelt) continue;
      drawEntity(g, e.proto, e.x, e.y, e.dir, 1, e.status);
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

/** What the ghost preview shows. */
export interface Ghost {
  proto: EntityPrototype;
  /** Top-left tile of the footprint. */
  x: number;
  y: number;
  dir: Direction;
  /** Whether the entity can be placed there, as far as the renderer can tell. */
  valid: boolean;
}

export class GhostLayer {
  readonly container = new Container({ label: 'ghost' });
  private readonly graphics = new Graphics({ label: 'ghost' });
  private key = '';

  constructor() {
    this.container.addChild(this.graphics);
  }

  /** Shows `ghost`, or hides the preview for `null`. Cheap when nothing changed. */
  draw(ghost: Ghost | null): void {
    const key = ghost
      ? `${String(ghost.proto.id)}:${String(ghost.x)}:${String(ghost.y)}:${String(ghost.dir)}:${String(ghost.valid)}`
      : '';
    if (key === this.key) {
      return;
    }
    this.key = key;
    const g = this.graphics;
    g.clear();
    if (!ghost) {
      return;
    }
    drawEntity(g, ghost.proto, ghost.x, ghost.y, ghost.dir, 0.55);
    const { w, h } = footprintSize(ghost.proto, ghost.dir);
    const tint = ghost.valid ? GHOST_OK : GHOST_BLOCKED;
    g.rect(ghost.x * TILE_PX, ghost.y * TILE_PX, w * TILE_PX, h * TILE_PX)
      .fill({ color: tint, alpha: 0.3 })
      .stroke({ width: 2, color: tint, alpha: 0.9 });
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

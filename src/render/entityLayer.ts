/**
 * Draws the entities (placeholder shapes in each prototype's color, with a
 * direction marker on rotatable ones) and the ghost preview of the entity
 * about to be placed.
 */

import { Container, Graphics } from 'pixi.js';
import type { EntityPrototype } from '../data/entities';
import type { Direction } from '../sim/entities/direction';
import { footprintSize } from '../sim/entities/store';
import { TILE_PX } from './camera';
import type { EntityIndex } from './entityIndex';

/** Ghost tint when the entity can be placed, and when it can't. */
export const GHOST_OK = 0x5ad15a;
export const GHOST_BLOCKED = 0xe0574f;
const MISSING_COLOR = 0xff00ff;

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
): void {
  const { w, h } = proto ? footprintSize(proto, dir) : { w: 1, h: 1 };
  const color = proto?.color ?? MISSING_COLOR;
  const inset = 2;
  const left = x * TILE_PX + inset;
  const top = y * TILE_PX + inset;
  const width = w * TILE_PX - 2 * inset;
  const height = h * TILE_PX - 2 * inset;
  g.roundRect(left, top, width, height, 3)
    .fill({ color, alpha })
    .stroke({ width: 2, color: shade(color, 0.45), alpha });
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
      drawEntity(g, e.proto, e.x, e.y, e.dir);
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

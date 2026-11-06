/**
 * Draws the belts and the items on them from the snapshot's belt records
 * (`encodeBelts` in src/sim/snapshot.ts): only belts in the chunk window
 * arrive, so only lines around the viewport are drawn.
 *
 * Straight belts are tiling sprites of a placeholder texture that scrolls
 * with the tick (8 subtiles a tick, like the items); curves are drawn as
 * arcs with bars sweeping around them. Items are drawn every frame between
 * the last tick's position and the current one: each record says how far the
 * item moved on the tick, so an item is drawn `moved * (1 - α)` behind where
 * it is, with `α` the fraction of a tick since the snapshot arrived.
 */

import { Container, Graphics, Texture, TilingSprite } from 'pixi.js';
import { ENTITIES, EntityTypeId } from '../data/entities';
import { itemPrototype } from '../data/items';
import { BELT_SPEED, BeltShape } from '../sim/belts/belts';
import { BELT_LENGTH } from '../sim/belts/line';
import { decodeBelts, type BeltData } from '../sim/snapshot';
import { TICKS_PER_SECOND } from '../worker/protocol';
import { beltPoint, laneLateral, progressOf } from './beltPath';
import { TILE_PX } from './camera';

const TICK_MS = 1000 / TICKS_PER_SECOND;
const BELT_BASE = 0x5b5d64;
const BELT_BAR = 0x84878f;
const BELT_RAIL = ENTITIES[EntityTypeId.TransportBelt].color;
const ITEM_OUTLINE = 0xf2ecd8;
/** Item squares, in tiles: a little under the lane spacing (a quarter tile), so packed items don't overlap. */
const ITEM_SIZE = 0.22;
/** Bars per tile on the belt texture. */
const BARS = 2;

/** Pixels the belt surface moves per tick. */
const PX_PER_TICK = (BELT_SPEED / BELT_LENGTH) * TILE_PX;

/** The placeholder belt texture, one tile facing north: rails and bars across the belt. */
function makeBeltTexture(): Texture {
  const canvas = document.createElement('canvas');
  canvas.width = TILE_PX;
  canvas.height = TILE_PX;
  const ctx = canvas.getContext('2d')!;
  const hex = (c: number) => `#${c.toString(16).padStart(6, '0')}`;
  ctx.fillStyle = hex(BELT_BASE);
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  ctx.fillStyle = hex(BELT_BAR);
  const period = TILE_PX / BARS;
  for (let i = 0; i < BARS; i++) {
    // A chevron pointing up (the way a north-facing belt moves).
    const y = i * period + period / 2;
    for (let x = 4; x < TILE_PX - 4; x++) {
      const dy = Math.abs(x - TILE_PX / 2) * 0.35;
      ctx.fillRect(x, Math.round(y + dy - 1.5), 1, 3);
    }
  }
  ctx.fillStyle = hex(BELT_RAIL);
  ctx.fillRect(0, 0, 3, TILE_PX);
  ctx.fillRect(TILE_PX - 3, 0, 3, TILE_PX);
  const texture = Texture.from(canvas);
  texture.source.scaleMode = 'nearest';
  return texture;
}

export class BeltLayer {
  /** The belts themselves (ground layer). */
  readonly container = new Container({ label: 'belts' });
  /** Items on belts, above the belts and below buildings. */
  readonly itemContainer = new Container({ label: 'belt-items' });
  private readonly straight: TilingSprite[] = [];
  private readonly curves = new Graphics({ label: 'belt-curves' });
  private readonly items = new Graphics({ label: 'items' });
  private texture: Texture | null = null;
  private belts: BeltData[] = [];
  private tick = 0;
  private receivedAt = 0;

  constructor() {
    this.container.addChild(this.curves);
    this.itemContainer.addChild(this.items);
  }

  /** Takes the belts of a snapshot of tick `tick`, received at `nowMs`. */
  apply(buffer: ArrayBuffer, tick: number, nowMs: number): void {
    this.belts = decodeBelts(buffer);
    this.tick = tick;
    this.receivedAt = nowMs;
  }

  /** The belts of the latest snapshot. */
  get data(): readonly BeltData[] {
    return this.belts;
  }

  /** Redraws belts and items for time `nowMs`. */
  draw(nowMs: number): void {
    const alpha = Math.min(1, Math.max(0, (nowMs - this.receivedAt) / TICK_MS));
    const phase = (this.tick + alpha) * PX_PER_TICK;
    this.texture ??= makeBeltTexture();

    let used = 0;
    const curves = this.curves;
    curves.clear();
    for (const belt of this.belts) {
      if (belt.shape === BeltShape.Straight) {
        let sprite = this.straight[used];
        if (!sprite) {
          sprite = new TilingSprite({ texture: this.texture, width: TILE_PX, height: TILE_PX });
          sprite.anchor.set(0.5);
          this.straight.push(sprite);
          this.container.addChild(sprite);
        }
        used++;
        sprite.visible = true;
        sprite.position.set((belt.x + 0.5) * TILE_PX, (belt.y + 0.5) * TILE_PX);
        sprite.rotation = ((belt.dir & 3) * Math.PI) / 2;
        // The surface moves towards the belt's front (up in the texture).
        sprite.tilePosition.y = -(phase % TILE_PX);
      } else {
        drawCurve(curves, belt, phase / TILE_PX);
      }
    }
    for (let i = used; i < this.straight.length; i++) this.straight[i]!.visible = false;

    const g = this.items;
    g.clear();
    const half = ITEM_SIZE / 2;
    for (const belt of this.belts) {
      for (const it of belt.items) {
        const offset = it.offset + it.moved * (1 - alpha);
        const p = beltPoint(
          belt.dir,
          belt.shape,
          laneLateral(it.lane),
          progressOf(offset, BELT_LENGTH),
        );
        const x = (belt.x + p.x - half) * TILE_PX;
        const y = (belt.y + p.y - half) * TILE_PX;
        g.rect(x, y, ITEM_SIZE * TILE_PX, ITEM_SIZE * TILE_PX)
          .fill(itemPrototype(it.item)?.color ?? 0xff00ff)
          .stroke({ width: 1.5, color: ITEM_OUTLINE, alpha: 0.9 });
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.itemContainer.destroy({ children: true });
    this.texture?.destroy(true);
  }
}

/** A curved belt: base, rails along both arcs, and bars that sweep around at the belt's speed. */
function drawCurve(g: Graphics, belt: BeltData, phaseTiles: number): void {
  const at = (lateral: number, t: number): [number, number] => {
    const p = beltPoint(belt.dir, belt.shape, lateral, t);
    return [(belt.x + p.x) * TILE_PX, (belt.y + p.y) * TILE_PX];
  };
  const STEPS = 8;
  const band: number[] = [];
  for (let i = 0; i <= STEPS; i++) band.push(...at(-0.5, i / STEPS));
  for (let i = STEPS; i >= 0; i--) band.push(...at(0.5, i / STEPS));
  // The corner opposite the arc stays empty; fill the band only.
  g.poly(band).fill(BELT_BASE);
  for (let b = 0; b < BARS; b++) {
    const t = ((((b + 0.5) / BARS + phaseTiles) % 1) + 1) % 1;
    const [x0, y0] = at(-0.36, t);
    const [x1, y1] = at(0, Math.min(1, t + 0.08));
    const [x2, y2] = at(0.36, t);
    g.moveTo(x0, y0).lineTo(x1, y1).lineTo(x2, y2).stroke({ width: 3, color: BELT_BAR });
  }
  for (const lateral of [-0.45, 0.45]) {
    const rail: number[] = [];
    for (let i = 0; i <= STEPS; i++) rail.push(...at(lateral, i / STEPS));
    g.poly(rail, false).stroke({ width: 3, color: BELT_RAIL });
  }
}

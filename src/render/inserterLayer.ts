/**
 * Draws the arms of the inserters (above the buildings; their bases are drawn
 * by the entity layer) from the snapshot's inserter records (`encodeInserters`
 * in src/sim/snapshot.ts), with the held item at the arm's tip.
 *
 * The arm turns half a circle, clockwise, from pointing at the pickup tile
 * (arm position 0) to pointing at the drop tile (`INSERTER_SWING_TICKS`).
 * Between ticks it is drawn `swing × (1 − α)` ticks behind the snapshot's
 * position, with `α` the fraction of a tick since the snapshot arrived, so it
 * rotates smoothly. The held item shows as its icon (src/render/itemIcons.ts),
 * the same as on belts.
 */

import { Container, Graphics, Sprite } from 'pixi.js';
import { INSERTER_SWING_TICKS } from '../sim/entities/inserter';
import { decodeInserters, type InserterData } from '../sim/snapshot';
import { TICKS_PER_SECOND } from '../worker/protocol';
import { TILE_PX } from './camera';
import { itemIconAtlas } from './itemIcons';

const TICK_MS = 1000 / TICKS_PER_SECOND;
/** From the inserter's center to the tip of its hand, in tiles: into the neighbouring tile. */
export const ARM_LENGTH = 0.8;
const ARM_COLOR = 0x3c3f46;
const ARM_EDGE = 0xd9d4c4;
const HAND_COLOR = 0xe0a040;

/**
 * The tip of the arm of an inserter facing `dir` at swing fraction `t` (0 at
 * the pickup tile, 1 at the drop tile), relative to the inserter's center, in
 * tiles. The arm swings clockwise on screen.
 */
export function armTip(
  dir: number,
  t: number,
  length: number = ARM_LENGTH,
): { x: number; y: number } {
  // Pointing at the pickup tile: north-facing inserters pick up from the south (y grows down).
  const start = (((dir & 3) + 1) * Math.PI) / 2;
  const a = start + Math.min(1, Math.max(0, t)) * Math.PI;
  return { x: Math.cos(a) * length, y: Math.sin(a) * length };
}

/** Swing fraction to draw an inserter at, `alpha` of a tick after its snapshot. */
export function swingFraction(inserter: InserterData, alpha: number): number {
  const arm = inserter.arm - inserter.swing * (1 - alpha);
  return Math.min(1, Math.max(0, arm / INSERTER_SWING_TICKS));
}

export class InserterLayer {
  readonly container = new Container({ label: 'inserters' });
  private readonly graphics = new Graphics({ label: 'inserter-arms' });
  /** Icons of held items (the same as on belts), above the arms; reused from frame to frame. */
  private readonly held: Sprite[] = [];
  private inserters: InserterData[] = [];
  private receivedAt = 0;

  constructor() {
    this.container.addChild(this.graphics);
  }

  /** Takes the inserters of a snapshot received at `nowMs`. */
  apply(buffer: ArrayBuffer, nowMs: number): void {
    this.inserters = decodeInserters(buffer);
    this.receivedAt = nowMs;
  }

  /** The inserters of the latest snapshot. */
  get data(): readonly InserterData[] {
    return this.inserters;
  }

  /** Redraws the arms for time `nowMs`. */
  draw(nowMs: number): void {
    const alpha = Math.min(1, Math.max(0, (nowMs - this.receivedAt) / TICK_MS));
    const g = this.graphics;
    g.clear();
    let shown = 0;
    for (const ins of this.inserters) {
      const cx = (ins.x + 0.5) * TILE_PX;
      const cy = (ins.y + 0.5) * TILE_PX;
      const tip = armTip(ins.dir, swingFraction(ins, alpha));
      const tx = cx + tip.x * TILE_PX;
      const ty = cy + tip.y * TILE_PX;
      g.moveTo(cx, cy).lineTo(tx, ty).stroke({ width: 6, color: ARM_EDGE, cap: 'round' });
      g.moveTo(cx, cy).lineTo(tx, ty).stroke({ width: 3.5, color: ARM_COLOR, cap: 'round' });
      g.circle(cx, cy, 4).fill(ARM_COLOR).stroke({ width: 1.5, color: ARM_EDGE });
      if (ins.held !== 0) {
        let sprite = this.held[shown];
        if (!sprite) {
          sprite = new Sprite();
          sprite.anchor.set(0.5);
          this.held.push(sprite);
          this.container.addChild(sprite);
        }
        shown++;
        sprite.visible = true;
        sprite.texture = itemIconAtlas().texture(ins.held);
        sprite.position.set(tx, ty);
      } else {
        g.circle(tx, ty, 3).fill(HAND_COLOR);
      }
    }
    for (let i = shown; i < this.held.length; i++) this.held[i]!.visible = false;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

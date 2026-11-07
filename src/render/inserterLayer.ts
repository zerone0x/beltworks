/**
 * Animates the inserters' arms from the snapshot's inserter records
 * (`encodeInserters` in src/sim/snapshot.ts). Inserters with a sprite model
 * (docs/ART.md) are drawn by the entity sprite layer, sorted in with the
 * buildings: this layer only works out where their arms point and what they
 * hold each frame (`poses`). The others get a placeholder arm, drawn here
 * above the buildings (their bases are drawn by the entity layer), with the
 * held item at the arm's tip.
 *
 * The arm turns half a circle, clockwise, from pointing at the pickup tile
 * (arm position 0) to pointing at the drop tile (arm position `span`: 36
 * ticks for a burner inserter, 26 ticks in 1/65536 units for an electric
 * one). Its length follows the type's reach (`armLength`: into the
 * neighbouring tile, or the tile beyond for the long-handed inserter), and
 * fast and long-handed arms are drawn in a shade of their type's color
 * (`armColor`). Between ticks it is drawn `swing × (1 − α)` behind the snapshot's
 * position, with `α` the fraction of a tick since the snapshot arrived, so it
 * rotates smoothly. The held item shows as its icon (src/render/itemIcons.ts),
 * the same as on belts.
 */

import { Container, Graphics, Sprite } from 'pixi.js';
import { EntityTypeId, entityPrototype, inserterReach } from '../data/entities';
import { decodeInserters, type InserterData } from '../sim/snapshot';
import { TICKS_PER_SECOND } from '../worker/protocol';
import { TILE_PX } from './camera';
import type { InserterPose, InserterPoses } from './entitySprites';
import { itemIconAtlas } from './itemIcons';
import type { SpriteAtlas } from './sprites';

const TICK_MS = 1000 / TICKS_PER_SECOND;
/** From the inserter's center to the tip of its hand, in tiles: into the neighbouring tile. */
export const ARM_LENGTH = 0.8;
const ARM_COLOR = 0x3c3f46;
/** Arm colors of the inserter types that don't use `ARM_COLOR`. */
const ARM_COLORS: Readonly<Record<number, number>> = {
  [EntityTypeId.FastInserter]: 0x7a2a24,
  [EntityTypeId.LongHandedInserter]: 0x2f5e2c,
};

/**
 * Length of the arm of inserter type `type`, in tiles: `ARM_LENGTH` into the
 * tile `reach` tiles away (0.8 for most inserters, 1.8 for the long-handed
 * one).
 */
export function armLength(type: number): number {
  const proto = entityPrototype(type);
  return (proto ? inserterReach(proto) : 1) - 1 + ARM_LENGTH;
}

/** Color of the arm of inserter type `type`. */
export function armColor(type: number): number {
  return ARM_COLORS[type] ?? ARM_COLOR;
}
const ARM_EDGE = 0xd9d4c4;
const HAND_COLOR = 0xe0a040;

/**
 * Where the arm of an inserter facing `dir` points at swing fraction `t` (0 at
 * the pickup tile, 1 at the drop tile): radians on screen, clockwise from
 * east. The arm swings clockwise on screen.
 */
export function armAngle(dir: number, t: number): number {
  // Pointing at the pickup tile: north-facing inserters pick up from the south (y grows down).
  const start = (((dir & 3) + 1) * Math.PI) / 2;
  return start + Math.min(1, Math.max(0, t)) * Math.PI;
}

/**
 * The tip of the arm of an inserter facing `dir` at swing fraction `t` (0 at
 * the pickup tile, 1 at the drop tile), relative to the inserter's center, in
 * tiles.
 */
export function armTip(
  dir: number,
  t: number,
  length: number = ARM_LENGTH,
): { x: number; y: number } {
  const a = armAngle(dir, t);
  return { x: Math.cos(a) * length, y: Math.sin(a) * length };
}

/** Packs a tile into one map key (tiles within about ±1M of the origin). */
const tileKey = (x: number, y: number): number => (x + 0x20_0000) * 0x40_0000 + (y + 0x20_0000);

/** Swing fraction to draw an inserter at, `alpha` of a tick after its snapshot. */
export function swingFraction(inserter: InserterData, alpha: number): number {
  if (inserter.span <= 0) return 0;
  const arm = inserter.arm - inserter.swing * (1 - alpha);
  return Math.min(1, Math.max(0, arm / inserter.span));
}

export class InserterLayer {
  readonly container = new Container({ label: 'inserters' });
  private readonly graphics = new Graphics({ label: 'inserter-arms' });
  /** Icons of held items (the same as on belts), above the arms; reused from frame to frame. */
  private readonly held: Sprite[] = [];
  private inserters: InserterData[] = [];
  private receivedAt = 0;
  private atlas: SpriteAtlas | null = null;
  /** Arm angle and held item per inserter tile, as of the latest `draw`. */
  private readonly poseByTile = new Map<number, InserterPose>();
  /** Where the arm of the inserter on a tile points and what it holds, as of the latest `draw`. */
  readonly poses: InserterPoses = (x, y) => this.poseByTile.get(tileKey(x, y)) ?? null;

  constructor() {
    this.container.addChild(this.graphics);
  }

  /** Inserters with a model in `atlas` get their arms from the entity sprite layer from now on. */
  setAtlas(atlas: SpriteAtlas | null): void {
    this.atlas = atlas;
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

  /** Works out every arm's pose for time `nowMs`, and redraws the placeholder arms. */
  draw(nowMs: number): void {
    const alpha = Math.min(1, Math.max(0, (nowMs - this.receivedAt) / TICK_MS));
    const g = this.graphics;
    g.clear();
    this.poseByTile.clear();
    let shown = 0;
    for (const ins of this.inserters) {
      const t = swingFraction(ins, alpha);
      if (this.atlas?.model(entityPrototype(ins.type)?.name)) {
        this.poseByTile.set(tileKey(ins.x, ins.y), { angle: armAngle(ins.dir, t), held: ins.held });
        continue;
      }
      const cx = (ins.x + 0.5) * TILE_PX;
      const cy = (ins.y + 0.5) * TILE_PX;
      const tip = armTip(ins.dir, t, armLength(ins.type));
      const color = armColor(ins.type);
      const tx = cx + tip.x * TILE_PX;
      const ty = cy + tip.y * TILE_PX;
      g.moveTo(cx, cy).lineTo(tx, ty).stroke({ width: 6, color: ARM_EDGE, cap: 'round' });
      g.moveTo(cx, cy).lineTo(tx, ty).stroke({ width: 3.5, color, cap: 'round' });
      g.circle(cx, cy, 4).fill(color).stroke({ width: 1.5, color: ARM_EDGE });
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

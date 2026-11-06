/**
 * Draws the entities that have a sprite model in the loaded atlas
 * (sprites.ts): each one's shadow into a shared shadow layer, and its
 * sprite layers (body, then overlays like fire or a turning rotor) above the
 * placeholder shapes, sorted so that entities further south stand in front.
 *
 * Shadows are drawn at full strength into one container that is faded as a
 * whole (an alpha filter), so overlapping shadows don't get darker.
 *
 * Animations run on a clock per entity that advances while it works (at half
 * speed on low power), so a machine that stops freezes its rotor in place;
 * layers marked `advance: 'always'` (flickering fire) run on the frame clock.
 *
 * Read-only: nothing here flows back into the simulation.
 */

import { AlphaFilter, Container, Sprite } from 'pixi.js';
import { TILE_PX } from './camera';
import type { EntityIndex, EntityView } from './entityIndex';
import {
  SHADOW_ALPHA,
  animationSpeed,
  frameAt,
  isWorking,
  layerShown,
  modelDirection,
  type ModelLayer,
  type ModelSprites,
  type SpriteAtlas,
  type SpriteFrame,
} from './sprites';

interface Placed {
  entity: EntityView;
  model: ModelSprites;
  dir: number;
  /** Footprint center in world pixels. */
  cx: number;
  cy: number;
  layers: { layer: ModelLayer; sprite: Sprite }[];
}

/** Puts `sprite` on `frame` with the frame's anchor at `(cx, cy)` (world pixels). */
export function placeSprite(
  sprite: Sprite,
  frame: SpriteFrame,
  scale: number,
  cx: number,
  cy: number,
): void {
  if (sprite.texture !== frame.texture) sprite.texture = frame.texture;
  sprite.scale.set(scale);
  sprite.position.set(cx - frame.ax * scale, cy - frame.ay * scale);
}

/** Draw order: by the footprint's bottom row, then left to right. */
function drawOrder(a: EntityView, b: EntityView): number {
  return a.y + a.h - (b.y + b.h) || a.x - b.x || a.id - b.id;
}

export class EntitySpriteLayer {
  /** Shadows; goes below every building. */
  readonly shadowContainer = new Container({ label: 'entity-shadows' });
  /** Sprites; goes above the placeholder shapes. */
  readonly container = new Container({ label: 'entity-sprites' });
  private atlas: SpriteAtlas | null = null;
  private readonly sprites: Sprite[] = [];
  private readonly shadows: Sprite[] = [];
  private placed: Placed[] = [];
  /** Seconds each entity's working animations have run, by entity id. */
  private readonly clocks = new Map<number, number>();
  /** Seconds of frames drawn, for animations that always run. */
  private seconds = 0;
  private drawn = -1;
  private animatedCount = 0;

  constructor() {
    this.shadowContainer.filters = [new AlphaFilter({ alpha: SHADOW_ALPHA })];
  }

  /** Uses `atlas` from now on (`null`: placeholders only). */
  setAtlas(atlas: SpriteAtlas | null): void {
    this.atlas = atlas;
    this.drawn = -1;
  }

  /** The model an entity of prototype `name` is drawn with, or `null` (placeholder). */
  modelFor(name: string | undefined): ModelSprites | null {
    return this.atlas?.model(name) ?? null;
  }

  /** Entities drawn with sprites, and how many of them animate right now. */
  get stats(): { entities: number; animated: number } {
    return { entities: this.placed.length, animated: this.animatedCount };
  }

  /** Re-sorts and re-assigns sprites when the entities changed; animates every frame. */
  draw(index: EntityIndex, dtMs: number): void {
    if (index.version !== this.drawn) {
      this.drawn = index.version;
      this.rebuild(index);
    }
    this.seconds += dtMs / 1000;
    let animated = 0;
    for (const p of this.placed) {
      const { entity, model } = p;
      const working = isWorking(entity.status);
      const speed = animationSpeed(entity.status);
      const clock = (this.clocks.get(entity.id) ?? 0) + (speed * dtMs) / 1000;
      if (speed > 0) {
        this.clocks.set(entity.id, clock);
        animated++;
      }
      for (const { layer, sprite } of p.layers) {
        const shown = layerShown(layer, working);
        sprite.visible = shown;
        if (!shown) continue;
        const frames = layer.frames[p.dir]!;
        if (frames.length === 1) continue;
        // Entities don't animate in step: each has its own phase.
        const t =
          layer.advance === 'always'
            ? this.seconds + (entity.id % 97) * 0.173
            : layer.advance === 'working'
              ? clock
              : 0;
        placeSprite(sprite, frames[frameAt(frames.length, layer.fps, t)]!, model.scale, p.cx, p.cy);
      }
    }
    this.animatedCount = animated;
  }

  private rebuild(index: EntityIndex): void {
    const atlas = this.atlas;
    const entities = atlas
      ? index.entities.filter((e) => atlas.model(e.proto?.name) !== null).sort(drawOrder)
      : [];
    const seen = new Set<number>();
    this.placed = [];
    let used = 0;
    this.container.removeChildren();
    this.shadowContainer.removeChildren();
    entities.forEach((entity, i) => {
      const model = atlas!.model(entity.proto?.name)!;
      seen.add(entity.id);
      const dir = modelDirection(model, entity.dir);
      const cx = (entity.x + entity.w / 2) * TILE_PX;
      const cy = (entity.y + entity.h / 2) * TILE_PX;
      const shadow = (this.shadows[i] ??= new Sprite());
      placeSprite(shadow, model.shadow[dir]!, model.scale, cx, cy);
      this.shadowContainer.addChild(shadow);
      const layers = model.layers.map((layer) => {
        const sprite = (this.sprites[used++] ??= new Sprite());
        placeSprite(sprite, layer.frames[dir]![0]!, model.scale, cx, cy);
        this.container.addChild(sprite);
        return { layer, sprite };
      });
      this.placed.push({ entity, model, dir, cx, cy, layers });
    });
    for (const id of [...this.clocks.keys()]) {
      if (!seen.has(id)) this.clocks.delete(id);
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.shadowContainer.destroy({ children: true });
  }
}

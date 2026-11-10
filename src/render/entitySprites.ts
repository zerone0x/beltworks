/**
 * Draws the entities that have a sprite model in the loaded atlas
 * (sprites.ts): each one's shadow into a shared shadow layer, and its
 * sprite layers (body, then overlays like fire or a turning rotor) above the
 * placeholder shapes, sorted so that entities further south stand in front.
 *
 * Shadows are drawn at full strength into one container that is faded as a
 * whole (an alpha filter), so overlapping shadows don't get darker.
 *
 * Only the entities overlapping the cull rectangle (cull.ts) have sprites in
 * the scene: the sprites are pooled and handed out again, in draw order,
 * whenever the rectangle or the entities change. Entities are only re-sorted
 * when they come, go, move or turn, not when their states change.
 *
 * Animations run on a clock per entity that advances while it works (at half
 * speed on low power), so a machine that stops freezes its rotor in place;
 * layers marked `advance: 'always'` (flickering fire) run on the frame clock. A
 * steam engine's run at a speed proportional to its output (`speedOf`).
 *
 * Inserters stand in the same sorted layer as the buildings (so one behind a
 * tall machine is hidden by it): their base, then the arm, a sprite of one
 * of the model's pre-rendered angles (its `arm` layer) turned the rest of the
 * way about the `pivot` point, at the angle the inserter layer interpolates
 * from the snapshots (`InserterPoses`), then the held item at the `hand`.
 * The arm sprites have no shadow of their own (they turn); the arm casts a
 * faint one anyway: its sprite again, in black, shifted along the light by
 * the arm's height (`placeArmShadow`).
 * Belts are drawn by the belt layer (beltLayer.ts), not here.
 *
 * Read-only: nothing here flows back into the simulation.
 */

import { AlphaFilter, Container, Sprite } from 'pixi.js';
import { TILE_PX } from './camera';
import { EVERYWHERE, overlaps, sameRect, type TileRect } from './cull';
import type { EntityIndex, EntityView } from './entityIndex';
import { itemIconAtlas } from './itemIconAtlas';
import {
  HEIGHT_ON_SCREEN,
  SHADOW_ALPHA,
  SHADOW_OFFSET,
  animationSpeed,
  frameAt,
  isWorking,
  layerShown,
  modelDirection,
  modelLayer,
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
  /** The model's arm layer (inserters), or `null`. */
  armLayer: ModelLayer | null;
  /** Seconds its working animations have run. */
  clock: number;
  /** Its sprites while it is in the cull rectangle (empty otherwise). */
  layers: { layer: ModelLayer; sprite: Sprite }[];
  /** An inserter's arm, its shadow and the item in its hand, while in the cull rectangle. */
  arm: { layer: ModelLayer; sprite: Sprite; shadow: Sprite; held: Sprite } | null;
}

/** Where an inserter's arm points and what it holds, as the inserter layer draws it this frame. */
export interface InserterPose {
  /** Radians on screen, clockwise from east (`armAngle` in inserterLayer.ts). */
  angle: number;
  /** Item in the hand, 0 for none. */
  held: number;
}

/** The pose of the inserter on tile `(x, y)`, or `null` when there is none (yet). */
export type InserterPoses = (x: number, y: number) => InserterPose | null;

/**
 * The pre-rendered arm angle nearest to `angle` (radians, clockwise from
 * east) out of `count` over a full turn, and what is left to turn the sprite
 * by (radians, within half a step either way).
 */
export function armFrame(angle: number, count: number): { frame: number; rest: number } {
  const step = (2 * Math.PI) / count;
  const k = Math.round(angle / step);
  return { frame: ((k % count) + count) % count, rest: angle - k * step };
}

/**
 * Puts an inserter's arm on the frame nearest to `angle` and turns it the rest
 * of the way about the model's `pivot` point; then its `held` item (or none)
 * at the hand. `(cx, cy)` is the inserter's center in world pixels.
 */
export function placeArm(
  model: ModelSprites,
  layer: ModelLayer,
  dir: number,
  arm: Sprite,
  held: Sprite | null,
  cx: number,
  cy: number,
  pose: InserterPose,
): void {
  const frames = layer.frames[dir]!;
  const { frame: index, rest } = armFrame(pose.angle, frames.length);
  const frame = frames[index]!;
  const pivot = model.points.pivot?.[0] ?? [0, 0];
  const s = model.scale;
  if (arm.texture !== frame.texture) arm.texture = frame.texture;
  arm.scale.set(s);
  arm.pivot.set(frame.ax + pivot[0], frame.ay + pivot[1]);
  arm.position.set(cx + pivot[0] * s, cy + pivot[1] * s);
  arm.rotation = rest;
  if (!held) return;
  held.visible = pose.held !== 0;
  if (pose.held === 0) return;
  // The hand of frame 0 points east: its x is the arm's reach, its y the hand's height.
  const hand = model.points.hand?.[0] ?? [0, 0];
  held.texture = itemIconAtlas().texture(pose.held);
  held.position.set(
    cx + Math.cos(pose.angle) * hand[0] * s,
    cy + Math.sin(pose.angle) * hand[0] * s + hand[1] * s,
  );
}

/**
 * Opacity of an arm's shadow within the shadow layer (which is faded to
 * `SHADOW_ALPHA` as a whole): fainter than the buildings', as a thin arm's
 * shadow is softer.
 */
export const ARM_SHADOW_ALPHA = 0.55;
/**
 * The height the arm's shadow is cast from, as a fraction of the pivot's: the
 * beam slopes down from the pivot to the hand, so most of it is a little
 * lower than the pivot.
 */
const ARM_SHADOW_HEIGHT = 0.85;

/**
 * Puts `shadow` where the shadow of `arm` (already placed by `placeArm`)
 * falls: the same frame and turn, in black, moved from where the arm shows
 * (lifted by its height on screen) down to the ground under it and on along
 * the light (`SHADOW_OFFSET`).
 */
export function placeArmShadow(model: ModelSprites, arm: Sprite, shadow: Sprite): void {
  const pivot = model.points.pivot?.[0] ?? [0, 0];
  // The pivot's y is all height on screen (it stands over the footprint's center).
  const lift = -pivot[1] * model.scale * ARM_SHADOW_HEIGHT;
  const height = lift / HEIGHT_ON_SCREEN;
  if (shadow.texture !== arm.texture) shadow.texture = arm.texture;
  shadow.scale.copyFrom(arm.scale);
  shadow.pivot.copyFrom(arm.pivot);
  shadow.rotation = arm.rotation;
  shadow.position.set(
    arm.position.x + height * SHADOW_OFFSET.x,
    arm.position.y + lift + height * SHADOW_OFFSET.y,
  );
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
  /** Sprite pools, assigned to the entities in the cull rectangle in draw order. */
  private readonly sprites: Sprite[] = [];
  private readonly shadows: Sprite[] = [];
  /** Inserter arms' shadows, in the shadow layer. */
  private readonly armShadows: Sprite[] = [];
  /** Every entity drawn with sprites, in draw order. */
  private placed: Placed[] = [];
  /** The part of `placed` in the cull rectangle: the ones with sprites. */
  private shown: Placed[] = [];
  /** Seconds of frames drawn, for animations that always run. */
  private seconds = 0;
  private drawn = -1;
  private cull: TileRect | null = null;
  private animatedCount = 0;
  /**
   * The animation speed of an entity whose animations don't simply follow
   * its state (a steam engine runs with its output), or `null` to use its
   * state (`animationSpeed`).
   */
  speedOf: ((entity: EntityView) => number | null) | null = null;

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

  /**
   * Entities drawn with sprites (around the view, on screen or not), how
   * many of them animate right now, how many have an arm, and how many are
   * in the cull rectangle (the ones with sprites in the scene).
   */
  get stats(): { entities: number; animated: number; arms: number; visible: number } {
    return {
      entities: this.placed.length,
      animated: this.animatedCount,
      arms: this.placed.filter((p) => p.armLayer).length,
      visible: this.shown.length,
    };
  }

  /**
   * Re-sorts when entities came, went, moved or turned; gives sprites to
   * the ones in the cull rectangle `cull` when it or they changed; animates
   * those every frame, inserter arms at their `poses`.
   */
  draw(
    index: EntityIndex,
    dtMs: number,
    poses: InserterPoses | null = null,
    cull: TileRect = EVERYWHERE,
  ): void {
    if (index.structureVersion !== this.drawn) {
      this.drawn = index.structureVersion;
      this.sort(index);
      this.cull = null;
    }
    if (!this.cull || !sameRect(this.cull, cull)) {
      this.cull = cull;
      this.assign(cull);
    }
    this.seconds += dtMs / 1000;
    // Every entity's clock runs, on screen or not; only those on screen are drawn.
    let animated = 0;
    for (const p of this.placed) {
      const speed = this.speedOf?.(p.entity) ?? animationSpeed(p.entity.status);
      if (speed > 0) {
        p.clock += (speed * dtMs) / 1000;
        animated++;
      }
    }
    this.animatedCount = animated;
    for (const p of this.shown) {
      const { entity, model } = p;
      if (p.arm) {
        const pose = poses?.(entity.x, entity.y) ?? { angle: restAngle(entity.dir), held: 0 };
        placeArm(model, p.arm.layer, p.dir, p.arm.sprite, p.arm.held, p.cx, p.cy, pose);
        placeArmShadow(model, p.arm.sprite, p.arm.shadow);
      }
      const working = isWorking(entity.status);
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
              ? p.clock
              : 0;
        placeSprite(sprite, frames[frameAt(frames.length, layer.fps, t)]!, model.scale, p.cx, p.cy);
      }
    }
  }

  /** Lists the entities that have a model, in draw order, keeping their animation clocks. */
  private sort(index: EntityIndex): void {
    const atlas = this.atlas;
    const clocks = new Map(this.placed.map((p) => [p.entity.id, p.clock]));
    const entities = atlas
      ? index.entities
          .filter((e) => e.proto?.beltSpeed === undefined && atlas.model(e.proto?.name) !== null)
          .sort(drawOrder)
      : [];
    this.placed = entities.map((entity) => {
      const model = atlas!.model(entity.proto?.name)!;
      return {
        entity,
        model,
        dir: modelDirection(model, entity.dir),
        cx: (entity.x + entity.w / 2) * TILE_PX,
        cy: (entity.y + entity.h / 2) * TILE_PX,
        armLayer: modelLayer(model, 'arm'),
        clock: clocks.get(entity.id) ?? 0,
        layers: [],
        arm: null,
      };
    });
  }

  /** Gives pooled sprites, in draw order, to the entities overlapping `cull`; the rest get none. */
  private assign(cull: TileRect): void {
    let used = 0;
    let shadows = 0;
    let arms = 0;
    this.container.removeChildren();
    this.shadowContainer.removeChildren();
    this.shown = [];
    for (const p of this.placed) {
      const { entity, model, dir, cx, cy } = p;
      p.layers = [];
      p.arm = null;
      if (!overlaps(cull, entity.x, entity.y, entity.w, entity.h)) continue;
      this.shown.push(p);
      const shadow = (this.shadows[shadows++] ??= new Sprite());
      placeSprite(shadow, model.shadow[dir]!, model.scale, cx, cy);
      this.shadowContainer.addChild(shadow);
      for (const layer of model.layers) {
        if (layer === p.armLayer) continue;
        const sprite = this.sprite(used++);
        placeSprite(sprite, layer.frames[dir]![0]!, model.scale, cx, cy);
        this.container.addChild(sprite);
        p.layers.push({ layer, sprite });
      }
      if (p.armLayer) {
        const armShadow = (this.armShadows[arms++] ??= new Sprite({
          tint: 0x000000,
          alpha: ARM_SHADOW_ALPHA,
        }));
        const arm = {
          layer: p.armLayer,
          sprite: this.sprite(used++),
          shadow: armShadow,
          held: this.sprite(used++),
        };
        arm.held.anchor.set(0.5);
        arm.held.visible = false;
        this.container.addChild(arm.sprite, arm.held);
        this.shadowContainer.addChild(armShadow);
        const pose = { angle: restAngle(entity.dir), held: 0 };
        placeArm(model, p.armLayer, dir, arm.sprite, arm.held, cx, cy, pose);
        placeArmShadow(model, arm.sprite, armShadow);
        p.arm = arm;
      }
    }
  }

  /** The `i`-th pooled sprite, reset to plain (no pivot, rotation or anchor), shown. */
  private sprite(i: number): Sprite {
    const sprite = (this.sprites[i] ??= new Sprite());
    sprite.pivot.set(0, 0);
    sprite.anchor.set(0, 0);
    sprite.rotation = 0;
    sprite.visible = true;
    return sprite;
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.shadowContainer.destroy({ children: true });
  }
}

/** Where an idle inserter facing `dir` points its arm: at its pickup tile (`armAngle(dir, 0)`). */
export function restAngle(dir: number): number {
  return (((dir & 3) + 1) * Math.PI) / 2;
}

/**
 * Draws the players and the hand-mining indicator: an outline on the target
 * tile and a progress bar above it.
 *
 * A player is the pre-rendered engineer of the `player` atlas (D67; its
 * pose, facing and frame from playerSprites.ts) with its shadow, drawn at
 * the buildings' shadow strength; until the atlas loads, or without it, the
 * placeholder ball. The bodies stand among the buildings' sprites in their
 * depth order (entitySprites.ts), the shadows and indicators in layers of
 * their own; in map mode, which hides the buildings, the bodies move to this
 * layer so the players stay on screen.
 */

import { Container, Graphics, Sprite } from 'pixi.js';
import { SUBTILES_PER_TILE } from '../sim/fixed';
import { HAND_MINING_TICKS, inMiningReach } from '../sim/player';
import { PLAYER_STRIDE, PlayerField } from '../sim/snapshot';
import { TILE_PX } from './camera';
import {
  FACING_SOUTH,
  PLAYER_MODELS,
  playerPose,
  type PlayerAnimations,
  type PlayerPose,
} from './playerSprites';
import type { PlayerTrack } from './playerTrack';
import { placeSprite, type EntitySpriteLayer } from './entitySprites';
import { SHADOW_ALPHA, type ModelSprites, type SpriteAtlas } from './sprites';

/** World pixels per subtile. */
const PX_PER_SUBTILE = TILE_PX / SUBTILES_PER_TILE;

const BODY_RADIUS = 10;
const BODY_COLOR = 0xf2b134;
const BODY_OUTLINE = 0x2b1d08;
const VISOR_COLOR = 0x3c6e8f;
const TARGET_COLOR = 0xfff3c4;
const TARGET_OUT_OF_REACH = 0xe0574f;
const BAR_HEIGHT = 4;
const BAR_COLOR = 0x8fdc5a;

/** The player's sprite models, by pose, and their animations. */
interface PlayerModels {
  idle: ModelSprites;
  walk: ModelSprites;
  mine: ModelSprites;
  anim: PlayerAnimations;
}

/** One player's display objects: the placeholder ball, or the sprite and its shadow. */
interface PlayerSprites {
  ball: Graphics;
  body: Sprite;
  shadow: Sprite;
  /** The way it faced last frame (kept while it stands). */
  facing: number;
}

export class PlayerLayer {
  readonly container = new Container({ label: 'players' });
  private readonly players: PlayerSprites[] = [];
  /** Mining indicators, above every player so a player never hides its own progress. */
  private readonly indicators = new Graphics({ label: 'mining' });
  /** Players' shadows, below every player, at the buildings' shadow strength. */
  private readonly shadowLayer = new Container({ label: 'player-shadows', alpha: SHADOW_ALPHA });
  private readonly bodyLayer = new Container({ label: 'bodies' });
  private models: PlayerModels | null = null;
  /**
   * The buildings' sprite layer, when the players' bodies stand among the
   * buildings in its depth order (a player north of a building is behind it);
   * without one they are drawn above everything in `bodyLayer`.
   */
  private depth: EntitySpriteLayer | null = null;
  /**
   * Whether the bodies are sorted in with the buildings right now: not while
   * map mode hides the buildings' layers, or the players would vanish with
   * them and leave only their shadows (`setDepthSorting`).
   */
  private sorting = true;
  /** What each player showed last frame (the test hook reads it); `null` for the placeholder. */
  readonly poses: (PlayerPose | null)[] = [];

  constructor() {
    this.container.addChild(this.shadowLayer, this.bodyLayer, this.indicators);
  }

  /** Sorts the players' bodies in with the buildings of `layer` (see `EntitySpriteLayer.placeActors`). */
  sortWith(layer: EntitySpriteLayer | null): void {
    this.depth = layer;
    if (layer) return;
    for (const player of this.players) this.bodyLayer.addChild(player.body);
  }

  /** Draws players with the `player` models of `atlas` from now on (the placeholder without them). */
  setAtlas(atlas: SpriteAtlas | null): void {
    const idle = atlas?.model(PLAYER_MODELS.idle) ?? null;
    const walk = atlas?.model(PLAYER_MODELS.walk) ?? null;
    const mine = atlas?.model(PLAYER_MODELS.mine) ?? null;
    const layer = (m: ModelSprites) => m.layers[0]!;
    this.models =
      idle && walk && mine
        ? {
            idle,
            walk,
            mine,
            anim: {
              walk: { frames: layer(walk).frames[0]!.length, fps: layer(walk).fps },
              mine: { frames: layer(mine).frames[0]!.length, fps: layer(mine).fps },
            },
          }
        : null;
  }

  /**
   * Sorts the bodies in with the buildings (`on`, the sprite view) or draws
   * them above everything in this layer (`!on`: map mode, which hides the
   * buildings' layers). Takes effect on the next `draw`.
   */
  setDepthSorting(on: boolean): void {
    this.sorting = on;
  }

  /** Shows or hides the players' shadows (the shadows setting). */
  setShadows(on: boolean): void {
    this.shadowLayer.visible = on;
  }

  /** Redraws every player at its interpolated position for time `nowMs`. */
  draw(track: PlayerTrack, nowMs: number): void {
    const count = track.count;
    while (this.players.length < count) {
      const player: PlayerSprites = {
        ball: makeBall(),
        body: new Sprite({ label: 'player' }),
        shadow: new Sprite({ label: 'player-shadow' }),
        facing: FACING_SOUTH,
      };
      this.players.push(player);
      this.bodyLayer.addChild(player.ball);
      if (!this.depth) this.bodyLayer.addChild(player.body);
      this.shadowLayer.addChild(player.shadow);
    }
    const models = this.models;
    this.players.forEach((player, i) => {
      player.ball.visible = i < count && !models;
      player.body.visible = player.shadow.visible = i < count && models !== null;
    });
    this.poses.length = count;
    const actors: { sprite: Sprite; y: number }[] = [];

    const g = this.indicators;
    g.clear();
    const records = track.latest;
    for (let i = 0; i < count; i++) {
      const p = track.sample(i, nowMs)!;
      const px = p.x * PX_PER_SUBTILE;
      const py = p.y * PX_PER_SUBTILE;
      const player = this.players[i]!;
      const o = i * PLAYER_STRIDE;
      const mining = records[o + PlayerField.mining] === 1;
      const tx = records[o + PlayerField.mineX]!;
      const ty = records[o + PlayerField.mineY]!;
      const sx = records[o + PlayerField.x]!;
      const sy = records[o + PlayerField.y]!;
      const reach = mining && inMiningReach(sx, sy, tx, ty);
      if (models) {
        const pose = playerPose(
          {
            moveX: records[o + PlayerField.moveX]!,
            moveY: records[o + PlayerField.moveY]!,
            mining: reach,
            mineDx: (tx + 0.5) * SUBTILES_PER_TILE - sx,
            mineDy: (ty + 0.5) * SUBTILES_PER_TILE - sy,
            mineProgress: records[o + PlayerField.mineProgress]!,
            walkTicks: track.walkTicks(i, nowMs),
          },
          player.facing,
          models.anim,
        );
        player.facing = pose.facing;
        actors.push({ sprite: player.body, y: py });
        this.poses[i] = pose;
        const model = models[pose.pose];
        const frames = model.layers[0]!.frames[pose.facing % model.directions]!;
        placeSprite(player.body, frames[pose.frame % frames.length]!, model.scale, px, py);
        placeSprite(
          player.shadow,
          model.shadow[pose.facing % model.directions]!,
          model.scale,
          px,
          py,
        );
      } else {
        player.ball.position.set(px, py);
        this.poses[i] = null;
      }

      if (!mining) {
        continue;
      }
      const left = tx * TILE_PX;
      const top = ty * TILE_PX;
      g.rect(left + 1, top + 1, TILE_PX - 2, TILE_PX - 2).stroke({
        width: 2,
        color: reach ? TARGET_COLOR : TARGET_OUT_OF_REACH,
      });
      if (reach) {
        const progress = records[o + PlayerField.mineProgress]! / HAND_MINING_TICKS;
        const width = TILE_PX - 4;
        g.rect(left + 2, top - BAR_HEIGHT - 3, width, BAR_HEIGHT).fill({
          color: 0x000000,
          alpha: 0.65,
        });
        if (progress > 0) {
          g.rect(left + 2, top - BAR_HEIGHT - 3, width * progress, BAR_HEIGHT).fill(BAR_COLOR);
        }
      }
    }
    if (this.depth && this.sorting) {
      this.depth.placeActors(actors);
    } else {
      // Out of the buildings' layer (if they were in it), into this one.
      this.depth?.placeActors([]);
      for (const { sprite } of actors) this.bodyLayer.addChild(sprite);
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

/** Placeholder player art (until the atlas loads): a round body with a visor, drawn around the origin. */
function makeBall(): Graphics {
  const g = new Graphics({ label: 'player' });
  g.ellipse(0, BODY_RADIUS - 2, BODY_RADIUS * 0.9, 4).fill({ color: 0x000000, alpha: 0.3 });
  g.circle(0, 0, BODY_RADIUS).fill(BODY_COLOR).stroke({ width: 2, color: BODY_OUTLINE });
  g.roundRect(-6, -5, 12, 5, 2).fill(VISOR_COLOR);
  return g;
}

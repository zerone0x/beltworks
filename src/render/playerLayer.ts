/**
 * Draws the players (placeholder shapes) and the hand-mining indicator: an
 * outline on the target tile and a progress bar above it.
 */

import { Container, Graphics } from 'pixi.js';
import { SUBTILES_PER_TILE } from '../sim/fixed';
import { HAND_MINING_TICKS, inMiningReach } from '../sim/player';
import { PLAYER_STRIDE, PlayerField } from '../sim/snapshot';
import { TILE_PX } from './camera';
import type { PlayerTrack } from './playerTrack';

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

export class PlayerLayer {
  readonly container = new Container({ label: 'players' });
  private readonly bodies: Graphics[] = [];
  /** Mining indicators, above every player so a player never hides its own progress. */
  private readonly indicators = new Graphics({ label: 'mining' });
  private readonly bodyLayer = new Container({ label: 'bodies' });

  constructor() {
    this.container.addChild(this.bodyLayer, this.indicators);
  }

  /** Redraws every player at its interpolated position for time `nowMs`. */
  draw(track: PlayerTrack, nowMs: number): void {
    const count = track.count;
    while (this.bodies.length < count) {
      const body = makeBody();
      this.bodies.push(body);
      this.bodyLayer.addChild(body);
    }
    this.bodies.forEach((body, i) => {
      body.visible = i < count;
    });

    const g = this.indicators;
    g.clear();
    const records = track.latest;
    for (let i = 0; i < count; i++) {
      const p = track.sample(i, nowMs)!;
      this.bodies[i]!.position.set(p.x * PX_PER_SUBTILE, p.y * PX_PER_SUBTILE);

      const o = i * PLAYER_STRIDE;
      if (records[o + PlayerField.mining] !== 1) {
        continue;
      }
      const tx = records[o + PlayerField.mineX]!;
      const ty = records[o + PlayerField.mineY]!;
      const reach = inMiningReach(records[o + PlayerField.x]!, records[o + PlayerField.y]!, tx, ty);
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
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

/** Placeholder player art: a round body with a visor, drawn around the origin. */
function makeBody(): Graphics {
  const g = new Graphics({ label: 'player' });
  g.ellipse(0, BODY_RADIUS - 2, BODY_RADIUS * 0.9, 4).fill({ color: 0x000000, alpha: 0.3 });
  g.circle(0, 0, BODY_RADIUS).fill(BODY_COLOR).stroke({ width: 2, color: BODY_OUTLINE });
  g.roundRect(-6, -5, 12, 5, 2).fill(VISOR_COLOR);
  return g;
}

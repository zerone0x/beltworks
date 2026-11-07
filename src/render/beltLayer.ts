/**
 * Draws the belts and the items on them from the snapshot's belt records
 * (`encodeBelts` in src/sim/snapshot.ts): only belts in the chunk window
 * arrive, so only lines around the viewport are drawn.
 *
 * With the sprite atlas loaded (docs/ART.md, "Belts"; src/render/beltSprites.ts)
 * each belt is its pre-rendered moving surface, whose frame follows how far
 * the belt has moved (so the slats run at the items' speed: 8, 16 or 24
 * subtiles a tick), under its side frames in the tier color (yellow, red,
 * blue); an underground belt gets its hood over its closed half (an
 * entrance's front half, an exit's rear half), drawn over the items
 * (`coverContainer`), with its shadow.
 *
 * Without sprites, straight belts are tiling sprites of a placeholder texture
 * that scrolls with the tick (at the belt's speed, like the items), with rails
 * in the tier color; curves are drawn as arcs with bars sweeping around them,
 * and underground belts get a flat hood over their closed half.
 *
 * Either way the items under a hood are hidden; items under the ground
 * aren't in the snapshot at all. While an underground belt is held, the
 * overlay shows the tiles its partner can be on and the partner it would get
 * (`undergroundGhost`, with the simulation's own pairing rule). Items are drawn every frame between
 * the last tick's position and the current one: each record says how far the
 * item moved on the tick, so an item is drawn `moved * (1 - α)` behind where
 * it is, with `α` the fraction of a tick since the snapshot arrived. Items
 * show as their icons (src/render/itemIcons.ts).
 */

import { Container, Graphics, Sprite, Texture, TilingSprite } from 'pixi.js';
import { ENTITIES, EntityTypeId, entityPrototype, type EntityPrototype } from '../data/entities';
import { BELT_SPEED, BeltShape } from '../sim/belts/belts';
import { BELT_LENGTH } from '../sim/belts/line';
import {
  UndergroundMode,
  findPartner,
  placedMode,
  type PartnerTile,
  type UndergroundInfo,
} from '../sim/belts/underground';
import type { Direction } from '../sim/entities/direction';
import { decodeBelts, type BeltData } from '../sim/snapshot';
import { TICKS_PER_SECOND } from '../worker/protocol';
import { beltPoint, laneLateral, progressOf } from './beltPath';
import { beltSprites, surfaceFrame, type BeltSprites } from './beltSprites';
import { TILE_PX } from './camera';
import { placeSprite } from './entitySprites';
import { itemIconAtlas } from './itemIcons';
import { SHADOW_ALPHA, modelDirection, type SpriteAtlas } from './sprites';

const TICK_MS = 1000 / TICKS_PER_SECOND;
const BELT_BASE = 0x5b5d64;
const BELT_BAR = 0x84878f;
const BELT_RAIL = ENTITIES[EntityTypeId.TransportBelt].color;
/** Bars per tile on the belt texture. */
const BARS = 2;
const HOOD = 0x3a3c42;
/** Overlay of a held underground belt: the tiles its partner can be on, and the partner. */
const REACH_COLOR = 0xf2f2f2;
const PARTNER_COLOR = 0x5ad15a;

/** Belt speed and rail color of a belt type (the tier); yellow for unknown types. */
function tierOf(type: number): { speed: number; rail: number } {
  const proto = entityPrototype(type);
  return { speed: proto?.beltSpeed ?? BELT_SPEED, rail: proto?.color ?? BELT_RAIL };
}

/** Point `(u, v)` of a north-facing tile (0..1 from its top-left corner), turned to face `dir`. */
function turn(dir: number, u: number, v: number): [number, number] {
  for (let i = 0; i < (dir & 3); i++) {
    const nu = 1 - v;
    v = u;
    u = nu;
  }
  return [u, v];
}

/** The underground ghost the overlay shows: the mode it would get and its partner, if any. */
export interface UndergroundGhost {
  mode: UndergroundMode;
  partner: PartnerTile | null;
}

/** The sprites of one belt, reused from frame to frame. */
interface BeltSpriteSlot {
  surface: Sprite;
  frame: Sprite;
}

/** The placeholder belt texture, one tile facing north: rails and bars across the belt. */
function makeBeltTexture(rail: number): Texture {
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
  ctx.fillStyle = hex(rail);
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
  /** The overlay of a held underground belt (above the players, with the ghost). */
  readonly overlayContainer = new Container({ label: 'underground-overlay' });
  /** Hoods of underground belts drawn with sprites, over the items going into them. */
  readonly coverContainer = new Container({ label: 'belt-covers' });
  /**
   * The shadows of underground belts' hoods (flat belts cast none worth the
   * fill rate). Each sprite is faded on its own rather than the layer through
   * a filter like the buildings' shadows: they hardly overlap, and a filter
   * over every belt on screen would cost a full-screen pass each frame.
   */
  private readonly shadows = new Container({ label: 'belt-shadows' });
  private readonly surfaces = new Container({ label: 'belt-surfaces' });
  private readonly frames = new Container({ label: 'belt-frames' });
  private readonly slots: BeltSpriteSlot[] = [];
  private readonly hoodSprites: { sprite: Sprite; shadow: Sprite }[] = [];
  private atlas: SpriteAtlas | null = null;
  /** `beltSprites` by type, shape and mode, for the current atlas. */
  private readonly sets = new Map<number, BeltSprites | null>();
  private spriteCount = 0;
  private readonly straight: TilingSprite[] = [];
  private readonly curves = new Graphics({ label: 'belt-curves' });
  private readonly hoods = new Graphics({ label: 'underground-hoods' });
  private readonly overlay = new Graphics({ label: 'underground-reach' });
  /** Item icon sprites, reused from frame to frame. */
  private readonly items: Sprite[] = [];
  /** Belt textures by rail color (one per tier). */
  private readonly textures = new Map<number, Texture>();
  private belts: BeltData[] = [];
  /** Undergrounds of the latest snapshot by tile, built when first needed. */
  private undergrounds: Map<string, UndergroundInfo> | null = null;
  private overlayKey = '';
  /** What the overlay shows for the held underground belt, or `null`. */
  ghostInfo: UndergroundGhost | null = null;
  private tick = 0;
  private receivedAt = 0;

  constructor() {
    this.container.addChild(this.shadows, this.curves, this.surfaces, this.frames);
    this.overlayContainer.addChild(this.overlay);
  }

  /** Draws belts with the sprites of `atlas` from now on (`null`: placeholders). */
  setAtlas(atlas: SpriteAtlas | null): void {
    this.atlas = atlas;
    this.sets.clear();
    this.overlayKey = '';
  }

  /** Belts drawn with sprites by the latest `draw`. */
  get spriteBelts(): number {
    return this.spriteCount;
  }

  /** The sprites of a belt of entity type `type`, shape `shape` and underground mode `mode`. */
  private spritesFor(type: number, shape: number, mode: number): BeltSprites | null {
    const key = (type * 4 + shape) * 4 + mode;
    let set = this.sets.get(key);
    if (set === undefined) {
      set = beltSprites(this.atlas, entityPrototype(type)?.name, shape, mode);
      this.sets.set(key, set);
    }
    return set;
  }

  /** Takes the belts of a snapshot of tick `tick`, received at `nowMs`. */
  apply(buffer: ArrayBuffer, tick: number, nowMs: number): void {
    this.belts = decodeBelts(buffer);
    this.undergrounds = null;
    this.tick = tick;
    this.receivedAt = nowMs;
  }

  /** The underground belt on tile `(x, y)` in the latest snapshot, as the pairing sees it. */
  private readonly lookup = (x: number, y: number): UndergroundInfo | null => {
    if (!this.undergrounds) {
      this.undergrounds = new Map();
      for (const b of this.belts) {
        if (b.mode === UndergroundMode.None) continue;
        const info = { speed: tierOf(b.type).speed, dir: b.dir as Direction, mode: b.mode };
        this.undergrounds.set(`${String(b.x)},${String(b.y)}`, info as UndergroundInfo);
      }
    }
    return this.undergrounds.get(`${String(x)},${String(y)}`) ?? null;
  };

  /**
   * What an underground belt of `proto` placed facing `dir` on `(x, y)`
   * would be, judged from the latest snapshot: an entrance or an exit, and
   * its partner. `null` for other prototypes.
   */
  undergroundGhost(
    proto: EntityPrototype,
    x: number,
    y: number,
    dir: Direction,
  ): UndergroundGhost | null {
    const gap = proto.undergroundMaxGap;
    if (gap === undefined) return null;
    const speed = proto.beltSpeed ?? 0;
    const mode = placedMode(this.lookup, x, y, dir, speed, gap);
    return { mode, partner: findPartner(this.lookup, x, y, dir, mode, speed, gap) };
  }

  /**
   * Shows, for a held underground belt (`proto` at `(x, y)` facing `dir`;
   * `null` for anything else), the tiles its partner can be on (in front of
   * an entrance, behind an exit), the partner it would get, and a hood on
   * its closed half.
   */
  drawOverlay(
    ghost: { proto: EntityPrototype; x: number; y: number; dir: Direction } | null,
  ): void {
    const info = ghost ? this.undergroundGhost(ghost.proto, ghost.x, ghost.y, ghost.dir) : null;
    this.ghostInfo = info;
    const key =
      ghost && info
        ? `${String(ghost.proto.id)}:${String(ghost.x)}:${String(ghost.y)}:${String(ghost.dir)}:${String(info.mode)}:${String(info.partner?.x)}:${String(info.partner?.y)}`
        : '';
    if (key === this.overlayKey) return;
    this.overlayKey = key;
    const g = this.overlay;
    g.clear();
    if (!ghost || !info) return;
    const gap = ghost.proto.undergroundMaxGap!;
    const step = info.mode === UndergroundMode.Entrance ? ghost.dir : (ghost.dir + 2) & 3;
    const dx = [0, 1, 0, -1][step]!;
    const dy = [-1, 0, 1, 0][step]!;
    for (let k = 1; k <= gap + 1; k++) {
      const tx = ghost.x + k * dx;
      const ty = ghost.y + k * dy;
      g.rect(tx * TILE_PX + 3, ty * TILE_PX + 3, TILE_PX - 6, TILE_PX - 6)
        .fill({ color: REACH_COLOR, alpha: 0.12 })
        .stroke({ width: 1, color: REACH_COLOR, alpha: 0.45 });
    }
    if (info.partner) {
      const { x, y } = info.partner;
      g.rect(x * TILE_PX + 1, y * TILE_PX + 1, TILE_PX - 2, TILE_PX - 2)
        .fill({ color: PARTNER_COLOR, alpha: 0.25 })
        .stroke({ width: 3, color: PARTNER_COLOR, alpha: 0.95 });
    }
    // With sprites, the ghost itself shows its hood (GhostLayer).
    if (!this.spritesFor(ghost.proto.id, BeltShape.Straight, info.mode)) {
      drawHood(g, ghost.x, ghost.y, ghost.dir, info.mode, ghost.proto.color, 0.7);
    }
  }

  /** The belts of the latest snapshot. */
  get data(): readonly BeltData[] {
    return this.belts;
  }

  /** Redraws belts and items for time `nowMs`. */
  draw(nowMs: number): void {
    const alpha = Math.min(1, Math.max(0, (nowMs - this.receivedAt) / TICK_MS));
    // Belt surface travelled since tick 0, in tiles per subtile/tick of speed.
    const ticks = this.tick + alpha;

    let used = 0;
    let sprites = 0;
    let hoodSprites = 0;
    const curves = this.curves;
    const hoods = this.hoods;
    curves.clear();
    hoods.clear();
    for (const belt of this.belts) {
      const { speed, rail } = tierOf(belt.type);
      const set = this.spritesFor(belt.type, belt.shape, belt.mode);
      if (set) {
        const cx = (belt.x + 0.5) * TILE_PX;
        const cy = (belt.y + 0.5) * TILE_PX;
        const slot = this.slot(sprites++);
        const frames = set.surface.frames[modelDirection(set.surfaceModel, belt.dir)]!;
        const scale = set.surfaceModel.scale;
        const travel = (ticks * speed) / BELT_LENGTH;
        placeSprite(slot.surface, frames[surfaceFrame(frames.length, travel)]!, scale, cx, cy);
        const dir = modelDirection(set.frame, belt.dir);
        placeSprite(slot.frame, set.frame.layers[0]!.frames[dir]![0]!, scale, cx, cy);
        if (set.hood) {
          let hood = this.hoodSprites[hoodSprites];
          if (!hood) {
            hood = { sprite: new Sprite(), shadow: new Sprite({ alpha: SHADOW_ALPHA }) };
            this.hoodSprites.push(hood);
            this.coverContainer.addChild(hood.sprite);
            this.shadows.addChild(hood.shadow);
          }
          hoodSprites++;
          hood.sprite.visible = hood.shadow.visible = true;
          const hd = modelDirection(set.hood, belt.dir);
          placeSprite(hood.sprite, set.hood.layers[0]!.frames[hd]![0]!, scale, cx, cy);
          placeSprite(hood.shadow, set.hood.shadow[hd]!, scale, cx, cy);
        }
        continue;
      }
      const phase = (ticks * speed * TILE_PX) / BELT_LENGTH;
      if (belt.shape === BeltShape.Straight) {
        let texture = this.textures.get(rail);
        if (!texture) {
          texture = makeBeltTexture(rail);
          this.textures.set(rail, texture);
        }
        let sprite = this.straight[used];
        if (!sprite) {
          sprite = new TilingSprite({ texture, width: TILE_PX, height: TILE_PX });
          sprite.anchor.set(0.5);
          this.straight.push(sprite);
          this.container.addChild(sprite);
        }
        used++;
        sprite.texture = texture;
        sprite.visible = true;
        sprite.position.set((belt.x + 0.5) * TILE_PX, (belt.y + 0.5) * TILE_PX);
        sprite.rotation = ((belt.dir & 3) * Math.PI) / 2;
        // The surface moves towards the belt's front (up in the texture).
        sprite.tilePosition.y = -(phase % TILE_PX);
        if (belt.mode !== UndergroundMode.None) {
          drawHood(hoods, belt.x, belt.y, belt.dir, belt.mode, rail, 1);
        }
      } else {
        drawCurve(curves, belt, phase / TILE_PX, rail);
      }
    }
    for (let i = used; i < this.straight.length; i++) this.straight[i]!.visible = false;
    for (let i = sprites; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      slot.surface.visible = slot.frame.visible = false;
    }
    for (let i = hoodSprites; i < this.hoodSprites.length; i++) {
      this.hoodSprites[i]!.sprite.visible = this.hoodSprites[i]!.shadow.visible = false;
    }
    this.spriteCount = sprites;
    // Hoods above every belt sprite.
    this.container.addChild(hoods);

    // Item icons (src/render/itemIcons.ts) at one texel per world pixel,
    // about 0.4 tile: bigger than the quarter-tile spacing of packed items,
    // so each lane is drawn from its back to its front and the front item of
    // a queue shows whole.
    const atlas = itemIconAtlas();
    let shown = 0;
    for (const belt of this.belts) {
      const order = belt.items
        .map((_, i) => i)
        .sort((a, b) => belt.items[b]!.offset - belt.items[a]!.offset);
      for (const i of order) {
        const it = belt.items[i]!;
        const offset = it.offset + it.moved * (1 - alpha);
        if (hidden(belt.mode, offset)) continue;
        const p = beltPoint(
          belt.dir,
          belt.shape,
          laneLateral(it.lane),
          progressOf(offset, BELT_LENGTH),
        );
        let sprite = this.items[shown];
        if (!sprite) {
          sprite = new Sprite();
          sprite.anchor.set(0.5);
          this.items.push(sprite);
          this.itemContainer.addChild(sprite);
        }
        shown++;
        sprite.visible = true;
        sprite.texture = atlas.texture(it.item);
        sprite.position.set((belt.x + p.x) * TILE_PX, (belt.y + p.y) * TILE_PX);
      }
    }
    for (let i = shown; i < this.items.length; i++) this.items[i]!.visible = false;
  }

  /** The sprites of the `i`-th belt drawn with sprites (made on first use), shown. */
  private slot(i: number): BeltSpriteSlot {
    let slot = this.slots[i];
    if (!slot) {
      slot = { surface: new Sprite(), frame: new Sprite() };
      this.slots.push(slot);
      this.surfaces.addChild(slot.surface);
      this.frames.addChild(slot.frame);
    }
    slot.surface.visible = slot.frame.visible = true;
    return slot;
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.itemContainer.destroy({ children: true });
    this.overlayContainer.destroy({ children: true });
    this.coverContainer.destroy({ children: true });
    for (const texture of this.textures.values()) texture.destroy(true);
  }
}

/** Whether an item `offset` subtiles from the end edge of an underground in `mode` is under its hood. */
function hidden(mode: number, offset: number): boolean {
  if (mode === UndergroundMode.Entrance) return offset < BELT_LENGTH / 2;
  if (mode === UndergroundMode.Exit) return offset > BELT_LENGTH / 2;
  return false;
}

/**
 * The hood of an underground belt on `(x, y)` facing `dir`: over its front
 * half for an entrance (items go down there), its rear half for an exit
 * (they come up there), with a band in the tier color along the opening.
 */
function drawHood(
  g: Graphics,
  x: number,
  y: number,
  dir: number,
  mode: number,
  rail: number,
  alpha: number,
): void {
  // Facing north: an entrance's hood covers v in [0, 0.5], an exit's [0.5, 1].
  const [v0, v1, edge] = mode === UndergroundMode.Entrance ? [0.04, 0.5, 0.5] : [0.5, 0.96, 0.5];
  const poly = (corners: [number, number][]): number[] =>
    corners.flatMap(([u, v]) => {
      const [tu, tv] = turn(dir, u, v);
      return [(x + tu) * TILE_PX, (y + tv) * TILE_PX];
    });
  g.poly(
    poly([
      [0.04, v0],
      [0.96, v0],
      [0.96, v1],
      [0.04, v1],
    ]),
  )
    .fill({ color: HOOD, alpha })
    .stroke({ width: 2, color: rail, alpha });
  const band = mode === UndergroundMode.Entrance ? [edge - 0.1, edge] : [edge, edge + 0.1];
  g.poly(
    poly([
      [0.04, band[0]!],
      [0.96, band[0]!],
      [0.96, band[1]!],
      [0.04, band[1]!],
    ]),
  ).fill({ color: rail, alpha });
}

/** A curved belt: base, rails along both arcs, and bars that sweep around at the belt's speed. */
function drawCurve(g: Graphics, belt: BeltData, phaseTiles: number, rail: number): void {
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
    const points: number[] = [];
    for (let i = 0; i <= STEPS; i++) points.push(...at(lateral, i / STEPS));
    g.poly(points, false).stroke({ width: 3, color: rail });
  }
}

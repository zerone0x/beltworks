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
 * (`coverContainer`), with its shadow. Belts are drawn north to south
 * (`BeltDrawOrder`), so each covers the end face of the one north of it.
 * A splitter comes as two records, one per half, each drawn as a straight
 * belt of its tier; its left half's record also draws the splitter's gantry
 * over both (in `coverContainer` too; a bar in the tier color without
 * sprites).
 *
 * Without sprites, straight belts are tiling sprites of a placeholder texture
 * that scrolls with the tick (at the belt's speed, like the items), with rails
 * in the tier color; curves are drawn as arcs with bars sweeping around them,
 * and underground belts get a flat hood over their closed half.
 *
 * Only the belts in the cull rectangle (cull.ts) are drawn, with pooled
 * sprites. Items are particles (one `ParticleContainer` per icon texture
 * source, in practice one), read from the snapshot into flat arrays without
 * an object per item, so tens of thousands of them cost one draw call and a
 * pass over the visible ones per frame.
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

import {
  Container,
  Graphics,
  Particle,
  ParticleContainer,
  Rectangle,
  Sprite,
  Texture,
  TilingSprite,
  type TextureSource,
} from 'pixi.js';
import { ENTITIES, EntityTypeId, entityPrototype, type EntityPrototype } from '../data/entities';
import { BELT_SPEED, BeltShape } from '../sim/belts/belts';
import { BELT_LENGTH } from '../sim/belts/line';
import { SPLITTER_HALF_MODE } from '../sim/belts/splitter';
import {
  UndergroundMode,
  findPartner,
  placedMode,
  type PartnerTile,
  type UndergroundInfo,
} from '../sim/belts/underground';
import type { Direction } from '../sim/entities/direction';
import {
  BELT_HEADER,
  BELT_ITEM_STRIDE,
  BELT_STRIDE,
  BeltField,
  beltItemId,
  beltItemLane,
  beltItemMoved,
  beltLayout,
  decodeBelts,
  type BeltData,
} from '../sim/snapshot';
import { TICKS_PER_SECOND } from '../worker/protocol';
import { beltPoint, beltPointInto, laneLateral, progressOf } from './beltPath';
import { beltSprites, surfaceFrame, type BeltSprites } from './beltSprites';
import { TILE_PX } from './camera';
import { EVERYWHERE, overlaps, type TileRect } from './cull';
import { placeSprite } from './entitySprites';
import { itemIconAtlas } from './itemIcons';
import { SHADOW_ALPHA, modelDirection, type SpriteAtlas } from './sprites';

const TICK_MS = 1000 / TICKS_PER_SECOND;
const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
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

/** Per-belt fields of the parsed snapshot, in draw order. */
const BELT_FIELDS = ['x', 'y', 'dir', 'shape', 'type', 'mode'] as const;
/** Per-item fields of the parsed snapshot, belt by belt, each belt's items from back to front. */
const ITEM_FIELDS = ['itemLane', 'itemOffset', 'itemMoved', 'itemId'] as const;

type BeltRecords = Record<
  (typeof BELT_FIELDS)[number] | (typeof ITEM_FIELDS)[number],
  Int32Array
> & {
  /** Belt `i`'s items are `itemStart[i]` up to `itemStart[i + 1]`. */
  itemStart: Int32Array;
};

/**
 * The items of one texture source (in practice the whole rendered icon
 * atlas): one particle container, so they cost one draw call and a buffer
 * upload of their positions and texture coordinates per frame.
 */
interface ItemBatch {
  container: ParticleContainer;
  /** Particles, reused from frame to frame; the first `used` are this frame's. */
  pool: Particle[];
  used: number;
  /** Particles whose static data (size, color) was uploaded. */
  uploaded: number;
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
  /** Placeholder straight belts (tiling sprites), below the placeholder hoods. */
  private readonly straightContainer = new Container({ label: 'belt-straight' });
  private readonly straight: TilingSprite[] = [];
  private readonly curves = new Graphics({ label: 'belt-curves' });
  private readonly hoods = new Graphics({ label: 'underground-hoods' });
  private readonly overlay = new Graphics({ label: 'underground-reach' });
  /** Whether the placeholder graphics hold anything. */
  private placeholders = false;
  /** Item particles by texture source. */
  private readonly batches = new Map<TextureSource, ItemBatch>();
  /** Item textures by item id, looked up once per frame. */
  private itemTextures: (Texture | undefined)[] = [];
  /** Belt textures by rail color (one per tier). */
  private readonly textures = new Map<number, Texture>();
  /** The latest snapshot's belt buffer, decoded into `BeltData` only when asked (`data`). */
  private buffer: ArrayBuffer = new Int32Array(1).buffer;
  private decoded: BeltData[] | null = null;
  /** The latest snapshot's belts, parsed into flat arrays in draw order. */
  private readonly records: BeltRecords = {
    x: new Int32Array(0),
    y: new Int32Array(0),
    dir: new Int32Array(0),
    shape: new Int32Array(0),
    type: new Int32Array(0),
    mode: new Int32Array(0),
    itemStart: new Int32Array(1),
    itemLane: new Int32Array(0),
    itemOffset: new Int32Array(0),
    itemMoved: new Int32Array(0),
    itemId: new Int32Array(0),
  };
  private count = 0;
  private itemTotal = 0;
  /** The belts block of the buffer `records` was put in draw order for (see `parse`). */
  private headers = new Int32Array(0);
  /** Draw order: the belt in the buffer drawn `i`-th. */
  private order: readonly number[] = [];
  /** Scratch: where each belt's items start in the buffer, in buffer order. */
  private itemAt = new Int32Array(0);
  /** Belts drawn by the latest `draw` (indices into `records`). */
  private visible = new Int32Array(0);
  /** Puts the belts of each snapshot in draw order (north to south). */
  private readonly drawOrder = new BeltDrawOrder();
  /** Undergrounds of the latest snapshot by tile, built when first needed. */
  private undergrounds: Map<string, UndergroundInfo> | null = null;
  private overlayKey = '';
  /** What the overlay shows for the held underground belt, or `null`. */
  ghostInfo: UndergroundGhost | null = null;
  private tick = 0;
  private receivedAt = 0;
  /** Scratch point for item positions. */
  private readonly point = { x: 0, y: 0 };
  /** Whether belt surfaces move (the animation setting); items move either way. */
  animateSurfaces = true;

  /** Shows or hides the shadows of underground hoods (the shadows setting). */
  setShadows(on: boolean): void {
    this.shadows.visible = on;
  }

  constructor() {
    this.container.addChild(
      this.shadows,
      this.curves,
      this.surfaces,
      this.frames,
      this.straightContainer,
      this.hoods,
    );
    this.overlayContainer.addChild(this.overlay);
  }

  /** Draws belts with the sprites of `atlas` from now on (`null`: placeholders). */
  setAtlas(atlas: SpriteAtlas | null): void {
    this.atlas = atlas;
    this.sets.clear();
    this.overlayKey = '';
  }

  /** Belts drawn with sprites by the latest `draw` (those in the cull rectangle). */
  get spriteBelts(): number {
    return this.spriteCount;
  }

  /** Items on the latest snapshot's belts. */
  get itemCount(): number {
    return this.itemTotal;
  }

  /** The sprites of a belt of entity type `type`, shape `shape` and underground mode `mode`. */
  private spritesFor(type: number, shape: number, mode: number): BeltSprites | null {
    const key = (type * 4 + shape) * 8 + mode;
    let set = this.sets.get(key);
    if (set === undefined) {
      set = beltSprites(this.atlas, entityPrototype(type)?.name, shape, mode);
      this.sets.set(key, set);
    }
    return set;
  }

  /**
   * Takes the belts of a snapshot of tick `tick`, received at `nowMs`. The
   * same buffer as the latest one (a snapshot whose belts didn't change,
   * src/worker/snapshotDelta.ts) only moves the clock on.
   */
  apply(buffer: ArrayBuffer, tick: number, nowMs: number): void {
    this.tick = tick;
    this.receivedAt = nowMs;
    if (buffer === this.buffer) return;
    this.buffer = buffer;
    this.decoded = null;
    this.parse(new Int32Array(buffer));
  }

  /**
   * Reads a belt buffer (`encodeBelts`) straight into flat arrays, belts in
   * draw order (`BeltDrawOrder`) and each belt's items from its back to its
   * front: no object per item, so 50 000 items cost a few copies per snapshot.
   * The belts block rarely changes (items move, belts don't): while it stays
   * the same, the draw order and the belts' fields are kept and only the
   * items are read again.
   */
  private parse(v: Int32Array): void {
    const layout = beltLayout(v) ?? { count: 0, counts: BELT_HEADER, items: BELT_HEADER };
    const { count, counts } = layout;
    const r = this.records;
    const headers = v.subarray(BELT_HEADER, counts);
    if (!sameWords(headers, this.headers)) {
      this.headers = headers.slice();
      this.undergrounds = null;
      const positions = new Int32Array(2 * count);
      for (let b = 0; b < count; b++) {
        positions[2 * b] = headers[b * BELT_STRIDE + BeltField.x]!;
        positions[2 * b + 1] = headers[b * BELT_STRIDE + BeltField.y]!;
      }
      this.order = this.drawOrder.indices(positions);
      if (r.x.length < count) {
        const size = Math.max(count, r.x.length * 2);
        for (const key of BELT_FIELDS) r[key] = new Int32Array(size);
        r.itemStart = new Int32Array(size + 1);
      }
      for (let i = 0; i < count; i++) {
        const h = this.order[i]! * BELT_STRIDE;
        r.x[i] = headers[h + BeltField.x]!;
        r.y[i] = headers[h + BeltField.y]!;
        r.dir[i] = headers[h + BeltField.dir]!;
        r.shape[i] = headers[h + BeltField.shape]!;
        r.type[i] = headers[h + BeltField.type]!;
        r.mode[i] = headers[h + BeltField.mode]!;
      }
    }
    // Where each belt's items start (buffer order), clamped to the buffer.
    if (this.itemAt.length < count + 1) this.itemAt = new Int32Array(count + 1);
    const at = this.itemAt;
    let o = layout.items;
    for (let b = 0; b < count; b++) {
      at[b] = o;
      const n = Math.max(
        0,
        Math.min(v[counts + b]!, Math.floor((v.length - o) / BELT_ITEM_STRIDE)),
      );
      o += n * BELT_ITEM_STRIDE;
    }
    at[count] = o;
    const items = (o - layout.items) / BELT_ITEM_STRIDE;
    if (r.itemLane.length < items) {
      const size = Math.max(items, r.itemLane.length * 2);
      for (const key of ITEM_FIELDS) r[key] = new Int32Array(size);
    }
    let m = 0;
    for (let i = 0; i < count; i++) {
      const b = this.order[i]!;
      r.itemStart[i] = m;
      const first = m;
      for (let p = at[b]!, end = at[b + 1]!; p < end; p += BELT_ITEM_STRIDE) {
        // Insertion sort by offset, largest first: each lane from its back to its front.
        const offset = v[p]!;
        const packed = v[p + 1]!;
        let j = m++;
        while (j > first && r.itemOffset[j - 1]! < offset) {
          r.itemLane[j] = r.itemLane[j - 1]!;
          r.itemOffset[j] = r.itemOffset[j - 1]!;
          r.itemMoved[j] = r.itemMoved[j - 1]!;
          r.itemId[j] = r.itemId[j - 1]!;
          j--;
        }
        r.itemLane[j] = beltItemLane(packed);
        r.itemOffset[j] = offset;
        r.itemMoved[j] = beltItemMoved(packed);
        r.itemId[j] = beltItemId(packed);
      }
    }
    r.itemStart[count] = m;
    this.count = count;
    this.itemTotal = m;
  }

  /** The underground belt on tile `(x, y)` in the latest snapshot, as the pairing sees it. */
  private readonly lookup = (x: number, y: number): UndergroundInfo | null => {
    if (!this.undergrounds) {
      this.undergrounds = new Map();
      const r = this.records;
      for (let i = 0; i < this.count; i++) {
        const mode = r.mode[i]!;
        if (mode !== UndergroundMode.Entrance && mode !== UndergroundMode.Exit) continue;
        const info = { speed: tierOf(r.type[i]!).speed, dir: r.dir[i] as Direction, mode };
        this.undergrounds.set(`${String(r.x[i])},${String(r.y[i])}`, info);
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

  /** The belts of the latest snapshot, in draw order. */
  get data(): readonly BeltData[] {
    this.decoded ??= this.drawOrder.sort(decodeBelts(this.buffer));
    return this.decoded;
  }

  /** Redraws the belts in the cull rectangle `cull` and the items on them, for time `nowMs`. */
  draw(nowMs: number, cull: TileRect = EVERYWHERE): void {
    const alpha = Math.min(1, Math.max(0, (nowMs - this.receivedAt) / TICK_MS));
    // Belt surface travelled since tick 0, in tiles per subtile/tick of speed
    // (standing still with animations off; the items still move).
    const ticks = this.animateSurfaces ? this.tick + alpha : 0;
    const r = this.records;

    if (this.visible.length < this.count) this.visible = new Int32Array(this.count);
    let shownBelts = 0;
    let used = 0;
    let sprites = 0;
    let hoodSprites = 0;
    const curves = this.curves;
    const hoods = this.hoods;
    if (this.placeholders) {
      curves.clear();
      hoods.clear();
      this.placeholders = false;
    }
    for (let i = 0; i < this.count; i++) {
      const bx = r.x[i]!;
      const by = r.y[i]!;
      if (!overlaps(cull, bx, by)) continue;
      this.visible[shownBelts++] = i;
      const type = r.type[i]!;
      const dir = r.dir[i]!;
      const shape = r.shape[i]!;
      const mode = r.mode[i]!;
      const { speed, rail } = tierOf(type);
      const set = this.spritesFor(type, shape, mode);
      if (set) {
        const cx = (bx + 0.5) * TILE_PX;
        const cy = (by + 0.5) * TILE_PX;
        const slot = this.slot(sprites++);
        const frames = set.surface.frames[modelDirection(set.surfaceModel, dir)]!;
        const scale = set.surfaceModel.scale;
        const travel = (ticks * speed) / BELT_LENGTH;
        placeSprite(slot.surface, frames[surfaceFrame(frames.length, travel)]!, scale, cx, cy);
        const d = modelDirection(set.frame, dir);
        placeSprite(slot.frame, set.frame.layers[0]!.frames[d]![0]!, scale, cx, cy);
        // A splitter's gantry stands over both halves: its center is half a
        // tile right of its left half's (looking the way items move).
        const cover = set.hood ?? set.splitter;
        if (cover) {
          const right = (dir + 1) & 3;
          const off = set.splitter ? TILE_PX / 2 : 0;
          const hx = cx + off * DX[right]!;
          const hy = cy + off * DY[right]!;
          let hood = this.hoodSprites[hoodSprites];
          if (!hood) {
            hood = { sprite: new Sprite(), shadow: new Sprite({ alpha: SHADOW_ALPHA }) };
            this.hoodSprites.push(hood);
            this.coverContainer.addChild(hood.sprite);
            this.shadows.addChild(hood.shadow);
          }
          hoodSprites++;
          hood.sprite.visible = hood.shadow.visible = true;
          const hd = modelDirection(cover, dir);
          placeSprite(hood.sprite, cover.layers[0]!.frames[hd]![0]!, scale, hx, hy);
          placeSprite(hood.shadow, cover.shadow[hd]!, scale, hx, hy);
        }
        continue;
      }
      const phase = (ticks * speed * TILE_PX) / BELT_LENGTH;
      if (shape === BeltShape.Straight) {
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
          this.straightContainer.addChild(sprite);
        }
        used++;
        sprite.texture = texture;
        sprite.visible = true;
        sprite.position.set((bx + 0.5) * TILE_PX, (by + 0.5) * TILE_PX);
        sprite.rotation = ((dir & 3) * Math.PI) / 2;
        // The surface moves towards the belt's front (up in the texture).
        sprite.tilePosition.y = -(phase % TILE_PX);
        if (mode === UndergroundMode.Entrance || mode === UndergroundMode.Exit) {
          drawHood(hoods, bx, by, dir, mode, rail, 1);
          this.placeholders = true;
        } else if (mode === SPLITTER_HALF_MODE) {
          drawSplitter(hoods, bx, by, dir, rail);
          this.placeholders = true;
        }
      } else {
        drawCurve(curves, bx, by, dir, shape, phase / TILE_PX, rail);
        this.placeholders = true;
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
    this.drawItems(shownBelts, alpha);
  }

  /**
   * The items on the first `shown` belts of `visible`, `moved × (1 − α)`
   * behind where they are. Item icons (src/render/itemIcons.ts) are drawn at
   * one texel per world pixel, about 0.4 tile: bigger than the quarter-tile
   * spacing of packed items, so each lane goes from its back to its front
   * and the front item of a queue shows whole.
   */
  private drawItems(shown: number, alpha: number): void {
    const r = this.records;
    const atlas = itemIconAtlas();
    const textures = this.itemTextures;
    textures.length = 0;
    for (const batch of this.batches.values()) batch.used = 0;
    let batch: ItemBatch | null = null;
    const point = this.point;
    for (let v = 0; v < shown; v++) {
      const i = this.visible[v]!;
      const end = r.itemStart[i + 1]!;
      const bx = r.x[i]!;
      const by = r.y[i]!;
      const dir = r.dir[i]!;
      const shape = r.shape[i]!;
      const mode = r.mode[i]!;
      for (let j = r.itemStart[i]!; j < end; j++) {
        const offset = r.itemOffset[j]! + r.itemMoved[j]! * (1 - alpha);
        if (hidden(mode, offset)) continue;
        const item = r.itemId[j]!;
        const texture = (textures[item] ??= atlas.texture(item));
        if (!batch || batch.container.texture.source !== texture.source) {
          batch = this.batch(texture);
        }
        beltPointInto(
          point,
          dir,
          shape,
          laneLateral(r.itemLane[j]!),
          progressOf(offset, BELT_LENGTH),
        );
        let particle = batch.pool[batch.used];
        if (!particle) {
          particle = new Particle({ texture, anchorX: 0.5, anchorY: 0.5 });
          batch.pool.push(particle);
        }
        particle.texture = texture;
        particle.x = (bx + point.x) * TILE_PX;
        particle.y = (by + point.y) * TILE_PX;
        batch.container.particleChildren[batch.used++] = particle;
      }
    }
    for (const b of this.batches.values()) {
      b.container.particleChildren.length = b.used;
      // Every icon has the same size and color: the static data only needs
      // uploading for particles that never had it.
      if (b.used > b.uploaded) {
        b.uploaded = b.used;
        b.container.update();
      }
    }
  }

  /** The particle batch of `texture`'s source, made on first use. */
  private batch(texture: Texture): ItemBatch {
    let batch = this.batches.get(texture.source);
    if (!batch) {
      const container = new ParticleContainer({
        texture,
        dynamicProperties: {
          position: true,
          uvs: true,
          vertex: false,
          rotation: false,
          color: false,
        },
        roundPixels: false,
      });
      // It doesn't measure its particles; it is never culled or filtered.
      container.boundsArea = new Rectangle(-1e9, -1e9, 2e9, 2e9);
      batch = { container, pool: [], used: 0, uploaded: 0 };
      this.batches.set(texture.source, batch);
      this.itemContainer.addChild(container);
    }
    return batch;
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

/**
 * Sorts belts north to south (then west to east), the order they are drawn
 * in. A belt sprite shows its south end face (the edge of the surface and the
 * side frames, a few texels below the tile), and the next belt to the south
 * covers it with its own top only if it is drawn later; drawn earlier, the
 * end face lies over it as a dark seam across the run (a north-going line,
 * whose belts usually come south first). The snapshot's order is stable from
 * tick to tick, so the order found for one set of positions is reused until
 * they change: a pass over the belts instead of a sort per snapshot.
 */
/** Whether `a` and `b` hold the same words. */
function sameWords(a: Int32Array, b: Int32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class BeltDrawOrder {
  private positions = new Int32Array(0);
  private order: number[] = [];

  /** The draw order (indices) of belts at `positions` (`[x0, y0, x1, y1, ...]`). */
  indices(positions: Int32Array): readonly number[] {
    const n = positions.length >> 1;
    let same = this.positions.length === positions.length;
    for (let i = 0; same && i < positions.length; i++) same = this.positions[i] === positions[i];
    if (!same) {
      this.positions = positions.slice();
      this.order = Array.from({ length: n }, (_, i) => i).sort(
        (a, b) =>
          positions[2 * a + 1]! - positions[2 * b + 1]! || positions[2 * a]! - positions[2 * b]!,
      );
    }
    return this.order;
  }

  sort(belts: BeltData[]): BeltData[] {
    const positions = new Int32Array(2 * belts.length);
    belts.forEach((b, i) => {
      positions[2 * i] = b.x;
      positions[2 * i + 1] = b.y;
    });
    return this.indices(positions).map((i) => belts[i]!);
  }
}

/**
 * The placeholder gantry of a splitter whose left half is on `(x, y)`,
 * facing `dir`: a bar in the tier color across the middle of both halves.
 */
function drawSplitter(g: Graphics, x: number, y: number, dir: number, rail: number): void {
  const right = (dir + 1) & 3;
  // The two tiles' centers, and the bar's half extent along and across the belts.
  const ax = (x + 0.5) * TILE_PX;
  const ay = (y + 0.5) * TILE_PX;
  const bx = ax + DX[right]! * TILE_PX;
  const by = ay + DY[right]! * TILE_PX;
  const fx = DX[dir]! * 0.2 * TILE_PX;
  const fy = DY[dir]! * 0.2 * TILE_PX;
  const sx = DX[right]! * 0.48 * TILE_PX;
  const sy = DY[right]! * 0.48 * TILE_PX;
  g.poly([
    ax - sx - fx,
    ay - sy - fy,
    bx + sx - fx,
    by + sy - fy,
    bx + sx + fx,
    by + sy + fy,
    ax - sx + fx,
    ay - sy + fy,
  ])
    .fill({ color: rail })
    .stroke({ width: 2, color: HOOD });
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
function drawCurve(
  g: Graphics,
  x: number,
  y: number,
  dir: number,
  shape: number,
  phaseTiles: number,
  rail: number,
): void {
  const at = (lateral: number, t: number): [number, number] => {
    const p = beltPoint(dir, shape, lateral, t);
    return [(x + p.x) * TILE_PX, (y + p.y) * TILE_PX];
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

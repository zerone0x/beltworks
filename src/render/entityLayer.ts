/**
 * Draws the entities: with their pre-rendered sprites where the atlas has a
 * model for them (entitySprites.ts), otherwise as placeholder shapes in each prototype's color, with a
 * direction marker on rotatable ones, a firebox on furnaces and boilers that
 * glows while they work, a drill head on mining drills that lights up while they work,
 * a small platform for inserters, a post with a crossbar for electric
 * poles, and a recessed work area on assembling machines), a power icon over electric consumers without enough power (red
 * for no power, yellow for low power; in `iconContainer`, above the
 * inserter arms and wires), and the ghost preview of the entity about to be
 * placed (for inserters with markers on the tiles they would pick up from
 * and drop onto). Placed belts are drawn by the belt layer (beltLayer.ts)
 * instead, placeholder inserter arms by the inserter layer (inserterLayer.ts), steam
 * engine flywheels by the generator layer (generatorLayer.ts), and
 * assembling machines' product icons and working lights by the assembler
 * layer (assemblerLayer.ts).
 */

import { Container, Graphics, Sprite } from 'pixi.js';
import {
  EntityTypeId,
  inserterReach,
  isBeltType,
  isInserterPrototype,
  type EntityPrototype,
} from '../data/entities';
import type { Direction } from '../sim/entities/direction';
import { isAssemblerType } from '../sim/entities/assembler';
import { drillDropTileFor } from '../sim/entities/drill';
import { UndergroundMode } from '../sim/belts/underground';
import { inserterDropTile, inserterPickupTile } from '../sim/entities/inserter';
import { MachineState } from '../sim/entities/machine';
import { footprintSize } from '../sim/entities/store';
import { TILE_PX } from './camera';
import { EVERYWHERE, overlaps, sameRect, type TileRect } from './cull';
import type { EntityIndex } from './entityIndex';
import { UNDERGROUND_TIER, beltSprites } from './beltSprites';
import {
  EntitySpriteLayer,
  placeArm,
  placeSprite,
  restAngle,
  type InserterPoses,
} from './entitySprites';
import { POLE_TOP } from './powerLayer';
import {
  layerShown,
  modelDirection,
  type ModelSprites,
  type SpriteAtlas,
  type SpriteFrame,
} from './sprites';

/** Ghost tint when the entity can be placed, and when it can't. */
export const GHOST_OK = 0x5ad15a;
export const GHOST_BLOCKED = 0xe0574f;
const MISSING_COLOR = 0xff00ff;
/** Furnace firebox when cold, and the glow of a working one. */
const FIREBOX_COLD = 0x2a2420;
const FIREBOX_GLOW = 0xff9a2e;
const FIREBOX_CORE = 0xffe08a;
/** Drill head when idle, and while the drill mines. */
const DRILL_HEAD_IDLE = 0x3a3c42;
const DRILL_HEAD_WORKING = 0xd8d2bf;
/** An assembling machine's work area, where its product icon shows. */
const WORK_AREA = 0x26282c;
/** A lab's glass dome: dark while idle, lit while it researches. */
const LAB_DOME_IDLE = 0x2c3a48;
const LAB_DOME_WORKING = 0x7fd4ff;
/** Power icons: no power at all, and low power (satisfaction below 1). */
export const NO_POWER_COLOR = 0xe0473c;
export const LOW_POWER_COLOR = 0xf2c230;
const POWER_ICON_BACK = 0x1c1d21;
/** Ghost markers of an inserter's pickup tile (a ring) and drop tile (a dot). */
export const PICKUP_MARKER = 0x6fc3ff;
export const DROP_MARKER = 0xffb347;

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
  status: number = MachineState.Idle,
): void {
  if (proto?.id === EntityTypeId.SmallElectricPole) {
    drawPole(g, proto.color, x, y, alpha);
    return;
  }
  const { w, h } = proto ? footprintSize(proto, dir) : { w: 1, h: 1 };
  const color = proto?.color ?? MISSING_COLOR;
  // Inserters stand on a small platform, leaving room to see their arm swing.
  const inserter = isInserterPrototype(proto);
  const inset = inserter ? 7 : 2;
  const left = x * TILE_PX + inset;
  const top = y * TILE_PX + inset;
  const width = w * TILE_PX - 2 * inset;
  const height = h * TILE_PX - 2 * inset;
  g.roundRect(left, top, width, height, 3)
    .fill({ color, alpha })
    .stroke({ width: 2, color: shade(color, 0.45), alpha });
  const lit = status === MachineState.Working;
  if (proto?.id === EntityTypeId.StoneFurnace) {
    // An opening in the lower half.
    const w = width * 0.5;
    const h = height * 0.3;
    drawFirebox(g, left + (width - w) / 2, top + height * 0.55, w, h, alpha, lit);
  }
  if (proto?.id === EntityTypeId.Boiler) {
    // Across the rear end, behind the direction marker.
    const ux = [0, 1, 0, -1][dir]!;
    const uy = [-1, 0, 1, 0][dir]!;
    const w = ux === 0 ? width * 0.55 : width * 0.16;
    const h = ux === 0 ? height * 0.16 : height * 0.55;
    const cx = left + width / 2 - ux * width * 0.3;
    const cy = top + height / 2 - uy * height * 0.3;
    drawFirebox(g, cx - w / 2, cy - h / 2, w, h, alpha, lit);
  }
  if (
    proto?.id === EntityTypeId.BurnerMiningDrill ||
    proto?.id === EntityTypeId.ElectricMiningDrill
  ) {
    // A ring around the direction marker.
    const radius = Math.min(width, height) * 0.4;
    const working = status === MachineState.Working || status === MachineState.LowPower;
    g.circle(left + width / 2, top + height / 2, radius).stroke({
      width: 3,
      color: working ? DRILL_HEAD_WORKING : DRILL_HEAD_IDLE,
      alpha,
    });
  }
  if (proto && isAssemblerType(proto.id)) {
    // A recessed square in the middle, with a bolt in each corner of the body.
    const edge = Math.min(width, height) * 0.56;
    g.roundRect(left + (width - edge) / 2, top + (height - edge) / 2, edge, edge, 4)
      .fill({ color: WORK_AREA, alpha })
      .stroke({ width: 2, color: shade(color, 0.6), alpha });
    for (const [bx, by] of [
      [left + 6, top + 6],
      [left + width - 6, top + 6],
      [left + 6, top + height - 6],
      [left + width - 6, top + height - 6],
    ] as const) {
      g.circle(bx, by, 2.5).fill({ color: shade(color, 0.5), alpha });
    }
  }
  if (proto?.id === EntityTypeId.Lab) {
    // A glass dome in the middle, on a darker ring.
    const r = Math.min(width, height) * 0.3;
    const cx = left + width / 2;
    const cy = top + height / 2;
    const working = status === MachineState.Working || status === MachineState.LowPower;
    g.circle(cx, cy, r + 3).fill({ color: shade(color, 0.55), alpha });
    g.circle(cx, cy, r).fill({ color: working ? LAB_DOME_WORKING : LAB_DOME_IDLE, alpha });
    g.circle(cx - r * 0.35, cy - r * 0.35, r * 0.25).fill({ color: 0xffffff, alpha: alpha * 0.35 });
  }
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

/**
 * The color of the power icon an entity in machine state `status` shows:
 * red for `NoPower`, yellow for `LowPower`, `null` for none.
 */
export function powerIconColor(status: number): number | null {
  if (status === MachineState.NoPower) return NO_POWER_COLOR;
  if (status === MachineState.LowPower) return LOW_POWER_COLOR;
  return null;
}

/**
 * A power icon centered on `(cx, cy)` (world pixels): a lightning bolt in
 * `color` on a dark rounded badge with a `color` rim.
 */
export function drawPowerIcon(g: Graphics, cx: number, cy: number, color: number): void {
  const r = 8;
  g.roundRect(cx - r, cy - r, 2 * r, 2 * r, 4)
    .fill({ color: POWER_ICON_BACK, alpha: 0.85 })
    .stroke({ width: 1.5, color });
  g.poly([
    cx + 1.5,
    cy - 6,
    cx - 4,
    cy + 1,
    cx - 0.5,
    cy + 1,
    cx - 1.5,
    cy + 6,
    cx + 4,
    cy - 1,
    cx + 0.5,
    cy - 1,
  ]).fill({ color });
}

/**
 * A small electric pole on tile `(x, y)`: a footing, a post, and a crossbar
 * with two insulators where the wires attach (`POLE_TOP` above the center).
 */
function drawPole(g: Graphics, color: number, x: number, y: number, alpha: number): void {
  const cx = (x + 0.5) * TILE_PX;
  const cy = (y + 0.5) * TILE_PX;
  const top = cy - POLE_TOP * TILE_PX;
  const dark = shade(color, 0.45);
  g.roundRect(cx - 7, cy + 2, 14, 9, 2).fill({ color: 0x5a554c, alpha });
  g.rect(cx - 2.5, top - 1, 5, cy + 6 - top)
    .fill({ color, alpha })
    .stroke({ width: 1, color: dark, alpha });
  g.rect(cx - 10, top - 2, 20, 4)
    .fill({ color, alpha })
    .stroke({ width: 1, color: dark, alpha });
  for (const dx of [-8, 8]) {
    g.circle(cx + dx, top - 3, 2.2).fill({ color: 0xd8dde0, alpha });
  }
}

/** A firebox (furnaces, boilers): an opening at `(x, y)` of `w × h`, lit while the entity works. */
function drawFirebox(
  g: Graphics,
  x: number,
  y: number,
  w: number,
  h: number,
  alpha: number,
  lit: boolean,
): void {
  if (lit) {
    // A soft halo around the opening, then the fire itself.
    g.roundRect(x - 4, y - 4, w + 8, h + 8, 6).fill({ color: FIREBOX_GLOW, alpha: 0.35 * alpha });
    g.roundRect(x, y, w, h, 3).fill({ color: FIREBOX_GLOW, alpha });
    g.roundRect(x + w * 0.2, y + h * 0.3, w * 0.6, h * 0.5, 2).fill({
      color: FIREBOX_CORE,
      alpha,
    });
  } else {
    g.roundRect(x, y, w, h, 3).fill({ color: FIREBOX_COLD, alpha });
  }
}

export class EntityLayer {
  readonly container = new Container({ label: 'entities' });
  /** Power icons, above the inserter arms and the wires. */
  readonly iconContainer = new Container({ label: 'entity-icons' });
  /** Entities with sprite models (and their shadows, in `sprites.shadowContainer`). */
  readonly sprites = new EntitySpriteLayer();
  private readonly graphics = new Graphics({ label: 'buildings' });
  private readonly icons = new Graphics({ label: 'power-icons' });
  private drawn = -1;
  private cull: TileRect | null = null;
  private iconCount = 0;

  constructor() {
    this.container.addChild(this.graphics, this.sprites.container);
    this.iconContainer.addChild(this.icons);
  }

  /** Shadows of the sprite entities; goes below every building. */
  get shadowContainer(): Container {
    return this.sprites.shadowContainer;
  }

  /** Draws the entities that have a model in `atlas` with sprites from now on. */
  setAtlas(atlas: SpriteAtlas | null): void {
    this.sprites.setAtlas(atlas);
    this.drawn = -1;
  }

  /** Entities with a power icon as of the latest `draw` (drawn if in the cull rectangle). */
  get powerIcons(): number {
    return this.iconCount;
  }

  /**
   * Redraws the placeholder shapes and power icons in the cull rectangle
   * `cull` if the entities or the rectangle changed since the last call, and
   * draws the sprites (animated by `dtMs` milliseconds).
   */
  draw(
    index: EntityIndex,
    dtMs: number = 0,
    poses: InserterPoses | null = null,
    cull: TileRect = EVERYWHERE,
  ): void {
    this.sprites.draw(index, dtMs, poses, cull);
    if (index.version === this.drawn && this.cull && sameRect(this.cull, cull)) {
      return;
    }
    this.drawn = index.version;
    this.cull = cull;
    const g = this.graphics;
    g.clear();
    this.icons.clear();
    this.iconCount = 0;
    for (const e of index.entities) {
      const icon = powerIconColor(e.status);
      if (icon !== null) this.iconCount++;
      if (!overlaps(cull, e.x, e.y, e.w, e.h)) continue;
      if (icon !== null) {
        drawPowerIcon(this.icons, (e.x + e.w / 2) * TILE_PX, (e.y + e.h / 2) * TILE_PX, icon);
      }
      if (isBeltType(e.type)) continue;
      if (this.sprites.modelFor(e.proto?.name)) continue;
      drawEntity(g, e.proto, e.x, e.y, e.dir, 1, e.status);
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
    this.iconContainer.destroy({ children: true });
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
  /** For an underground belt: whether it would be an entrance or an exit (`UndergroundMode`). */
  mode?: number;
}

/**
 * The tiles an inserter ghost would pick up from and drop onto (`reach`
 * tiles behind and in front of it), or `null` for other entities.
 */
export function ghostInserterTiles(
  ghost: Ghost,
): { pickup: { x: number; y: number }; drop: { x: number; y: number } } | null {
  if (!isInserterPrototype(ghost.proto)) return null;
  const reach = inserterReach(ghost.proto);
  return {
    pickup: inserterPickupTile(ghost.x, ghost.y, ghost.dir, reach),
    drop: inserterDropTile(ghost.x, ghost.y, ghost.dir, reach),
  };
}

/** Outline of a blueprint selection box. */
export const SELECTION_BOX = 0x6fc3ff;

/** A tile rectangle with both corners included (a blueprint selection). */
export interface TileBoxLike {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const ghostKey = (g: Ghost): string =>
  `${String(g.proto.id)}:${String(g.x)}:${String(g.y)}:${String(g.dir)}:${String(g.valid)}:${String(g.mode)}`;

/** Opacity of a ghost's sprite. */
const GHOST_SPRITE_ALPHA = 0.6;

/** The tile a mining drill ghost would drop onto, or `null` for other entities. */
export function ghostDrillDropTile(ghost: Ghost): { x: number; y: number } | null {
  if (ghost.proto.miningTicks === undefined) return null;
  return drillDropTileFor(ghost.proto, ghost.x, ghost.y, ghost.dir);
}

/**
 * The sprite frames of a ghost, in draw order (none without a model): a
 * belt's surface and side frames (and an underground belt's hood, as the
 * entrance or exit it would be), an inserter's base and its arm at rest
 * (`arm`), or a model's idle layers (a splitter's gantry).
 */
export function ghostFrames(
  atlas: SpriteAtlas | null,
  ghost: Ghost,
): { model: ModelSprites; frame: SpriteFrame; arm: boolean }[] {
  const { proto } = ghost;
  if (proto.beltSpeed !== undefined && proto.splitter !== true) {
    const mode = UNDERGROUND_TIER[proto.name]
      ? (ghost.mode ?? UndergroundMode.Entrance)
      : UndergroundMode.None;
    const set = beltSprites(atlas, proto.name, 0, mode);
    if (!set) return [];
    const pick = (model: ModelSprites, layer = model.layers[0]!) => ({
      model,
      frame: layer.frames[modelDirection(model, ghost.dir)]![0]!,
      arm: false,
    });
    const frames = [pick(set.surfaceModel, set.surface), pick(set.frame)];
    if (set.hood) frames.push(pick(set.hood));
    return frames;
  }
  const model = atlas?.model(proto.name) ?? null;
  if (!model) return [];
  const dir = modelDirection(model, ghost.dir);
  return model.layers
    .filter((layer) => layerShown(layer, false))
    .map((layer) => ({ model, frame: layer.frames[dir]![0]!, arm: layer.name === 'arm' }));
}

export class GhostLayer {
  readonly container = new Container({ label: 'ghost' });
  private readonly graphics = new Graphics({ label: 'ghost' });
  /** The ghost's sprite layers, when its entity has a model. */
  private readonly spriteContainer = new Container({ label: 'ghost-sprites' });
  private readonly sprites: Sprite[] = [];
  private atlas: SpriteAtlas | null = null;
  private key = '';

  constructor() {
    this.spriteContainer.alpha = GHOST_SPRITE_ALPHA;
    this.container.addChild(this.spriteContainer, this.graphics);
  }

  /** Shows ghosts of entities that have a model in `atlas` with their sprite. */
  setAtlas(atlas: SpriteAtlas | null): void {
    this.atlas = atlas;
    this.key = '';
  }

  /** Whether the ghost shown is drawn with a sprite. */
  get spriteShown(): boolean {
    return this.sprites.some((s) => s.visible);
  }

  /**
   * Shows `ghost` (a blueprint's several ghosts for an array), or hides the
   * preview for `null`, with the box of a blueprint selection (`box`, tile
   * corners included) when one is being dragged. Cheap when nothing changed.
   */
  draw(ghost: Ghost | readonly Ghost[] | null, box: TileBoxLike | null = null): void {
    const ghosts: readonly Ghost[] = ghost === null ? [] : 'proto' in ghost ? [ghost] : ghost;
    const boxKey = box
      ? `${String(box.x0)}:${String(box.y0)}:${String(box.x1)}:${String(box.y1)}`
      : '';
    const key = `${boxKey}|${ghosts.map(ghostKey).join('|')}`;
    if (key === this.key) {
      return;
    }
    this.key = key;
    const g = this.graphics;
    g.clear();
    for (const s of this.sprites) s.visible = false;
    let used = 0;
    // A single ghost shows its inserter and drill markers; a blueprint's many would only clutter.
    for (const one of ghosts) used = this.drawOne(one, used, ghosts.length === 1);
    if (box) {
      const x = box.x0 * TILE_PX;
      const y = box.y0 * TILE_PX;
      const w = (box.x1 - box.x0 + 1) * TILE_PX;
      const h = (box.y1 - box.y0 + 1) * TILE_PX;
      g.rect(x, y, w, h)
        .fill({ color: SELECTION_BOX, alpha: 0.12 })
        .stroke({ width: 2, color: SELECTION_BOX, alpha: 0.95 });
    }
  }

  /** Draws one ghost with sprites from index `used` on; returns the next free sprite index. */
  private drawOne(ghost: Ghost, used: number, markers: boolean): number {
    const g = this.graphics;
    const { w, h } = footprintSize(ghost.proto, ghost.dir);
    const cx = (ghost.x + w / 2) * TILE_PX;
    const cy = (ghost.y + h / 2) * TILE_PX;
    const frames = ghostFrames(this.atlas, ghost);
    if (frames.length > 0) {
      // The idle sprite, without its shadow.
      for (const { model, frame, arm } of frames) {
        let sprite = this.sprites[used];
        if (!sprite) {
          sprite = new Sprite();
          this.sprites.push(sprite);
          this.spriteContainer.addChild(sprite);
        }
        used++;
        sprite.pivot.set(0, 0);
        sprite.rotation = 0;
        if (arm) {
          const layer = model.layers.find((l) => l.name === 'arm')!;
          const pose = { angle: restAngle(ghost.dir), held: 0 };
          placeArm(model, layer, modelDirection(model, ghost.dir), sprite, null, cx, cy, pose);
        } else {
          placeSprite(sprite, frame, model.scale, cx, cy);
        }
        sprite.visible = true;
      }
    } else {
      drawEntity(g, ghost.proto, ghost.x, ghost.y, ghost.dir, 0.55);
    }
    const tint = ghost.valid ? GHOST_OK : GHOST_BLOCKED;
    g.rect(ghost.x * TILE_PX, ghost.y * TILE_PX, w * TILE_PX, h * TILE_PX)
      .fill({ color: tint, alpha: 0.3 })
      .stroke({ width: 2, color: tint, alpha: 0.9 });
    if (!markers) return used;
    const tiles = ghostInserterTiles(ghost);
    if (tiles) {
      const center = (t: number): number => (t + 0.5) * TILE_PX;
      g.circle(center(tiles.pickup.x), center(tiles.pickup.y), TILE_PX * 0.28).stroke({
        width: 3,
        color: PICKUP_MARKER,
        alpha: 0.9,
      });
      g.circle(center(tiles.drop.x), center(tiles.drop.y), TILE_PX * 0.18).fill({
        color: DROP_MARKER,
        alpha: 0.9,
      });
    }
    const drop = ghostDrillDropTile(ghost);
    if (drop) {
      // Sprites show a drill's facing less boldly than the placeholder's arrow.
      g.circle((drop.x + 0.5) * TILE_PX, (drop.y + 0.5) * TILE_PX, TILE_PX * 0.18).fill({
        color: DROP_MARKER,
        alpha: 0.9,
      });
    }
    return used;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

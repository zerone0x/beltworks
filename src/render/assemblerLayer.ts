/**
 * Draws what is on top of the assembling machines (their bodies and work
 * area are drawn by the entity layer): the icon of the product of the recipe
 * each one is set to (the same icon as on belts and in the inventory, from
 * the snapshot's entity records), and for machines without a sprite model a
 * working animation, a ring of lights around the work area with a bright one
 * chasing around it, one turn per `ASSEMBLER_TURN_SECONDS`, while the machine
 * works (dimmer and at the speed of its power on low power). Idle machines
 * show the ring dark. Machines drawn with sprites animate in their sprite
 * (entitySprites.ts) and show the icon smaller, at their model's `icon`
 * point (over the rotor's hub).
 *
 * Read-only: nothing here flows back into the simulation.
 */

import { Container, Graphics, Sprite } from 'pixi.js';
import { recipePrototype } from '../data/recipes';
import { isAssemblerType } from '../sim/entities/assembler';
import { MachineState } from '../sim/entities/machine';
import { TILE_PX } from './camera';
import { EVERYWHERE, overlaps, type TileRect } from './cull';
import type { EntityIndex, EntityView } from './entityIndex';
import { itemIconAtlas } from './itemIcons';
import { modelDirection, type SpriteAtlas } from './sprites';

/** Seconds per turn of the working animation at full speed. */
export const ASSEMBLER_TURN_SECONDS = 1.5;
/** Lights in the ring around the work area. */
export const ASSEMBLER_LIGHTS = 12;
/** The product icon's scale: 13 texels to 2.5 world pixels each, about a tile. */
const ICON_SCALE = 2.5;
/** On a sprite, over the rotor's hub: about 0.6 tile. */
const SPRITE_ICON_SCALE = 1.5;
const LIGHT_OFF = 0x2a2c30;
const LIGHT_ON = 0x8fe07a;
const LIGHT_LOW = 0xf2c230;

/** The item an assembling machine set to recipe `recipe` shows: its first product, or 0. */
export function assemblerIcon(recipe: number): number {
  return recipePrototype(recipe)?.outputs[0]?.[0] ?? 0;
}

/** How fast the working animation of a machine in state `status` runs: 1, 0.5 on low power, else 0. */
export function assemblerSpeed(status: number): number {
  if (status === MachineState.Working) return 1;
  if (status === MachineState.LowPower) return 0.5;
  return 0;
}

export class AssemblerLayer {
  readonly container = new Container({ label: 'assemblers' });
  private readonly graphics = new Graphics({ label: 'assembler-lights' });
  private readonly icons = new Container({ label: 'assembler-icons' });
  /** Product icons, reused from frame to frame. */
  private readonly sprites: Sprite[] = [];
  /** Whether the lights' graphics hold anything (placeholder machines). */
  private lit = false;
  /** The assembling machines around the view, with their animation angle in turns (0..1). */
  private list: { entity: EntityView; phase: number }[] = [];
  private listed = -1;
  private atlas: SpriteAtlas | null = null;

  constructor() {
    this.container.addChild(this.graphics, this.icons);
  }

  /** Machines that have a model in `atlas` are drawn with sprites from now on. */
  setAtlas(atlas: SpriteAtlas | null): void {
    this.atlas = atlas;
  }

  /** The machines around the view: product item (0 for none) and animation speed. */
  get machines(): readonly { id: number; item: number; speed: number }[] {
    return this.list.map(({ entity }) => ({
      id: entity.id,
      item: assemblerIcon(entity.recipe),
      speed: assemblerSpeed(entity.status),
    }));
  }

  /**
   * Advances the animations by one frame of `dtMs` milliseconds and redraws
   * the machines in the cull rectangle `cull`.
   */
  draw(index: EntityIndex, dtMs: number, cull: TileRect = EVERYWHERE): void {
    if (index.structureVersion !== this.listed) {
      this.listed = index.structureVersion;
      const phases = new Map(this.list.map((m) => [m.entity.id, m.phase]));
      this.list = index.entities
        .filter((e) => isAssemblerType(e.type))
        .map((entity) => ({ entity, phase: phases.get(entity.id) ?? 0 }));
    }
    const g = this.graphics;
    if (this.lit) g.clear();
    this.lit = false;
    const atlas = itemIconAtlas();
    let used = 0;
    for (const m of this.list) {
      const e = m.entity;
      const speed = assemblerSpeed(e.status);
      const turn = (m.phase + (speed * dtMs) / 1000 / ASSEMBLER_TURN_SECONDS) % 1;
      m.phase = turn;
      if (!overlaps(cull, e.x, e.y, e.w, e.h)) continue;
      const item = assemblerIcon(e.recipe);
      let cx = (e.x + e.w / 2) * TILE_PX;
      let cy = (e.y + e.h / 2) * TILE_PX;
      const model = this.atlas?.model(e.proto?.name) ?? null;
      const point = model?.points.icon?.[modelDirection(model, e.dir)];
      if (model && point) {
        cx += point[0] * model.scale;
        cy += point[1] * model.scale;
      }
      const r = TILE_PX * 1.1;
      const lead = Math.floor(turn * ASSEMBLER_LIGHTS);
      for (let k = 0; !model && k < ASSEMBLER_LIGHTS; k++) {
        const a = (k / ASSEMBLER_LIGHTS) * 2 * Math.PI - Math.PI / 2;
        // The lead light is brightest; the two behind it fade out.
        const behind = (lead - k + ASSEMBLER_LIGHTS) % ASSEMBLER_LIGHTS;
        const lit = speed > 0 && behind < 3;
        g.circle(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2.6).fill({
          color: lit ? (speed < 1 ? LIGHT_LOW : LIGHT_ON) : LIGHT_OFF,
          alpha: lit ? 1 - behind * 0.3 : 1,
        });
        this.lit = true;
      }
      if (item === 0) continue;
      let sprite = this.sprites[used];
      if (!sprite) {
        sprite = new Sprite();
        sprite.anchor.set(0.5);
        this.sprites.push(sprite);
        this.icons.addChild(sprite);
      }
      sprite.scale.set(model ? SPRITE_ICON_SCALE : ICON_SCALE);
      const texture = atlas.texture(item);
      if (sprite.texture !== texture) sprite.texture = texture;
      sprite.position.set(cx, cy);
      sprite.visible = true;
      used++;
    }
    for (let i = used; i < this.sprites.length; i++) this.sprites[i]!.visible = false;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

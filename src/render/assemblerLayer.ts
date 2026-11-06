/**
 * Draws what is on top of the assembling machines (their bodies and work
 * area are drawn by the entity layer): the icon of the product of the recipe
 * each one is set to (the same icon as on belts and in the inventory, from
 * the snapshot's entity records), and a working animation, a ring of lights
 * around the work area with a bright one chasing around it, one turn per
 * `ASSEMBLER_TURN_SECONDS`, while the machine works (dimmer and at the speed
 * of its power on low power). Idle machines show the ring dark.
 *
 * Read-only: nothing here flows back into the simulation.
 */

import { Container, Graphics, Sprite } from 'pixi.js';
import { recipePrototype } from '../data/recipes';
import { isAssemblerType } from '../sim/entities/assembler';
import { MachineState } from '../sim/entities/machine';
import { TILE_PX } from './camera';
import type { EntityIndex } from './entityIndex';
import { itemIconAtlas } from './itemIcons';

/** Seconds per turn of the working animation at full speed. */
export const ASSEMBLER_TURN_SECONDS = 1.5;
/** Lights in the ring around the work area. */
export const ASSEMBLER_LIGHTS = 12;
/** The product icon's scale: 13 texels to 2.5 world pixels each, about a tile. */
const ICON_SCALE = 2.5;
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
  /** Animation angle per machine id, in turns (0..1). */
  private readonly phase = new Map<number, number>();
  private shown: { id: number; item: number; speed: number }[] = [];

  constructor() {
    this.container.addChild(this.graphics, this.icons);
  }

  /** The machines drawn last: product item (0 for none) and animation speed. */
  get machines(): readonly { id: number; item: number; speed: number }[] {
    return this.shown;
  }

  /** Advances the animations by one frame of `dtMs` milliseconds and redraws. */
  draw(index: EntityIndex, dtMs: number): void {
    const g = this.graphics;
    g.clear();
    const atlas = itemIconAtlas();
    const seen = new Set<number>();
    const shown: { id: number; item: number; speed: number }[] = [];
    let used = 0;
    for (const e of index.entities) {
      if (!isAssemblerType(e.type)) continue;
      seen.add(e.id);
      const speed = assemblerSpeed(e.status);
      const turn =
        ((this.phase.get(e.id) ?? 0) + (speed * dtMs) / 1000 / ASSEMBLER_TURN_SECONDS) % 1;
      this.phase.set(e.id, turn);
      const item = assemblerIcon(e.recipe);
      shown.push({ id: e.id, item, speed });
      const cx = (e.x + e.w / 2) * TILE_PX;
      const cy = (e.y + e.h / 2) * TILE_PX;
      const r = TILE_PX * 1.1;
      const lead = Math.floor(turn * ASSEMBLER_LIGHTS);
      for (let k = 0; k < ASSEMBLER_LIGHTS; k++) {
        const a = (k / ASSEMBLER_LIGHTS) * 2 * Math.PI - Math.PI / 2;
        // The lead light is brightest; the two behind it fade out.
        const behind = (lead - k + ASSEMBLER_LIGHTS) % ASSEMBLER_LIGHTS;
        const lit = speed > 0 && behind < 3;
        g.circle(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 2.6).fill({
          color: lit ? (speed < 1 ? LIGHT_LOW : LIGHT_ON) : LIGHT_OFF,
          alpha: lit ? 1 - behind * 0.3 : 1,
        });
      }
      if (item === 0) continue;
      let sprite = this.sprites[used];
      if (!sprite) {
        sprite = new Sprite();
        sprite.anchor.set(0.5);
        sprite.scale.set(ICON_SCALE);
        this.sprites.push(sprite);
        this.icons.addChild(sprite);
      }
      sprite.texture = atlas.texture(item);
      sprite.position.set(cx, cy);
      sprite.visible = true;
      used++;
    }
    for (let i = used; i < this.sprites.length; i++) this.sprites[i]!.visible = false;
    for (const id of [...this.phase.keys()]) {
      if (!seen.has(id)) this.phase.delete(id);
    }
    this.shown = shown;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

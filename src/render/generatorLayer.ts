/**
 * Animates the steam engines: each one gets a flywheel, drawn above the
 * buildings near its rear end, that turns at a speed proportional to the
 * energy the engine delivered on the latest tick (from the snapshot's power
 * records, `encodePower`): one turn per second at its maximum output, still
 * when it delivers nothing. Engines with a sprite model (sprites.ts) turn
 * the flywheel of their sprite instead: the entity sprite layer asks
 * `speed` for its animation speed, so it runs at the same rate.
 *
 * Read-only: nothing here flows back into the simulation.
 */

import { Container, Graphics } from 'pixi.js';
import { ENTITIES, EntityTypeId } from '../data/entities';
import type { PowerData } from '../sim/snapshot';
import { TILE_PX } from './camera';
import { EVERYWHERE, overlaps, type TileRect } from './cull';
import type { EntityIndex, EntityView } from './entityIndex';
import type { SpriteAtlas } from './sprites';

/** Flywheel turns per second at full output. */
export const FLYWHEEL_TURNS_PER_SECOND = 1;
const WHEEL_RIM = 0x2c3438;
const WHEEL_SPOKE = 0xc9d3d6;
const WHEEL_HUB = 0xe8c25a;
const ENGINE_MAX_OUTPUT = ENTITIES[EntityTypeId.SteamEngine].maxOutputPerTick ?? 0;

/** How fast a steam engine runs: what it delivered over its maximum, 0..1. */
export function engineSpeed(drawn: number, maxOutput: number): number {
  return maxOutput > 0 ? Math.min(1, drawn / maxOutput) : 0;
}

export class GeneratorLayer {
  readonly container = new Container({ label: 'generators' });
  private readonly graphics = new Graphics({ label: 'flywheels' });
  /** The steam engines around the view, with their speed (0..1) and flywheel angle (turns). */
  private list: { entity: EntityView; speed: number; phase: number }[] = [];
  private readonly byId = new Map<number, { speed: number }>();
  private listed = -1;
  /** Power delivered per engine id, as of the power data last seen. */
  private drawnById = new Map<number, number>();
  private power: PowerData | null = null;
  /** Whether the flywheels' graphics hold anything (placeholder engines). */
  private wheels = false;
  private atlas: SpriteAtlas | null = null;

  constructor() {
    this.container.addChild(this.graphics);
  }

  /** Speed (0..1) and flywheel angle (turns) per steam engine around the view. */
  get engines(): { id: number; speed: number; phase: number }[] {
    return this.list.map((e) => ({ id: e.entity.id, speed: e.speed, phase: e.phase }));
  }

  /** Engines get a placeholder flywheel only without a model in `atlas`. */
  setAtlas(atlas: SpriteAtlas | null): void {
    this.atlas = atlas;
  }

  /** How fast steam engine `id` runs (0..1) as of the latest frame, or `null` if it isn't around. */
  speed(id: number): number | null {
    return this.byId.get(id)?.speed ?? null;
  }

  /**
   * Advances every flywheel by one frame of `dtMs` milliseconds, and redraws
   * the placeholder ones in the cull rectangle `cull`.
   */
  draw(index: EntityIndex, power: PowerData, dtMs: number, cull: TileRect = EVERYWHERE): void {
    if (index.structureVersion !== this.listed) {
      this.listed = index.structureVersion;
      const old = new Map(this.list.map((e) => [e.entity.id, e]));
      this.list = index.entities
        .filter((e) => e.type === EntityTypeId.SteamEngine)
        .map((entity) => ({ entity, speed: 0, phase: old.get(entity.id)?.phase ?? 0 }));
      this.byId.clear();
      for (const e of this.list) this.byId.set(e.entity.id, e);
    }
    if (power !== this.power) {
      this.power = power;
      this.drawnById = new Map(power.members.map((m) => [m.id, m.drawn]));
    }
    const g = this.graphics;
    if (this.wheels) g.clear();
    this.wheels = false;
    for (const engine of this.list) {
      const e = engine.entity;
      const speed = engineSpeed(this.drawnById.get(e.id) ?? 0, ENGINE_MAX_OUTPUT);
      engine.speed = speed;
      const step = (speed * FLYWHEEL_TURNS_PER_SECOND * dtMs) / 1000;
      const turn = (engine.phase + step) % 1;
      engine.phase = turn;
      if (this.atlas?.model(e.proto?.name)) continue;
      if (!overlaps(cull, e.x, e.y, e.w, e.h)) continue;
      this.wheels = true;
      // 1.4 tiles behind the center, along the engine's long axis (it faces along it).
      const ux = [0, 1, 0, -1][e.dir]!;
      const uy = [-1, 0, 1, 0][e.dir]!;
      const cx = (e.x + e.w / 2 - ux * 1.4) * TILE_PX;
      const cy = (e.y + e.h / 2 - uy * 1.4) * TILE_PX;
      const r = TILE_PX * 0.9;
      g.circle(cx, cy, r).stroke({ width: 4, color: WHEEL_RIM });
      for (let k = 0; k < 3; k++) {
        const a = (turn + k / 3) * 2 * Math.PI;
        g.moveTo(cx, cy)
          .lineTo(cx + Math.cos(a) * (r - 2), cy + Math.sin(a) * (r - 2))
          .stroke({ width: 3, color: WHEEL_SPOKE });
      }
      g.circle(cx, cy, 4).fill({ color: speed > 0 ? WHEEL_HUB : WHEEL_RIM });
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

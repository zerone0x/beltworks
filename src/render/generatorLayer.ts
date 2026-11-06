/**
 * Animates the steam engines: each one gets a flywheel, drawn above the
 * buildings near its rear end, that turns at a speed proportional to the
 * energy the engine delivered on the latest tick (from the snapshot's power
 * records, `encodePower`): one turn per second at its maximum output, still
 * when it delivers nothing.
 *
 * Read-only: nothing here flows back into the simulation.
 */

import { Container, Graphics } from 'pixi.js';
import { ENTITIES, EntityTypeId } from '../data/entities';
import type { PowerData } from '../sim/snapshot';
import { TILE_PX } from './camera';
import type { EntityIndex } from './entityIndex';

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
  /** Flywheel angle per engine id, in turns (0..1). */
  private readonly phase = new Map<number, number>();
  /** Speed per engine id as of the latest snapshot. */
  private readonly speeds = new Map<number, number>();

  constructor() {
    this.container.addChild(this.graphics);
  }

  /** Speed (0..1) and flywheel angle (turns) per steam engine around the view. */
  get engines(): { id: number; speed: number; phase: number }[] {
    return [...this.speeds].map(([id, speed]) => ({ id, speed, phase: this.phase.get(id) ?? 0 }));
  }

  /** Advances and redraws every flywheel by one frame of `dtMs` milliseconds. */
  draw(index: EntityIndex, power: PowerData, dtMs: number): void {
    const drawnById = new Map(power.members.map((m) => [m.id, m.drawn]));
    const g = this.graphics;
    g.clear();
    const seen = new Set<number>();
    for (const e of index.entities) {
      if (e.type !== EntityTypeId.SteamEngine) continue;
      seen.add(e.id);
      const speed = engineSpeed(drawnById.get(e.id) ?? 0, ENGINE_MAX_OUTPUT);
      this.speeds.set(e.id, speed);
      const step = (speed * FLYWHEEL_TURNS_PER_SECOND * dtMs) / 1000;
      const turn = ((this.phase.get(e.id) ?? 0) + step) % 1;
      this.phase.set(e.id, turn);
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
    for (const id of [...this.phase.keys()]) {
      if (!seen.has(id)) {
        this.phase.delete(id);
        this.speeds.delete(id);
      }
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

/**
 * Dev and test builds only: the scenes the render profile can draw
 * (docs/TOOLING.md, "Render profile"), picked with `?scene=`:
 *
 * - The benchmark scenes (`1k`, `power`, `m3`, `10k`, `50k`; tools/bench/scenes/),
 *   built by the worker through commands at start, exactly as the benchmark
 *   builds them (a second or two for `10k`), and then simulated as usual.
 * - A grid factory (`grid-1k`, `grid-10k`, this file): a scripted scene with
 *   no simulation behind it, ready at once, every belt full and every
 *   machine working. The worker still runs the real simulation for the
 *   player and the terrain, but sends this scene's entities, belts,
 *   inserters and power grid in every snapshot instead of the simulation's:
 *   the same buffers `encodeEntities`,
 * `encodeBelts`, `encodeInserters` and `encodePower` write (src/sim/snapshot.ts),
 * filtered to the snapshot's chunk window the same way, so the main thread
 * decodes and draws them exactly as it would a real factory.
 *
 * The scene is a grid of identical blocks (`BLOCK_W` × `BLOCK_H` tiles). Each
 * block has a two-row belt loop full of items (8 per belt, both lanes,
 * moving at the belt's tier speed; tiers rotate yellow, red, blue, and every
 * other block's loop dives through an underground pair), inserters of every
 * type swinging from the loop into six assembling machines and from those
 * into six stone furnaces, three electric poles wired to their neighbours,
 * and a boiler with a steam engine. `grid-10k` is 12 × 11 blocks: 10 032
 * entities and 49 632 items on belts, the M4 target scene
 * (docs/ARCHITECTURE.md, "Performance targets").
 *
 * Everything moves as a pure function of the tick (no state), so the scene
 * costs the worker one pass over its entities per snapshot and never
 * touches the simulation: the determinism hash can't change.
 */

import { EntityTypeId, SAT_ONE, entityPrototype } from '../data/entities';
import { ItemId } from '../data/items';
import { RecipeId } from '../data/recipes';
import { BeltShape } from '../sim/belts/belts';
import { BELT_LENGTH } from '../sim/belts/line';
import { UndergroundMode } from '../sim/belts/underground';
import { Direction } from '../sim/entities/direction';
import { MachineState } from '../sim/entities/machine';
import {
  BELT_ITEM_STRIDE,
  BELT_STRIDE,
  packBeltItem,
  ENTITY_STRIDE,
  INSERTER_STRIDE,
  MEMBER_STRIDE,
} from '../sim/snapshot';
import { CHUNK_SHIFT } from '../sim/world/chunk';
import type { ChunkRect } from './protocol';

/** Block size in tiles. */
export const BLOCK_W = 28;
export const BLOCK_H = 10;
/** Belts per row of a block's loop. */
const LOOP_W = 24;
/** Items per lane of a full belt: one every 64 subtiles. */
const ITEMS_PER_LANE = 4;
const ITEM_SPACING = BELT_LENGTH / ITEMS_PER_LANE;
/** First synthetic entity id, far above anything the simulation hands out in a test. */
const FIRST_ID = 0x4000_0000;
/** The scene's one power network id. */
const NETWORK = 1;

/** Grid scene sizes: blocks across and down. */
export const GRID_SCENES: Readonly<Record<string, { cols: number; rows: number }>> = {
  'grid-1k': { cols: 4, rows: 3 },
  'grid-10k': { cols: 12, rows: 11 },
};

/** The benchmark scenes (tools/bench/scenes/index.ts) by name. */
export const BENCH_SCENES: readonly string[] = ['1k', 'power', 'm3', '10k', '50k'];

/** Whether `name` is a grid scene. */
export function isGridScene(name: unknown): boolean {
  return typeof name === 'string' && Object.hasOwn(GRID_SCENES, name);
}

/** Whether `name` is a known render scene: a benchmark scene or a grid. */
export function isRenderScene(name: unknown): boolean {
  return isGridScene(name) || (typeof name === 'string' && BENCH_SCENES.includes(name));
}

interface SceneEntity {
  id: number;
  type: number;
  x: number;
  y: number;
  dir: number;
  /** Chunk of the origin, for the window filter. */
  cx: number;
  cy: number;
  recipe: number;
  /** Belts: shape, mode, speed and the item they carry. */
  shape: number;
  mode: number;
  speed: number;
  item: number;
  /** Inserters: arm units per tick and swing ticks; poles: wired neighbours (ids). */
  armScale: number;
  swingTicks: number;
  wires: number[];
}

const BELT_TIERS = [
  { belt: EntityTypeId.TransportBelt, underground: EntityTypeId.UndergroundBelt },
  { belt: EntityTypeId.FastTransportBelt, underground: EntityTypeId.FastUndergroundBelt },
  { belt: EntityTypeId.ExpressTransportBelt, underground: EntityTypeId.ExpressUndergroundBelt },
] as const;
const INSERTERS = [
  EntityTypeId.BurnerInserter,
  EntityTypeId.ElectricInserter,
  EntityTypeId.FastInserter,
  EntityTypeId.LongHandedInserter,
] as const;
const LOOP_ITEMS = [
  ItemId.IronPlate,
  ItemId.CopperCable,
  ItemId.IronGearWheel,
  ItemId.CopperPlate,
  ItemId.ElectronicCircuit,
  ItemId.Coal,
] as const;
const RECIPES = [
  RecipeId.IronGearWheel,
  RecipeId.CopperCable,
  RecipeId.ElectronicCircuit,
  RecipeId.TransportBelt,
] as const;

export class RenderScene {
  readonly entities: SceneEntity[] = [];
  /** Belt items in the whole scene. */
  readonly items: number;

  constructor(readonly name: string) {
    const size = GRID_SCENES[name];
    if (!size) throw new Error(`unknown grid scene "${name}"`);
    // Centered on the spawn.
    const x0 = -Math.floor((size.cols * BLOCK_W) / 2);
    const y0 = -Math.floor((size.rows * BLOCK_H) / 2);
    const poles: number[][] = [];
    for (let row = 0; row < size.rows; row++) {
      poles.push([]);
      for (let col = 0; col < size.cols; col++) {
        const ids = this.block(row * size.cols + col, x0 + col * BLOCK_W, y0 + row * BLOCK_H);
        poles[row]!.push(...ids);
      }
    }
    // Wire each pole to the next one in its row and to the one below it.
    poles.forEach((rowPoles, row) => {
      rowPoles.forEach((id, i) => {
        const next = rowPoles[i + 1];
        const below = poles[row + 1]?.[i];
        const pole = this.entities[id - FIRST_ID]!;
        if (next !== undefined) pole.wires.push(next);
        if (below !== undefined) pole.wires.push(below);
      });
    });
    let items = 0;
    for (const e of this.entities) {
      if (e.speed > 0) items += 2 * ITEMS_PER_LANE;
    }
    this.items = items;
  }

  private add(type: number, x: number, y: number, dir: number, extra: Partial<SceneEntity> = {}) {
    const id = FIRST_ID + this.entities.length;
    this.entities.push({
      id,
      type,
      x,
      y,
      dir,
      cx: x >> CHUNK_SHIFT,
      cy: y >> CHUNK_SHIFT,
      recipe: 0,
      shape: BeltShape.Straight,
      mode: UndergroundMode.None,
      speed: 0,
      item: 0,
      armScale: 0,
      swingTicks: 0,
      wires: [],
      ...extra,
    });
    return id;
  }

  /** Adds block number `n` with its top-left tile at `(bx, by)`; returns its poles' ids. */
  private block(n: number, bx: number, by: number): number[] {
    const tier = BELT_TIERS[n % BELT_TIERS.length]!;
    const speed = entityPrototype(tier.belt)!.beltSpeed!;
    const item = LOOP_ITEMS[n % LOOP_ITEMS.length]!;
    const belt = (x: number, y: number, dir: number, shape: number = BeltShape.Straight) =>
      this.add(tier.belt, bx + x, by + y, dir, { shape, speed, item });
    // A clockwise loop: east along row 0, west along row 1, a curve at each corner.
    belt(0, 0, Direction.East, BeltShape.CurveFromRight);
    for (let x = 1; x < LOOP_W - 1; x++) belt(x, 0, Direction.East);
    belt(LOOP_W - 1, 0, Direction.South, BeltShape.CurveFromRight);
    belt(LOOP_W - 1, 1, Direction.West, BeltShape.CurveFromRight);
    const tunnel = n % 2 === 1;
    for (let x = LOOP_W - 2; x >= 1; x--) {
      // Every other block dives under tiles 8 and 9 of its lower row.
      if (tunnel && (x === 8 || x === 9)) continue;
      if (tunnel && (x === 10 || x === 7)) {
        const mode = x === 10 ? UndergroundMode.Entrance : UndergroundMode.Exit;
        this.add(tier.underground, bx + x, by + 1, Direction.West, { mode, speed, item });
        continue;
      }
      belt(x, 1, Direction.West);
    }
    belt(0, 1, Direction.North, BeltShape.CurveFromRight);
    // Six assembling machines under the loop, each with an inserter feeding it
    // from the loop and one taking its product down into a stone furnace.
    for (let k = 0; k < 6; k++) {
      const x = 1 + 4 * k;
      const recipe = RECIPES[(n + k) % RECIPES.length]!;
      const machine =
        k % 2 === 0 ? EntityTypeId.AssemblingMachine1 : EntityTypeId.AssemblingMachine2;
      this.add(machine, bx + x, by + 3, Direction.North, { recipe });
      for (const y of [2, 6]) {
        const type = INSERTERS[(n + k + y) % INSERTERS.length]!;
        const proto = entityPrototype(type)!;
        this.add(type, bx + x + 1, by + y, Direction.South, {
          armScale: type === EntityTypeId.BurnerInserter ? 1 : SAT_ONE,
          swingTicks: proto.swingTicks!,
          item,
        });
      }
      this.add(EntityTypeId.StoneFurnace, bx + x, by + 7, Direction.North);
    }
    const poles = [4, 12, 20].map((x) =>
      this.add(EntityTypeId.SmallElectricPole, bx + x, by + 4, Direction.North),
    );
    // A boiler and a steam engine beside the machines.
    this.add(EntityTypeId.SteamEngine, bx + 24, by + 2, Direction.North);
    this.add(EntityTypeId.Boiler, bx + 24, by + 7, Direction.East);
    return poles;
  }

  /** Machine state of entity `e` at tick `tick`: mostly working, some changing every few seconds. */
  private status(e: SceneEntity, tick: number): number {
    if (e.speed > 0 || e.type === EntityTypeId.SmallElectricPole) return MachineState.Idle;
    if (e.armScale > 0) return MachineState.Working;
    // One machine in five pauses for 2 s of every 8 s, at its own time.
    if (e.id % 5 === 0 && (tick + e.id * 37) % 480 < 120) return MachineState.NoInput;
    return MachineState.Working;
  }

  private inWindow(e: SceneEntity, w: ChunkRect): boolean {
    return e.cx >= w.cx0 && e.cx <= w.cx1 && e.cy >= w.cy0 && e.cy <= w.cy1;
  }

  /** `encodeEntities` of the scene at tick `tick`. */
  encodeEntities(window: ChunkRect | null, tick: number): Int32Array<ArrayBuffer> {
    if (!window) return new Int32Array(0);
    const out: number[] = [];
    for (const e of this.entities) {
      if (!this.inWindow(e, window)) continue;
      out.push(e.id, e.type, e.x, e.y, e.dir, this.status(e, tick), e.recipe);
    }
    return check(Int32Array.from(out), ENTITY_STRIDE);
  }

  /** `encodeBelts` of the scene at tick `tick`: every belt full, moving at its speed. */
  encodeBelts(window: ChunkRect | null, tick: number): Int32Array<ArrayBuffer> {
    if (!window) return new Int32Array(1);
    const belts = this.entities.filter((e) => e.speed > 0 && this.inWindow(e, window));
    const perBelt = 2 * ITEMS_PER_LANE;
    const out = new Int32Array(1 + belts.length * (BELT_STRIDE + 1 + perBelt * BELT_ITEM_STRIDE));
    out[0] = belts.length;
    const counts = 1 + belts.length * BELT_STRIDE;
    let o = counts + belts.length;
    belts.forEach((b, i) => {
      out.set([b.x, b.y, b.dir, b.shape, b.type, b.mode], 1 + i * BELT_STRIDE);
      out[counts + i] = perBelt;
      // Offsets count down to the belt's end edge; items wrap onto the next belt.
      const front = (((b.id * 29 - tick * b.speed) % ITEM_SPACING) + ITEM_SPACING) % ITEM_SPACING;
      for (let lane = 0; lane < 2; lane++) {
        for (let k = 0; k < ITEMS_PER_LANE; k++) {
          out[o] = front + k * ITEM_SPACING;
          out[o + 1] = packBeltItem(lane, b.speed, b.item);
          o += BELT_ITEM_STRIDE;
        }
      }
    });
    return out;
  }

  /** `encodeInserters` of the scene at tick `tick`: every arm swinging, full on the way out. */
  encodeInserters(window: ChunkRect | null, tick: number): Int32Array<ArrayBuffer> {
    if (!window) return new Int32Array(1);
    const list = this.entities.filter((e) => e.armScale > 0 && this.inWindow(e, window));
    const out = new Int32Array(1 + list.length * INSERTER_STRIDE);
    out[0] = list.length;
    list.forEach((e, i) => {
      const period = 2 * e.swingTicks;
      const t = (tick + e.id * 7) % period;
      const out1 = t < e.swingTicks;
      const arm = (out1 ? t : period - t) * e.armScale;
      out.set(
        [
          e.x,
          e.y,
          e.dir,
          arm,
          out1 ? e.item : 0,
          out1 ? e.armScale : -e.armScale,
          e.swingTicks * e.armScale,
          e.type,
        ],
        1 + i * INSERTER_STRIDE,
      );
    });
    return out;
  }

  /** `encodePower` of the scene: its poles, their wires, one network, its engines and consumers. */
  encodePower(window: ChunkRect | null): Int32Array<ArrayBuffer> {
    if (!window) return new Int32Array(4);
    const inside = this.entities.filter((e) => this.inWindow(e, window));
    const poles = inside.filter((e) => e.type === EntityTypeId.SmallElectricPole);
    const ids = new Set(poles.map((p) => p.id));
    const out: number[] = [poles.length];
    for (const p of poles) out.push(p.id, p.type, p.x, p.y, NETWORK);
    const wires: number[] = [];
    for (const p of poles) for (const n of p.wires) if (ids.has(n)) wires.push(p.id, n);
    out.push(wires.length / 2, ...wires);
    out.push(poles.length > 0 ? 1 : 0);
    if (poles.length > 0) out.push(NETWORK, poles.length, 900_000, 1_200_000, SAT_ONE);
    const engine = entityPrototype(EntityTypeId.SteamEngine)!.maxOutputPerTick!;
    const members: number[] = [];
    for (const e of inside) {
      if (e.type === EntityTypeId.SteamEngine)
        members.push(e.id, NETWORK, 0, engine, (engine * 3) >> 2);
      else if (e.recipe !== 0 || e.armScale === SAT_ONE) members.push(e.id, NETWORK, 1500, 0, 1500);
    }
    out.push(members.length / MEMBER_STRIDE, ...members);
    return Int32Array.from(out);
  }
}

function check(out: Int32Array<ArrayBuffer>, stride: number): Int32Array<ArrayBuffer> {
  if (out.length % stride !== 0) throw new Error('bad record stride');
  return out;
}

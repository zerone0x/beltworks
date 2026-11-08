/**
 * The map's flat colours, one texel per tile, kept per chunk: what map mode
 * (mapLayer.ts) and the minimap (src/ui/minimap.ts) draw.
 *
 * Built only from what the main thread already has: the chunk data of each
 * snapshot (terrain, ore, trees) and the entities around the view
 * (`EntityIndex`, belts included). Updates are incremental: a chunk's
 * colours are rebuilt only when its chunk data arrives or changes, or when
 * the entities over it change (a per-chunk signature of their ids, types,
 * places and directions, compared on each structural change of the index),
 * a few chunks per frame.
 *
 * Chunks that leave the snapshot's chunk window keep their last colours (the
 * explored map) but no longer get updates; at most `MAX_MAP_CHUNKS` are kept
 * (4 KiB each), the ones furthest from the window going first, so memory
 * stays bounded however far the player travels.
 */

import { RESOURCES, type OreId } from '../data/resources';
import { TILES } from '../data/tiles';
import { TREE_CANOPY_COLOR } from '../data/trees';
import type { ChunkData } from '../sim/snapshot';
import { CHUNK_AREA, CHUNK_SHIFT, CHUNK_SIZE } from '../sim/world/chunk';
import { chunkKey } from '../sim/world/world';
import { rectContains, type ChunkRect } from '../worker/protocol';
import { MISSING_COLOR } from './chunkBake';
import type { EntityIndex, EntityView } from './entityIndex';

/** Bytes of one chunk's colours: RGBA, one texel per tile. */
export const MAP_CHUNK_BYTES = CHUNK_AREA * 4;
/** Most chunks whose colours are kept (4 MiB): the window plus what was explored around it. */
export const MAX_MAP_CHUNKS = 1024;
/** Chunks whose colours are rebuilt per frame, at most (a few µs each, more with many entities). */
export const MAP_BUILDS_PER_FRAME = 16;

/** How strongly an ore tile is tinted towards the ore colour, out of 256 (stronger than the placeholder terrain's: it must read at a texel per tile). */
const ORE_TINT = 184;
/** A tree tile: the canopy colour, a bit darker so forests read as a mass. */
const TREE_COLOR = shade(TREE_CANOPY_COLOR, 216);
/** Entity footprints: the right column and bottom row of a footprint are darkened by this, out of 256, so neighbours stay apart. */
const EDGE_SHADE = 168;

function shade(c: number, t256: number): number {
  return (
    (((((c >> 16) & 0xff) * t256) >> 8) << 16) |
    (((((c >> 8) & 0xff) * t256) >> 8) << 8) |
    (((c & 0xff) * t256) >> 8)
  );
}

function mix(a: number, b: number, t256: number): number {
  const ch = (s: number): number => {
    const ca = (a >> s) & 0xff;
    const cb = (b >> s) & 0xff;
    return (ca + (((cb - ca) * t256) >> 8)) << s;
  };
  return ch(16) | ch(8) | ch(0);
}

/** The map colour (0xRRGGBB) of a tile without an entity. */
export function mapTileColor(terrain: number, resource: number, tree: number): number {
  if (tree === 1) return TREE_COLOR;
  const ground = TILES[terrain]?.color ?? MISSING_COLOR;
  if (resource === 0) return ground;
  return mix(ground, RESOURCES[resource as OreId]?.color ?? MISSING_COLOR, ORE_TINT);
}

/**
 * The map colour of tile `(dx, dy)` of an entity's `w` × `h` footprint: its
 * prototype's colour, darker on the right column and bottom row of
 * footprints larger than a tile.
 */
export function mapEntityColor(e: EntityView, dx: number, dy: number): number {
  const color = e.proto?.color ?? MISSING_COLOR;
  const edge = (e.w > 1 && dx === e.w - 1) || (e.h > 1 && dy === e.h - 1);
  return edge ? shade(color, EDGE_SHADE) : color;
}

/** Whether this machine stores multi-byte numbers little-endian (every browser in practice). */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** An opaque 0xRRGGBB as the uint32 whose bytes in memory are R, G, B, 255. */
function rgba(color: number): number {
  const r = (color >> 16) & 0xff;
  const g = (color >> 8) & 0xff;
  const b = color & 0xff;
  return LITTLE_ENDIAN
    ? ((0xff << 24) | (b << 16) | (g << 8) | r) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0;
}

/**
 * Tile colours as `rgba` words for terrain and resource ids below 16, by
 * `tree << 8 | resource << 4 | terrain` (0: not computed yet), so a chunk
 * costs a table read per tile.
 */
const TILE_RGBA = new Uint32Array(512);

function tileRgba(terrain: number, resource: number, tree: number): number {
  if (terrain >= 16 || resource >= 16 || tree > 1) {
    return rgba(mapTileColor(terrain, resource, tree));
  }
  const i = (tree << 8) | (resource << 4) | terrain;
  return (TILE_RGBA[i] ||= rgba(mapTileColor(terrain, resource, tree)));
}

/**
 * Writes the map colours of `data` with `entities` (any that overlap the
 * chunk; the rest of their footprints is clipped) into `out`: RGBA, one
 * texel per tile, row-major.
 */
export function mapChunkPixels(
  data: ChunkData,
  entities: readonly EntityView[],
  out: Uint8Array = new Uint8Array(MAP_CHUNK_BYTES),
): Uint8Array {
  if (out.length !== MAP_CHUNK_BYTES || out.byteOffset % 4 !== 0) {
    throw new RangeError('output buffer has the wrong size or alignment');
  }
  const words = new Uint32Array(out.buffer, out.byteOffset, CHUNK_AREA);
  const { terrain, resource, tree } = data;
  const table = TILE_RGBA;
  for (let i = 0; i < CHUNK_AREA; i++) {
    const t = terrain[i]!;
    const r = resource[i]!;
    const tr = tree[i]!;
    const key = (tr << 8) | (r << 4) | t;
    const c = (t | r) < 16 && tr <= 1 ? table[key]! : 0;
    words[i] = c !== 0 ? c : tileRgba(t, r, tr);
  }
  const x0 = data.cx << CHUNK_SHIFT;
  const y0 = data.cy << CHUNK_SHIFT;
  for (const e of entities) {
    const tx0 = Math.max(e.x, x0);
    const ty0 = Math.max(e.y, y0);
    const tx1 = Math.min(e.x + e.w, x0 + CHUNK_SIZE);
    const ty1 = Math.min(e.y + e.h, y0 + CHUNK_SIZE);
    for (let ty = ty0; ty < ty1; ty++) {
      for (let tx = tx0; tx < tx1; tx++) {
        words[(ty - y0) * CHUNK_SIZE + (tx - x0)] = rgba(mapEntityColor(e, tx - e.x, ty - e.y));
      }
    }
  }
  return out;
}

/** One chunk of the map. */
export interface MapChunk {
  readonly cx: number;
  readonly cy: number;
  /** RGBA, one texel per tile (`MAP_CHUNK_BYTES`). */
  readonly pixels: Uint8Array<ArrayBuffer>;
  /** Bumped every time `pixels` is rebuilt (1 after the first build, 0 before). */
  version: number;
  /** The chunk's data while it is in the window (else `null`: no more updates). */
  data: ChunkData | null;
  /** Whether `pixels` is out of date with `data` or the entities over the chunk. */
  dirty: boolean;
}

/** An order-independent signature of the entities over one chunk. */
function entitySignature(e: EntityView): number {
  let h = Math.imul(e.id ^ 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (e.type + (e.dir << 16)), 0xc2b2ae35);
  h = Math.imul(h ^ e.x, 0x27d4eb2d) ^ Math.imul(e.y, 0x165667b1);
  return (h ^ (h >>> 15)) >>> 0;
}

export class MapStore {
  private readonly chunks = new Map<number, MapChunk>();
  private window: ChunkRect | null = null;
  /** Entities over each chunk of the window, from the latest structural change. */
  private buckets = new Map<number, EntityView[]>();
  private signatures = new Map<number, number>();
  private entityStructure = -1;
  /** Bumped whenever a chunk's colours change or a chunk is dropped: readers redraw when it moves. */
  version = 0;
  /** Chunks rebuilt so far (tests and the render profile). */
  buildCount = 0;

  constructor(private readonly maxChunks: number = MAX_MAP_CHUNKS) {}

  /** Takes the chunk part of a snapshot: the window, and the chunks that arrived (decoded by the terrain layer). */
  applyChunks(window: ChunkRect | null, arrived: readonly ChunkData[]): void {
    if (window !== null) {
      this.window = window;
      for (const c of this.chunks.values()) {
        if (c.data && !rectContains(window, c.cx, c.cy)) {
          // Out of the window: keep the colours (explored), drop the data.
          c.data = null;
          c.dirty = false;
        }
      }
    }
    for (const data of arrived) {
      const key = chunkKey(data.cx, data.cy);
      let c = this.chunks.get(key);
      if (!c || c.cx !== data.cx || c.cy !== data.cy) {
        c = {
          cx: data.cx,
          cy: data.cy,
          pixels: new Uint8Array(MAP_CHUNK_BYTES),
          version: 0,
          data: null,
          dirty: true,
        };
        this.chunks.set(key, c);
      }
      c.data = data;
      c.dirty = true;
    }
    if (this.chunks.size > this.maxChunks + (this.maxChunks >> 3)) this.evict();
  }

  /**
   * Takes the entities of a snapshot; only a structural change
   * (`structureVersion`) can change the map. Only chunks in the window are
   * marked for a rebuild: the explored ones outside keep what they showed.
   */
  applyEntities(index: EntityIndex): void {
    if (index.structureVersion === this.entityStructure) return;
    this.entityStructure = index.structureVersion;
    const buckets = new Map<number, EntityView[]>();
    const signatures = new Map<number, number>();
    for (const e of index.entities) {
      const cx0 = e.x >> CHUNK_SHIFT;
      const cy0 = e.y >> CHUNK_SHIFT;
      const cx1 = (e.x + e.w - 1) >> CHUNK_SHIFT;
      const cy1 = (e.y + e.h - 1) >> CHUNK_SHIFT;
      const sig = entitySignature(e);
      for (let cy = cy0; cy <= cy1; cy++) {
        for (let cx = cx0; cx <= cx1; cx++) {
          const key = chunkKey(cx, cy);
          const list = buckets.get(key);
          if (list) list.push(e);
          else buckets.set(key, [e]);
          signatures.set(key, ((signatures.get(key) ?? 0) + sig) >>> 0);
        }
      }
    }
    for (const [key, sig] of signatures) {
      if (this.signatures.get(key) !== sig) this.markDirty(key);
    }
    for (const key of this.signatures.keys()) {
      if (!signatures.has(key)) this.markDirty(key);
    }
    this.buckets = buckets;
    this.signatures = signatures;
  }

  /** Rebuilds up to `budget` out-of-date chunks; returns how many it rebuilt. */
  update(budget: number = MAP_BUILDS_PER_FRAME): number {
    let built = 0;
    for (const [key, c] of this.chunks) {
      if (built >= budget) break;
      if (!c.dirty || !c.data) continue;
      mapChunkPixels(c.data, this.buckets.get(key) ?? [], c.pixels);
      c.dirty = false;
      c.version++;
      built++;
    }
    if (built > 0) {
      this.version++;
      this.buildCount += built;
    }
    return built;
  }

  /** Chunk `(cx, cy)`'s colours, or `undefined` if it was never seen (or was dropped). */
  get(cx: number, cy: number): MapChunk | undefined {
    const c = this.chunks.get(chunkKey(cx, cy));
    return c && c.cx === cx && c.cy === cy ? c : undefined;
  }

  /** Whether chunk `(cx, cy)` has up-to-date colours (built, and nothing pending). */
  isCurrent(cx: number, cy: number): boolean {
    const c = this.get(cx, cy);
    return c !== undefined && c.version > 0 && !c.dirty;
  }

  /** Chunks kept. */
  get size(): number {
    return this.chunks.size;
  }

  /** Bytes of colours kept. */
  get bytes(): number {
    return this.chunks.size * MAP_CHUNK_BYTES;
  }

  /** Chunks waiting for a rebuild. */
  get pending(): number {
    let n = 0;
    for (const c of this.chunks.values()) if (c.dirty && c.data) n++;
    return n;
  }

  private markDirty(key: number): void {
    const c = this.chunks.get(key);
    if (c?.data) c.dirty = true;
  }

  /** Drops the chunks outside the window furthest from it, down to `maxChunks`. */
  private evict(): void {
    const w = this.window;
    const mx = w ? (w.cx0 + w.cx1) / 2 : 0;
    const my = w ? (w.cy0 + w.cy1) / 2 : 0;
    const outside = [...this.chunks.entries()].filter(([, c]) => c.data === null);
    outside.sort(
      ([, a], [, b]) =>
        Math.abs(b.cx - mx) + Math.abs(b.cy - my) - (Math.abs(a.cx - mx) + Math.abs(a.cy - my)),
    );
    for (const [key] of outside) {
      if (this.chunks.size <= this.maxChunks) break;
      this.chunks.delete(key);
    }
    this.version++;
  }
}

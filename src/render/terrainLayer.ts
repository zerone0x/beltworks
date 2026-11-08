/**
 * Terrain rendering: one sprite per chunk, each backed by its own baked
 * texture.
 *
 * The layer caches the chunk data from snapshots and keeps exactly the chunks
 * in the snapshot's `chunkWindow` (the viewport plus a one-chunk margin):
 * chunks that leave it are dropped together with their textures, so memory
 * stays flat however far the camera travels. Baking is spread over frames
 * (`BAKES_PER_FRAME`) so a big batch of new chunks doesn't cause a hitch.
 *
 * Two looks:
 * - Placeholder (until the terrain atlas loads, or if it can't): flat colors
 *   baked on the CPU at 8 texels per tile (chunkBake.ts), every chunk of the
 *   window.
 * - Rendered (docs/ART.md, "Terrain"): blended ground textures, ore decals,
 *   decor and trees, baked on the GPU into a render texture
 *   (terrainArt.ts) at a resolution that follows the zoom
 *   (`texelsForZoom`: 32 texels per tile at 1×, 4 MiB per chunk). Only the
 *   chunks near the camera view are baked (`BAKE_MARGIN`); textures of chunks
 *   that drift further away (`FREE_MARGIN`) are freed. A chunk waits for its
 *   neighbours inside the window before its first bake, since its edges show
 *   their terrain, trees and stains; when one arrives later, or changes near
 *   the shared edge, the chunk is baked again. Zoomed in from
 *   `DETAIL_ZOOM` on a real GPU, the chunks on screen also get a detail
 *   texture at 64 texels per tile (16 MiB each) over their base one, baked
 *   one per frame once no base bake is pending, and freed as soon as the
 *   chunk leaves the view (`DETAIL_FREE_MARGIN`) or the zoom drops: the base
 *   textures, and so panning, work exactly as without them.
 */

import {
  BufferImageSource,
  Container,
  RenderTexture,
  Sprite,
  Texture,
  type Renderer,
} from 'pixi.js';
import { decodeChunks, type ChunkData } from '../sim/snapshot';
import { CHUNK_MASK, CHUNK_SHIFT, CHUNK_SIZE, tileIndex } from '../sim/world/chunk';
import { chunkKey } from '../sim/world/world';
import { rectContains, type ChunkRect, type Viewport } from '../worker/protocol';
import { TILE_PX } from './camera';
import { CHUNK_TEXTURE_SIZE, bakeChunkPixels } from './chunkBake';
import type { TerrainArt } from './terrainArt';
import {
  DETAIL_TEXELS,
  detailTexels,
  planChunk,
  texelsForZoom,
  visualChange,
  type ChunkPlan,
} from './terrainPlan';

/** Edge length of a chunk in world pixels. */
export const CHUNK_PX = CHUNK_SIZE * TILE_PX;
/** Chunk textures baked per rendered frame, at most. */
export const BAKES_PER_FRAME = 4;
/** Rendered terrain: texels baked per frame, at most: one chunk at 1× (1024²), more at lower zoom (scaled down with `maxTexels`). */
export const RENDERED_BAKE_TEXELS = 1024 * 1024;
/**
 * Rendered terrain: while the view moves, the share of `RENDERED_BAKE_TEXELS`
 * baked per frame, in bands of tile rows (a quarter of a chunk at 1×: about
 * 60 ms instead of 250 ms per frame on a software renderer).
 */
export const BACKGROUND_BAKE_SHARE = 1 / 4;
/** Rendered terrain: the view counts as moving until it stood still this long (ms). */
export const SETTLE_MS = 500;
/** Rendered terrain: chunks within this many tiles of the view get baked... */
export const BAKE_MARGIN = 8;
/** ...and keep their texture until they are further away than this. */
export const FREE_MARGIN = 24;
/** Detail textures (zoomed in, on a GPU): chunks within this many tiles of the view get one... */
export const DETAIL_MARGIN = 1;
/** ...and keep it until they are further away than this. */
export const DETAIL_FREE_MARGIN = 4;

export interface TileInfo {
  terrain: number;
  resource: number;
  amount: number;
  /** 1 where a tree stands, else 0. */
  tree: number;
}

/** A rendered bake in progress, done in bands of tile rows over several frames. */
interface BakeJob {
  chunk: CachedChunk;
  texels: number;
  target: RenderTexture;
  /** Whether `target` is a new texture (shown once complete), not the chunk's own (re-baked in place). */
  fresh: boolean;
  /** Made at the first band, from the chunk's data then (a change starts the bake over). */
  plan: ChunkPlan | null;
  /** Tile rows baked so far. */
  rows: number;
}

interface CachedChunk {
  data: ChunkData;
  /** Null until the chunk has been baked for the first time (and after its texture was freed). */
  sprite: Sprite | null;
  /** Placeholder look: the CPU pixels behind the sprite's texture. */
  pixels: Uint8Array | null;
  /** Rendered look: the texels per tile the texture was baked at (0: not baked). */
  texels: number;
  /** Whether `data` (or a neighbour it shows) changed since the last bake. */
  stale: boolean;
  /** Rendered look zoomed in: the detail texture over the base one, or null. */
  detail: Sprite | null;
}

export interface TerrainStats {
  /** Chunks whose data is cached. */
  chunks: number;
  /** Chunks with a live sprite and texture. */
  sprites: number;
  /** Chunks waiting to be (re-)baked. */
  pendingBakes: number;
  /** Chunks in the current window, or 0 before the first one. */
  windowChunks: number;
  /** Chunks that should have a texture now: the window, or (rendered look) the part near the view. */
  bakeChunks: number;
  /** Rendered look: texels per tile at the current zoom; 0 for the placeholder look. */
  texelsPerTile: number;
  /** Bytes of chunk textures alive (GPU, and CPU pixels for the placeholder look), detail textures included. */
  textureBytes: number;
  /** Rendered look zoomed in: chunks with a detail texture. */
  detailSprites: number;
  /** Rendered look: texels per tile of the detail textures at the current zoom (0: none). */
  detailTexelsPerTile: number;
}

/** Whether chunk `(cx, cy)` overlaps the tiles of `view` grown by `margin` tiles. */
function nearView(view: Viewport, margin: number, cx: number, cy: number): boolean {
  const x0 = cx << CHUNK_SHIFT;
  const y0 = cy << CHUNK_SHIFT;
  return (
    x0 + CHUNK_SIZE > view.x - margin &&
    x0 < view.x + view.w + margin &&
    y0 + CHUNK_SIZE > view.y - margin &&
    y0 < view.y + view.h + margin
  );
}

export class TerrainLayer {
  readonly container = new Container({ label: 'terrain' });
  /** The base textures, one sprite per chunk... */
  private readonly base = new Container({ label: 'terrain-base' });
  /** ...and the detail textures over them. */
  private readonly details = new Container({ label: 'terrain-detail' });
  private readonly chunks = new Map<number, CachedChunk>();
  /** Placeholder look: keys of chunks to bake, in the order the worker sent them (nearest first). */
  private readonly queue = new Set<number>();
  private current: ChunkRect | null = null;
  private art: TerrainArt | null = null;
  private renderer: Renderer | null = null;
  private view: Viewport | null = null;
  private texels = 32;
  private detail = 0;
  private zoom = 1;
  /** When the view last moved or zoomed (`performance.now()` ms). */
  private movedAt = -Infinity;
  /** The bakes in progress (rendered look): a base texture and a detail texture. */
  private baseJob: BakeJob | null = null;
  private detailJob: BakeJob | null = null;
  /** Most texels per tile the rendered look bakes at: 64 allows detail textures; lower on software renderers. */
  maxTexels = 32;
  /** Chunk textures (base and detail) baked so far, for the render profile. */
  bakeCount = 0;
  /** Whether the rendered look draws the trees' shadows (the shadows setting). */
  private treeShadows = true;

  constructor() {
    this.container.addChild(this.base, this.details);
  }

  /**
   * Uses the rendered look from `art` (baked with `renderer`) from now on, or
   * the placeholder look for `null`; every chunk is baked again.
   */
  setArt(art: TerrainArt | null, renderer: Renderer | null): void {
    this.art = art && renderer ? art : null;
    this.renderer = renderer;
    if (this.art) this.art.treeShadows = this.treeShadows;
    this.rebakeAll();
  }

  /** Draws the trees' shadows (or not) from now on, baking every chunk again. */
  setShadows(on: boolean): void {
    if (on === this.treeShadows) return;
    this.treeShadows = on;
    if (this.art) {
      this.art.treeShadows = on;
      this.rebakeAll();
    }
  }

  /** Bakes every chunk again. */
  private rebakeAll(): void {
    for (const [key, cached] of this.chunks) {
      this.freeTexture(cached);
      cached.stale = true;
      this.queue.add(key);
    }
  }

  /** Whether the rendered look is in use. */
  get rendered(): boolean {
    return this.art !== null;
  }

  /** Applies the chunk part of a snapshot: drop what left the window, cache what arrived. */
  applySnapshot(window: ChunkRect | null, buffer: ArrayBuffer | null): void {
    if (window !== null) {
      this.current = window;
      for (const [key, cached] of this.chunks) {
        if (!rectContains(window, cached.data.cx, cached.data.cy)) {
          this.evict(key, cached);
        }
      }
    }
    if (buffer === null) {
      return;
    }
    for (const data of decodeChunks(buffer)) {
      const key = chunkKey(data.cx, data.cy);
      const cached = this.chunks.get(key);
      if (cached) {
        const change = visualChange(cached.data, data);
        cached.data = data;
        if (this.art) {
          if (change.self) {
            this.markStale(cached);
            this.freeDetail(cached);
          }
          if (change.edge) this.touchNeighbours(data.cx, data.cy);
        } else {
          cached.stale = true;
        }
      } else {
        this.chunks.set(key, {
          data,
          sprite: null,
          pixels: null,
          texels: 0,
          stale: true,
          detail: null,
        });
        if (this.art) this.touchNeighbours(data.cx, data.cy);
      }
      this.queue.add(key);
    }
  }

  /**
   * Bakes up to `budget` chunks; call once per frame with the tiles on screen
   * and the zoom (the rendered look bakes what is near them, at a resolution
   * for that zoom).
   */
  update(
    budget: number = BAKES_PER_FRAME,
    view?: Viewport,
    zoom?: number,
    nowMs: number = performance.now(),
  ): void {
    // The first view isn't a move.
    const old = this.view;
    if (
      view &&
      old &&
      (old.x !== view.x || old.y !== view.y || old.w !== view.w || old.h !== view.h)
    ) {
      this.movedAt = nowMs;
    }
    if (view) this.view = view;
    if (zoom !== undefined) {
      if (old && zoom !== this.zoom) this.movedAt = nowMs;
      this.zoom = zoom;
      this.texels = texelsForZoom(zoom, this.maxTexels);
      this.detail = detailTexels(zoom, this.maxTexels);
    }
    if (this.art) {
      // The base bakes' budget doesn't grow with the detail textures.
      const scale = (Math.min(this.maxTexels, 32) / 32) ** 2;
      const texels = RENDERED_BAKE_TEXELS * scale;
      // While the view moves, a long frame shows as a stutter: spread the
      // bakes over frames. Standing still, bake as fast as before.
      const moving = nowMs - this.movedAt < SETTLE_MS;
      const background = moving ? texels * BACKGROUND_BAKE_SHARE : texels;
      const baked = this.updateRendered(budget, texels, background);
      this.updateDetails(baked, moving ? background : Infinity);
      return;
    }
    for (const key of this.queue) {
      if (budget-- <= 0) {
        break;
      }
      this.queue.delete(key);
      const cached = this.chunks.get(key);
      if (cached?.stale) {
        this.bakePlaceholder(cached);
      }
    }
  }

  /** Terrain, resource and tree at world tile `(x, y)`, or `null` if that chunk isn't loaded. */
  tileAt(x: number, y: number): TileInfo | null {
    const cx = x >> CHUNK_SHIFT;
    const cy = y >> CHUNK_SHIFT;
    const cached = this.chunks.get(chunkKey(cx, cy));
    // The packed key wraps for huge coordinates; check it is really this chunk.
    if (!cached || cached.data.cx !== cx || cached.data.cy !== cy) {
      return null;
    }
    const i = tileIndex(x & CHUNK_MASK, y & CHUNK_MASK);
    return {
      terrain: cached.data.terrain[i]!,
      resource: cached.data.resource[i]!,
      amount: cached.data.amount[i]!,
      tree: cached.data.tree[i]!,
    };
  }

  /** The chunk window of the latest snapshot, or `null` before the first one. */
  get chunkWindow(): ChunkRect | null {
    return this.current;
  }

  stats(): TerrainStats {
    let sprites = 0;
    let pending = 0;
    let bake = 0;
    let bytes = 0;
    let details = 0;
    for (const c of this.chunks.values()) {
      if (c.detail) {
        details++;
        bytes += (CHUNK_SIZE * DETAIL_TEXELS) ** 2 * 4;
      }
      if (this.art && !c.detail && this.wantsDetail(c)) pending++;
      if (c.sprite) {
        sprites++;
        const edge = this.art ? CHUNK_SIZE * c.texels : CHUNK_TEXTURE_SIZE;
        bytes += edge * edge * 4 * (this.art ? 1 : 2);
      }
      if (this.art && this.wanted(c)) {
        bake++;
        if (this.needsBake(c)) pending++;
      }
    }
    const w = this.current;
    const windowChunks = w ? (w.cx1 - w.cx0 + 1) * (w.cy1 - w.cy0 + 1) : 0;
    return {
      chunks: this.chunks.size,
      sprites,
      pendingBakes: this.art ? pending : this.queue.size,
      windowChunks,
      bakeChunks: this.art ? bake : windowChunks,
      texelsPerTile: this.art ? this.texels : 0,
      textureBytes: bytes,
      detailSprites: details,
      detailTexelsPerTile: this.art ? this.detail : 0,
    };
  }

  /** True once every chunk that should be drawn has been received and baked. */
  isComplete(): boolean {
    const s = this.stats();
    if (s.windowChunks === 0 || s.pendingBakes > 0) return false;
    if (!this.art) return s.sprites === s.windowChunks;
    // Every chunk of the window near the view has arrived (and was baked, as nothing is pending).
    const w = this.current!;
    const view = this.view;
    for (let cy = w.cy0; cy <= w.cy1; cy++) {
      for (let cx = w.cx0; cx <= w.cx1; cx++) {
        if (view && !nearView(view, BAKE_MARGIN, cx, cy)) continue;
        const c = this.chunks.get(chunkKey(cx, cy));
        if (!c?.sprite) return false;
      }
    }
    return true;
  }

  destroy(): void {
    for (const [key, cached] of this.chunks) {
      this.evict(key, cached);
    }
    this.container.destroy({ children: true });
  }

  /** Whether the rendered look wants a texture for `c` (near the view, or everywhere without one). */
  private wanted(c: CachedChunk): boolean {
    return !this.view || nearView(this.view, BAKE_MARGIN, c.data.cx, c.data.cy);
  }

  /** Whether `c` should have a detail texture now: zoomed in on a GPU, near the view, baked and current. */
  private wantsDetail(c: CachedChunk, margin: number = DETAIL_MARGIN): boolean {
    return (
      this.detail > 0 &&
      this.view !== null &&
      nearView(this.view, margin, c.data.cx, c.data.cy) &&
      c.sprite !== null &&
      !this.needsBake(c)
    );
  }

  /**
   * Frees the detail textures no longer wanted and, unless a base bake
   * happened this frame (`baked`), bakes up to `budget` texels of one that
   * is missing (in bands: it shows once complete).
   */
  private updateDetails(baked: boolean, budget: number): void {
    let next: CachedChunk | null = null;
    for (const c of this.chunks.values()) {
      if (c.detail && !this.wantsDetail(c, DETAIL_FREE_MARGIN)) this.freeDetail(c);
      else if (!c.detail && !next && this.wantsDetail(c)) next = c;
    }
    let job = this.detailJob;
    if (job && (job.chunk.detail || !this.wantsDetail(job.chunk, DETAIL_FREE_MARGIN))) {
      this.cancel(job);
      job = null;
    }
    if (baked || (!job && !next)) return;
    if (!job) {
      const size = CHUNK_SIZE * DETAIL_TEXELS;
      const target = RenderTexture.create({
        width: size,
        height: size,
        scaleMode: 'linear',
        antialias: false,
        label: `chunk detail ${String(next!.data.cx)},${String(next!.data.cy)}`,
      });
      job = { chunk: next!, texels: DETAIL_TEXELS, target, fresh: true, plan: null, rows: 0 };
      this.detailJob = job;
    }
    if (!this.bakeRows(job, budget)) return;
    this.detailJob = null;
    const sprite = new Sprite(job.target);
    sprite.position.set(job.chunk.data.cx * CHUNK_PX, job.chunk.data.cy * CHUNK_PX);
    sprite.setSize(CHUNK_PX, CHUNK_PX);
    this.details.addChild(sprite);
    job.chunk.detail = sprite;
  }

  private freeDetail(cached: CachedChunk): void {
    cached.detail?.destroy({ texture: true, textureSource: true });
    cached.detail = null;
    if (this.detailJob?.chunk === cached) this.cancel(this.detailJob);
  }

  /** Drops a bake in progress (and its texture, if it was a new one). */
  private cancel(job: BakeJob): void {
    if (job.fresh) job.target.destroy(true);
    if (this.baseJob === job) this.baseJob = null;
    if (this.detailJob === job) this.detailJob = null;
  }

  /** Marks `c` for a new bake; a bake of it in progress starts over with its new data. */
  private markStale(c: CachedChunk): void {
    const job = this.baseJob;
    if (job?.chunk === c) {
      job.plan = null;
      job.rows = 0;
    } else {
      c.stale = true;
    }
  }

  private needsBake(c: CachedChunk): boolean {
    return c.stale || c.texels !== this.texels || !c.sprite || this.baseJob?.chunk === c;
  }

  /** Whether every neighbour of `c` that belongs to the window has arrived. */
  private neighboursReady(c: CachedChunk): boolean {
    const w = this.current;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = c.data.cx + dx;
        const cy = c.data.cy + dy;
        if (w && !rectContains(w, cx, cy)) continue;
        if (!this.chunks.has(chunkKey(cx, cy))) return false;
      }
    }
    return true;
  }

  private touchNeighbours(cx: number, cy: number): void {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const n = this.chunks.get(chunkKey(cx + dx, cy + dy));
        if (n && (n.sprite || this.baseJob?.chunk === n)) this.markStale(n);
        if (n) this.freeDetail(n);
      }
    }
  }

  /**
   * Bakes base textures; whether it baked any. While the view stands still
   * (`background` is all of `texels`), chunks on screen without a texture
   * (holes) are baked whole, up to `maxChunks` and `texels` texels per frame
   * (at least one chunk). The rest (chunks around the view, new resolutions,
   * changes of chunks already shown), and while the view moves the holes
   * too (first), are baked in bands of tile rows, `background` texels per
   * frame, so a new chunk coming near the view while panning or zooming
   * costs a few small steps instead of one long frame (software renderers
   * take about a quarter of a second per chunk).
   */
  private updateRendered(maxChunks: number, texels: number, background: number): boolean {
    this.queue.clear();
    const view = this.view;
    const job = this.baseJob;
    if (
      job &&
      (job.texels !== this.texels ||
        this.chunks.get(chunkKey(job.chunk.data.cx, job.chunk.data.cy)) !== job.chunk)
    ) {
      this.cancel(job);
    }
    const candidates: CachedChunk[] = [];
    for (const c of this.chunks.values()) {
      if (view && c.sprite && !nearView(view, FREE_MARGIN, c.data.cx, c.data.cy)) {
        this.freeTexture(c);
        continue;
      }
      if (c === this.baseJob?.chunk) continue;
      if (this.wanted(c) && this.needsBake(c) && this.neighboursReady(c)) candidates.push(c);
    }
    if (candidates.length === 0 && !this.baseJob) return false;
    const mx = view ? view.x + view.w / 2 : 0;
    const my = view ? view.y + view.h / 2 : 0;
    const distance = (c: CachedChunk) =>
      Math.abs((c.data.cx << CHUNK_SHIFT) + CHUNK_SIZE / 2 - mx) +
      Math.abs((c.data.cy << CHUNK_SHIFT) + CHUNK_SIZE / 2 - my);
    const hole = (c: CachedChunk) =>
      !c.sprite && (!view || nearView(view, 0, c.data.cx, c.data.cy));
    // Holes first, then nearest to the view's center.
    candidates.sort((a, b) => Number(hole(b)) - Number(hole(a)) || distance(a) - distance(b));
    const holes = candidates.filter(hole);
    if (this.baseJob && hole(this.baseJob.chunk)) holes.unshift(this.baseJob.chunk);
    if (holes.length > 0 && background >= texels) {
      const size = CHUNK_SIZE * this.texels;
      const count = Math.min(maxChunks, Math.max(1, Math.floor(texels / (size * size))));
      for (const c of holes.slice(0, count)) {
        const whole = this.baseJob?.chunk === c ? this.baseJob : this.startBase(c, false);
        this.bakeRows(whole, Infinity);
        this.finishBase(whole);
      }
      return true;
    }
    let budget = background;
    let finished = 0;
    while (budget > 0 && finished < maxChunks) {
      const next =
        this.baseJob ?? (candidates.length > 0 ? this.startBase(candidates.shift()!) : null);
      if (!next) break;
      const before = next.rows;
      const done = this.bakeRows(next, budget);
      budget -= (next.rows - before) * CHUNK_SIZE * next.texels * next.texels;
      if (!done) break;
      this.finishBase(next);
      finished++;
    }
    return true;
  }

  /** Tile rows of `job` that fit in `budget` texels (at least one). */
  private rowsFor(job: BakeJob, budget: number): number {
    return Math.max(1, Math.floor(budget / (CHUNK_SIZE * job.texels * job.texels)));
  }

  /**
   * Starts a base bake of `c` at the current resolution: into its texture,
   * or a new one; as the bake in progress (`baseJob`) unless `track` is
   * false (a bake done whole within the frame).
   */
  private startBase(c: CachedChunk, track = true): BakeJob {
    const texels = this.texels;
    let job: BakeJob;
    if (c.sprite && c.texels === texels) {
      job = {
        chunk: c,
        texels,
        target: c.sprite.texture as RenderTexture,
        fresh: false,
        plan: null,
        rows: 0,
      };
    } else {
      const size = CHUNK_SIZE * texels;
      const target = RenderTexture.create({
        width: size,
        height: size,
        scaleMode: 'linear',
        antialias: false,
        label: `chunk ${String(c.data.cx)},${String(c.data.cy)}`,
      });
      job = { chunk: c, texels, target, fresh: true, plan: null, rows: 0 };
    }
    // Its data is now what gets baked: changes from here on start it over.
    c.stale = false;
    if (track) this.baseJob = job;
    return job;
  }

  /** Bakes up to `budget` texels' worth of tile rows of `job`; whether it is complete. */
  private bakeRows(job: BakeJob, budget: number): boolean {
    const cached = job.chunk;
    job.plan ??= planChunk(cached.data, (cx, cy) => {
      const c = this.chunks.get(chunkKey(cx, cy));
      return c && c.data.cx === cx && c.data.cy === cy ? c.data : undefined;
    });
    const to = Math.min(CHUNK_SIZE, job.rows + this.rowsFor(job, budget));
    this.art!.bake(
      this.renderer!,
      job.plan,
      cached.data.cx << CHUNK_SHIFT,
      cached.data.cy << CHUNK_SHIFT,
      job.texels,
      job.target,
      job.rows,
      to,
    );
    job.rows = to;
    return to >= CHUNK_SIZE;
  }

  /** Shows a complete base bake: swaps in (or adds) its texture. */
  private finishBase(job: BakeJob): void {
    const cached = job.chunk;
    if (this.baseJob === job) this.baseJob = null;
    if (job.fresh) {
      if (cached.sprite) {
        // A new resolution: swap the texture, free the old one.
        const old = cached.sprite.texture;
        cached.sprite.texture = job.target;
        cached.sprite.setSize(CHUNK_PX, CHUNK_PX);
        old.destroy(true);
      } else {
        this.addSprite(cached, job.target);
      }
    }
    cached.texels = job.texels;
    this.bakeCount++;
  }

  private bakePlaceholder(cached: CachedChunk): void {
    cached.pixels = bakeChunkPixels(cached.data, cached.pixels ?? undefined);
    this.bakeCount++;
    cached.stale = false;
    if (cached.sprite) {
      // Same buffer, new contents: re-upload it.
      cached.sprite.texture.source.update();
      return;
    }
    const source = new BufferImageSource({
      resource: cached.pixels,
      width: CHUNK_TEXTURE_SIZE,
      height: CHUNK_TEXTURE_SIZE,
      scaleMode: 'nearest',
      label: `chunk ${String(cached.data.cx)},${String(cached.data.cy)}`,
    });
    this.addSprite(cached, new Texture({ source }));
  }

  private addSprite(cached: CachedChunk, texture: Texture): void {
    const sprite = new Sprite(texture);
    sprite.position.set(cached.data.cx * CHUNK_PX, cached.data.cy * CHUNK_PX);
    sprite.setSize(CHUNK_PX, CHUNK_PX);
    this.base.addChild(sprite);
    cached.sprite = sprite;
  }

  private freeTexture(cached: CachedChunk): void {
    if (this.baseJob?.chunk === cached) this.cancel(this.baseJob);
    // Destroying the texture with its source frees the GPU memory too.
    cached.sprite?.destroy({ texture: true, textureSource: true });
    cached.sprite = null;
    cached.pixels = null;
    cached.texels = 0;
    this.freeDetail(cached);
  }

  private evict(key: number, cached: CachedChunk): void {
    this.chunks.delete(key);
    this.queue.delete(key);
    this.freeTexture(cached);
  }
}

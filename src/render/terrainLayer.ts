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
 *   the shared edge, the chunk is baked again.
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
import { planChunk, texelsForZoom, visualChange } from './terrainPlan';

/** Edge length of a chunk in world pixels. */
export const CHUNK_PX = CHUNK_SIZE * TILE_PX;
/** Chunk textures baked per rendered frame, at most. */
export const BAKES_PER_FRAME = 4;
/** Rendered terrain: texels baked per frame, at most: one chunk at 1× (1024²), more at lower zoom (scaled down with `maxTexels`). */
export const RENDERED_BAKE_TEXELS = 1024 * 1024;
/** Rendered terrain: chunks within this many tiles of the view get baked... */
export const BAKE_MARGIN = 8;
/** ...and keep their texture until they are further away than this. */
export const FREE_MARGIN = 24;

export interface TileInfo {
  terrain: number;
  resource: number;
  amount: number;
  /** 1 where a tree stands, else 0. */
  tree: number;
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
  /** Bytes of chunk textures alive (GPU, and CPU pixels for the placeholder look). */
  textureBytes: number;
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
  private readonly chunks = new Map<number, CachedChunk>();
  /** Placeholder look: keys of chunks to bake, in the order the worker sent them (nearest first). */
  private readonly queue = new Set<number>();
  private current: ChunkRect | null = null;
  private art: TerrainArt | null = null;
  private renderer: Renderer | null = null;
  private view: Viewport | null = null;
  private texels = 32;
  /** Most texels per tile the rendered look bakes at (lower on software renderers). */
  maxTexels = 32;

  /**
   * Uses the rendered look from `art` (baked with `renderer`) from now on, or
   * the placeholder look for `null`; every chunk is baked again.
   */
  setArt(art: TerrainArt | null, renderer: Renderer | null): void {
    this.art = art && renderer ? art : null;
    this.renderer = renderer;
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
          if (change.self) cached.stale = true;
          if (change.edge) this.touchNeighbours(data.cx, data.cy);
        } else {
          cached.stale = true;
        }
      } else {
        this.chunks.set(key, { data, sprite: null, pixels: null, texels: 0, stale: true });
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
  update(budget: number = BAKES_PER_FRAME, view?: Viewport, zoom?: number): void {
    if (view) this.view = view;
    if (zoom !== undefined) this.texels = texelsForZoom(zoom, this.maxTexels);
    if (this.art) {
      const size = CHUNK_SIZE * this.texels;
      this.updateRendered(
        Math.min(
          budget,
          Math.max(
            1,
            Math.floor((RENDERED_BAKE_TEXELS * (this.maxTexels / 32) ** 2) / (size * size)),
          ),
        ),
      );
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
    for (const c of this.chunks.values()) {
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
    this.container.destroy();
  }

  /** Whether the rendered look wants a texture for `c` (near the view, or everywhere without one). */
  private wanted(c: CachedChunk): boolean {
    return !this.view || nearView(this.view, BAKE_MARGIN, c.data.cx, c.data.cy);
  }

  private needsBake(c: CachedChunk): boolean {
    return c.stale || c.texels !== this.texels || !c.sprite;
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
        if (n?.sprite) n.stale = true;
      }
    }
  }

  private updateRendered(budget: number): void {
    this.queue.clear();
    const view = this.view;
    const candidates: CachedChunk[] = [];
    for (const c of this.chunks.values()) {
      if (view && c.sprite && !nearView(view, FREE_MARGIN, c.data.cx, c.data.cy)) {
        this.freeTexture(c);
        continue;
      }
      if (this.wanted(c) && this.needsBake(c) && this.neighboursReady(c)) candidates.push(c);
    }
    if (candidates.length === 0) return;
    // Nearest to the view's center first.
    const mx = view ? view.x + view.w / 2 : 0;
    const my = view ? view.y + view.h / 2 : 0;
    const distance = (c: CachedChunk) =>
      Math.abs((c.data.cx << CHUNK_SHIFT) + CHUNK_SIZE / 2 - mx) +
      Math.abs((c.data.cy << CHUNK_SHIFT) + CHUNK_SIZE / 2 - my);
    candidates.sort((a, b) => distance(a) - distance(b));
    for (const c of candidates.slice(0, budget)) this.bakeRendered(c);
  }

  private bakeRendered(cached: CachedChunk): void {
    const art = this.art!;
    const texels = this.texels;
    const size = CHUNK_SIZE * texels;
    const plan = planChunk(cached.data, (cx, cy) => {
      const c = this.chunks.get(chunkKey(cx, cy));
      return c && c.data.cx === cx && c.data.cy === cy ? c.data : undefined;
    });
    let target = cached.sprite?.texture as RenderTexture | undefined;
    if (!cached.sprite || cached.texels !== texels) {
      target = RenderTexture.create({
        width: size,
        height: size,
        scaleMode: 'linear',
        antialias: false,
        label: `chunk ${String(cached.data.cx)},${String(cached.data.cy)}`,
      });
    }
    art.bake(
      this.renderer!,
      plan,
      cached.data.cx << CHUNK_SHIFT,
      cached.data.cy << CHUNK_SHIFT,
      texels,
      target!,
    );
    if (cached.sprite && cached.sprite.texture !== target) {
      // A new resolution: swap the texture, free the old one.
      const old = cached.sprite.texture;
      cached.sprite.texture = target!;
      cached.sprite.setSize(CHUNK_PX, CHUNK_PX);
      old.destroy(true);
    } else if (!cached.sprite) {
      this.addSprite(cached, target!);
    }
    cached.texels = texels;
    cached.stale = false;
  }

  private bakePlaceholder(cached: CachedChunk): void {
    cached.pixels = bakeChunkPixels(cached.data, cached.pixels ?? undefined);
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
    this.container.addChild(sprite);
    cached.sprite = sprite;
  }

  private freeTexture(cached: CachedChunk): void {
    // Destroying the texture with its source frees the GPU memory too.
    cached.sprite?.destroy({ texture: true, textureSource: true });
    cached.sprite = null;
    cached.pixels = null;
    cached.texels = 0;
  }

  private evict(key: number, cached: CachedChunk): void {
    this.chunks.delete(key);
    this.queue.delete(key);
    this.freeTexture(cached);
  }
}

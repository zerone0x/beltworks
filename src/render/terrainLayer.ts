/**
 * Terrain rendering: one sprite per chunk, each backed by its own baked
 * texture (see chunkBake.ts).
 *
 * The layer caches the chunk data from snapshots and keeps exactly the chunks
 * in the snapshot's `chunkWindow` (the viewport plus a one-chunk margin):
 * chunks that leave it are destroyed together with their textures, so memory
 * stays flat however far the camera travels. Baking is spread over frames
 * (`BAKES_PER_FRAME`) so a big batch of new chunks doesn't cause a hitch.
 */

import { BufferImageSource, Container, Sprite, Texture } from 'pixi.js';
import { decodeChunks, type ChunkData } from '../sim/snapshot';
import { CHUNK_MASK, CHUNK_SHIFT, CHUNK_SIZE, tileIndex } from '../sim/world/chunk';
import { chunkKey } from '../sim/world/world';
import { rectContains, type ChunkRect } from '../worker/protocol';
import { TILE_PX } from './camera';
import { CHUNK_TEXTURE_SIZE, bakeChunkPixels } from './chunkBake';

/** Edge length of a chunk in world pixels. */
export const CHUNK_PX = CHUNK_SIZE * TILE_PX;
/** Chunk textures baked per rendered frame, at most. */
export const BAKES_PER_FRAME = 4;

export interface TileInfo {
  terrain: number;
  resource: number;
  amount: number;
}

interface CachedChunk {
  data: ChunkData;
  /** Null until the chunk has been baked for the first time. */
  sprite: Sprite | null;
  pixels: Uint8Array | null;
  /** Whether `data` changed since the last bake. */
  stale: boolean;
}

export interface TerrainStats {
  /** Chunks whose data is cached. */
  chunks: number;
  /** Chunks with a live sprite and texture. */
  sprites: number;
  /** Cached chunks waiting to be (re-)baked. */
  pendingBakes: number;
  /** Chunks in the current window, or 0 before the first one. */
  windowChunks: number;
}

export class TerrainLayer {
  readonly container = new Container({ label: 'terrain' });
  private readonly chunks = new Map<number, CachedChunk>();
  /** Keys of chunks to bake, in the order the worker sent them (nearest to the view center first). */
  private readonly queue = new Set<number>();
  private current: ChunkRect | null = null;

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
        cached.data = data;
        cached.stale = true;
      } else {
        this.chunks.set(key, { data, sprite: null, pixels: null, stale: true });
      }
      this.queue.add(key);
    }
  }

  /** Bakes up to `budget` queued chunks; call once per frame. */
  update(budget: number = BAKES_PER_FRAME): void {
    for (const key of this.queue) {
      if (budget-- <= 0) {
        break;
      }
      this.queue.delete(key);
      const cached = this.chunks.get(key);
      if (cached?.stale) {
        this.bake(cached);
      }
    }
  }

  /** Terrain and resource at world tile `(x, y)`, or `null` if that chunk isn't loaded. */
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
    };
  }

  /** The chunk window of the latest snapshot, or `null` before the first one. */
  get chunkWindow(): ChunkRect | null {
    return this.current;
  }

  stats(): TerrainStats {
    let sprites = 0;
    for (const c of this.chunks.values()) {
      if (c.sprite) sprites++;
    }
    const w = this.current;
    return {
      chunks: this.chunks.size,
      sprites,
      pendingBakes: this.queue.size,
      windowChunks: w ? (w.cx1 - w.cx0 + 1) * (w.cy1 - w.cy0 + 1) : 0,
    };
  }

  /** True once every chunk of the current window has been received and baked. */
  isComplete(): boolean {
    const s = this.stats();
    return s.windowChunks > 0 && s.sprites === s.windowChunks && s.pendingBakes === 0;
  }

  destroy(): void {
    for (const [key, cached] of this.chunks) {
      this.evict(key, cached);
    }
    this.container.destroy();
  }

  private bake(cached: CachedChunk): void {
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
    const sprite = new Sprite(new Texture({ source }));
    sprite.position.set(cached.data.cx * CHUNK_PX, cached.data.cy * CHUNK_PX);
    sprite.setSize(CHUNK_PX, CHUNK_PX);
    this.container.addChild(sprite);
    cached.sprite = sprite;
  }

  private evict(key: number, cached: CachedChunk): void {
    this.chunks.delete(key);
    this.queue.delete(key);
    // Destroying the texture with its source frees the GPU memory too.
    cached.sprite?.destroy({ texture: true, textureSource: true });
  }
}

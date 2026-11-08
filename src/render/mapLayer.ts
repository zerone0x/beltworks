/**
 * Map mode (docs/ARCHITECTURE.md, "Rendering"): zoomed out past `MAP_ZOOM`,
 * the world is drawn as flat colours, one texel per tile (mapStore.ts):
 * one sprite per chunk of the window, each with its own 32 × 32 texture
 * (4 KiB), plus a marker for the local player that keeps its size on
 * screen. The game view fades this layer in over the sprites
 * (`MAP_FADE_MS`) and, once it is opaque, hides the terrain and entity
 * layers and stops drawing them, so a frame costs a few dozen sprites
 * whatever the factory holds.
 *
 * The textures exist only while the layer shows (`clear` frees them) and
 * only for chunks in the window: GPU memory is bounded by the view.
 */

import { BufferImageSource, Container, Graphics, Sprite, Texture } from 'pixi.js';
import { CHUNK_SIZE } from '../sim/world/chunk';
import { chunkKey } from '../sim/world/world';
import type { ChunkRect, Viewport } from '../worker/protocol';
import { TILE_PX, type Point } from './camera';
import type { MapStore } from './mapStore';

/** Zoomed out below this, the view switches to map mode (the sprite view's lowest zoom). */
export const MAP_ZOOM = 0.25;
/** How long the switch between the sprite view and map mode fades, ms. */
export const MAP_FADE_MS = 250;
/** The player marker's radius in screen pixels. */
const MARKER_RADIUS = 5;
const MARKER_COLOR = 0xf2b134;
const MARKER_OUTLINE = 0x1a1206;

const CHUNK_PX = CHUNK_SIZE * TILE_PX;

/** Whether the view should show map mode at `zoom` (`override` forces it on or off). */
export function wantsMapMode(zoom: number, override: boolean | null = null): boolean {
  return override ?? zoom < MAP_ZOOM;
}

/**
 * Moves the map's opacity `blend` (0 the sprite view, 1 map mode) towards
 * `target` by a frame of `dtMs` milliseconds, at a full fade per
 * `MAP_FADE_MS`. Long frames are capped, so a stall still shows some of the fade.
 */
export function stepMapBlend(blend: number, target: boolean, dtMs: number): number {
  const step = Math.min(dtMs, 100) / MAP_FADE_MS;
  return target ? Math.min(1, blend + step) : Math.max(0, blend - step);
}

interface MapSprite {
  sprite: Sprite;
  /** The chunk version its texture shows, and the store's pixels behind it. */
  version: number;
  pixels: Uint8Array;
}

export class MapLayer {
  readonly container = new Container({ label: 'map' });
  private readonly chunks = new Container({ label: 'map-chunks' });
  private readonly marker = new Graphics({ label: 'map-player' });
  private readonly sprites = new Map<number, MapSprite>();
  private shownVersion = -1;
  private shownWindow: ChunkRect | null = null;
  /** Texture uploads so far (the render profile, tests). */
  uploads = 0;

  constructor() {
    this.container.addChild(this.chunks, this.marker);
    this.container.visible = false;
    this.marker
      .circle(0, 0, MARKER_RADIUS)
      .fill(MARKER_COLOR)
      .stroke({ color: MARKER_OUTLINE, width: 1.5 });
  }

  /**
   * Shows the chunks of `window` from `store` (adding, updating and dropping
   * sprites only when the store or the window changed) and the player marker
   * at `player` (world pixels) at `zoom`.
   */
  sync(store: MapStore, window: ChunkRect | null, player: Point | null, zoom: number): void {
    if (window && (store.version !== this.shownVersion || !sameRect(window, this.shownWindow))) {
      this.shownVersion = store.version;
      this.shownWindow = window;
      for (const [key, s] of this.sprites) {
        const cx = Math.round(s.sprite.x / CHUNK_PX);
        const cy = Math.round(s.sprite.y / CHUNK_PX);
        const inWindow =
          cx >= window.cx0 && cx <= window.cx1 && cy >= window.cy0 && cy <= window.cy1;
        if (!inWindow || !store.get(cx, cy)) this.drop(key, s);
      }
      for (let cy = window.cy0; cy <= window.cy1; cy++) {
        for (let cx = window.cx0; cx <= window.cx1; cx++) {
          const chunk = store.get(cx, cy);
          if (!chunk || chunk.version === 0) continue;
          const key = chunkKey(cx, cy);
          let s = this.sprites.get(key);
          if (s && s.pixels !== chunk.pixels) {
            // The store dropped the chunk and saw it again: a new buffer.
            this.drop(key, s);
            s = undefined;
          }
          if (!s) {
            const source = new BufferImageSource({
              resource: chunk.pixels,
              width: CHUNK_SIZE,
              height: CHUNK_SIZE,
              scaleMode: 'nearest',
              label: `map ${String(cx)},${String(cy)}`,
            });
            const sprite = new Sprite(new Texture({ source }));
            sprite.position.set(cx * CHUNK_PX, cy * CHUNK_PX);
            sprite.setSize(CHUNK_PX, CHUNK_PX);
            this.chunks.addChild(sprite);
            this.sprites.set(key, { sprite, version: chunk.version, pixels: chunk.pixels });
            this.uploads++;
          } else if (s.version !== chunk.version) {
            s.sprite.texture.source.update();
            s.version = chunk.version;
            this.uploads++;
          }
        }
      }
    }
    this.marker.visible = player !== null;
    if (player) {
      this.marker.position.set(player.x, player.y);
      this.marker.scale.set(1 / zoom);
    }
  }

  /** Whether every chunk of `window` on screen (`view`) that `store` has is shown, up to date. */
  isComplete(store: MapStore, window: ChunkRect | null, view: Viewport): boolean {
    if (!window) return false;
    const cx0 = Math.max(window.cx0, Math.floor(view.x / CHUNK_SIZE));
    const cy0 = Math.max(window.cy0, Math.floor(view.y / CHUNK_SIZE));
    const cx1 = Math.min(window.cx1, Math.floor((view.x + view.w - 1) / CHUNK_SIZE));
    const cy1 = Math.min(window.cy1, Math.floor((view.y + view.h - 1) / CHUNK_SIZE));
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const chunk = store.get(cx, cy);
        const s = this.sprites.get(chunkKey(cx, cy));
        if (!chunk || !store.isCurrent(cx, cy) || s?.version !== chunk.version) return false;
      }
    }
    return true;
  }

  /** Chunk sprites alive. */
  get spriteCount(): number {
    return this.sprites.size;
  }

  /** Frees every texture (the layer is hidden). */
  clear(): void {
    for (const [key, s] of this.sprites) this.drop(key, s);
    this.shownVersion = -1;
    this.shownWindow = null;
  }

  private drop(key: number, s: MapSprite): void {
    // The pixels belong to the store: free the GPU side only.
    s.sprite.destroy({ texture: true, textureSource: true });
    this.sprites.delete(key);
  }
}

function sameRect(a: ChunkRect, b: ChunkRect | null): boolean {
  return b !== null && a.cx0 === b.cx0 && a.cy0 === b.cy0 && a.cx1 === b.cx1 && a.cy1 === b.cy1;
}

/**
 * Decides which chunks go into each snapshot.
 *
 * The main thread caches the chunks it has received and drops those outside
 * the `chunkWindow` of each snapshot. The streamer mirrors that cache: it
 * remembers which chunks (and which version of each) it has sent inside the
 * current window, forgets chunks that leave it, and on every snapshot sends
 * the chunks in the window that are new or changed. Because the main thread
 * applies snapshots in order, both sides always agree on what is cached.
 */

import { isInt32 } from '../sim/fixed';
import { CHUNK_SHIFT, type Chunk } from '../sim/world/chunk';
import { CHUNK_COORD_LIMIT, chunkKey, type World } from '../sim/world/world';
import {
  CHUNK_MARGIN,
  MAX_CHUNKS_PER_SNAPSHOT,
  MAX_VIEWPORT_TILES,
  rectContains,
  type ChunkRect,
  type Viewport,
} from './protocol';

/**
 * Checks a viewport received from the main thread and clamps its size to
 * `MAX_VIEWPORT_TILES`. Throws a `TypeError` if it is malformed.
 */
export function sanitizeViewport(input: unknown): Viewport {
  const v = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const { x, y, w, h } = v;
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    typeof w !== 'number' ||
    typeof h !== 'number' ||
    !isInt32(x) ||
    !isInt32(y) ||
    !Number.isInteger(w) ||
    !Number.isInteger(h) ||
    w < 0 ||
    h < 0
  ) {
    throw new TypeError('viewport needs int32 x and y and non-negative integer w and h');
  }
  return { x, y, w: Math.min(w, MAX_VIEWPORT_TILES), h: Math.min(h, MAX_VIEWPORT_TILES) };
}

const clampChunk = (c: number): number =>
  Math.min(CHUNK_COORD_LIMIT - 1, Math.max(-CHUNK_COORD_LIMIT, c));

/**
 * The chunks covering `viewport` (an empty viewport still covers the chunk
 * at its origin) plus `margin` chunks on each side, clamped to the supported
 * chunk coordinate range.
 */
export function chunkWindow(viewport: Viewport, margin: number = CHUNK_MARGIN): ChunkRect {
  const size = 1 << CHUNK_SHIFT;
  const lastX = viewport.x + Math.max(viewport.w, 1) - 1;
  const lastY = viewport.y + Math.max(viewport.h, 1) - 1;
  return {
    cx0: clampChunk(Math.floor(viewport.x / size) - margin),
    cy0: clampChunk(Math.floor(viewport.y / size) - margin),
    cx1: clampChunk(Math.floor(lastX / size) + margin),
    cy1: clampChunk(Math.floor(lastY / size) + margin),
  };
}

export interface ChunkBatch {
  /** The window the main thread should keep. */
  window: ChunkRect;
  /** Chunks to send now, nearest to the viewport center first. */
  chunks: Chunk[];
}

interface SentChunk {
  readonly cx: number;
  readonly cy: number;
  version: number;
}

export class ChunkStreamer {
  private viewport: Viewport | null = null;
  /** Chunks the main thread has, by chunk key, with the version that was sent. */
  private readonly sent = new Map<number, SentChunk>();

  constructor(
    private readonly world: World,
    private readonly budget: number = MAX_CHUNKS_PER_SNAPSHOT,
  ) {}

  /** Number of chunks the main thread currently has cached, as far as the worker knows. */
  get sentCount(): number {
    return this.sent.size;
  }

  setViewport(viewport: Viewport): void {
    this.viewport = viewport;
  }

  /**
   * Returns the chunks for the next snapshot and assumes they will be
   * delivered. Returns `null` before the first viewport.
   */
  collect(): ChunkBatch | null {
    if (this.viewport === null) {
      return null;
    }
    const window = chunkWindow(this.viewport);

    // Forget what left the window: the main thread drops it too. Unmodified
    // chunks are also released from the world cache, since they can be
    // regenerated from the seed, which keeps the worker's memory bounded too.
    for (const [key, s] of this.sent) {
      if (!rectContains(window, s.cx, s.cy)) {
        this.sent.delete(key);
        this.world.unloadChunk(s.cx, s.cy);
      }
    }

    const wanted: { cx: number; cy: number; d2: number }[] = [];
    const size = 1 << CHUNK_SHIFT;
    // Distances in chunk-sized units from the viewport center to chunk centers.
    const centerX = (this.viewport.x + this.viewport.w / 2) / size - 0.5;
    const centerY = (this.viewport.y + this.viewport.h / 2) / size - 0.5;
    for (let cy = window.cy0; cy <= window.cy1; cy++) {
      for (let cx = window.cx0; cx <= window.cx1; cx++) {
        const s = this.sent.get(chunkKey(cx, cy));
        if (s === undefined || s.version !== this.world.chunkVersion(cx, cy)) {
          wanted.push({ cx, cy, d2: (cx - centerX) ** 2 + (cy - centerY) ** 2 });
        }
      }
    }
    wanted.sort((a, b) => a.d2 - b.d2 || a.cy - b.cy || a.cx - b.cx);

    const chunks: Chunk[] = [];
    for (const { cx, cy } of wanted.slice(0, this.budget)) {
      chunks.push(this.world.getChunk(cx, cy));
      const version = this.world.chunkVersion(cx, cy);
      const key = chunkKey(cx, cy);
      const s = this.sent.get(key);
      if (s) {
        s.version = version;
      } else {
        this.sent.set(key, { cx, cy, version });
      }
    }
    return { window, chunks };
  }
}

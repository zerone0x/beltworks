/**
 * Pre-rendered sprites (docs/ART.md): loads the atlases `npm run art` writes
 * to `public/sprites/` and maps an entity's model, direction, state and
 * animation time to sprite frames. Anything without a model keeps the
 * placeholder shapes, so art can land one model at a time.
 *
 * The atlas index (`<name>.json`) lists the sheets, every frame as
 * `[sheet, x, y, w, h, ax, ay]` (texels; `(ax, ay)` is where the footprint's
 * center falls in the frame) and per model its footprint, directions, named
 * points (texels from the footprint's center, per direction), one shadow
 * frame per direction and its layers in draw order, each with frames per
 * direction, a frame rate, when it shows and when it animates.
 *
 * Read-only: nothing here flows back into the simulation.
 */

import { Assets, Rectangle, Texture } from 'pixi.js';
import { MachineState } from '../sim/entities/machine';
import { TILE_PX } from './camera';

export const ATLAS_VERSION = 1;
/** Opacity of the shadow layer (shadows are drawn at full strength into it, so they never double up). */
export const SHADOW_ALPHA = 0.5;

/** When a layer is drawn: always, or only while the entity works / doesn't. */
export type LayerShow = 'always' | 'working' | 'idle';
/** When a layer's animation advances: while the entity works, all the time, or never. */
export type LayerAdvance = 'working' | 'always' | 'never';

export interface AtlasLayerIndex {
  name: string;
  fps: number;
  show: LayerShow;
  advance: LayerAdvance;
  /** Frame indices per direction. */
  frames: number[][];
}

export interface AtlasModelIndex {
  footprint: [number, number];
  directions: number;
  /** Named points, `[x, y]` texels from the footprint's center, per direction. */
  points: Record<string, [number, number][]>;
  /** One shadow frame per direction. */
  shadow: number[];
  layers: AtlasLayerIndex[];
}

export interface AtlasIndex {
  version: number;
  /** Texels per tile. */
  tilePx: number;
  sheets: string[];
  /** `[sheet, x, y, w, h, ax, ay]` per frame. */
  frames: [number, number, number, number, number, number, number][];
  models: Record<string, AtlasModelIndex>;
}

/** One frame: its texture, and where the footprint's center falls in it (texels). */
export interface SpriteFrame {
  texture: Texture;
  ax: number;
  ay: number;
}

export interface ModelLayer {
  name: string;
  fps: number;
  show: LayerShow;
  advance: LayerAdvance;
  /** Frames per direction. */
  frames: SpriteFrame[][];
}

export interface ModelSprites {
  footprint: [number, number];
  directions: number;
  /** World pixels per texel. */
  scale: number;
  shadow: SpriteFrame[];
  layers: ModelLayer[];
  points: Record<string, [number, number][]>;
}

/** Throws unless `json` looks like an atlas index this build can read. */
export function parseAtlasIndex(json: unknown): AtlasIndex {
  const index = json as Partial<AtlasIndex> | null;
  if (
    !index ||
    index.version !== ATLAS_VERSION ||
    typeof index.tilePx !== 'number' ||
    !Array.isArray(index.sheets) ||
    !Array.isArray(index.frames) ||
    typeof index.models !== 'object'
  ) {
    throw new Error('not a sprite atlas index (or another version)');
  }
  const frameCount = index.frames.length;
  for (const [name, model] of Object.entries(index.models)) {
    const ok = (i: number) => Number.isInteger(i) && i >= 0 && i < frameCount;
    const valid =
      model.shadow.length === model.directions &&
      model.shadow.every(ok) &&
      model.layers.every(
        (l) =>
          l.frames.length === model.directions &&
          l.frames.every((fs) => fs.length > 0 && fs.every(ok)),
      );
    if (!valid) throw new Error(`sprite model ${name} refers to missing frames`);
  }
  return index as AtlasIndex;
}

/** Whether an entity in machine state `status` counts as working for its sprite (also on low power). */
export function isWorking(status: number): boolean {
  return status === MachineState.Working || status === MachineState.LowPower;
}

/** How fast an entity's working animations run: 1, 0.5 on low power, 0 when not working. */
export function animationSpeed(status: number): number {
  if (status === MachineState.Working) return 1;
  if (status === MachineState.LowPower) return 0.5;
  return 0;
}

/** Whether `layer` is drawn for an entity that is (or isn't) working. */
export function layerShown(layer: { show: LayerShow }, working: boolean): boolean {
  return layer.show === 'always' || (layer.show === 'working') === working;
}

/**
 * The frame of a layer with `count` frames at animation time `seconds`
 * (time the animation has advanced, not wall time) and `fps`.
 */
export function frameAt(count: number, fps: number, seconds: number): number {
  if (count <= 1 || fps <= 0) return 0;
  const f = Math.floor(seconds * fps) % count;
  return f < 0 ? f + count : f;
}

/** The sprite models of one loaded atlas. */
export class SpriteAtlas {
  private readonly models = new Map<string, ModelSprites>();

  constructor(index: AtlasIndex, sheets: readonly Texture[]) {
    const frames = index.frames.map(([sheet, x, y, w, h, ax, ay]) => ({
      texture: new Texture({ source: sheets[sheet]!.source, frame: new Rectangle(x, y, w, h) }),
      ax,
      ay,
    }));
    const scale = TILE_PX / index.tilePx;
    for (const [name, m] of Object.entries(index.models)) {
      this.models.set(name, {
        footprint: m.footprint,
        directions: m.directions,
        scale,
        shadow: m.shadow.map((i) => frames[i]!),
        layers: m.layers.map((l) => ({
          name: l.name,
          fps: l.fps,
          show: l.show,
          advance: l.advance,
          frames: l.frames.map((fs) => fs.map((i) => frames[i]!)),
        })),
        points: m.points,
      });
    }
  }

  /** The model named `name` (an entity prototype name), or `null` without one. */
  model(name: string | undefined): ModelSprites | null {
    return (name !== undefined && this.models.get(name)) || null;
  }

  get modelNames(): string[] {
    return [...this.models.keys()];
  }
}

/** The direction index a model with `directions` directions uses for entity direction `dir`. */
export function modelDirection(model: { directions: number }, dir: number): number {
  return model.directions > 1 ? dir % model.directions : 0;
}

/**
 * Loads the atlas whose index is at `url` (sheets next to it), with mipmaps
 * for zoomed-out views. Resolves to `null` (and the game keeps its
 * placeholders) when there is none or it can't be read.
 */
export async function loadSpriteAtlas(url: string): Promise<SpriteAtlas | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const index = parseAtlasIndex(await response.json());
    const base = url.slice(0, url.lastIndexOf('/') + 1);
    const sheets = await Promise.all(
      index.sheets.map((file) =>
        Assets.load<Texture>({
          src: base + file,
          data: { autoGenerateMipmaps: true, scaleMode: 'linear' },
        }),
      ),
    );
    return new SpriteAtlas(index, sheets);
  } catch (err) {
    console.warn('sprites: falling back to placeholders:', err);
    return null;
  }
}

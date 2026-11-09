/**
 * Pixi textures of the item icons (itemIcons.ts draws and loads them), for
 * the belt, inserter and assembler layers. Kept apart from itemIcons.ts so
 * that the windows, which only need the icons as images, don't pull PixiJS
 * into the code the title screen waits for (D64).
 */

import { ImageSource, Rectangle, Texture } from 'pixi.js';
import { ITEM_IDS } from '../data/items';
import {
  ICON_PX,
  RENDERED_ICON_SCALE,
  hasRenderedIcon,
  iconPixels,
  renderedIconPlace,
  renderedIconsGeneration,
} from './itemIcons';

/**
 * Pixi textures of the item icons. The lettered ones share one atlas (so
 * items on belts and in hands batch into few draw calls), sampled with
 * nearest filtering: at zoom 1 one texel covers exactly one screen pixel, so
 * labels stay crisp. The rendered ones come from their atlas, mipmapped
 * (made on first use from the sheets itemIcons.ts loaded).
 */
export class ItemIconAtlas {
  private readonly textures = new Map<number, Texture>();
  private readonly base: Texture;
  /** The rendered icons' textures by item, made on first use, from the set loaded last. */
  private readonly rendered = new Map<number, Texture>();
  private readonly renderedSources: ImageSource[] = [];
  private renderedGeneration = -1;
  /** Icon pitch in the atlas: one transparent pixel between icons so neighbours never bleed. */
  private static readonly PITCH = ICON_PX + 1;

  constructor() {
    const ids: number[] = [...ITEM_IDS, 0xffff];
    const canvas = document.createElement('canvas');
    canvas.width = ids.length * ItemIconAtlas.PITCH;
    canvas.height = ICON_PX;
    const ctx = canvas.getContext('2d')!;
    ids.forEach((id, i) => {
      const image = ctx.createImageData(ICON_PX, ICON_PX);
      image.data.set(iconPixels(id));
      ctx.putImageData(image, i * ItemIconAtlas.PITCH, 0);
    });
    this.base = Texture.from(canvas);
    this.base.source.scaleMode = 'nearest';
    ids.forEach((id, i) => {
      const frame = new Rectangle(i * ItemIconAtlas.PITCH, 0, ICON_PX, ICON_PX);
      this.textures.set(id, new Texture({ source: this.base.source, frame }));
    });
  }

  /** The texture of item `item` (the unknown-item icon for ids without a prototype). */
  texture(item: number): Texture {
    if (hasRenderedIcon(item)) {
      if (this.renderedGeneration !== renderedIconsGeneration()) {
        // Another set loaded: start over (sprites may still show the old textures, so they stay).
        this.rendered.clear();
        this.renderedSources.length = 0;
        this.renderedGeneration = renderedIconsGeneration();
      }
      return this.rendered.get(item) ?? this.renderedTexture(item);
    }
    return this.textures.get(item) ?? this.textures.get(0xffff)!;
  }

  /** Makes item `item`'s rendered icon texture (it has one). */
  private renderedTexture(item: number): Texture {
    const { sheet, x, y } = renderedIconPlace(item)!;
    let source = this.renderedSources.find((s) => s.resource === sheet);
    if (!source) {
      source = new ImageSource({
        resource: sheet,
        resolution: RENDERED_ICON_SCALE,
        autoGenerateMipmaps: true,
        scaleMode: 'linear',
        label: 'item icons',
      });
      this.renderedSources.push(source);
    }
    const s = RENDERED_ICON_SCALE;
    const texture = new Texture({ source, frame: new Rectangle(x / s, y / s, ICON_PX, ICON_PX) });
    this.rendered.set(item, texture);
    return texture;
  }

  destroy(): void {
    for (const t of this.textures.values()) t.destroy(false);
    for (const t of this.rendered.values()) t.destroy(false);
    for (const source of this.renderedSources) source.destroy();
    this.base.destroy(true);
  }
}

let shared: ItemIconAtlas | null = null;

/** The atlas shared by the belt and inserter layers, created on first use. */
export function itemIconAtlas(): ItemIconAtlas {
  shared ??= new ItemIconAtlas();
  return shared;
}

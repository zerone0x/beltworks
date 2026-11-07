/**
 * Item icons. Two kinds, shown everywhere an item is: on belts and in
 * inserter hands (Pixi textures, `ICON_PX` world pixels wide), over
 * assembling machines, and in the inventory, hotbar and entity windows
 * (images scaled 2×).
 *
 * - Rendered icons (docs/ART.md): a small 3D render of every item from the
 *   `icons` atlas (`npm run art`), `ICON_PX` × 4 texels square, loaded at
 *   startup (`loadItemIcons`). Their texture source has a resolution of 4, so
 *   the textures are `ICON_PX` units wide like the lettered ones and every
 *   layer draws them the same way.
 * - Lettered icons, drawn in code: a small pixel-art tile in the item's color
 *   with a one- or two-letter label in a 3×5 pixel font (e.g. `FE` for iron
 *   ore and iron plates, `C` for coal). The shape tells item kinds apart:
 *   ores and stone are rough chunks, plates and bricks are bevelled squares,
 *   and everything else (buildings, intermediates) is a rounded square. They
 *   are the fallback until (or unless) the rendered icons load, for items
 *   without one, and an option for players who read labels more easily than
 *   pictures (`setLetterIcons`, in the controls panel; remembered).
 *
 * Neither depends on a font, so icons look the same on every machine (the
 * hotbar is part of the screenshot tests).
 */

import { ImageSource, Rectangle, Texture } from 'pixi.js';
import { ITEM_IDS, ItemId, itemPrototype, type RealItemId } from '../data/items';

/** Edge length of an item icon in pixels (world pixels on belts, so ~0.4 tile). */
export const ICON_PX = 13;

/** Outline of an item kind. */
export type IconShape = 'ore' | 'plate' | 'item';

export interface IconSpec {
  /** One or two letters (A–Z) or digits (1, 2: machine tiers) drawn on the icon. */
  label: string;
  shape: IconShape;
}

/** Icons of the known items. Items missing here get one from `iconSpec`'s fallback. */
const ICONS: Readonly<Partial<Record<RealItemId, IconSpec>>> = {
  [ItemId.IronOre]: { label: 'FE', shape: 'ore' },
  [ItemId.CopperOre]: { label: 'CU', shape: 'ore' },
  [ItemId.Coal]: { label: 'C', shape: 'ore' },
  [ItemId.Stone]: { label: 'S', shape: 'ore' },
  [ItemId.WoodenChest]: { label: 'CH', shape: 'item' },
  [ItemId.StoneFurnace]: { label: 'FU', shape: 'item' },
  [ItemId.BurnerMiningDrill]: { label: 'DR', shape: 'item' },
  [ItemId.TransportBelt]: { label: 'BE', shape: 'item' },
  [ItemId.BurnerInserter]: { label: 'IN', shape: 'item' },
  [ItemId.Wood]: { label: 'W', shape: 'item' },
  [ItemId.IronPlate]: { label: 'FE', shape: 'plate' },
  [ItemId.CopperPlate]: { label: 'CU', shape: 'plate' },
  [ItemId.StoneBrick]: { label: 'BR', shape: 'plate' },
  [ItemId.IronGearWheel]: { label: 'G', shape: 'item' },
  [ItemId.CopperCable]: { label: 'CA', shape: 'item' },
  [ItemId.ElectronicCircuit]: { label: 'EC', shape: 'item' },
  [ItemId.SmallElectricPole]: { label: 'PO', shape: 'item' },
  [ItemId.Boiler]: { label: 'BO', shape: 'item' },
  [ItemId.SteamEngine]: { label: 'SE', shape: 'item' },
  [ItemId.ElectricMiningDrill]: { label: 'ED', shape: 'item' },
  [ItemId.ElectricInserter]: { label: 'EI', shape: 'item' },
  [ItemId.AssemblingMachine1]: { label: 'A1', shape: 'item' },
  [ItemId.AssemblingMachine2]: { label: 'A2', shape: 'item' },
  [ItemId.IronChest]: { label: 'IC', shape: 'item' },
  [ItemId.FastInserter]: { label: 'FI', shape: 'item' },
  [ItemId.LongHandedInserter]: { label: 'LI', shape: 'item' },
  // Belt tiers: F(ast) and (e)X(press), in the tier colors.
  [ItemId.FastTransportBelt]: { label: 'FB', shape: 'item' },
  [ItemId.ExpressTransportBelt]: { label: 'XB', shape: 'item' },
  [ItemId.UndergroundBelt]: { label: 'UG', shape: 'item' },
  [ItemId.FastUndergroundBelt]: { label: 'UF', shape: 'item' },
  [ItemId.ExpressUndergroundBelt]: { label: 'UX', shape: 'item' },
  // Research: the lab, and the science packs in their own colors.
  [ItemId.Lab]: { label: 'LA', shape: 'item' },
  [ItemId.AutomationSciencePack]: { label: 'S1', shape: 'item' },
  [ItemId.LogisticSciencePack]: { label: 'S2', shape: 'item' },
};

/** Color of unknown items, so bad data is obvious. */
const UNKNOWN_COLOR = 0xff00ff;

/**
 * The icon of item `item`: from the table above, or for items added later
 * the initials of the first two words of its label; `?` for unknown ids.
 */
export function iconSpec(item: number): IconSpec {
  const known = (ICONS as Readonly<Record<number, IconSpec | undefined>>)[item];
  if (known) return known;
  const proto = itemPrototype(item);
  if (!proto) return { label: '?', shape: 'item' };
  const initials = proto.label
    .split(/[\s-]+/)
    .map((w) => w.charAt(0).toUpperCase())
    .filter((c) => c in GLYPHS)
    .join('')
    .slice(0, 2);
  return { label: initials || '?', shape: 'item' };
}

/** A 3×5 pixel font: five rows of three columns each, `#` set. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = {
  A: ['.#.', '#.#', '###', '#.#', '#.#'],
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  C: ['.##', '#..', '#..', '#..', '.##'],
  D: ['##.', '#.#', '#.#', '#.#', '##.'],
  E: ['###', '#..', '##.', '#..', '###'],
  F: ['###', '#..', '##.', '#..', '#..'],
  G: ['.##', '#..', '#.#', '#.#', '.##'],
  H: ['#.#', '#.#', '###', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  J: ['..#', '..#', '..#', '#.#', '.#.'],
  K: ['#.#', '#.#', '##.', '#.#', '#.#'],
  L: ['#..', '#..', '#..', '#..', '###'],
  M: ['#.#', '###', '###', '#.#', '#.#'],
  N: ['##.', '#.#', '#.#', '#.#', '#.#'],
  O: ['.#.', '#.#', '#.#', '#.#', '.#.'],
  P: ['##.', '#.#', '##.', '#..', '#..'],
  Q: ['.#.', '#.#', '#.#', '##.', '.##'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  S: ['.##', '#..', '.#.', '..#', '##.'],
  T: ['###', '.#.', '.#.', '.#.', '.#.'],
  U: ['#.#', '#.#', '#.#', '#.#', '###'],
  V: ['#.#', '#.#', '#.#', '#.#', '.#.'],
  W: ['#.#', '#.#', '###', '###', '#.#'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
  Y: ['#.#', '#.#', '.#.', '.#.', '.#.'],
  Z: ['###', '..#', '.#.', '#..', '###'],
  '1': ['.#.', '##.', '.#.', '.#.', '###'],
  '2': ['##.', '..#', '.#.', '#..', '###'],
  '?': ['##.', '..#', '.#.', '...', '.#.'],
};
const GLYPH_W = 3;
const GLYPH_H = 5;

/** Darkest outline, and the label colors for dark and light fills. */
const OUTLINE = 0x16181c;
const LIGHT_TEXT = 0xf4efe0;
const DARK_TEXT = 0x1a1c20;

function scale(c: number, t: number): number {
  const ch = (s: number) => Math.min(255, Math.max(0, Math.round(((c >> s) & 0xff) * t))) << s;
  return ch(16) | ch(8) | ch(0);
}

/** Perceived brightness of 0xRRGGBB in [0, 1]. */
function luminance(c: number): number {
  return (0.299 * ((c >> 16) & 0xff) + 0.587 * ((c >> 8) & 0xff) + 0.114 * (c & 0xff)) / 255;
}

/** Whether pixel `(x, y)` of the icon lies inside `shape`, and whether it is on its edge. */
function inside(shape: IconShape, x: number, y: number): boolean {
  const n = ICON_PX - 1;
  const dx = Math.min(x, n - x);
  const dy = Math.min(y, n - y);
  switch (shape) {
    case 'ore':
      // An octagon with corners cut by 3 pixels: a rough chunk.
      return dx + dy >= 3;
    case 'plate':
      return true;
    case 'item':
      // Rounded corners: one pixel cut.
      return dx + dy >= 1;
  }
}

const iconCache = new Map<number, Uint8ClampedArray>();

/**
 * The RGBA pixels (`ICON_PX`², row-major, top row first) of item `item`'s
 * icon. Transparent outside the shape. Cached; don't modify the result.
 */
export function iconPixels(item: number): Uint8ClampedArray {
  const cached = iconCache.get(item);
  if (cached) return cached;
  const { label, shape } = iconSpec(item);
  const color = itemPrototype(item)?.color ?? UNKNOWN_COLOR;
  const px = new Uint8ClampedArray(ICON_PX * ICON_PX * 4);
  const set = (x: number, y: number, c: number): void => {
    const o = (y * ICON_PX + x) * 4;
    px[o] = (c >> 16) & 0xff;
    px[o + 1] = (c >> 8) & 0xff;
    px[o + 2] = c & 0xff;
    px[o + 3] = 0xff;
  };
  const light = scale(color, 1.3);
  const dark = scale(color, 0.7);
  for (let y = 0; y < ICON_PX; y++) {
    for (let x = 0; x < ICON_PX; x++) {
      if (!inside(shape, x, y)) continue;
      // Edge pixels (a neighbour is outside or off the icon) form the outline.
      const edge =
        x === 0 ||
        y === 0 ||
        x === ICON_PX - 1 ||
        y === ICON_PX - 1 ||
        !inside(shape, x - 1, y) ||
        !inside(shape, x + 1, y) ||
        !inside(shape, x, y - 1) ||
        !inside(shape, x, y + 1);
      if (edge) {
        set(x, y, OUTLINE);
      } else if (shape === 'plate' && (x === 1 || y === 1)) {
        set(x, y, light); // bevel: lit from the top left
      } else if (shape === 'plate' && (x === ICON_PX - 2 || y === ICON_PX - 2)) {
        set(x, y, dark);
      } else {
        set(x, y, color);
      }
    }
  }
  if (shape === 'ore') {
    // A few darker specks in the corners, clear of the label.
    for (const [x, y] of [
      [3, 2],
      [9, 3],
      [2, 9],
      [10, 9],
    ] as const) {
      set(x, y, dark);
    }
  }
  const text = luminance(color) > 0.55 ? DARK_TEXT : LIGHT_TEXT;
  const letters = [...label].slice(0, 2);
  const width = letters.length * GLYPH_W + (letters.length - 1);
  const x0 = Math.floor((ICON_PX - width) / 2);
  const y0 = Math.floor((ICON_PX - GLYPH_H) / 2);
  letters.forEach((ch, i) => {
    const glyph = GLYPHS[ch] ?? GLYPHS['?']!;
    glyph.forEach((row, gy) => {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (row[gx] === '#') set(x0 + i * (GLYPH_W + 1) + gx, y0 + gy, text);
      }
    });
  });
  iconCache.set(item, px);
  return px;
}

/** A canvas with item `item`'s lettered icon at one pixel per icon pixel. */
function iconCanvas(item: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = ICON_PX;
  canvas.height = ICON_PX;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(ICON_PX, ICON_PX);
  image.data.set(iconPixels(item));
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** Rendered icon texels per icon pixel (`ICON_PX`): the icons atlas holds 52² renders. */
export const RENDERED_ICON_SCALE = 4;

/** The rendered icons, once loaded: textures and the sheet they come from, by item id. */
interface RenderedIcons {
  sheets: ImageBitmap[];
  /** `[sheet, x, y]` of each item's icon in texels. */
  places: Map<number, [number, number, number]>;
  textures: Map<number, Texture>;
  size: number;
}

let rendered: RenderedIcons | null = null;
const LETTER_KEY = 'beltworks.letterIcons';
let letters = readLetterSetting();
const listeners = new Set<() => void>();

function readLetterSetting(): boolean {
  try {
    return globalThis.localStorage?.getItem(LETTER_KEY) === '1';
  } catch {
    return false;
  }
}

/** Whether item `item` shows its rendered icon (loaded, has one, and letters aren't preferred). */
export function hasRenderedIcon(item: number): boolean {
  return !letters && rendered !== null && rendered.places.has(item);
}

/** Whether the lettered icons are preferred over the rendered ones. */
export function letterIcons(): boolean {
  return letters;
}

/** Prefers the lettered icons (`true`) or the rendered ones; remembered across sessions. */
export function setLetterIcons(on: boolean): void {
  letters = on;
  try {
    globalThis.localStorage?.setItem(LETTER_KEY, on ? '1' : '0');
  } catch {
    // Private mode and the like: just don't remember it.
  }
  urlCache.clear();
  for (const listener of listeners) listener();
}

/** Calls `listener` whenever the icons change (rendered ones loaded, letters toggled). */
export function onIconsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const urlCache = new Map<number, string>();

/**
 * A `data:` URL of item `item`'s icon, for DOM slots: the rendered icon at
 * full resolution (scale it smoothly), or the lettered one at one pixel per
 * icon pixel (scale it with `image-rendering: pixelated`; see `hasRenderedIcon`).
 */
export function iconDataUrl(item: number): string {
  let url = urlCache.get(item);
  if (url === undefined) {
    url = hasRenderedIcon(item) ? renderedCanvas(item).toDataURL() : iconCanvas(item).toDataURL();
    urlCache.set(item, url);
  }
  return url;
}

function renderedCanvas(item: number): HTMLCanvasElement {
  const { sheets, places, size } = rendered!;
  const [sheet, x, y] = places.get(item)!;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.getContext('2d')!.drawImage(sheets[sheet]!, x, y, size, size, 0, 0, size, size);
  return canvas;
}

/**
 * Loads the rendered icons from the `icons` atlas index at `url`. Until it
 * resolves, and if it fails, the lettered icons stay.
 */
export async function loadItemIcons(url: string): Promise<boolean> {
  try {
    const response = await fetch(url);
    if (!response.ok) return false;
    const index = (await response.json()) as {
      sheets: string[];
      icons?: { size: number; items: Record<string, [number, number, number]> };
    };
    if (!index.icons || index.icons.size !== ICON_PX * RENDERED_ICON_SCALE) {
      throw new Error('no icons of the expected size in the atlas');
    }
    const base = url.slice(0, url.lastIndexOf('/') + 1);
    const sheets = await Promise.all(
      index.sheets.map(async (file) => {
        const blob = await (await fetch(base + file)).blob();
        return createImageBitmap(blob);
      }),
    );
    const sources = sheets.map(
      (bitmap) =>
        new ImageSource({
          resource: bitmap,
          resolution: RENDERED_ICON_SCALE,
          autoGenerateMipmaps: true,
          scaleMode: 'linear',
          label: 'item icons',
        }),
    );
    const byName = new Map(ITEM_IDS.map((id) => [itemPrototype(id)!.name, id]));
    const places = new Map<number, [number, number, number]>();
    const textures = new Map<number, Texture>();
    for (const [name, place] of Object.entries(index.icons.items)) {
      const id = byName.get(name);
      if (id === undefined) continue;
      const [sheet, x, y] = place;
      places.set(id, place);
      const s = RENDERED_ICON_SCALE;
      textures.set(
        id,
        new Texture({
          source: sources[sheet]!,
          frame: new Rectangle(x / s, y / s, ICON_PX, ICON_PX),
        }),
      );
    }
    rendered = { sheets, places, textures, size: index.icons.size };
    urlCache.clear();
    for (const listener of listeners) listener();
    return true;
  } catch (err) {
    console.warn('item icons: keeping the lettered ones:', err);
    return false;
  }
}

/**
 * Pixi textures of the item icons. The lettered ones share one atlas (so
 * items on belts and in hands batch into few draw calls), sampled with
 * nearest filtering: at zoom 1 one texel covers exactly one screen pixel, so
 * labels stay crisp. The rendered ones come from their atlas, mipmapped.
 */
export class ItemIconAtlas {
  private readonly textures = new Map<number, Texture>();
  private readonly base: Texture;
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
    if (hasRenderedIcon(item)) return rendered!.textures.get(item)!;
    return this.textures.get(item) ?? this.textures.get(0xffff)!;
  }

  destroy(): void {
    for (const t of this.textures.values()) t.destroy(false);
    this.base.destroy(true);
  }
}

let shared: ItemIconAtlas | null = null;

/** The atlas shared by the belt and inserter layers, created on first use. */
export function itemIconAtlas(): ItemIconAtlas {
  shared ??= new ItemIconAtlas();
  return shared;
}

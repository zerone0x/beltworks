/**
 * A contact sheet of every model in an atlas, on grass, the way the game
 * composes sprites (shadows first, as one layer, then the layers in order):
 * each direction idle and working, at 2× (the sprites' own 64 texels per
 * tile) and at 1× (32 pixels per tile, box-filtered like the GPU does).
 * For looking at models while working on them (`npm run art -- --preview`).
 */

import { halve } from './pack.js';
import { blit, createImage, encodePng } from './png.js';

const GRASS = [0x4f, 0x7a, 0x3a];
/** Matches SHADOW_ALPHA in src/render/sprites.ts. */
const SHADOW_ALPHA = 0.5;
const TILE = 64;

/**
 * @param {import('./png.js').Image} dst
 * @param {import('./png.js').Image} src
 * @param {number} dx @param {number} dy
 */
function over(dst, src, dx, dy) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const tx = dx + x;
      const ty = dy + y;
      if (tx < 0 || ty < 0 || tx >= dst.width || ty >= dst.height) continue;
      const s = (y * src.width + x) * 4;
      const a = src.data[s + 3] / 255;
      if (a === 0) continue;
      const d = (ty * dst.width + tx) * 4;
      for (let c = 0; c < 3; c++)
        dst.data[d + c] = Math.round(src.data[s + c] * a + dst.data[d + c] * (1 - a));
    }
  }
}

/**
 * @param {import('./pack.js').Model[]} models
 * @returns {{ full: Buffer, half: Buffer }} PNGs at 2× and at 1× (shown 2× larger, nearest)
 */
export function contactSheet(models) {
  /** @type {{ model: import('./pack.js').Model, d: number, working: boolean }[]} */
  const cells = [];
  for (const model of models) {
    for (let d = 0; d < model.directions; d++) {
      for (const working of [false, true]) cells.push({ model, d, working });
    }
  }
  const cellTiles = Math.max(5, ...models.map((m) => Math.max(...m.footprint) + 2));
  const columns = Math.min(8, cells.length);
  const rows = Math.ceil(cells.length / columns);
  const sheet = createImage(columns * cellTiles * TILE, rows * cellTiles * TILE);
  for (let i = 0; i < sheet.width * sheet.height; i++) {
    const x = i % sheet.width;
    const y = Math.floor(i / sheet.width);
    // A faint checker of tiles, like ground variation.
    const shade = ((x >> 6) + (y >> 6)) % 2 === 0 ? 1 : 0.94;
    sheet.data.set([GRASS[0] * shade, GRASS[1] * shade, GRASS[2] * shade, 255], i * 4);
  }
  cells.forEach(({ model, d, working }, i) => {
    const cx = (i % columns) * cellTiles * TILE + (cellTiles * TILE) / 2;
    const cy = Math.floor(i / columns) * cellTiles * TILE + (cellTiles * TILE) / 2 + TILE;
    const shadow = model.shadow[d];
    const faded = createImage(shadow.image.width, shadow.image.height);
    blit(shadow.image, 0, 0, shadow.image.width, shadow.image.height, faded, 0, 0);
    for (let p = 3; p < faded.data.length; p += 4)
      faded.data[p] = Math.round(faded.data[p] * SHADOW_ALPHA);
    over(sheet, faded, cx - shadow.ax, cy - shadow.ay);
    for (const layer of model.layers) {
      if (layer.show === 'working' && !working) continue;
      if (layer.show === 'idle' && working) continue;
      const frames = layer.frames[d];
      const animated = working || layer.advance === 'always';
      const frame = frames[animated ? Math.floor(frames.length / 3) : 0];
      over(sheet, frame.image, cx - frame.ax, cy - frame.ay);
    }
  });
  const half = createImage(sheet.width, sheet.height);
  for (let y = 0; y < sheet.height; y += 2) {
    for (let x = 0; x < sheet.width; x += 2) {
      for (let c = 0; c < 4; c++) {
        const at = (/** @type {number} */ xx, /** @type {number} */ yy) =>
          sheet.data[(yy * sheet.width + xx) * 4 + c];
        const v = Math.round((at(x, y) + at(x + 1, y) + at(x, y + 1) + at(x + 1, y + 1)) / 4);
        for (const [ox, oy] of [
          [0, 0],
          [1, 0],
          [0, 1],
          [1, 1],
        ]) {
          half.data[((y + oy) * sheet.width + x + ox) * 4 + c] = v;
        }
      }
    }
  }
  return { full: encodePng(sheet), half: encodePng(half) };
}

/** Backgrounds the icons are checked on: an inventory slot, a belt, grass. */
const ICON_BACKGROUNDS = [[0x2a, 0x2d, 0x31], [0x55, 0x57, 0x5a], GRASS];

/**
 * A sheet of item icons at the sizes the game shows them: full size (a slot
 * on a HiDPI screen), half (a slot at 1×) and a quarter (on a belt at 1×),
 * on a slot, a belt and grass, all magnified 2× (nearest) for looking at.
 * @param {import('./pack.js').Icon[]} icons
 */
export function iconSheet(icons) {
  const cell = 64;
  const columns = 5;
  const sheet = createImage(columns * cell * 2, icons.length * cell * 2);
  icons.forEach((icon, row) => {
    const half = halve(icon.image);
    const quarter = halve(half);
    const cells = [
      [icon.image, 0],
      [half, 0],
      [quarter, 0],
      [quarter, 1],
      [quarter, 2],
    ];
    cells.forEach(([image, bg], col) => {
      const tile = createImage(cell, cell);
      const color = ICON_BACKGROUNDS[/** @type {number} */ (bg)];
      for (let i = 0; i < cell * cell; i++) tile.data.set([...color, 255], i * 4);
      const img = /** @type {import('./png.js').Image} */ (image);
      over(tile, img, (cell - img.width) >> 1, (cell - img.height) >> 1);
      for (let y = 0; y < cell * 2; y++) {
        for (let x = 0; x < cell * 2; x++) {
          const s = ((y >> 1) * cell + (x >> 1)) * 4;
          const d = ((row * cell * 2 + y) * sheet.width + col * cell * 2 + x) * 4;
          sheet.data.set(tile.data.subarray(s, s + 4), d);
        }
      }
    });
  });
  return encodePng(sheet);
}

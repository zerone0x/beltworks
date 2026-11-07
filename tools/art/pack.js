/**
 * Packs rendered sprite frames (art/build/<model>/, from art/blender/render.py)
 * into texture atlases plus a JSON index the game loads
 * (src/render/sprites.ts). See docs/ART.md for the format.
 *
 * Frames are trimmed to their visible pixels (on even texel boundaries, so a
 * sprite drawn at half scale lands on whole world pixels), deduplicated, and
 * shelf-packed into sheets of at most MAX_SHEET² texels. Models that were not
 * re-rendered are carried over from the existing atlas, so one model can be
 * re-rendered on its own.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { blit, createImage, decodePng, encodePng } from './png.js';

export const ATLAS_VERSION = 1;
export const MAX_SHEET = 4096;
/** Transparent texels around every frame, so filtering and mipmaps don't bleed between frames. */
const PADDING = 4;
/** Frame positions and sizes are multiples of this (whole world pixels at half scale; mip-friendly). */
const ALIGN = 2;

/**
 * @typedef {{ key: string, image: import('./png.js').Image, ax: number, ay: number }} Frame
 *   A trimmed frame; `(ax, ay)` is where the footprint's center falls, relative to its top-left.
 * @typedef {{ name: string, fps: number, show: string, advance: string, frames: Frame[][] }} Layer
 *   One sprite layer, frames per direction.
 * @typedef {{ name: string, footprint: number[], directions: number, points: Record<string, number[][]>, shadow: Frame[], layers: Layer[] }} Model
 */

/**
 * Trims `image` to its non-transparent pixels on ALIGN boundaries, clearing
 * the color of fully transparent pixels; `shadow` frames become pure black
 * with the alpha as rendered.
 * @param {import('./png.js').Image} image
 * @param {number[]} anchor
 * @param {boolean} shadow
 * @param {string} key
 * @returns {Frame}
 */
function trimFrame(image, anchor, shadow, key) {
  const { width, height, data } = image;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (shadow) data[i] = data[i + 1] = data[i + 2] = 0;
      if (data[i + 3] === 0) {
        data[i] = data[i + 1] = data[i + 2] = 0;
        continue;
      }
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) {
    return { key, image: createImage(ALIGN, ALIGN), ax: anchor[0], ay: anchor[1] };
  }
  x0 -= x0 % ALIGN;
  y0 -= y0 % ALIGN;
  const w = Math.min(width - x0, Math.ceil((x1 + 1 - x0) / ALIGN) * ALIGN);
  const h = Math.min(height - y0, Math.ceil((y1 + 1 - y0) / ALIGN) * ALIGN);
  const out = createImage(w, h);
  blit(image, x0, y0, w, h, out, 0, 0);
  return { key, image: out, ax: anchor[0] - x0, ay: anchor[1] - y0 };
}

/**
 * Reads the renders of one model from `dir` (manifest.json and its PNGs).
 * @param {string} dir
 * @returns {Model}
 */
export function readRenders(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const load = (/** @type {string} */ layer, /** @type {number} */ d, /** @type {number} */ f) =>
    trimFrame(
      read(layer, d, f),
      manifest.anchor,
      false,
      `${String(manifest.name)}/${layer}/${String(d)}/${String(f)}`,
    );
  const dirs = [...Array(manifest.directions).keys()];
  const read = (/** @type {string} */ layer, /** @type {number} */ d, /** @type {number} */ f) =>
    decodePng(readFileSync(join(dir, `${layer}-d${String(d)}-f${String(f)}.png`)));
  const shadow = (/** @type {number} */ d) => {
    // Shadow under the opaque parts of the body never shows: drop it, it only costs bytes.
    const image = read('shadow', d, 0);
    const body = read(manifest.layers[0].name, d, 0);
    for (let i = 3; i < image.data.length; i += 4) {
      if (body.data[i] === 255) image.data[i] = 0;
    }
    return trimFrame(
      image,
      manifest.anchor,
      true,
      `${String(manifest.name)}/shadow/${String(d)}/0`,
    );
  };
  return {
    name: manifest.name,
    footprint: manifest.footprint,
    directions: manifest.directions,
    points: manifest.points ?? {},
    shadow: dirs.map(shadow),
    layers: manifest.layers.map(
      (
        /** @type {{ name: string, frames: number, fps: number, show: string, advance: string }} */ l,
      ) => ({
        name: l.name,
        fps: l.fps,
        show: l.show,
        advance: l.advance,
        frames: dirs.map((d) => [...Array(l.frames).keys()].map((f) => load(l.name, d, f))),
      }),
    ),
  };
}

/**
 * Reads the models of an existing atlas back into frames.
 * @param {string} outDir
 * @param {string} name atlas name, e.g. `entities`
 * @returns {Model[]}
 */
export function readAtlas(outDir, name) {
  const indexPath = join(outDir, `${name}.json`);
  if (!existsSync(indexPath)) return [];
  const index = JSON.parse(readFileSync(indexPath, 'utf8'));
  if (index.version !== ATLAS_VERSION) return [];
  const sheets = index.sheets.map((/** @type {string} */ file) =>
    decodePng(readFileSync(join(outDir, file))),
  );
  const frame = (/** @type {number} */ i, /** @type {string} */ key) => {
    const [sheet, x, y, w, h, ax, ay] = index.frames[i];
    const image = createImage(w, h);
    blit(sheets[sheet], x, y, w, h, image, 0, 0);
    return { key, image, ax, ay };
  };
  return Object.entries(index.models).map(([model, m]) => ({
    name: model,
    footprint: m.footprint,
    directions: m.directions,
    points: m.points ?? {},
    shadow: m.shadow.map((/** @type {number} */ i, /** @type {number} */ d) =>
      frame(i, `${model}/shadow/${String(d)}/0`),
    ),
    layers: m.layers.map(
      (
        /** @type {{ name: string, fps: number, show: string, advance: string, frames: number[][] }} */ l,
      ) => ({
        name: l.name,
        fps: l.fps,
        show: l.show,
        advance: l.advance,
        frames: l.frames.map((fs, d) =>
          fs.map((i, f) => frame(i, `${model}/${l.name}/${String(d)}/${String(f)}`)),
        ),
      }),
    ),
  }));
}

/**
 * Shelf-packs `sizes` (in order) into sheets `width` wide and at most MAX_SHEET tall.
 * @param {{ w: number, h: number }[]} sizes
 * @param {number} width
 */
function shelfPack(sizes, width) {
  /** @type {{ sheet: number, x: number, y: number }[]} */
  const places = [];
  /** @type {number[]} */
  const heights = [];
  let sheet = 0;
  let x = 0;
  let y = 0;
  let shelf = 0;
  for (const { w, h } of sizes) {
    const pw = w + PADDING;
    const ph = h + PADDING;
    if (pw > width) return null;
    if (x + pw > width) {
      y += shelf;
      x = 0;
      shelf = 0;
    }
    if (y + ph > MAX_SHEET) {
      heights[sheet] = y;
      sheet++;
      x = 0;
      y = 0;
      shelf = 0;
    }
    places.push({ sheet, x: x + PADDING / 2, y: y + PADDING / 2 });
    x += pw;
    shelf = Math.max(shelf, ph);
    heights[sheet] = y + shelf;
  }
  return { places, heights };
}

/**
 * Packs `models` into `<outDir>/<name>-<n>.png` and `<outDir>/<name>.json`,
 * replacing the previous atlas files. Returns the files written with their sizes.
 * @param {Model[]} models
 * @param {string} outDir
 * @param {string} name
 */
export function writeAtlas(models, outDir, name) {
  models = [...models].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  /** @type {Frame[]} */
  const unique = [];
  /** @type {Map<string, number>} */
  const byHash = new Map();
  const indexOf = (/** @type {Frame} */ frame) => {
    const hash = createHash('sha1')
      .update(
        `${String(frame.image.width)}x${String(frame.image.height)}@${String(frame.ax)},${String(frame.ay)}`,
      )
      .update(frame.image.data)
      .digest('hex');
    let i = byHash.get(hash);
    if (i === undefined) {
      i = unique.length;
      unique.push(frame);
      byHash.set(hash, i);
    }
    return i;
  };
  const index = {
    version: ATLAS_VERSION,
    tilePx: 64,
    /** @type {string[]} */
    sheets: [],
    /** @type {number[][]} */
    frames: [],
    /** @type {Record<string, unknown>} */
    models: {},
  };
  for (const m of models) {
    index.models[m.name] = {
      footprint: m.footprint,
      directions: m.directions,
      points: m.points,
      shadow: m.shadow.map(indexOf),
      layers: m.layers.map((l) => ({
        name: l.name,
        fps: l.fps,
        show: l.show,
        advance: l.advance,
        frames: l.frames.map((fs) => fs.map(indexOf)),
      })),
    };
  }
  // Tallest first (then widest, then by key) packs shelves tightly and keeps the order stable.
  const order = [...unique.keys()].sort((a, b) => {
    const fa = unique[a];
    const fb = unique[b];
    return (
      fb.image.height - fa.image.height ||
      fb.image.width - fa.image.width ||
      (fa.key < fb.key ? -1 : fa.key > fb.key ? 1 : 0)
    );
  });
  const sizes = order.map((i) => ({ w: unique[i].image.width, h: unique[i].image.height }));
  let best = null;
  for (const width of [256, 512, 1024, 2048, 4096]) {
    const packed = shelfPack(sizes, width);
    if (!packed) continue;
    const area = packed.heights.reduce((s, h) => s + h * width, 0);
    // Prefer one sheet, then the smallest area, then the squarer sheet.
    const score = packed.heights.length * 1e9 + area + Math.abs(width - packed.heights[0]);
    if (!best || score < best.score) best = { width, packed, score };
  }
  if (!best) throw new Error('a frame is wider than the largest sheet');
  const { width, packed } = best;
  const sheets = packed.heights.map((h) => createImage(width, Math.ceil(h / 4) * 4));
  index.frames = new Array(unique.length);
  order.forEach((frameIndex, k) => {
    const frame = unique[frameIndex];
    const { sheet, x, y } = packed.places[k];
    blit(frame.image, 0, 0, frame.image.width, frame.image.height, sheets[sheet], x, y);
    index.frames[frameIndex] = [
      sheet,
      x,
      y,
      frame.image.width,
      frame.image.height,
      frame.ax,
      frame.ay,
    ];
  });
  for (const file of existsSync(outDir) ? readdirSync(outDir) : []) {
    if (new RegExp(`^${name}(-\\d+\\.png|\\.json)$`).test(file)) rmSync(join(outDir, file));
  }
  const written = [];
  sheets.forEach((sheet, i) => {
    const file = `${name}-${String(i)}.png`;
    const bytes = encodePng(sheet);
    writeFileSync(join(outDir, file), bytes);
    index.sheets.push(file);
    written.push({ file, width: sheet.width, height: sheet.height, bytes: bytes.length });
  });
  const json = `${JSON.stringify(index)}\n`;
  writeFileSync(join(outDir, `${name}.json`), json);
  written.push({ file: `${name}.json`, bytes: json.length });
  return written;
}

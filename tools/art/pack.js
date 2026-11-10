/**
 * Packs rendered sprite frames (art/build/<model>/, from art/blender/render.py)
 * into texture atlases plus a JSON index the game loads
 * (src/render/sprites.ts). See docs/ART.md for the format.
 *
 * Every model names the atlas it goes to (`entities`, `power`, `terrain`,
 * `icons`, ...); each atlas is its own set of files, so groups of models can
 * be re-rendered, reviewed and loaded separately.
 *
 * Sprite frames are trimmed to their visible pixels (on even texel
 * boundaries, so a sprite drawn at half scale lands on whole world pixels),
 * deduplicated, and shelf-packed into sheets of at most MAX_SHEET² texels.
 * Ground textures are written as they are, one PNG each (they repeat, so
 * they can't share a sheet). Item icons are box-filtered to half their
 * render size and laid out on a grid. Models that were not re-rendered are
 * carried over from the existing atlas, so one model can be re-rendered on
 * its own.
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
/** Item icons: grid cell and where the icon sits in it (texels); 8 cells per sheet row. */
const ICON_CELL = 64;
const ICON_INSET = 6;
const ICON_COLUMNS = 8;

/**
 * @typedef {{ key: string, image: import('./png.js').Image, ax: number, ay: number }} Frame
 *   A trimmed frame; `(ax, ay)` is where the footprint's center falls, relative to its top-left.
 * @typedef {{ name: string, fps: number, show: string, advance: string, frames: Frame[][] }} Layer
 *   One sprite layer, frames per direction.
 * @typedef {{ kind: 'sprite', name: string, atlas: string, footprint: number[], directions: number, points: Record<string, number[][]>, shadow: Frame[], layers: Layer[] }} Model
 * @typedef {{ kind: 'ground', name: string, atlas: string, period: number, image: import('./png.js').Image }} Ground
 *   A seamless ground texture of `period`² tiles.
 * @typedef {{ kind: 'icon', name: string, atlas: string, image: import('./png.js').Image }} Icon
 *   An item icon, keyed by item name.
 * @typedef {Model | Ground | Icon} Entry
 */

/**
 * Pixels at or below this alpha are dropped: invisible on screen (at most 2%
 * opacity, and shadows are drawn at half that), but the soft tails of a
 * shadow's penumbra would otherwise stretch its frame over mostly empty texels.
 */
const ALPHA_FLOOR = 6;

/**
 * Trims `image` to its pixels above ALPHA_FLOOR on ALIGN boundaries, clearing
 * the others; `shadow` frames become pure black with the alpha as rendered.
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
      if (data[i + 3] <= ALPHA_FLOOR) {
        data[i] = data[i + 1] = data[i + 2] = data[i + 3] = 0;
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
 * Halves an image with a 2×2 box filter on premultiplied alpha.
 * @param {import('./png.js').Image} image
 */
export function halve(image) {
  const out = createImage(image.width >> 1, image.height >> 1);
  const src = image.data;
  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [dx, dy] of [
        [0, 0],
        [1, 0],
        [0, 1],
        [1, 1],
      ]) {
        const i = ((2 * y + dy) * image.width + 2 * x + dx) * 4;
        const alpha = src[i + 3];
        r += src[i] * alpha;
        g += src[i + 1] * alpha;
        b += src[i + 2] * alpha;
        a += alpha;
      }
      const o = (y * out.width + x) * 4;
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
        out.data[o + 3] = Math.round(a / 4);
      }
    }
  }
  return out;
}

/**
 * Reads the renders of one model from `dir` (manifest.json and its PNGs).
 * @param {string} dir
 * @returns {Entry}
 */
export function readRenders(dir) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const atlas = String(manifest.atlas ?? 'entities');
  if (manifest.kind === 'ground') {
    return {
      kind: 'ground',
      name: manifest.name,
      atlas,
      period: manifest.period,
      image: decodePng(readFileSync(join(dir, 'ground.png'))),
    };
  }
  if (manifest.kind === 'icon') {
    return {
      kind: 'icon',
      name: manifest.item ?? manifest.name,
      atlas,
      image: halve(decodePng(readFileSync(join(dir, 'icon.png')))),
    };
  }
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
  // A shared layer is rendered for the first direction only and used for all of them.
  const shared = (/** @type {{ shared?: boolean }} */ l, /** @type {number} */ d) =>
    l.shared ? 0 : d;
  /** @type {Map<string, Frame>} */
  const loaded = new Map();
  const frameOf = (
    /** @type {string} */ layer,
    /** @type {number} */ d,
    /** @type {number} */ f,
  ) => {
    const key = `${layer}/${String(d)}/${String(f)}`;
    let frame = loaded.get(key);
    if (!frame) {
      frame = load(layer, d, f);
      loaded.set(key, frame);
    }
    return frame;
  };
  const shadow = (/** @type {number} */ d) => {
    const key = `${String(manifest.name)}/shadow/${String(d)}/0`;
    // Models whose body catches its own shadow have no shadow frame: an empty one.
    if (manifest.shadow === false) return trimFrame(createImage(2, 2), manifest.anchor, true, key);
    // A model that borrows another's shadow (`shadow_from`: a walk cycle uses its idle pose's)
    // reads that model's shadow and body; the packer then stores the shared frame once.
    const from = manifest.shadowFrom ? join(dir, '..', String(manifest.shadowFrom)) : dir;
    const donor =
      from === dir ? manifest : JSON.parse(readFileSync(join(from, 'manifest.json'), 'utf8'));
    const readDonor = (/** @type {string} */ layer, /** @type {number} */ n) =>
      decodePng(readFileSync(join(from, `${layer}-d${String(n)}-f0.png`)));
    // Shadow under the opaque parts of the body never shows: drop it, it only costs bytes.
    const image = readDonor('shadow', d);
    const body = readDonor(donor.layers[0].name, shared(donor.layers[0], d));
    for (let i = 3; i < image.data.length; i += 4) {
      if (body.data[i] === 255) image.data[i] = 0;
    }
    return trimFrame(image, manifest.anchor, true, key);
  };
  return {
    kind: 'sprite',
    name: manifest.name,
    atlas,
    footprint: manifest.footprint,
    directions: manifest.directions,
    points: manifest.points ?? {},
    shadow: dirs.map(shadow),
    layers: manifest.layers.map(
      (
        /** @type {{ name: string, frames: number, fps: number, show: string, advance: string, shared?: boolean }} */ l,
      ) => ({
        name: l.name,
        fps: l.fps,
        show: l.show,
        advance: l.advance,
        frames: dirs.map((d) =>
          [...Array(l.frames).keys()].map((f) => frameOf(l.name, shared(l, d), f)),
        ),
      }),
    ),
  };
}

/**
 * The names of the atlases in `outDir` (every `<name>.json` atlas index).
 * @param {string} outDir
 * @returns {string[]}
 */
export function atlasNames(outDir) {
  if (!existsSync(outDir)) return [];
  return readdirSync(outDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -5))
    .sort();
}

/**
 * Reads the models of an existing atlas back into frames, ground textures and icons.
 * @param {string} outDir
 * @param {string} name atlas name, e.g. `entities`
 * @returns {Entry[]}
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
  /** @type {Entry[]} */
  const entries = Object.entries(index.models).map(([model, m]) => ({
    kind: /** @type {const} */ ('sprite'),
    name: model,
    atlas: name,
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
  for (const [ground, g] of Object.entries(index.ground ?? {})) {
    const { file, period } = /** @type {{ file: string, period: number }} */ (g);
    entries.push({
      kind: 'ground',
      name: ground,
      atlas: name,
      period,
      image: decodePng(readFileSync(join(outDir, file))),
    });
  }
  if (index.icons) {
    const size = index.icons.size;
    for (const [item, [sheet, x, y]] of Object.entries(index.icons.items)) {
      const image = createImage(size, size);
      blit(sheets[sheet], x, y, size, size, image, 0, 0);
      entries.push({ kind: 'icon', name: item, atlas: name, image });
    }
  }
  return entries;
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
 * Deletes the files of atlas `name` in `outDir`: its index and the files the
 * index lists (sheets and ground textures).
 * @param {string} outDir
 * @param {string} name
 */
function removeAtlas(outDir, name) {
  const indexPath = join(outDir, `${name}.json`);
  if (!existsSync(indexPath)) return;
  const old = JSON.parse(readFileSync(indexPath, 'utf8'));
  const files = [
    ...(Array.isArray(old.sheets) ? old.sheets : []),
    ...Object.values(old.ground ?? {}).map((g) => /** @type {{ file: string }} */ (g).file),
  ];
  for (const file of files) {
    if (existsSync(join(outDir, file))) rmSync(join(outDir, file));
  }
  rmSync(indexPath);
}

const byName = (/** @type {{ name: string }} */ a, /** @type {{ name: string }} */ b) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

/**
 * Packs the sprite models into sheets; returns the sheets and fills `index`.
 * @param {Model[]} models
 * @param {{ frames: number[][], models: Record<string, unknown> }} index
 */
function packSprites(models, index) {
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
  if (unique.length === 0) return [];
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
  return sheets;
}

/**
 * Lays the icons out on a grid in one sheet (sheet number `sheet`); returns it.
 * @param {Icon[]} icons
 * @param {number} sheet
 * @param {{ icons?: { size: number, items: Record<string, number[]> } }} index
 */
function packIcons(icons, sheet, index) {
  const size = icons[0].image.width;
  if (size + ICON_INSET * 2 > ICON_CELL) throw new Error('icons are larger than their grid cell');
  const columns = Math.min(ICON_COLUMNS, icons.length);
  const rows = Math.ceil(icons.length / ICON_COLUMNS);
  const image = createImage(columns * ICON_CELL, rows * ICON_CELL);
  /** @type {Record<string, number[]>} */
  const items = {};
  icons.forEach((icon, i) => {
    if (icon.image.width !== size || icon.image.height !== size)
      throw new Error(`icon ${icon.name} is not ${String(size)}² like the others`);
    const x = (i % ICON_COLUMNS) * ICON_CELL + ICON_INSET;
    const y = Math.floor(i / ICON_COLUMNS) * ICON_CELL + ICON_INSET;
    blit(icon.image, 0, 0, size, size, image, x, y);
    items[icon.name] = [sheet, x, y];
  });
  index.icons = { size, items };
  return image;
}

/**
 * Packs `entries` into `<outDir>/<name>-<n>.png` (sprites, then icons),
 * `<outDir>/<name>-<ground>.png` (ground textures) and `<outDir>/<name>.json`,
 * replacing the previous files of that atlas (with `remove`, only deletes
 * them). Returns the files written with their sizes.
 * @param {Entry[]} entries
 * @param {string} outDir
 * @param {string} name
 */
export function writeAtlas(entries, outDir, name, { remove = false } = {}) {
  if (remove) {
    removeAtlas(outDir, name);
    return [];
  }
  const models = /** @type {Model[]} */ (entries.filter((e) => e.kind === 'sprite')).sort(byName);
  const grounds = /** @type {Ground[]} */ (entries.filter((e) => e.kind === 'ground')).sort(byName);
  const icons = /** @type {Icon[]} */ (entries.filter((e) => e.kind === 'icon')).sort(byName);
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
  const sheets = packSprites(models, index);
  if (icons.length > 0) sheets.push(packIcons(icons, sheets.length, index));
  if (grounds.length > 0) {
    /** @type {Record<string, { file: string, period: number }>} */
    const ground = {};
    for (const g of grounds) ground[g.name] = { file: `${name}-${g.name}.png`, period: g.period };
    Object.assign(index, { ground });
  }
  removeAtlas(outDir, name);
  const written = [];
  sheets.forEach((sheet, i) => {
    const file = `${name}-${String(i)}.png`;
    const bytes = encodePng(sheet);
    writeFileSync(join(outDir, file), bytes);
    index.sheets.push(file);
    written.push({ file, width: sheet.width, height: sheet.height, bytes: bytes.length });
  });
  for (const g of grounds) {
    const file = `${name}-${g.name}.png`;
    const bytes = encodePng(g.image);
    writeFileSync(join(outDir, file), bytes);
    written.push({ file, width: g.image.width, height: g.image.height, bytes: bytes.length });
  }
  const json = `${JSON.stringify(index)}\n`;
  writeFileSync(join(outDir, `${name}.json`), json);
  written.push({ file: `${name}.json`, bytes: json.length });
  return written;
}

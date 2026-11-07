/**
 * `npm run art [-- [options] [model ...]]`: renders the Blender sprite models
 * (art/blender/) and packs them into the atlases in public/sprites/. See docs/ART.md.
 *
 *   npm run art                        # render every model, rebuild the atlases from scratch
 *   npm run art -- stone-furnace       # re-render one model (or all variants of it), keep the others
 *   npm run art -- --pack-only         # re-pack the last renders in art/build/
 *   npm run art -- --preview           # also write art/build/preview-2x.png and preview-1x.png
 *   npm run art -- --samples 32        # quicker, noisier renders while iterating
 *   npm run art -- belts               # every model a module (art/blender/models/belts.py) defines
 *   npm run art -- terrain             # every model of an atlas
 *
 * Each model goes into the atlas its MODEL names (`atlas`, default
 * `entities`): public/sprites/<atlas>.json and <atlas>-<n>.png.
 *
 * Blender comes from $BLENDER (any Blender 4.2 LTS binary or wrapper script);
 * without it, ~/tools/blender.sh if it exists, else `blender` on the PATH.
 */

import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atlasNames, readAtlas, readRenders, writeAtlas } from './pack.js';
import { contactSheet, iconSheet } from './preview.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BUILD = join(ROOT, 'art', 'build');
const OUT = join(ROOT, 'public', 'sprites');
const DEFAULT_SAMPLES = 96;

function blenderCommand() {
  if (process.env.BLENDER) return process.env.BLENDER;
  const local = join(homedir(), 'tools', 'blender.sh');
  return existsSync(local) ? local : 'blender';
}

/** @param {string[]} args */
function parseArgs(args) {
  const options = {
    names: /** @type {string[]} */ ([]),
    samples: DEFAULT_SAMPLES,
    packOnly: false,
    preview: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--pack-only') options.packOnly = true;
    else if (arg === '--preview') options.preview = true;
    else if (arg === '--samples') options.samples = Number(args[++i]);
    else if (arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    else options.names.push(arg);
  }
  if (!Number.isInteger(options.samples) || options.samples < 1)
    throw new Error('--samples takes a positive integer');
  return options;
}

/**
 * Runs Blender headless on the render driver; shows only the driver's own lines and errors.
 * @param {string[]} names
 * @param {number} samples
 */
function render(names, samples) {
  const blender = blenderCommand();
  const args = [
    '-b',
    '--factory-startup',
    '-P',
    join(ROOT, 'art', 'blender', 'render.py'),
    '--',
    '--out',
    BUILD,
    '--samples',
    String(samples),
    ...names,
  ];
  return new Promise((done, fail) => {
    const child = spawn(blender, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const onData = (/** @type {Buffer} */ data) => {
      tail = (tail + data.toString()).slice(-4000);
      for (const line of data.toString().split('\n')) {
        if (line.startsWith('[art]') || /Error|Traceback/.test(line)) console.log(line);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      fail(
        new Error(
          `could not run Blender (${blender}): ${err.message}. Set BLENDER to a Blender 4.2 binary.`,
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) done(undefined);
      else fail(new Error(`Blender exited with ${String(code)}:\n${tail}`));
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const started = Date.now();
  if (!options.packOnly) {
    if (options.names.length === 0 && existsSync(BUILD)) rmSync(BUILD, { recursive: true });
    mkdirSync(BUILD, { recursive: true });
    await render(options.names, options.samples);
  }
  const rendered = existsSync(BUILD)
    ? readdirSync(BUILD).filter((d) => existsSync(join(BUILD, d, 'manifest.json')))
    : [];
  // The models rendered by this run; with --pack-only, every render in
  // art/build/, or those the names pick (a model, every variant of it, or a
  // whole atlas).
  const picked = (/** @type {string} */ dir) => {
    const path = join(BUILD, dir, 'manifest.json');
    if (!options.packOnly) return statSync(path).mtimeMs >= started - 1000;
    if (options.names.length === 0) return true;
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    return [manifest.name, manifest.base, manifest.atlas ?? 'entities'].some((n) =>
      options.names.includes(n),
    );
  };
  const fresh = rendered.filter(picked).map((n) => readRenders(join(BUILD, n)));
  const freshNames = new Set(fresh.map((e) => e.name));
  // Each atlas with fresh renders is rewritten: from scratch after a full render;
  // a partial one (or --pack-only) keeps the atlas' other models.
  const atlases = [...new Set(fresh.map((e) => e.atlas))].sort();
  mkdirSync(OUT, { recursive: true });
  if (options.names.length === 0 && !options.packOnly) {
    // After a full render: atlases no model goes into any more.
    for (const atlas of atlasNames(OUT)) {
      if (!atlases.includes(atlas)) writeAtlas([], OUT, atlas, { remove: true });
    }
  }
  for (const atlas of atlases) {
    const entries = fresh.filter((e) => e.atlas === atlas);
    if (options.names.length > 0 || options.packOnly) {
      for (const old of readAtlas(OUT, atlas)) {
        if (!freshNames.has(old.name)) entries.push(old);
      }
    }
    for (const file of writeAtlas(entries, OUT, atlas)) {
      const size = file.width ? ` ${String(file.width)}x${String(file.height)}` : '';
      console.log(
        `[art] public/sprites/${file.file}${size}, ${(file.bytes / 1024).toFixed(1)} KiB`,
      );
    }
  }
  if (options.preview) {
    const shown = options.names.length > 0 ? freshNames : null;
    const all = atlases.flatMap((atlas) => readAtlas(OUT, atlas));
    const models = /** @type {import('./pack.js').Model[]} */ (
      all.filter((e) => e.kind === 'sprite' && (!shown || shown.has(e.name)))
    );
    const icons = /** @type {import('./pack.js').Icon[]} */ (
      all.filter((e) => e.kind === 'icon' && (!shown || shown.has(e.name)))
    );
    mkdirSync(BUILD, { recursive: true });
    if (models.length > 0) {
      const sheet = contactSheet(models);
      writeFileSync(join(BUILD, 'preview-2x.png'), sheet.full);
      writeFileSync(join(BUILD, 'preview-1x.png'), sheet.half);
      console.log('[art] art/build/preview-2x.png, art/build/preview-1x.png');
    }
    if (icons.length > 0) {
      writeFileSync(join(BUILD, 'preview-icons.png'), iconSheet(icons));
      console.log('[art] art/build/preview-icons.png');
    }
  }
  console.log(`[art] done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

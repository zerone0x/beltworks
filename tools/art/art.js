/**
 * `npm run art [-- [options] [model ...]]`: renders the Blender sprite models
 * (art/blender/) and packs them into public/sprites/. See docs/ART.md.
 *
 *   npm run art                        # render every model, rebuild the atlas from scratch
 *   npm run art -- stone-furnace       # re-render one model, keep the others from the atlas
 *   npm run art -- --pack-only         # re-pack the last renders in art/build/
 *   npm run art -- --preview           # also write art/build/preview-2x.png and preview-1x.png
 *   npm run art -- --samples 32        # quicker, noisier renders while iterating
 *
 * Blender comes from $BLENDER (any Blender 4.2 LTS binary or wrapper script);
 * without it, ~/tools/blender.sh if it exists, else `blender` on the PATH.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAtlas, readRenders, writeAtlas } from './pack.js';
import { contactSheet } from './preview.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BUILD = join(ROOT, 'art', 'build');
const OUT = join(ROOT, 'public', 'sprites');
const ATLAS = 'entities';
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
  const fresh = rendered.filter((n) => options.names.length === 0 || options.names.includes(n));
  const models = fresh.map((n) => readRenders(join(BUILD, n)));
  // A full render rebuilds the atlas from scratch; a partial one keeps the other models.
  if (options.names.length > 0 || options.packOnly) {
    for (const old of readAtlas(OUT, ATLAS)) {
      if (!fresh.includes(old.name)) models.push(old);
    }
  }
  mkdirSync(OUT, { recursive: true });
  for (const file of writeAtlas(models, OUT, ATLAS)) {
    const size = file.width ? ` ${String(file.width)}x${String(file.height)}` : '';
    console.log(`[art] public/sprites/${file.file}${size}, ${(file.bytes / 1024).toFixed(1)} KiB`);
  }
  if (options.preview) {
    const sheet = contactSheet(readAtlas(OUT, ATLAS));
    mkdirSync(BUILD, { recursive: true });
    writeFileSync(join(BUILD, 'preview-2x.png'), sheet.full);
    writeFileSync(join(BUILD, 'preview-1x.png'), sheet.half);
    console.log('[art] art/build/preview-2x.png, art/build/preview-1x.png');
  }
  console.log(`[art] done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

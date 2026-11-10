#!/usr/bin/env node
/**
 * Turns the frames `capture.mjs` wrote into an mp4 (demo/gpu/README.md,
 * "Capture and benchmark"): `out/gpu-demo/frames/frame-*.png` to
 * `out/gpu-demo/gpu-demo.mp4`, H.264 (or MPEG-4 part 2 if the ffmpeg build has
 * no libx264), yuv420p so every player takes it.
 *
 *   node tools/gpu-demo/assemble.mjs [--fps 30] [--out out/gpu-demo]
 *
 * It looks for ffmpeg in `FFMPEG`, then on `PATH`, then the build Playwright
 * downloads (`~/.cache/ms-playwright/ffmpeg-*`, or under
 * `PLAYWRIGHT_BROWSERS_PATH`), and takes the first that can read PNG and write
 * mp4. Playwright's own build is a minimal one for its video recording (it
 * writes VP8 WebM only), so on most machines it is found but can't do this;
 * the script says what each candidate lacks.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, relative, resolve } from 'node:path';
import { ROOT, parseArgs } from './common.mjs';

const args = parseArgs({ fps: 30, out: 'out/gpu-demo' });
const out = resolve(ROOT, args.out);
const framesDir = join(out, 'frames');
const frames = existsSync(framesDir)
  ? readdirSync(framesDir).filter((f) => /^frame-\d{5}\.png$/.test(f))
  : [];
if (frames.length === 0) {
  throw new Error(`no frames in ${framesDir}; run node tools/gpu-demo/capture.mjs first`);
}

/** Every ffmpeg binary worth trying, in order, without duplicates. */
function candidates() {
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const list = [];
  if (process.env.FFMPEG) list.push(process.env.FFMPEG);
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir) list.push(join(dir, exe));
  }
  const caches = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), '.cache', 'ms-playwright'),
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ms-playwright'),
  ];
  for (const cache of caches) {
    if (!cache || !existsSync(cache)) continue;
    const dirs = readdirSync(cache)
      .filter((d) => d.startsWith('ffmpeg-'))
      .sort()
      .reverse();
    for (const d of dirs) {
      for (const name of ['ffmpeg-linux', 'ffmpeg-mac', 'ffmpeg-win64.exe', 'ffmpeg']) {
        list.push(join(cache, d, name));
      }
    }
  }
  return [...new Set(list)].filter((p) => existsSync(p) && statSync(p).isFile());
}

/** @param {string} bin @param {string} what */
function probe(bin, what) {
  try {
    return execFileSync(bin, ['-hide_banner', `-${what}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return '';
  }
}

/**
 * What `bin` lacks for PNG frames to mp4, or the encoder to use.
 * @param {string} bin
 * @returns {{ encoder: string } | { missing: string[] }}
 */
function capabilities(bin) {
  const has = (/** @type {string} */ list, /** @type {string} */ name) =>
    new RegExp(`^\\s*\\S+\\s+${name}\\s`, 'm').test(list);
  const decoders = probe(bin, 'decoders');
  const encoders = probe(bin, 'encoders');
  const muxers = probe(bin, 'muxers');
  const missing = [];
  if (!has(decoders, 'png')) missing.push('png decoder');
  if (!has(muxers, 'mp4')) missing.push('mp4 muxer');
  const encoder = ['libx264', 'mpeg4'].find((e) => has(encoders, e));
  if (!encoder) missing.push('libx264 or mpeg4 encoder');
  return missing.length > 0 || !encoder ? { missing } : { encoder };
}

let ffmpeg = '';
let encoder = '';
for (const bin of candidates()) {
  const caps = capabilities(bin);
  if ('encoder' in caps) {
    ffmpeg = bin;
    encoder = caps.encoder;
    break;
  }
  console.log(`skipping ${bin}: no ${caps.missing.join(', no ')}`);
}
if (!ffmpeg) {
  throw new Error(
    'no ffmpeg that can turn PNG frames into an mp4 was found; install one, or point FFMPEG at it',
  );
}

const mp4 = join(out, 'gpu-demo.mp4');
const quality = encoder === 'libx264' ? ['-preset', 'medium', '-crf', '18'] : ['-q:v', '2'];
console.log(`ffmpeg: ${ffmpeg} (${encoder})`);
execFileSync(
  ffmpeg,
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-framerate',
    String(args.fps),
    '-i',
    join(framesDir, 'frame-%05d.png'),
    '-c:v',
    encoder,
    ...quality,
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    mp4,
  ],
  { stdio: 'inherit' },
);

// ffmpeg prints the container's duration when asked to read the file with no output.
let duration = '';
try {
  execFileSync(ffmpeg, ['-hide_banner', '-i', mp4], { stdio: ['ignore', 'ignore', 'pipe'] });
} catch (e) {
  const stderr = /** @type {{ stderr?: Buffer }} */ (e).stderr?.toString() ?? '';
  duration = /Duration: ([\d:.]+)/.exec(stderr)?.[1] ?? '';
}
const bytes = statSync(mp4).size;
console.log(
  `wrote ${relative(ROOT, mp4)}: ${String(frames.length)} frames at ${String(args.fps)} fps, ` +
    `${duration || `${(frames.length / args.fps).toFixed(2)} s`}, ${(bytes / 1024).toFixed(0)} KiB`,
);

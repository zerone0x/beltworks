#!/usr/bin/env node
/**
 * Turns the frames `capture.mjs` wrote into an mp4 (demo/gpu/README.md,
 * "Capture and benchmark"): `out/gpu-demo/frames/frame-*.png` to
 * `out/gpu-demo/gpu-demo.mp4`, H.264 (or MPEG-4 part 2 if the ffmpeg build has
 * no libx264), yuv420p so every player takes it.
 *
 *   node tools/gpu-demo/assemble.mjs [--fps 30] [--out out/gpu-demo] [--crf 18]
 *     [--name gpu-demo.mp4]
 *
 * `--crf` is libx264's quality (lower is better and bigger; the film uses 26).
 * `--name` is the mp4's file name in `--out`.
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
import { join, relative, resolve } from 'node:path';
import { ROOT, findFfmpeg, parseArgs } from './common.mjs';

const args = parseArgs({ fps: 30, out: 'out/gpu-demo', crf: 18, name: 'gpu-demo.mp4' });
const out = resolve(ROOT, args.out);
const framesDir = join(out, 'frames');
const frames = existsSync(framesDir)
  ? readdirSync(framesDir).filter((f) => /^frame-\d{5}\.png$/.test(f))
  : [];
if (frames.length === 0) {
  console.error(`No frames in ${framesDir}. Run node tools/gpu-demo/capture.mjs first.`);
  process.exit(1);
}

const { ffmpeg, encoder } = findFfmpeg();

const mp4 = join(out, args.name);
const quality =
  encoder === 'libx264' ? ['-preset', 'medium', '-crf', String(args.crf)] : ['-q:v', '2'];
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

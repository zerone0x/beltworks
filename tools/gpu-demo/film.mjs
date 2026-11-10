#!/usr/bin/env node
/**
 * Records the demo film (demo/gpu/README.md, "The film"): one million items,
 * the scripted camera (the whole factory, into the splitter, a belt rotated
 * and back, out again) and the end card, then an mp4.
 *
 *   node tools/gpu-demo/film.mjs [--n 1000000] [--seconds 24] [--fps 15]
 *     [--steps 4] [--crf 26] [--out out/gpu-demo/film] [--retries 5]
 *     [--fresh] [--assemble-only]
 *
 * It runs `capture.mjs --film --resume`, so it can be stopped and started
 * again at any time: frames already on disk are kept, and the capture
 * carries on from the first missing one. A capture that fails (a lost GPU
 * device, a crashed browser) is retried up to `--retries` times, each
 * resuming. Then `assemble.mjs` writes `<out>/gpu-demo-film.mp4`. `--fresh`
 * deletes the frames first.
 *
 * The defaults fit a software adapter: SwiftShader takes seconds per frame at
 * one million items, so 15 fps with 4 ticks per frame (the game's 60 ticks
 * per second) halves the frames of a 30 fps film at the same speed; 24 s is
 * 360 frames.
 */

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ROOT, parseArgs } from './common.mjs';

const args = parseArgs({
  n: 1_000_000,
  seconds: 24,
  fps: 15,
  steps: 4,
  crf: 26,
  out: 'out/gpu-demo/film',
  retries: 5,
  fresh: false,
  'assemble-only': false,
  url: '',
});
const frames = Math.round(args.seconds * args.fps);
if (frames < 2) throw new Error('--seconds * --fps must give at least 2 frames');
const out = resolve(ROOT, args.out);
if (args.fresh) rmSync(join(out, 'frames'), { recursive: true, force: true });

/** @param {string} script @param {string[]} flags */
const run = (script, flags) =>
  spawnSync(process.execPath, [join(ROOT, 'tools', 'gpu-demo', script), ...flags], {
    stdio: 'inherit',
    cwd: ROOT,
  }).status;

if (!args['assemble-only']) {
  const flags = [
    '--film',
    '--resume',
    '--n',
    String(args.n),
    '--frames',
    String(frames),
    '--steps',
    String(args.steps),
    '--out',
    out,
    ...(args.url ? ['--url', args.url] : []),
  ];
  let status = run('capture.mjs', flags);
  for (let attempt = 1; status !== 0 && attempt <= args.retries; attempt++) {
    console.log(`capture failed (exit ${String(status)}); resuming, attempt ${String(attempt)}`);
    status = run('capture.mjs', flags);
  }
  if (status !== 0) process.exit(status ?? 1);
}
const status = run('assemble.mjs', [
  '--fps',
  String(args.fps),
  '--crf',
  String(args.crf),
  '--out',
  out,
  '--name',
  'gpu-demo-film.mp4',
]);
process.exit(status ?? 1);

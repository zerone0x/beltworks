#!/usr/bin/env node
/**
 * Records the GPU demo frame by frame (demo/gpu/README.md, "Capture and
 * benchmark"): opens the page in capture mode (`?capture=1`), where nothing
 * moves on its own, and for every frame calls `window.__step(k)` (k ticks, one
 * frame, resolved when the GPU is done) and takes a 1280x720 screenshot.
 * Frames go to `out/gpu-demo/frames/frame-00000.png` onwards; `assemble.mjs`
 * turns them into an mp4.
 *
 * The same flags give byte-identical frames: the item state is integer, the
 * steps are exact, and by default the overlay leaves out the measured step
 * time (`--timing` puts it in, which makes frames differ between runs). The
 * step times always go to `capture.json`.
 *
 *   node tools/gpu-demo/capture.mjs [--n 1000000] [--frames 60] [--steps 2]
 *     [--timing] [--url http://localhost:5173/demo/gpu/] [--out out/gpu-demo]
 *     [--timeout 600000]
 *
 * `--steps` is ticks per frame: 2 at 30 fps plays at the game's 60 ticks/s.
 * Without `--url` it starts a Vite dev server. `GPU_CHROME` picks the Chromium
 * binary (see playwright.gpu.config.ts).
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ROOT, demoServer, launchBrowser, openDemo, parseArgs } from './common.mjs';

const args = parseArgs({
  n: 1_000_000,
  frames: 60,
  steps: 2,
  timing: false,
  url: '',
  out: 'out/gpu-demo',
  timeout: 600_000,
});
if (!Number.isSafeInteger(args.frames) || args.frames < 1) throw new Error('--frames must be >= 1');
if (!Number.isSafeInteger(args.steps) || args.steps < 0) throw new Error('--steps must be >= 0');

const out = resolve(ROOT, args.out);
const framesDir = join(out, 'frames');
mkdirSync(framesDir, { recursive: true });
for (const f of readdirSync(framesDir)) if (f.endsWith('.png')) rmSync(join(framesDir, f));

/** @param {Buffer} bytes */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** @param {number} i */
const frameName = (i) => `frame-${String(i).padStart(5, '0')}.png`;

const server = await demoServer(args.url);
const browser = await launchBrowser();
const started = Date.now();
try {
  const query = `capture=1&n=${String(args.n)}${args.timing ? '' : '&timing=0'}`;
  const { page, adapter, items } = await openDemo(browser, server.url, query, args.timeout);
  console.log(
    `capturing ${String(args.frames)} frames of ${items.toLocaleString('en-US')} items, ` +
      `${String(args.steps)} ticks per frame, adapter: ${adapter}`,
  );
  /** @type {{ frame: number, tick: number, msPerStep: number | null, source: string | null }[]} */
  const log = [];
  for (let i = 0; i < args.frames; i++) {
    // Frame 0 is the start (tick 0), as the page drew it; every later frame is `steps` ticks on.
    const k = i === 0 ? 0 : args.steps;
    const r = await page.evaluate((k) => window.__step(k), k);
    // Let the compositor show the new frame before the screenshot (no timing involved).
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    await page.screenshot({ path: join(framesDir, frameName(i)), animations: 'disabled' });
    log.push({
      frame: i,
      tick: r.tick,
      msPerStep: r.timing?.msPerStep ?? null,
      source: r.timing?.source ?? null,
    });
    if (i === 0 || (i + 1) % 10 === 0 || i === args.frames - 1) {
      const t = r.timing ? `, ${r.timing.msPerStep.toFixed(2)} ms/step (${r.timing.source})` : '';
      console.log(`frame ${String(i + 1)}/${String(args.frames)}: tick ${String(r.tick)}${t}`);
    }
  }
  const first = readFileSync(join(framesDir, frameName(0)));
  const last = readFileSync(join(framesDir, frameName(args.frames - 1)));
  const summary = {
    items,
    adapter,
    frames: args.frames,
    ticksPerFrame: args.steps,
    timingInOverlay: args.timing,
    firstFrame: { file: frameName(0), sha256: sha256(first) },
    lastFrame: { file: frameName(args.frames - 1), sha256: sha256(last) },
    seconds: (Date.now() - started) / 1000,
    log,
  };
  writeFileSync(join(out, 'capture.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `wrote ${String(args.frames)} frames to ${relative(ROOT, framesDir) || '.'} ` +
      `in ${summary.seconds.toFixed(0)} s`,
  );
  console.log(`first ${summary.firstFrame.file} sha256 ${summary.firstFrame.sha256}`);
  console.log(`last  ${summary.lastFrame.file} sha256 ${summary.lastFrame.sha256}`);
} finally {
  await browser.close();
  await server.close();
}

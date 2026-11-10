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
 *     [--timing] [--film] [--resume] [--url http://localhost:5173/demo/gpu/]
 *     [--out out/gpu-demo] [--timeout 600000]
 *
 * `--film` uses the scripted film camera (`?camera=film`), timed to end on
 * the last frame. `--resume` keeps the frames already in the output folder
 * and captures only the missing ones: it steps straight to the tick before a
 * missing frame, which gives the same picture as getting there frame by frame, so a
 * capture cut off by a restart carries on where it stopped. It refuses to mix
 * frames of different settings (`settings.json`). Each frame's log line is
 * appended to `log.jsonl` as it is written.
 *
 * `--steps` is ticks per frame: 2 at 30 fps plays at the game's 60 ticks/s.
 * Without `--url` it starts a Vite dev server. `GPU_CHROME` picks the Chromium
 * binary (see playwright.gpu.config.ts).
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { ROOT, demoServer, launchBrowser, openDemo, parseArgs } from './common.mjs';

const args = parseArgs({
  n: 1_000_000,
  frames: 60,
  steps: 2,
  timing: false,
  film: false,
  resume: false,
  url: '',
  out: 'out/gpu-demo',
  timeout: 600_000,
});
if (!Number.isSafeInteger(args.frames) || args.frames < 1) throw new Error('--frames must be >= 1');
if (!Number.isSafeInteger(args.steps) || args.steps < 0) throw new Error('--steps must be >= 0');

const out = resolve(ROOT, args.out);
const framesDir = join(out, 'frames');
const settingsFile = join(out, 'settings.json');
const logFile = join(out, 'log.jsonl');
mkdirSync(framesDir, { recursive: true });
// What makes a frame's picture: frames captured with other settings must not be mixed in.
const settings = {
  n: args.n,
  frames: args.frames,
  steps: args.steps,
  timing: args.timing,
  film: args.film,
};
if (args.resume && existsSync(settingsFile)) {
  const before = readFileSync(settingsFile, 'utf8');
  if (before !== JSON.stringify(settings)) {
    throw new Error(
      `--resume: ${relative(ROOT, settingsFile)} says ${before}, not ${JSON.stringify(settings)}; ` +
        'use the same flags, or capture again without --resume',
    );
  }
}
if (!args.resume) {
  for (const f of readdirSync(framesDir)) if (f.endsWith('.png')) rmSync(join(framesDir, f));
  rmSync(logFile, { force: true });
}
writeFileSync(settingsFile, JSON.stringify(settings));

/** @param {Buffer} bytes */
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
/** @param {number} i */
const frameName = (i) => `frame-${String(i).padStart(5, '0')}.png`;

const server = await demoServer(args.url);
const browser = await launchBrowser();
const started = Date.now();
try {
  // The film ends on the last frame: frame i is tick i * steps.
  const filmTicks = Math.max(1, (args.frames - 1) * args.steps);
  const query =
    `capture=1&n=${String(args.n)}${args.timing ? '' : '&timing=0'}` +
    (args.film ? `&camera=film&filmticks=${String(filmTicks)}` : '');
  const { page, adapter, items } = await openDemo(browser, server.url, query, args.timeout);
  console.log(
    `capturing ${String(args.frames)} frames of ${items.toLocaleString('en-US')} items, ` +
      `${String(args.steps)} ticks per frame, adapter: ${adapter}`,
  );
  let tick = 0;
  let captured = 0;
  for (let i = 0; i < args.frames; i++) {
    if (args.resume && existsSync(join(framesDir, frameName(i)))) continue;
    // Frame i is tick i * steps. Frame 0 is the start, as the page drew it. After skipped
    // frames, step straight to the frame before (the same state, network and camera as frame
    // by frame), then the usual `steps`, so the overlay's "ticks for this frame" matches too.
    const jump = i * args.steps - tick - (i === 0 ? 0 : args.steps);
    if (jump > 0) await page.evaluate((k) => window.__step(k), jump);
    const r = await page.evaluate((k) => window.__step(k), i === 0 ? 0 : args.steps);
    tick = r.tick;
    // Let the compositor show the new frame before the screenshot (no timing involved).
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    // Write to a temporary name first, so a cut-off run never leaves half a frame behind.
    const partial = join(framesDir, `partial-${frameName(i)}`);
    await page.screenshot({ path: partial, animations: 'disabled' });
    renameSync(partial, join(framesDir, frameName(i)));
    captured++;
    const entry = {
      frame: i,
      tick: r.tick,
      msPerStep: r.timing?.msPerStep ?? null,
      source: r.timing?.source ?? null,
      zoom: r.camera.zoom,
    };
    appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
    if (captured === 1 || (i + 1) % 10 === 0 || i === args.frames - 1) {
      const t = r.timing ? `, ${r.timing.msPerStep.toFixed(2)} ms/step (${r.timing.source})` : '';
      console.log(`frame ${String(i + 1)}/${String(args.frames)}: tick ${String(r.tick)}${t}`);
    }
  }
  /** @type {Map<number, { frame: number, tick: number, msPerStep: number | null, source: string | null, zoom: number }>} */
  const byFrame = new Map();
  for (const line of readFileSync(logFile, 'utf8').split('\n')) {
    if (line.trim()) byFrame.set(JSON.parse(line).frame, JSON.parse(line));
  }
  const log = [...byFrame.values()].sort((a, b) => a.frame - b.frame);
  const first = readFileSync(join(framesDir, frameName(0)));
  const last = readFileSync(join(framesDir, frameName(args.frames - 1)));
  const summary = {
    items,
    adapter,
    frames: args.frames,
    ticksPerFrame: args.steps,
    timingInOverlay: args.timing,
    film: args.film,
    capturedThisRun: captured,
    firstFrame: { file: frameName(0), sha256: sha256(first) },
    lastFrame: { file: frameName(args.frames - 1), sha256: sha256(last) },
    seconds: (Date.now() - started) / 1000,
    log,
  };
  writeFileSync(join(out, 'capture.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `wrote ${String(captured)} of ${String(args.frames)} frames to ${relative(ROOT, framesDir) || '.'} ` +
      `in ${summary.seconds.toFixed(0)} s`,
  );
  console.log(`first ${summary.firstFrame.file} sha256 ${summary.firstFrame.sha256}`);
  console.log(`last  ${summary.lastFrame.file} sha256 ${summary.lastFrame.sha256}`);
} finally {
  await browser.close();
  await server.close();
}

#!/usr/bin/env node
/**
 * Records the promo footage of the demo factory (docs/TOOLING.md, "Promo
 * capture"; D72): `npm run capture:promo`.
 *
 * It builds the game in test mode (for the test hook's capture mode), opens
 * `?demo` in headless Chromium at 1920x1080, and records the shots of
 * shots.mjs frame by frame: the simulation and the page's drawing are paused
 * (`window.__beltworks.capture`), and every frame runs one tick (or
 * `ticksPerFrame`), draws once at an exact 1/60 s step and takes a
 * screenshot, which goes straight into ffmpeg (no frames on disk). The camera
 * follows the shot's eased path; the HUD is hidden, or shows only the
 * research bar (the `-hud` variants) or the power panel (the power shot).
 * The same flags give the same footage: the factory is built through
 * commands and the frames are stepped, not timed.
 *
 * Into `--out` (default `promo/out/`, git-ignored):
 * - `shots/<shot>.mp4` (and `<shot>-hud.mp4`): H.264, 60 fps, CRF `--crf`
 *   (12: high bitrate, for editing);
 * - `reel.mp4` and `reel-hud.mp4`: the highlight reel, simple cuts, no sound;
 * - `stills/<shot>.png`: one full-size frame of each shot;
 * - `readme.gif`: the README clip; `counts.json` and `counts.md`: what the
 *   factory mined, made and used up during each shot, measured in the game
 *   over the shot's own ticks.
 * `--readme` also writes the README clip to docs/demo-factory.gif and
 * 1280x720 copies of the stills (256 colours) to
 * docs/screenshots/demo-<shot>.png.
 *
 *   node tools/promo/capture.mjs [--out promo/out] [--shots a-wide,f-labs]
 *     [--width 1920] [--height 1080] [--crf 12] [--ui-scale 1.5] [--readme]
 *     [--url http://localhost:4173/] [--max-seconds 2] [--timeout 900000]
 *
 * `--max-seconds` shortens every shot (a quick preview; the camera moves
 * faster). Without `--url` it builds into out/promo-dist/ and serves that. Chromium:
 * `PROMO_CHROME` (or `GPU_CHROME`) picks the binary; ffmpeg as in
 * tools/gpu-demo (`FFMPEG`, else `PATH`), with libx264.
 */

import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { ROOT, findFfmpeg, parseArgs } from '../gpu-demo/common.mjs';
import { README_CLIP, REEL, SHOTS, cameraAt } from './shots.mjs';

const args = parseArgs({
  out: 'promo/out',
  shots: '',
  width: 1920,
  height: 1080,
  crf: 12,
  'ui-scale': 1.5,
  readme: false,
  url: '',
  'max-seconds': 0,
  'assemble-only': false,
  'gif-width': 600,
  'gif-fps': 10,
  'gif-colors': 64,
  timeout: 900_000,
});
const FPS = 60;
const TILE_PX = 32;
const RESEARCH = 'automation-2';
const out = resolve(ROOT, args.out);
for (const dir of ['shots', 'stills']) mkdirSync(join(out, dir), { recursive: true });
const { ffmpeg } = findFfmpeg();
const wanted = args.shots ? new Set(String(args.shots).split(',')) : null;
const shots = SHOTS.filter((s) => !wanted || wanted.has(s.name));

/** Runs ffmpeg with `argv`; resolves once it exits cleanly. */
function run(argv) {
  return new Promise((done, fail) => {
    const p = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...argv], {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    p.on('exit', (code) => (code === 0 ? done() : fail(new Error(`ffmpeg exited with ${code}`))));
  });
}

/**
 * An ffmpeg encoding the frames written to it into an H.264 mp4 at 60 fps:
 * PNG screenshots, or (`raw`) the canvas's RGBA pixels, bottom row first.
 */
function encoder(file, raw = false) {
  const input = raw
    ? ['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${args.width}x${args.height}`]
    : ['-f', 'image2pipe', '-c:v', 'png'];
  const p = spawn(
    ffmpeg,
    [
      ...['-hide_banner', '-loglevel', 'error', '-y'],
      ...input,
      ...['-framerate', String(FPS), '-i', '-'],
      ...(raw ? ['-vf', 'vflip'] : []),
      ...['-c:v', 'libx264', '-preset', 'slow', '-crf', String(args.crf)],
      ...['-pix_fmt', 'yuv420p', '-movflags', '+faststart', file],
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  const exited = new Promise((done, fail) => {
    p.on('exit', (code) => (code === 0 ? done() : fail(new Error(`ffmpeg exited with ${code}`))));
  });
  return {
    /** @param {Buffer} frame */
    write: (frame) =>
      new Promise((done) => {
        if (p.stdin.write(frame)) done();
        else p.stdin.once('drain', done);
      }),
    end: () => {
      p.stdin.end();
      return exited;
    },
  };
}

/** Writes RGBA pixels (bottom row first) to `file` as a PNG. */
const rawToPng = (rgba, file) =>
  new Promise((done, fail) => {
    const p = spawn(
      ffmpeg,
      [
        ...['-hide_banner', '-loglevel', 'error', '-y'],
        ...['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${args.width}x${args.height}`, '-i', '-'],
        ...['-vf', 'vflip', '-frames:v', '1', file],
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    p.on('exit', (code) => (code === 0 ? done() : fail(new Error(`ffmpeg exited with ${code}`))));
    p.stdin.end(rgba);
  });

/** The game, built in test mode and served here, unless `--url` points at one. */
async function server() {
  if (args.url) return { url: args.url, close: async () => {} };
  const { build, preview } = await import('vite');
  const outDir = join(ROOT, 'out', 'promo-dist');
  await build({ root: ROOT, mode: 'test', base: '/', logLevel: 'warn', build: { outDir } });
  const server = await preview({
    root: ROOT,
    mode: 'test',
    base: '/',
    logLevel: 'warn',
    build: { outDir },
    preview: { host: 'localhost', port: 4460, strictPort: false },
  });
  const url = server.resolvedUrls?.local[0];
  if (!url) throw new Error('the preview server has no local URL');
  return { url, close: () => server.close() };
}

const MB = (file) => `${(statSync(file).size / 1024 / 1024).toFixed(1)} MB`;

/** Opens the demo and records every shot; returns what each shot counted. */
async function record() {
  const { url, close } = await server();
  const browser = await chromium.launch({
    executablePath: process.env.PROMO_CHROME || process.env.GPU_CHROME || undefined,
    args: [
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--ignore-gpu-blocklist',
      '--no-sandbox',
    ],
  });
  const page = await browser.newPage({
    viewport: { width: args.width, height: args.height },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(args.timeout);
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`page console: ${m.text()}`);
  });
  const start = new URL(url);
  start.search = '?demo&art=1';
  console.log(`opening ${start.href}`);
  await page.goto(start.href);
  await page.waitForFunction(
    () => {
      const hook = window.__beltworks;
      return (
        !!hook && hook.latestTick() > 0 && hook.terrainReady() && hook.sprites().models.length > 0
      );
    },
    null,
    { timeout: args.timeout },
  );

  const capture = {
    enter: (hud) =>
      page.evaluate((o) => window.__beltworks.capture.enter(o), { hud, uiScale: args['ui-scale'] }),
    step: (ticks) => page.evaluate((t) => window.__beltworks.capture.step(t), ticks),
    /** Steps and reads the frame back from the canvas (the HUD isn't in it). */
    stepPixels: async (ticks) => {
      const frame = await page.evaluate((t) => window.__beltworks.capture.stepPixels(t), ticks);
      if (frame.width !== args.width || frame.height !== args.height) {
        throw new Error(
          `the canvas is ${frame.width}x${frame.height}, not ${args.width}x${args.height}`,
        );
      }
      return Buffer.from(frame.rgba, 'base64');
    },
    production: (reset) => page.evaluate((r) => window.__beltworks.capture.production(r), reset),
    camera: (c) =>
      page.evaluate(
        ([x, y, z]) => window.__beltworks.setCamera(x, y, z),
        [c.x * TILE_PX, c.y * TILE_PX, c.zoom],
      ),
    /** Automation 2's progress, and what the labs research now (the next technology after it). */
    research: () =>
      page.evaluate((name) => {
        const r = window.__beltworks.research();
        return {
          current: r.current,
          currentUnits: r.techs[r.current]?.unitsDone ?? 0,
          ...r.techs[name],
        };
      }, RESEARCH),
  };
  await capture.enter('none');
  await capture.step(1);

  const results = [];
  for (const shot of shots) {
    const seconds =
      args['max-seconds'] > 0 ? Math.min(shot.seconds, args['max-seconds']) : shot.seconds;
    const frames = Math.round(seconds * FPS);
    const ticks = shot.ticksPerFrame ?? 1;
    console.log(`${shot.name}: ${shot.title}`);
    // Unrecorded: run on to where the shot starts.
    if (shot.untilUnits !== undefined) {
      while ((await capture.research()).unitsDone < shot.untilUnits) await capture.step(300);
    }
    // Let the terrain under the whole camera path bake before recording.
    for (const key of [shot.to, shot.from]) {
      await capture.camera(key);
      for (let i = 0; i < 20; i++) await capture.step(1);
    }
    await capture.enter(shot.openPole ? 'panels' : 'none');
    if (shot.openPole) {
      const at = await page.evaluate(
        ({ x, y }) => window.__beltworks.tileToScreen(x, y),
        shot.openPole,
      );
      await page.mouse.click(at.x, at.y);
      // The game takes the click on its next frame, where the pointer is then.
      await capture.step(1);
      // The pointer rests on an empty tile, out of the way (no hover box).
      await page.mouse.move(args.width - 2, args.height - 2);
      for (let i = 0; i < 120; i++) await capture.step(1);
    }
    await capture.production(true);
    const before = await capture.research();
    const tickFrom = await capture.step(0);
    // The canvas's own pixels (fast), unless the shot shows a panel: HTML, so a screenshot.
    const screenshots = !!shot.openPole;
    const clean = encoder(join(out, 'shots', `${shot.name}.mp4`), !screenshots);
    const hud = shot.hudVariant ? encoder(join(out, 'shots', `${shot.name}-hud.mp4`)) : null;
    const stillAt = Math.round((shot.still ?? 0.5) * (frames - 1));
    const still = async (frame) => {
      const file = join(out, 'stills', `${shot.name}.png`);
      if (screenshots) writeFileSync(file, frame);
      else await rawToPng(frame, file);
    };
    let recorded = 0;
    let holdLeft = Math.round((shot.holdSeconds ?? 0) * FPS);
    for (let f = 0; f < frames; f++) {
      await capture.camera(cameraAt(shot, f / (frames - 1)));
      let frame;
      if (screenshots) {
        await capture.step(ticks);
        frame = await page.screenshot({ type: 'png' });
      } else {
        frame = await capture.stepPixels(ticks);
      }
      await clean.write(frame);
      if (f === stillAt) await still(frame);
      if (hud) {
        // The research bar is HTML over the canvas: a screenshot with it shown.
        await capture.enter('research');
        await hud.write(await page.screenshot({ type: 'png' }));
        await capture.enter('none');
      }
      recorded++;
      if (shot.untilResearched) {
        const done = (await capture.research()).researched;
        if (done && holdLeft-- <= 0) {
          // Ended before its still frame: the last one instead.
          if (f < stillAt) await still(frame);
          break;
        }
      }
      if (f % 60 === 0) console.log(`  frame ${f}/${frames}`);
    }
    await clean.end();
    await hud?.end();
    const counts = await capture.production(true);
    const after = await capture.research();
    const units = 40;
    results.push({
      shot: shot.name,
      title: shot.title,
      frames: recorded,
      seconds: recorded / FPS,
      ticks: counts.ticks,
      tickFrom,
      tickTo: tickFrom + counts.ticks,
      research: {
        technology: RESEARCH,
        unitsBefore: before.unitsDone,
        unitsAfter: after.unitsDone,
        percentBefore: Math.round((100 * before.unitsDone) / units),
        percentAfter: Math.round((100 * after.unitsDone) / units),
        currentBefore: before.current,
        currentAfter: after.current,
        currentUnitsAfter: after.currentUnits,
      },
      mined: counts.mined,
      made: counts.made,
      consumed: counts.consumed,
    });
    console.log(`  ${recorded} frames, ${counts.ticks} ticks: ${JSON.stringify(counts.made)}`);
  }
  await browser.close();
  await close();
  return results;
}

const results = args['assemble-only']
  ? JSON.parse(readFileSync(join(out, 'counts.json'), 'utf8'))
  : await record();
if (!args['assemble-only']) {
  writeFileSync(join(out, 'counts.json'), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(out, 'counts.md'), countsTable(results));
}

/** Cuts `[shot, from, seconds]` segments of the shots' mp4s together (suffix: `-hud` variants where recorded). */
async function cut(segments, file, filters, codec) {
  const inputs = [];
  const parts = [];
  segments.forEach(([name, from, seconds], i) => {
    inputs.push('-i', join(out, 'shots', `${name}.mp4`));
    parts.push(
      `[${i}:v]trim=start=${from}:duration=${seconds},setpts=PTS-STARTPTS${filters}[v${i}]`,
    );
  });
  const concat = `${segments.map((_, i) => `[v${i}]`).join('')}concat=n=${segments.length}:v=1:a=0`;
  await run([
    ...inputs,
    '-filter_complex',
    `${parts.join(';')};${concat}[out]`,
    '-map',
    '[out]',
    ...codec,
    file,
  ]);
}

const have = new Set(results.map((r) => r.shot));
const h264 = [
  '-c:v',
  'libx264',
  '-preset',
  'slow',
  '-crf',
  String(args.crf),
  '-pix_fmt',
  'yuv420p',
  '-movflags',
  '+faststart',
];
if (REEL.every(([name]) => have.has(name))) {
  await cut(REEL, join(out, 'reel.mp4'), '', h264);
  const hudReel = REEL.map(([name, from, s]) => [
    SHOTS.find((x) => x.name === name)?.hudVariant ? `${name}-hud` : name,
    from,
    s,
  ]);
  await cut(hudReel, join(out, 'reel-hud.mp4'), '', h264);
  console.log(
    `reel: ${MB(join(out, 'reel.mp4'))}, with the research bar: ${MB(join(out, 'reel-hud.mp4'))}`,
  );
}
if (README_CLIP.every(([name]) => have.has(name))) {
  const clip = README_CLIP.map(([name, from, s]) => [
    SHOTS.find((x) => x.name === name)?.hudVariant ? `${name}-hud` : name,
    from,
    s,
  ]);
  const gif = join(out, 'readme.gif');
  await cut(
    clip,
    join(out, 'readme-master.mp4'),
    `,fps=${args['gif-fps']},scale=${args['gif-width']}:-2:flags=lanczos`,
    h264,
  );
  await run([
    ...['-i', join(out, 'readme-master.mp4')],
    '-filter_complex',
    `split[a][b];[a]palettegen=max_colors=${args['gif-colors']}:stats_mode=diff[p];` +
      '[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle',
    gif,
  ]);
  console.log(`README clip: ${MB(gif)}`);
  if (args.readme) {
    copyFileSync(gif, join(ROOT, 'docs', 'demo-factory.gif'));
    // The shots with a chosen still (not the README clip's views).
    for (const r of results.filter(
      (x) => SHOTS.find((s) => s.name === x.shot)?.still !== undefined,
    )) {
      const file = join(out, 'stills', `${r.shot}.png`);
      if (!existsSync(file)) {
        // Not written (an older capture): the shot's frame at its still, from the mp4.
        const at =
          (SHOTS.find((s) => s.name === r.shot)?.still ?? 0.5) * Math.max(0, r.seconds - 0.05);
        const video = join(out, 'shots', `${r.shot}.mp4`);
        await run(['-ss', at.toFixed(3), '-i', video, '-frames:v', '1', file]);
      }
      await run([
        ...['-i', file],
        // 1280x720 with a 256-colour palette: about half a megabyte each.
        '-filter_complex',
        'scale=1280:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=single[p];' +
          '[b][p]paletteuse=dither=sierra2_4a',
        join(ROOT, 'docs', 'screenshots', `demo-${r.shot}.png`),
      ]);
    }
  }
}
console.log(`wrote ${relative(ROOT, out)}/`);

/** The counters as a Markdown table, one row per shot. */
function countsTable(rows) {
  const items = [
    ['iron ore mined', (r) => r.mined['iron-ore']],
    ['copper ore mined', (r) => r.mined['copper-ore']],
    ['coal mined', (r) => r.mined.coal],
    ['iron plates', (r) => r.made['iron-plate']],
    ['copper plates', (r) => r.made['copper-plate']],
    ['gears', (r) => r.made['iron-gear-wheel']],
    ['copper cable', (r) => r.made['copper-cable']],
    ['circuits', (r) => r.made['electronic-circuit']],
    ['electric inserters', (r) => r.made['electric-inserter']],
    ['transport belts', (r) => r.made['transport-belt']],
    ['red packs made', (r) => r.made['automation-science-pack']],
    ['green packs made', (r) => r.made['logistic-science-pack']],
    ['red packs used', (r) => r.consumed['automation-science-pack']],
    ['green packs used', (r) => r.consumed['logistic-science-pack']],
    [
      'research',
      (r) =>
        `automation 2 ${r.research.percentBefore}% → ${r.research.percentAfter}%` +
        (r.research.currentAfter && r.research.currentAfter !== RESEARCH
          ? `, then ${r.research.currentAfter} (${r.research.currentUnitsAfter} units)`
          : ''),
    ],
  ];
  const head = `| | ${rows.map((r) => r.shot).join(' | ')} |\n|---|${rows.map(() => '---:').join('|')}|\n`;
  const ticks = `| ticks (60 = 1 s) | ${rows.map((r) => `${r.tickFrom}–${r.tickTo}`).join(' | ')} |\n`;
  return (
    head +
    ticks +
    items
      .map(([label, get]) => `| ${label} | ${rows.map((r) => get(r) ?? 0).join(' | ')} |`)
      .join('\n') +
    '\n'
  );
}

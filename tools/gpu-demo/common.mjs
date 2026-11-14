/**
 * What the GPU demo's capture and benchmark scripts share (demo/gpu/README.md,
 * "Capture and benchmark"): command-line flags, a server for the demo page, and
 * headless Chromium with WebGPU on SwiftShader.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

/** The repository root. */
export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/**
 * Chromium flags for WebGPU without a GPU: the same list as
 * `playwright.gpu.config.ts`. Without the last two, SwiftShader's WebGPU can
 * compute but presenting a canvas loses the device.
 */
export const GPU_CHROME_ARGS = [
  '--enable-unsafe-webgpu',
  '--use-angle=swiftshader',
  '--use-webgpu-adapter=swiftshader',
  '--no-sandbox',
  '--ignore-gpu-blocklist',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
];

/** The capture frame size. */
export const VIEWPORT = { width: 1280, height: 720 };

/**
 * Parses `--name value` and `--flag` arguments against `defaults`: a flag
 * whose default is a boolean takes no value, numbers are parsed (with `_`
 * separators allowed), anything else stays a string. Unknown flags throw.
 * @template {Record<string, string | number | boolean>} T
 * @param {T} defaults
 * @param {string[]} [argv]
 * @returns {T}
 */
export function parseArgs(defaults, argv = process.argv.slice(2)) {
  /** @type {Record<string, string | number | boolean>} */
  const out = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    const [flag, inline] = arg.split('=', 2);
    const name = (flag ?? '').replace(/^--/, '');
    if (!arg.startsWith('--') || !(name in defaults)) {
      throw new Error(`unknown argument ${arg}; flags: ${Object.keys(defaults).join(', ')}`);
    }
    const fallback = defaults[name];
    if (typeof fallback === 'boolean') {
      out[name] = inline === undefined ? true : inline !== 'false' && inline !== '0';
      continue;
    }
    const raw = inline ?? argv[++i];
    if (raw === undefined) throw new Error(`--${name} needs a value`);
    if (typeof fallback === 'number') {
      const n = Number(raw.replace(/_/g, ''));
      if (!Number.isFinite(n)) throw new Error(`--${name}: not a number: ${raw}`);
      out[name] = n;
    } else {
      out[name] = raw;
    }
  }
  return /** @type {T} */ (out);
}

/**
 * The URL of the demo page: `url` if given (a running dev server, preview or
 * deploy), else a Vite dev server started here on the repository, closed by
 * `close()`.
 * @param {string} url
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function demoServer(url) {
  if (url) return { url, close: async () => {} };
  const { createServer } = await import('vite');
  const server = await createServer({
    root: ROOT,
    // Serve at the root whatever the shell's BASE_PATH says.
    base: '/',
    logLevel: 'warn',
    clearScreen: false,
    server: { host: 'localhost', port: 5190, strictPort: false, hmr: false, watch: null },
    // The demo has no dependencies to pre-bundle; don't scan the game's entry for them.
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await server.listen();
  const local = server.resolvedUrls?.local[0];
  if (!local) throw new Error('the Vite dev server has no local URL');
  return { url: new URL('demo/gpu/', local).href, close: () => server.close() };
}

/**
 * Headless Chromium with WebGPU on SwiftShader. `GPU_CHROME` points at another
 * Chromium binary or a wrapper script, as for `npm run test:gpu`.
 */
export function launchBrowser() {
  return chromium.launch({
    ...(process.env.GPU_CHROME && { executablePath: process.env.GPU_CHROME }),
    args: GPU_CHROME_ARGS,
  });
}

/**
 * Opens the demo at `query` in a new 1280x720 page and waits until it runs.
 * Page errors go to stderr.
 * @param {import('@playwright/test').Browser} browser
 * @param {string} base The demo page's URL.
 * @param {string} query
 * @param {number} timeout
 */
export async function openDemo(browser, base, query, timeout) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  page.setDefaultTimeout(timeout);
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') console.error(`page console: ${m.text()}`);
  });
  const url = new URL(base);
  url.search = query;
  await page.goto(url.href);
  await page.waitForFunction(() => window.__gpuDemo?.state !== 'starting', null, { timeout });
  const hook = await page.evaluate(() => ({
    state: window.__gpuDemo?.state,
    error: window.__gpuDemo?.error,
    adapter: window.__gpuDemo?.adapter ?? '',
    items: window.__gpuDemo?.items ?? 0,
  }));
  if (hook.state !== 'running') throw new Error(`the demo did not start: ${String(hook.error)}`);
  return { page, adapter: hook.adapter, items: hook.items };
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

/**
 * The first ffmpeg that can turn PNG frames into an mp4, and its H.264 (or
 * MPEG-4 part 2) encoder: `FFMPEG`, then `PATH`, then the build Playwright
 * downloads (a minimal one, which most often can't). With `need`, it must
 * also have those encoders (e.g. `libvpx-vp9` for a WebM). Exits with a
 * message when there is none.
 * @param {string[]} [need]
 * @returns {{ ffmpeg: string, encoder: string }}
 */
export function findFfmpeg(need = []) {
  for (const bin of candidates()) {
    const caps = capabilities(bin);
    const encoders = need.length > 0 ? probe(bin, 'encoders') : '';
    const lacking = need.filter((e) => !new RegExp(`^\\s*\\S+\\s+${e}\\s`, 'm').test(encoders));
    if ('encoder' in caps && lacking.length === 0) return { ffmpeg: bin, encoder: caps.encoder };
    const missing = 'missing' in caps ? [...caps.missing, ...lacking] : lacking;
    console.log(`skipping ${bin}: no ${missing.join(', no ')}`);
  }
  console.error(
    'No ffmpeg that can turn PNG frames into an mp4 was found. Install one, or point FFMPEG at it.',
  );
  process.exit(1);
}

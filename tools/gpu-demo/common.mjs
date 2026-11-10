/**
 * What the GPU demo's capture and benchmark scripts share (demo/gpu/README.md,
 * "Capture and benchmark"): command-line flags, a server for the demo page, and
 * headless Chromium with WebGPU on SwiftShader.
 */

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

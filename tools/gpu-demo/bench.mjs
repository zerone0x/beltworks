#!/usr/bin/env node
/**
 * The GPU demo's step benchmark (demo/gpu/README.md, "Capture and
 * benchmark"): for each item count, opens the page in capture mode and times
 * the compute step alone (no drawing in between), then prints ms per step and
 * the adapter it ran on. The time comes from GPU timestamp queries when the
 * device has them, else from the wall clock between submission and the GPU's
 * "done" (each timed batch starts on an idle GPU).
 *
 *   node tools/gpu-demo/bench.mjs [--sizes 10000,100000,1000000] [--steps 16]
 *     [--rounds 3] [--warmup 4] [--url ...] [--timeout 600000]
 *
 * Each round steps `--steps` ticks in one go; the table shows the median and
 * the best round. Without `--url` it starts a Vite dev server. `GPU_CHROME`
 * picks the Chromium binary (see playwright.gpu.config.ts).
 */

import { demoServer, launchBrowser, openDemo, parseArgs } from './common.mjs';

const args = parseArgs({
  sizes: '10000,100000,1000000',
  steps: 16,
  rounds: 3,
  warmup: 4,
  url: '',
  timeout: 600_000,
});
const sizes = args.sizes.split(',').map((s) => Number(s.replace(/_/g, '')));
if (sizes.some((n) => !Number.isSafeInteger(n) || n < 1)) throw new Error('bad --sizes');

const server = await demoServer(args.url);
const browser = await launchBrowser();
/** @type {{ items: number, median: number, best: number, source: string }[]} */
const rows = [];
let adapterName = '';
try {
  for (const n of sizes) {
    const { page, adapter, items } = await openDemo(
      browser,
      server.url,
      `capture=1&timing=0&n=${String(n)}`,
      args.timeout,
    );
    adapterName = adapter;
    if (args.warmup > 0) await page.evaluate((k) => window.__gpuDemo.timedStep(k), args.warmup);
    const times = [];
    let source = '';
    for (let r = 0; r < args.rounds; r++) {
      const t = await page.evaluate((k) => window.__gpuDemo.timedStep(k), args.steps);
      if (!t) throw new Error('the timed step returned no timing');
      times.push(t.msPerStep);
      source = t.source;
    }
    await page.close();
    times.sort((a, b) => a - b);
    const row = {
      items,
      median: times[Math.floor(times.length / 2)] ?? NaN,
      best: times[0] ?? NaN,
      source,
    };
    rows.push(row);
    console.log(
      `${items.toLocaleString('en-US')} items: ${row.median.toFixed(3)} ms/step median, ` +
        `${row.best.toFixed(3)} best (${source}, ${String(args.rounds)} x ${String(args.steps)} steps)`,
    );
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(`\nadapter: ${adapterName}`);
console.log('| items | ms/step (median) | ms/step (best) | timing |');
console.log('|---:|---:|---:|---|');
for (const r of rows) {
  console.log(
    `| ${r.items.toLocaleString('en-US')} | ${r.median.toFixed(3)} | ${r.best.toFixed(3)} | ${r.source} |`,
  );
}

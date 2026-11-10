/**
 * The WebGPU belt demo (#129, demo/gpu/README.md), headless on SwiftShader:
 * the compute shader's result after K ticks matches the pure-TS reference
 * bit for bit, one million items draw and move, the capture mode (#130)
 * steps exactly and draws the same frames every time, and a browser without
 * WebGPU gets a message. Run with `npm run test:gpu`.
 */

import { expect, test, type Page } from '@playwright/test';
import { buildNetwork } from '../../demo/gpu/network';
import { initItems, referenceCounters, referenceRun } from '../../demo/gpu/sim';

const net = buildNetwork();

async function open(page: Page, query: string): Promise<{ adapter: string; items: number }> {
  page.on('pageerror', (e) => console.error(`page error: ${e.message}`));
  await page.goto(`demo/gpu/?${query}`);
  await page.waitForFunction(() => window.__gpuDemo?.state !== 'starting', null, {
    timeout: 120_000,
  });
  const hook = await page.evaluate(() => ({
    state: window.__gpuDemo!.state,
    error: window.__gpuDemo!.error,
    adapter: window.__gpuDemo!.adapter,
    items: window.__gpuDemo!.items,
  }));
  expect(hook.error).toBeNull();
  expect(hook.state).toBe('running');
  return hook;
}

/** The indices where `a` and `b` differ (at most 5), and how many there are. */
function diff(a: ArrayLike<number>, b: ArrayLike<number>): { count: number; first: number[] } {
  const first: number[] = [];
  let count = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) {
      count++;
      if (first.length < 5) first.push(i);
    }
  }
  return { count, first };
}

// Item counts around the 256-thread workgroup size, and steps in uneven batches across the
// 64-step submissions, long enough for every item to cross the splitter or the merge.
for (const n of [1, 255, 1000, 4099]) {
  test(`the GPU step matches the reference for ${String(n)} items`, async ({ page }) => {
    const { adapter, items } = await open(page, `n=${String(n)}&paused=1`);
    expect(items).toBe(n);
    const initial = initItems(n, net);
    const start = await page.evaluate(() => window.__gpuDemo!.read());
    expect(diff(start.belt, initial.belt).count).toBe(0);
    expect(diff(start.progress, initial.progress).count).toBe(0);
    expect(diff(start.itemType, initial.itemType).count).toBe(0);

    const batches = [1, 37, 64, 130, 268];
    let steps = 0;
    for (const k of batches) {
      await page.evaluate((s) => window.__gpuDemo!.step(s), k);
      steps += k;
      const gpu = await page.evaluate(() => window.__gpuDemo!.read());
      const ref = referenceRun(initial, net, steps);
      const belt = diff(gpu.belt, ref.belt);
      const progress = diff(gpu.progress, ref.progress);
      expect(belt, `belt ids after ${String(steps)} steps`).toEqual({ count: 0, first: [] });
      expect(progress, `progress after ${String(steps)} steps`).toEqual({ count: 0, first: [] });
    }
    const ref = referenceRun(initial, net, steps);
    const gpuCounters = await page.evaluate(() => window.__gpuDemo!.counters());
    expect(gpuCounters.tick).toBe(steps);
    expect(gpuCounters.counters).toEqual(Array.from(referenceCounters(ref, net)));
    console.log(
      `GPU == reference: ${String(n)} items, ${String(steps)} steps, 0 mismatches, ` +
        `counters ${gpuCounters.counters.join(' ')} (adapter: ${adapter})`,
    );
  });
}

test('one quad per instance draws the same picture as batched quads', async ({ page }) => {
  const shots: Buffer[] = [];
  for (const quads of [1, 64]) {
    await open(page, `n=5000&paused=1&quads=${String(quads)}`);
    await page.evaluate(() => window.__gpuDemo!.step(100));
    const frames = await page.evaluate(() => window.__gpuDemo!.frames);
    await page.waitForFunction((f) => window.__gpuDemo!.frames >= f + 2, frames);
    shots.push(await page.screenshot({ mask: [page.locator('#hud')] }));
  }
  expect(shots[0]!.equals(shots[1]!)).toBe(true);
});

/** The art tools' PNG reader, imported by URL so TypeScript doesn't look for its types. */
async function decodePng(
  png: Buffer,
): Promise<{ width: number; height: number; data: Uint8Array }> {
  const { decodePng } = (await import(new URL('../../tools/art/png.js', import.meta.url).href)) as {
    decodePng: (file: Uint8Array) => { width: number; height: number; data: Uint8Array };
  };
  return decodePng(png);
}

/**
 * Pixels of the screenshot `png` outside `mask` that are bright (items, not
 * belts or background). Decoded here in Node, not in the busy page.
 */
async function analyze(
  png: Buffer,
  mask: { x: number; y: number; width: number; height: number },
): Promise<{ bright: number; total: number; pixels: Uint8Array }> {
  const { width, height, data } = await decodePng(png);
  let bright = 0;
  let total = 0;
  // A coarse fingerprint for comparing two frames: one brightness bit per pixel.
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (x >= mask.x && x < mask.x + mask.width && y >= mask.y && y < mask.y + mask.height) {
        continue;
      }
      const o = (y * width + x) * 4;
      total++;
      if (Math.max(data[o]!, data[o + 1]!, data[o + 2]!) > 150) {
        pixels[y * width + x] = 1;
        bright++;
      }
    }
  }
  return { bright, total, pixels };
}

test('one million items draw and move', async ({ page }, testInfo) => {
  // SwiftShader draws one million items at a frame every second or two, much slower on a busy machine.
  test.setTimeout(600_000);
  const { adapter, items } = await open(page, '');
  expect(items).toBe(1_000_000);
  const tickAtLeast = (t: number) =>
    page.waitForFunction((t) => window.__gpuDemo!.tick() >= t && window.__gpuDemo!.frames >= 2, t, {
      timeout: 300_000,
    });
  await tickAtLeast(8);
  // Wait for the counters to show in the overlay before the screenshot.
  await expect(page.locator('#hud')).toContainText('checksum', { timeout: 300_000 });
  const mask = (await page.locator('#hud').boundingBox())!;
  const first = await page.screenshot({ timeout: 300_000 });
  const tick = await page.evaluate(() => window.__gpuDemo!.tick());
  await tickAtLeast(tick + 12);
  const second = await page.screenshot({
    path: testInfo.outputPath('gpu-demo-1m.png'),
    timeout: 300_000,
  });

  const a = await analyze(first, mask);
  const b = await analyze(second, mask);
  // Items cover a good part of the picture (the belts are drawn in dark colors only).
  expect(a.bright / a.total).toBeGreaterThan(0.05);
  expect(b.bright / b.total).toBeGreaterThan(0.05);
  // And they moved between the two frames.
  let changed = 0;
  for (let i = 0; i < a.pixels.length; i++) if (a.pixels[i] !== b.pixels[i]) changed++;
  expect(changed / a.total).toBeGreaterThan(0.005);

  const { counters } = await page.evaluate(() => window.__gpuDemo!.counters());
  expect(counters.slice(0, 3).reduce((s, c) => s + c, 0)).toBe(1_000_000);
  console.log(
    `1M items: ${(100 * (b.bright / b.total)).toFixed(1)}% of pixels are items, ` +
      `${(100 * (changed / a.total)).toFixed(1)}% changed over 12+ ticks ` +
      `(adapter: ${adapter}); screenshot ${testInfo.outputPath('gpu-demo-1m.png')}`,
  );
});

/** Capture mode: `__step(k)` and a screenshot, as tools/gpu-demo/capture.mjs does it. */
async function captureFrames(page: Page, n: number, steps: readonly number[]) {
  await open(page, `capture=1&timing=0&n=${String(n)}`);
  const shots: Buffer[] = [];
  const ticks: number[] = [];
  for (const k of steps) {
    const r = await page.evaluate((k) => window.__step!(k), k);
    ticks.push(r.tick);
    await page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    shots.push(await page.screenshot());
  }
  return { shots, ticks };
}

test('capture mode steps exactly and draws the same frames every time', async ({ browser }) => {
  const n = 3000;
  const steps = [0, 7, 64, 1, 100];
  const pageA = await browser.newPage();
  const a = await captureFrames(pageA, n, steps);
  expect(a.ticks).toEqual([0, 7, 71, 72, 172]);

  // The state is exactly the reference's after the ticks asked for: nothing ran on a clock.
  const gpu = await pageA.evaluate(() => window.__gpuDemo!.read());
  const ref = referenceRun(initItems(n, net), net, 172);
  expect(diff(gpu.belt, ref.belt).count).toBe(0);
  expect(diff(gpu.progress, ref.progress).count).toBe(0);
  const hud = await pageA.locator('#hud').textContent();
  expect(hud).toContain('3,000 items');
  expect(hud).toContain('adapter: ');
  expect(hud).toContain('tick 172, capture mode: 100 ticks for this frame');
  expect(hud).toMatch(
    /simulation ms\/step: hidden \(timing=0\), timed by (GPU timestamps|wall clock)/,
  );
  expect(hud).toContain('at tick 172: ');
  await pageA.close();

  // Every frame shows motion, and a second page draws the same bytes.
  for (let i = 1; i < steps.length; i++) expect(a.shots[i]!.equals(a.shots[i - 1]!)).toBe(false);
  const pageB = await browser.newPage();
  const b = await captureFrames(pageB, n, steps);
  await pageB.close();
  expect(b.ticks).toEqual(a.ticks);
  for (let i = 0; i < steps.length; i++) {
    expect(b.shots[i]!.equals(a.shots[i]!), `frame ${String(i)}`).toBe(true);
  }
});

test('the overlay shows the measured step time', async ({ page }) => {
  await open(page, 'capture=1&n=2000');
  const r = await page.evaluate(() => window.__step!(16));
  expect(r.timing).not.toBeNull();
  expect(r.timing!.steps).toBe(16);
  expect(r.timing!.msPerStep).toBeGreaterThan(0);
  await expect(page.locator('#hud')).toContainText(
    /simulation ms\/step: \d+\.\d+ \((GPU timestamps|wall clock), over 16 ticks\)/,
  );
  // __step(0) draws without stepping.
  expect((await page.evaluate(() => window.__step!(0))).tick).toBe(16);
});

test('a browser without WebGPU gets a message', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'gpu', { value: undefined, configurable: true });
  });
  await page.goto('demo/gpu/');
  const message = page.locator('#gpu-message');
  await expect(message).toBeVisible();
  await expect(message).toContainText('WebGPU is not available');
  await expect(page.locator('#hud')).toBeHidden();
});

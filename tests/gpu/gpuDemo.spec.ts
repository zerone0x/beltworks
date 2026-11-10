/**
 * The WebGPU belt demo (#129, demo/gpu/README.md), headless on SwiftShader:
 * the compute shader's result after K ticks matches the pure-TS reference
 * bit for bit, one million items draw and move, and a browser without
 * WebGPU gets a message. Run with `npm run test:gpu`.
 */

import { expect, test, type Page } from '@playwright/test';
import { buildNetwork } from '../../demo/gpu/network';
import { initItems, referenceCounters, referenceRun } from '../../demo/gpu/sim';

const net = buildNetwork();

async function open(page: Page, query: string): Promise<{ adapter: string; items: number }> {
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

/** Pixels of the screenshot `png` outside `mask` that are bright (items, not belts or background). */
async function analyze(
  page: Page,
  png: Buffer,
  mask: { x: number; y: number; width: number; height: number },
): Promise<{ bright: number; total: number; pixels: number[] }> {
  return page.evaluate(
    async ({ b64, mask }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      let bright = 0;
      let total = 0;
      // A coarse fingerprint for comparing two frames: one brightness bit per pixel.
      const pixels: number[] = [];
      for (let y = 0; y < bitmap.height; y++) {
        for (let x = 0; x < bitmap.width; x++) {
          const inMask =
            x >= mask.x && x < mask.x + mask.width && y >= mask.y && y < mask.y + mask.height;
          const o = (y * bitmap.width + x) * 4;
          const max = Math.max(data[o]!, data[o + 1]!, data[o + 2]!);
          const on = !inMask && max > 150;
          pixels.push(on ? 1 : 0);
          if (inMask) continue;
          total++;
          if (on) bright++;
        }
      }
      return { bright, total, pixels };
    },
    { b64: png.toString('base64'), mask },
  );
}

test('one million items draw and move', async ({ page }, testInfo) => {
  const { adapter, items } = await open(page, '');
  expect(items).toBe(1_000_000);
  const tickAtLeast = (t: number) =>
    page.waitForFunction((t) => window.__gpuDemo!.tick() >= t && window.__gpuDemo!.frames >= 2, t, {
      timeout: 120_000,
    });
  await tickAtLeast(8);
  // Wait for the counters to show in the overlay before the screenshot.
  await expect(page.locator('#hud')).toContainText('checksum', { timeout: 60_000 });
  const mask = (await page.locator('#hud').boundingBox())!;
  const first = await page.screenshot({ timeout: 120_000 });
  const tick = await page.evaluate(() => window.__gpuDemo!.tick());
  await tickAtLeast(tick + 12);
  const second = await page.screenshot({
    path: testInfo.outputPath('gpu-demo-1m.png'),
    timeout: 120_000,
  });

  const a = await analyze(page, first, mask);
  const b = await analyze(page, second, mask);
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

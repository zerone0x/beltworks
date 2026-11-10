import { defineConfig, devices } from '@playwright/test';

/**
 * The WebGPU belt demo's headless check (`npm run test:gpu`, demo/gpu/README.md):
 * the GPU step against the pure-TS reference, and a screenshot at one million
 * items. It serves the production build under the deploy's base path, so it
 * also checks that `demo/gpu/` resolves there. Chromium runs WebGPU on
 * SwiftShader (the CPU), so no GPU is needed; `GPU_CHROME` points Playwright at
 * another Chromium binary (or a wrapper script). Not part of CI. `E2E_PORT`
 * picks another port.
 */
const PORT = Number(process.env.E2E_PORT ?? 4175);
const BASE_PATH = '/beltworks-play/';

export default defineConfig({
  testDir: 'tests/gpu',
  testMatch: '*.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: `http://localhost:${String(PORT)}${BASE_PATH}`,
    viewport: { width: 1280, height: 720 },
    trace: 'off',
    launchOptions: {
      ...(process.env.GPU_CHROME && { executablePath: process.env.GPU_CHROME }),
      args: [
        '--enable-unsafe-webgpu',
        '--use-angle=swiftshader',
        '--use-webgpu-adapter=swiftshader',
        '--no-sandbox',
        '--ignore-gpu-blocklist',
        // Without these, SwiftShader's WebGPU can compute but presenting a canvas loses the device.
        '--enable-features=Vulkan',
        '--use-vulkan=swiftshader',
      ],
    },
  },
  webServer: {
    command: `npm run build && npm run preview -- --port ${String(PORT)} --strictPort`,
    env: { BASE_PATH },
    url: `http://localhost:${String(PORT)}${BASE_PATH}demo/gpu/`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

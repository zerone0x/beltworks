import { defineConfig, devices } from '@playwright/test';

/**
 * The release check (docs/TOOLING.md, "Release check"): plays the
 * production build exactly as it deploys (`npm run build` with
 * BASE_PATH=/beltworks-play/, no test hook) through real input only.
 * Not part of CI: run it before a release with `npm run test:release`.
 * `E2E_PORT` picks another port.
 */
const PORT = Number(process.env.E2E_PORT ?? 4174);
const BASE_PATH = '/beltworks-play/';

export default defineConfig({
  testDir: 'tests/release',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${String(PORT)}${BASE_PATH}`,
    viewport: { width: 1280, height: 720 },
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run build && npm run preview -- --port ${String(PORT)} --strictPort`,
    env: { BASE_PATH },
    url: `http://localhost:${String(PORT)}${BASE_PATH}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});

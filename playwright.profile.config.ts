import { defineConfig, devices } from '@playwright/test';

/**
 * The scripted render profile (`npm run profile:render`, docs/TOOLING.md
 * "Render profile"): one long test against the test build, separate from the
 * end-to-end suite. `PROFILE_GPU=1` runs a headed Chromium on the machine's
 * GPU instead of the headless software renderer; `PROFILE_URL` profiles an
 * already running server (e.g. `npm run dev`) instead of building one.
 */
const PORT = 4174;
const URL = process.env.PROFILE_URL ?? `http://localhost:${String(PORT)}/`;
const GPU = process.env.PROFILE_GPU === '1';

export default defineConfig({
  testDir: 'tests/profile',
  testMatch: '*.profile.ts',
  timeout: 30 * 60_000,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: URL,
    trace: 'off',
    headless: !GPU,
    ...(GPU && {
      launchOptions: { args: ['--ignore-gpu-blocklist', '--enable-gpu-rasterization'] },
    }),
  },
  ...(process.env.PROFILE_URL
    ? {}
    : {
        webServer: {
          command: `npm run build:test && npm run preview -- --port ${String(PORT)} --strictPort`,
          url: URL,
          reuseExistingServer: true,
          timeout: 180_000,
        },
      }),
});

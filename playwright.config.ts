import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_PATH = process.env.BASE_PATH ?? '/';
const base = `/${BASE_PATH.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
/**
 * Set by CI's e2e shards, which download the test build (`dist/`) from the
 * build job instead of building it again (docs/TOOLING.md, "End-to-end tests").
 */
const PREBUILT = !!process.env.E2E_PREBUILT;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // On CI every shard writes a blob report; the `e2e` job merges them into one HTML report.
  reporter: process.env.CI ? [['github'], ['list'], ['blob']] : 'list',
  use: {
    baseURL: `http://localhost:${String(PORT)}${base}`,
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Serve a production build so the tests cover what gets deployed. `--mode test` only adds
  // the `window.__beltworks` test hook (see src/testHook.ts); everything else is identical.
  webServer: {
    command: `${PREBUILT ? '' : 'npm run build:test && '}npm run preview -- --port ${String(PORT)} --strictPort`,
    url: `http://localhost:${String(PORT)}${base}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

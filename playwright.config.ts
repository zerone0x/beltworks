import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const BASE_PATH = process.env.BASE_PATH ?? '/';
const base = `/${BASE_PATH.replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${String(PORT)}${base}`,
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Serve the production build so the smoke test covers what gets deployed.
  webServer: {
    command: `npm run build && npm run preview -- --port ${String(PORT)} --strictPort`,
    url: `http://localhost:${String(PORT)}${base}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});

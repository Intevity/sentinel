import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config. Tests run against the Vite dev server with VITE_E2E=true,
 * which reroutes IPC through the HTTP bridge spawned by test-daemon.ts.
 *
 * Production builds never set VITE_E2E, so this harness cannot affect
 * shipped behavior.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    // CI escape hatch for cdn.playwright.dev outages: the browser-download
    // step has repeatedly stalled on GitHub runners (zip reaches 100%, the
    // follow-up artifact fetch hangs; bounded retries all stall identically,
    // so it's a deterministic CDN-path failure, not flakiness). Setting
    // PLAYWRIGHT_CHANNEL=chrome launches the runner image's preinstalled
    // Google Chrome instead of a downloaded Chromium, removing the download
    // dependency entirely. Unset locally, the default downloaded Chromium
    // keeps local runs hermetic.
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Vite dev server is started per-test via fixtures (so VITE_E2E_BRIDGE_URL
  // can reference the dynamically-allocated bridge port).
});

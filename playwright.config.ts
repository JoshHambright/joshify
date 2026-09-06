import { defineConfig, devices } from '@playwright/test';

const PORT = 4771;

/**
 * A Chromium that is already on the machine.
 *
 * CI installs its own with `playwright install`, which is the normal path and
 * needs nothing here. Some development containers ship one instead, and
 * downloading a second copy of the same browser to sit beside it is a hundred
 * megabytes and two minutes for nothing.
 */
const chromium = process.env['JOSHIFY_CHROMIUM'];

/**
 * The end-to-end suite: a real browser, the real built bundle, a real server,
 * and the fake Spotify.
 *
 * Deliberately small. This is not where behaviour gets tested — 1,183 unit and
 * component tests already do that, faster and with better failure messages.
 * This exists to catch the one class of bug none of them can see: the pieces
 * being individually correct and not actually assembled. It runs against
 * `dist/`, so a build that ships nothing fails here.
 */
export default defineConfig({
  testDir: './e2e',
  // A panel that only works on the third try is broken. Retries would hide it.
  retries: 0,
  reporter: process.env['CI'] === undefined ? 'list' : 'github',
  use: {
    baseURL: `http://127.0.0.1:${String(PORT)}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'panel',
      use: {
        ...devices['Desktop Chrome'],
        ...(chromium === undefined
          ? {}
          : { launchOptions: { executablePath: chromium } }),
        // The device's real panel, so a layout that only works on a laptop
        // fails here (D-039).
        viewport: { width: 720, height: 1280 },
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: 'node e2e/start-panel.mjs',
    url: `http://127.0.0.1:${String(PORT)}/health`,
    reuseExistingServer: process.env['CI'] === undefined,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
  },
});

// @ts-check
const { defineConfig, devices } = require('@playwright/test');

/**
 * Playwright configuration for the payment-dashboard workspace.
 *
 * Focused on visual regression coverage for responsive dashboard layouts
 * (issue #451). Captures registration, history, and navigation screens
 * across mobile, tablet, and desktop viewports.
 *
 * Determinism strategy:
 *  - Fixed viewports per project (mobile 375x812, tablet 768x1024, desktop 1440x900).
 *  - Frozen clock via `page.clock` in the spec (see tests/visual/helpers).
 *  - Animations/transitions disabled via injected CSS in the spec helpers.
 *  - Fixed locale (en-US) and timezone (UTC) at the browser context level.
 *  - API responses mocked deterministically in the spec (no live network).
 *  - Masking limited to unavoidable dynamic regions (e.g. relative timestamps).
 *
 * Baselines are committed under `tests/visual/__screenshots__/` and approved
 * via the workflow documented in `tests/visual/README.md`.
 */

const PORT = Number(process.env.VISUAL_TEST_PORT || 4173);
const BASE_URL = process.env.VISUAL_TEST_BASE_URL || `http://127.0.0.1:${PORT}`;

/** @type {import('@playwright/test').PlaywrightTestConfig} */
module.exports = defineConfig({
  testDir: './tests/visual',
  // Visual snapshots must be deterministic; run serially to avoid
  // resource contention affecting rendering.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report/visual' }]]
    : [['list']],
  outputDir: 'test-results/visual',

  // Generous timeout: preview build + first paint can be slow in CI.
  timeout: 60_000,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      // Small tolerance for anti-aliasing differences across platforms.
      maxDiffPixelRatio: 0.01,
      // Disable animations at the screenshot level as a safety net.
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },

  // Snapshot path template keeps baselines grouped by project and spec,
  // making review and approval straightforward.
  snapshotPathTemplate:
    '{testDir}/__screenshots__/{projectName}/{testFilePath}/{arg}{ext}',

  use: {
    baseURL: BASE_URL,
    // Fixed locale and timezone for deterministic rendering.
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    reducedMotion: 'reduce',
    // Consistent device scale factor across projects.
    deviceScaleFactor: 1,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },

  projects: [
    {
      name: 'mobile',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 375, height: 812 },
        isMobile: false, // Keep desktop Chrome engine for cross-platform stability.
        hasTouch: true,
      },
    },
    {
      name: 'tablet',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 768, height: 1024 },
        hasTouch: true,
      },
    },
    {
      name: 'desktop',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],

  webServer: {
    // Serve the production preview build so visuals match shipped output.
    command: `npm run preview -- --port ${PORT} --strictPort --host 127.0.0.1`,
    url: BASE_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
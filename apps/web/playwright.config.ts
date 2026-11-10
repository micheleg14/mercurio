import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// The critical flow in a real browser (docs/conventions.md F19), against the production build:
// the API compiled by Nest serves the web app compiled by Vite, under the /mercurio prefix, as on
// the server. Build both first (see the "browser" job in .github/workflows/ci.yml).
const PORT = 4173;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  // A flaky browser test must be fixed, not retried until it passes.
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    locale: 'it-IT',
    trace: 'retain-on-failure',
  },
  // The flows on a desktop; the responsive spec on a phone and on a tablet (docs/conventions.md
  // F20). All in Chromium: CI installs only that browser.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: /responsive\.spec\.ts/,
    },
    {
      name: 'phone',
      use: { ...devices['Pixel 7'] },
      testMatch: /responsive\.spec\.ts/,
      grep: /@phone/,
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /responsive\.spec\.ts/,
      grep: /@desktop/,
    },
    {
      name: 'tablet',
      use: { ...devices['Desktop Chrome'], viewport: { width: 820, height: 1180 }, hasTouch: true },
      testMatch: /responsive\.spec\.ts/,
      grep: /@tablet/,
    },
  ],
  webServer: {
    command: 'node --env-file-if-exists=../../.env ../api/dist/main.js',
    url: `http://127.0.0.1:${PORT}/mercurio/api/health`,
    reuseExistingServer: false,
    env: {
      HOST: '127.0.0.1',
      PORT: String(PORT),
      APP_BASE_PATH: '/mercurio',
      WEB_DIST_PATH: resolve('dist'),
      LOG_LEVEL: 'warn',
      // Every flow activates new people from the same address, side by side: the production limit
      // (10 a minute per sign-in route) would refuse some of them. The limit itself is tested by
      // the API (auth-rate-limit.e2e-spec.ts).
      AUTH_RATE_LIMIT_PER_MINUTE: '100',
    },
  },
});

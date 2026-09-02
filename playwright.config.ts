import { defineConfig } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Keep Chromium profiles/file-backed shared memory away from system /tmp quotas.
// An explicit TMPDIR remains the caller's choice.
const browserTempDir = process.env.TMPDIR || resolve('.cache/browser-tests');
mkdirSync(browserTempDir, { recursive: true, mode: 0o700 });
process.env.TMPDIR = browserTempDir;

const chromePath = process.env.CHROME_PATH;
const launchOptions = {
  chromiumSandbox: true,
  ...(chromePath ? { executablePath: chromePath } : {}),
};

export default defineConfig({
  testDir: './tests',
  testMatch: 'workshop.spec.ts',
  fullyParallel: true,
  workers: 2,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    browserName: 'chromium',
    ...(chromePath ? {} : { channel: 'chrome' }),
    headless: true,
    baseURL: process.env.OFFCUT_BASE_URL || 'http://127.0.0.1:4173',
    viewport: { width: 1365, height: 900 },
    locale: 'en-US',
    timezoneId: 'UTC',
    contextOptions: { reducedMotion: 'reduce' },
    acceptDownloads: true,
    storageState: { cookies: [], origins: [] },
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // The caller owns the production preview. Every test receives a fresh context;
  // neither project starts a server or installs a replacement native API.
  projects: [
    {
      name: 'native-webmcp',
      grep: /@native/,
      use: { launchOptions: { ...launchOptions, args: ['--enable-features=WebMCP'] } },
    },
    {
      name: 'ordinary-manual',
      grep: /@manual/,
      use: { launchOptions: { ...launchOptions, args: ['--disable-features=WebMCP'] } },
    },
  ],
});

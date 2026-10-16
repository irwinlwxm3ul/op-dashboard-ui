import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// Use the pre-installed Chromium when the bundled browser for this Playwright version is absent.
const localChromium = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 180_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:5173',
    viewport: { width: 1280, height: 720 },
    launchOptions: {
      executablePath: existsSync(localChromium) ? localChromium : undefined,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
    },
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'npx tsx src/server/index.ts',
      url: 'http://localhost:8787/healthz',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'npx vite --port 5173 --strictPort',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 60_000,
    },
  ],
});

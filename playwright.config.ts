import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

// Use the pre-installed Chromium when the bundled browser for this Playwright version is absent.
const localChromium = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const PORT = Number(process.env.E2E_PORT ?? 8791);

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 240_000,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  use: {
    // The e2e suite runs against a production build served by the real game server (static files + /ws).
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 960, height: 540 },
    launchOptions: {
      executablePath: existsSync(localChromium) ? localChromium : undefined,
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
    },
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: `npx vite build && NODE_ENV=production PORT=${PORT} npx tsx src/server/index.ts`,
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});

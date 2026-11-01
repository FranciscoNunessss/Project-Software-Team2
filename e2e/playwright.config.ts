import { defineConfig } from '@playwright/test'

// Starts the real backend with fake models (e2e/server.py) and the Vite frontend, then runs
// the browser specs. The extension spec loads extension/ into Chromium itself.
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:8443',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'uv run python e2e/server.py',
      cwd: '..',
      url: 'http://127.0.0.1:8000/api/health',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      command: 'pnpm dev --host 127.0.0.1',
      cwd: '../frontend',
      url: 'http://127.0.0.1:8443',
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
})

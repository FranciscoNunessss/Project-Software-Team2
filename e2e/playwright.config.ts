import { defineConfig } from '@playwright/test'

// Starts the real backend with fake models (e2e/server.py) and the Vite frontend, then runs
// the browser specs. Own ports (API 8100, web 8543), never reused: a developer's running app
// on 8000/8443 must never be tested by mistake (it has real models and real data).
export const API_PORT = '8100'
export const WEB_PORT = '8543'
export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'uv run python e2e/server.py',
      cwd: '..',
      env: { E2E_API_PORT: API_PORT, E2E_WEB_ORIGIN: `http://127.0.0.1:${WEB_PORT}` },
      url: `http://127.0.0.1:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'pnpm dev --host 127.0.0.1',
      cwd: '../frontend',
      env: { PORT: WEB_PORT, ADAPTAI_API_PROXY: `http://127.0.0.1:${API_PORT}` },
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
})

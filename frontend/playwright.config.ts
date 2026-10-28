import { defineConfig, devices } from "@playwright/test"

const webServers = [
  {
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: false,
    timeout: 30_000,
  },
]

if (process.env.RUN_LIVE_GROQ === "1") {
  webServers.unshift({
    command:
      "uv run python -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000",
    cwd: "..",
    url: "http://127.0.0.1:8000/api/health",
    reuseExistingServer: false,
    timeout: 60_000,
  })
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: process.env.RUN_LIVE_GROQ !== "1",
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.RUN_LIVE_GROQ === "1" ? 0 : process.env.CI ? 2 : 0,
  reporter: process.env.CI ? "github" : "list",
  workers: process.env.RUN_LIVE_GROQ === "1" ? 1 : undefined,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: webServers,
})

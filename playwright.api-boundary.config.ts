import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-api-boundary",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  webServer: [
    { command: "pnpm --filter @openarc/api dev", url: "http://127.0.0.1:3003/readyz", timeout: 30_000,
      reuseExistingServer: false, env: { NODE_ENV: "test", HOST: "127.0.0.1", PORT: "3003",
        APP_ORIGIN: "http://127.0.0.1:5185", API_BOUNDARY_ENABLED: "true", LOG_LEVEL: "silent" } },
    { command: "pnpm --filter @openarc/web dev --port 5185", url: "http://127.0.0.1:5185/workspace", timeout: 30_000,
      reuseExistingServer: false, env: { VITE_ENCRYPTED_WORKSPACE_ENABLED: "true", VITE_API_BOUNDARY_ENABLED: "true",
        OPENARC_DEV_API_ORIGIN: "http://127.0.0.1:3003", VITE_COMMIT_SHA: "api-boundary-e2e" } },
  ],
  use: { baseURL: "http://127.0.0.1:5185", reducedMotion: "reduce", trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "chromium-api-boundary", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit-api-boundary", use: { ...devices["Desktop Safari"] } },
  ],
});

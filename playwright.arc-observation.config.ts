import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-arc-observation",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5186",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm --filter @openarc/web dev --port 5186",
    url: "http://127.0.0.1:5186/workspace",
    timeout: 30_000,
    reuseExistingServer: false,
    env: {
      VITE_COMMIT_SHA: "arc-observation-e2e",
      VITE_ENCRYPTED_WORKSPACE_ENABLED: "true",
      VITE_API_BOUNDARY_ENABLED: "true",
      VITE_ARC_OBSERVATION_ENABLED: "true",
    },
  },
  projects: [
    { name: "chromium-arc-observation", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit-arc-observation", use: { ...devices["Desktop Safari"] } },
  ],
});

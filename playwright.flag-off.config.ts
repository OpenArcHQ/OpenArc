import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-flag-off",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5184",
    reducedMotion: "reduce",
  },
  webServer: {
    command: "pnpm --filter @openarc/web dev --port 5184",
    url: "http://127.0.0.1:5184",
    reuseExistingServer: false,
    env: {
      VITE_COMMIT_SHA: "e2e-workspace-disabled",
      VITE_ENCRYPTED_WORKSPACE_ENABLED: "false",
    },
  },
  projects: [
    { name: "chromium-flag-off", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit-flag-off", use: { ...devices["Desktop Safari"] } },
  ],
});

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-local-agent-import", fullyParallel: false, forbidOnly: Boolean(process.env.CI), timeout: 60_000,
  retries: process.env.CI ? 1 : 0, reporter: "list",
  use: { baseURL: "http://127.0.0.1:5190", reducedMotion: "reduce", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "pnpm --filter @openarc/web dev --port 5190", url: "http://127.0.0.1:5190/workspace",
    timeout: 30_000, reuseExistingServer: false,
    env: { VITE_COMMIT_SHA: "local-agent-import-e2e", VITE_ENCRYPTED_WORKSPACE_ENABLED: "true",
      VITE_GENERIC_AGENT_IMPORT_ENABLED: "true" } },
  projects: [
    { name: "chromium-local-agent-import", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit-local-agent-import", use: { ...devices["Desktop Safari"] } },
  ],
});

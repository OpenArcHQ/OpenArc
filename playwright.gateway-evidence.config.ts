import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-gateway-evidence", fullyParallel: false, forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0, reporter: "list",
  use: { baseURL: "http://127.0.0.1:5189", reducedMotion: "reduce", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "pnpm --filter @openarc/web dev --port 5189", url: "http://127.0.0.1:5189/workspace",
    timeout: 30_000, reuseExistingServer: false,
    env: { VITE_COMMIT_SHA: "gateway-evidence-e2e", VITE_ENCRYPTED_WORKSPACE_ENABLED: "true",
      VITE_API_BOUNDARY_ENABLED: "true", VITE_ARC_OBSERVATION_ENABLED: "true", VITE_AGENT_REGISTRY_ENABLED: "true",
      VITE_AGENT_JOBS_ENABLED: "true", VITE_GATEWAY_EVIDENCE_ENABLED: "true" } },
  projects: [
    { name: "chromium-gateway-evidence", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit-gateway-evidence", use: { ...devices["Desktop Safari"] } },
  ],
});

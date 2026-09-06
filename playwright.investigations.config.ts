import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./e2e-investigations", testIgnore: "**/flag-off.spec.ts", fullyParallel: false,
  forbidOnly: Boolean(process.env.CI), timeout: 60_000, retries: 0, reporter: "list",
  use: { baseURL: "http://127.0.0.1:5191", reducedMotion: "reduce", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: { command: "pnpm --filter @openarc/web dev --port 5191", url: "http://127.0.0.1:5191/workspace", timeout: 30_000, reuseExistingServer: false,
    env: { VITE_COMMIT_SHA: "investigations-e2e", VITE_ENCRYPTED_WORKSPACE_ENABLED: "true", VITE_INVESTIGATIONS_ENABLED: "true", VITE_GENERIC_AGENT_IMPORT_ENABLED: "true",
      VITE_API_BOUNDARY_ENABLED: "true", VITE_ARC_OBSERVATION_ENABLED: "true", VITE_AGENT_REGISTRY_ENABLED: "true", VITE_AGENT_JOBS_ENABLED: "true", VITE_GATEWAY_EVIDENCE_ENABLED: "true" } },
  projects: [{ name: "chromium-investigations", use: { ...devices["Desktop Chrome"], reducedMotion: "reduce" } }, { name: "webkit-investigations", use: { ...devices["Desktop Safari"], reducedMotion: "reduce" } }],
});

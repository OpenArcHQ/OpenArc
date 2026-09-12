import { defineConfig, devices } from "@playwright/test";

/**
 * Human machine-credential management acceptance suite.
 *
 * One browser worker, no retries, no server reuse and dedicated ports so no
 * other worker's server is touched. Every credential, session, read and write
 * endpoint is intercepted with strict synthetic fixtures. This suite proves the
 * UI and transport contract only: it is NOT proof of a live API, PostgreSQL,
 * passkey freshness, TLS or the production nginx proxy.
 */

const WEB_MACHINE_ON = "http://localhost:5217";
const WEB_MACHINE_OFF = "http://localhost:5218";
const API_ORIGIN = "http://127.0.0.1:3003";

export default defineConfig({
  testDir: "./e2e-machine-management",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  maxFailures: 3,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL: WEB_MACHINE_ON,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
    {
      command: "pnpm --filter @openarc/web dev --port 5217",
      url: WEB_MACHINE_ON,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_COMMIT_SHA: "e2e-machine-management",
        VITE_ACCOUNT_ACCESS_ENABLED: "true",
        VITE_API_BOUNDARY_ENABLED: "true",
        VITE_TENANT_READS_ENABLED: "true",
        VITE_TENANT_WRITES_ENABLED: "true",
        VITE_MACHINE_CREDENTIAL_MANAGEMENT_ENABLED: "true",
        OPENARC_DEV_API_ORIGIN: API_ORIGIN,
      },
    },
    {
      command: "pnpm --filter @openarc/web dev --port 5218",
      url: WEB_MACHINE_OFF,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_COMMIT_SHA: "e2e-machine-management-off",
        VITE_ACCOUNT_ACCESS_ENABLED: "true",
        VITE_API_BOUNDARY_ENABLED: "true",
        VITE_TENANT_READS_ENABLED: "true",
        VITE_TENANT_WRITES_ENABLED: "true",
        VITE_MACHINE_CREDENTIAL_MANAGEMENT_ENABLED: "false",
        OPENARC_DEV_API_ORIGIN: API_ORIGIN,
      },
    },
  ],
  projects: [
    {
      name: "chromium-machine",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /machine\.spec\.ts$/u,
    },
    {
      name: "webkit-machine",
      use: { ...devices["Desktop Safari"] },
      testMatch: /machine\.spec\.ts$/u,
    },
    {
      name: "chromium-machine-off",
      use: { ...devices["Desktop Chrome"], baseURL: WEB_MACHINE_OFF },
      testMatch: /machine-off\.spec\.ts$/u,
    },
  ],
});

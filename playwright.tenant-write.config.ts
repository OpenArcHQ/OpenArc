import { defineConfig, devices } from "@playwright/test";

/**
 * Protected organization mutation acceptance suite.
 *
 * One browser worker, no retries and no server reuse. The write endpoints are
 * intercepted with strict synthetic fixtures, so this suite proves the UI and
 * transport contract only: it is NOT proof of a live API, PostgreSQL, passkey
 * freshness, TLS or the production nginx proxy. The lead verifies those
 * separately against the real backend.
 */

const WEB_WRITE_ON = "http://localhost:5213";
const WEB_WRITE_OFF = "http://localhost:5214";
const API_ORIGIN = "http://127.0.0.1:3003";

export default defineConfig({
  testDir: "./e2e-tenant-write",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL: WEB_WRITE_ON,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
    {
      command: "pnpm --filter @openarc/web dev --port 5213",
      url: WEB_WRITE_ON,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_COMMIT_SHA: "e2e-tenant-write",
        VITE_ACCOUNT_ACCESS_ENABLED: "true",
        VITE_API_BOUNDARY_ENABLED: "true",
        VITE_TENANT_READS_ENABLED: "true",
        VITE_TENANT_WRITES_ENABLED: "true",
        OPENARC_DEV_API_ORIGIN: API_ORIGIN,
      },
    },
    {
      command: "pnpm --filter @openarc/web dev --port 5214",
      url: WEB_WRITE_OFF,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_COMMIT_SHA: "e2e-tenant-write-off",
        VITE_ACCOUNT_ACCESS_ENABLED: "true",
        VITE_API_BOUNDARY_ENABLED: "true",
        VITE_TENANT_READS_ENABLED: "true",
        VITE_TENANT_WRITES_ENABLED: "false",
        OPENARC_DEV_API_ORIGIN: API_ORIGIN,
      },
    },
  ],
  projects: [
    {
      name: "chromium-tenant-write",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /tenant-write\.spec\.ts$/u,
    },
    {
      name: "webkit-tenant-write",
      use: { ...devices["Desktop Safari"] },
      testMatch: /tenant-write\.spec\.ts$/u,
    },
    {
      name: "chromium-tenant-write-off",
      use: { ...devices["Desktop Chrome"], baseURL: WEB_WRITE_OFF },
      testMatch: /tenant-write-off\.spec\.ts$/u,
    },
  ],
});

import { defineConfig, devices } from "@playwright/test";

/**
 * Protected organization workspace acceptance suite.
 *
 * One browser worker, no retries and no server reuse. The organization reads
 * are intercepted with synthetic responses, so this suite proves the UI
 * contract only; it does not prove a live API, PostgreSQL or nginx path.
 */

const WEB_ORIGIN = "http://localhost:5211";
const WEB_OFF_ORIGIN = "http://localhost:5212";
const API_ORIGIN = "http://127.0.0.1:3003";

export default defineConfig({
  testDir: "./e2e-tenant",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL: WEB_ORIGIN,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
    {
      command: "pnpm --filter @openarc/web dev --port 5211",
      url: WEB_ORIGIN,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_COMMIT_SHA: "e2e-tenant",
        VITE_ACCOUNT_ACCESS_ENABLED: "true",
        VITE_API_BOUNDARY_ENABLED: "true",
        VITE_TENANT_READS_ENABLED: "true",
        OPENARC_DEV_API_ORIGIN: API_ORIGIN,
      },
    },
    {
      command: "pnpm --filter @openarc/web dev --port 5212",
      url: WEB_OFF_ORIGIN,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_COMMIT_SHA: "e2e-tenant-off",
        VITE_ACCOUNT_ACCESS_ENABLED: "true",
        VITE_TENANT_READS_ENABLED: "false",
      },
    },
  ],
  projects: [
    {
      name: "chromium-tenant",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /tenant-shell\.spec\.ts$/u,
    },
    {
      name: "webkit-tenant",
      use: { ...devices["Desktop Safari"] },
      testMatch: /tenant-shell\.spec\.ts$/u,
    },
    {
      name: "chromium-tenant-off",
      use: { ...devices["Desktop Chrome"], baseURL: WEB_OFF_ORIGIN },
      testMatch: /tenant-off\.spec\.ts$/u,
    },
  ],
});

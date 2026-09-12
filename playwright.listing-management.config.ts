import { defineConfig, devices } from "@playwright/test";

/**
 * Protected provider-listing acceptance suite.
 *
 * One browser worker, no retries, no server reuse and dedicated ports so no
 * other worker's server is touched. Every account, read, write, lifecycle and
 * capability endpoint is intercepted with honestly labelled strict synthetic
 * HTTP fixtures. This suite proves the UI and transport contract only: it is
 * NOT proof of a live API, PostgreSQL, passkey freshness, TLS, the production
 * nginx proxy or any purchase/payment behavior.
 *
 * The ON server enables account access, tenant reads and the API boundary while
 * leaving tenant writes and machine credentials OFF, proving that listing
 * management is independent of both. The OFF server disables the listing flag
 * with the same parent flags.
 */

const WEB_LISTING_ON = "http://localhost:5273";
const WEB_LISTING_OFF = "http://localhost:5274";
const API_ORIGIN = "http://127.0.0.1:3003";

export default defineConfig({
  testDir: "./e2e-listing-management",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  maxFailures: 3,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL: WEB_LISTING_ON,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
    {
      command: "pnpm --filter @openarc/web dev --port 5273",
      url: WEB_LISTING_ON,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_COMMIT_SHA: "e2e-listing-management",
        VITE_ACCOUNT_ACCESS_ENABLED: "true",
        VITE_API_BOUNDARY_ENABLED: "true",
        VITE_TENANT_READS_ENABLED: "true",
        VITE_TENANT_WRITES_ENABLED: "false",
        VITE_MACHINE_CREDENTIAL_MANAGEMENT_ENABLED: "false",
        VITE_LISTING_MANAGEMENT_ENABLED: "true",
        OPENARC_DEV_API_ORIGIN: API_ORIGIN,
      },
    },
    {
      command: "pnpm --filter @openarc/web dev --port 5274",
      url: WEB_LISTING_OFF,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_COMMIT_SHA: "e2e-listing-management-off",
        VITE_ACCOUNT_ACCESS_ENABLED: "true",
        VITE_API_BOUNDARY_ENABLED: "true",
        VITE_TENANT_READS_ENABLED: "true",
        VITE_TENANT_WRITES_ENABLED: "false",
        VITE_MACHINE_CREDENTIAL_MANAGEMENT_ENABLED: "false",
        VITE_LISTING_MANAGEMENT_ENABLED: "false",
        OPENARC_DEV_API_ORIGIN: API_ORIGIN,
      },
    },
  ],
  projects: [
    {
      name: "chromium-listing",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /listing\.spec\.ts$/u,
    },
    {
      name: "webkit-listing",
      use: { ...devices["Desktop Safari"] },
      testMatch: /listing\.spec\.ts$/u,
    },
    {
      name: "chromium-listing-off",
      use: { ...devices["Desktop Chrome"], baseURL: WEB_LISTING_OFF },
      testMatch: /listing-off\.spec\.ts$/u,
    },
  ],
});

import { defineConfig, devices } from "@playwright/test";

/**
 * Isolated browser gate for the public marketplace.
 *
 * Three local Vite servers are started inside the runner on isolated loopback
 * ports: 5271 with the marketplace catalog flag ON (and the API boundary ON),
 * 5272 with both flags OFF, and 5273 with only the catalog OFF while the API
 * boundary stays ON (the `/status` capability-read matrix). No host port,
 * external origin or background process is used. The spec serves only accepted
 * HTTP responses through `page.route`, so the browser never reaches a real API,
 * database or network.
 */
export default defineConfig({
  testDir: "./e2e-market-public",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL: "http://127.0.0.1:5271",
    viewport: { width: 1280, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "pnpm --filter @openarc/web dev --port 5271",
      url: "http://127.0.0.1:5271",
      reuseExistingServer: false,
      env: {
        VITE_COMMIT_SHA: "e2e-market-on",
        VITE_MARKET_CATALOG_ENABLED: "true",
        VITE_API_BOUNDARY_ENABLED: "true",
      },
    },
    {
      command: "pnpm --filter @openarc/web dev --port 5272",
      url: "http://127.0.0.1:5272",
      reuseExistingServer: false,
      env: {
        VITE_COMMIT_SHA: "e2e-market-off",
        VITE_MARKET_CATALOG_ENABLED: "false",
        VITE_API_BOUNDARY_ENABLED: "false",
      },
    },
    {
      command: "pnpm --filter @openarc/web dev --port 5273",
      url: "http://127.0.0.1:5273",
      reuseExistingServer: false,
      env: {
        VITE_COMMIT_SHA: "e2e-market-api-on",
        VITE_MARKET_CATALOG_ENABLED: "false",
        VITE_API_BOUNDARY_ENABLED: "true",
      },
    },
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

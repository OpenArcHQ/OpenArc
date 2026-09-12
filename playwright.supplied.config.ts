import { defineConfig, devices } from "@playwright/test";

const PORT = 5199;
const DEV_BASE_URL = `http://127.0.0.1:${PORT}`;

// Exact production target only. Any other value is ignored so the suite cannot
// be pointed at an arbitrary host; ordinary mode keeps the dev webServer.
const productionUrl = process.env.OPENARC_SUPPLIED_PRODUCTION_URL;
const usingProduction = productionUrl === "http://127.0.0.1:8080";
const baseURL = usingProduction ? productionUrl : DEV_BASE_URL;

export default defineConfig({
  testDir: "./e2e-supplied",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  ...(usingProduction
    ? {}
    : {
        webServer: {
          command: `pnpm --filter @openarc/web dev --port ${PORT}`,
          url: DEV_BASE_URL,
          reuseExistingServer: false,
          timeout: 120_000,
          env: {
            VITE_COMMIT_SHA: "e2e-supplied",
            VITE_ENCRYPTED_WORKSPACE_ENABLED: "true",
          },
        },
      }),
  projects: [
    { name: "chromium-supplied", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit-supplied", use: { ...devices["Desktop Safari"] } },
  ],
});

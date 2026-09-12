import { defineConfig, devices } from "@playwright/test";

/**
 * Account vertical-slice acceptance suite.
 *
 * One worker, no retries and no server reuse so the disposable PostgreSQL
 * fixture is deterministic. The web app is served on `localhost:5201` (a
 * hostname, as WebAuthn requires) while Vite binds 127.0.0.1; the API listens
 * on 3003 and is reached only through the same-origin Vite proxy.
 */

const WEB_ORIGIN = "http://localhost:5201";
const WEB_OFF_ORIGIN = "http://localhost:5202";
const API_ORIGIN = "http://127.0.0.1:3003";

export default defineConfig({
  testDir: "./e2e-account",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  timeout: 90_000,
  use: {
    baseURL: WEB_ORIGIN,
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  webServer: [
    {
      command: "pnpm --filter @openarc/api exec tsx ../../e2e-account/test-server.ts",
      url: `${API_ORIGIN}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: "test",
      },
    },
    {
      command: "pnpm --filter @openarc/web dev --port 5201",
      url: WEB_ORIGIN,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_COMMIT_SHA: "e2e-account",
        VITE_ACCOUNT_ACCESS_ENABLED: "true",
        OPENARC_DEV_API_ORIGIN: API_ORIGIN,
      },
    },
    {
      command: "pnpm --filter @openarc/web dev --port 5202",
      url: WEB_OFF_ORIGIN,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        VITE_COMMIT_SHA: "e2e-account-off",
        VITE_ACCOUNT_ACCESS_ENABLED: "false",
      },
    },
  ],
  projects: [
    {
      name: "chromium-account",
      use: { ...devices["Desktop Chrome"] },
      testMatch: /account(?:-wallet)?\.spec\.ts$/u,
    },
    {
      name: "chromium-account-off",
      use: { ...devices["Desktop Chrome"], baseURL: WEB_OFF_ORIGIN },
      testMatch: /account-off\.spec\.ts/u,
    },
    {
      name: "webkit-account",
      use: { ...devices["Desktop Safari"] },
      testMatch: /account-ui\.spec\.ts$/u,
    },
  ],
});

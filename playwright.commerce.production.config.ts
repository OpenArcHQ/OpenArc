import { defineConfig, devices } from "@playwright/test";

/**
 * Real production PORT-03 commerce action/grant acceptance against the
 * provisioned real API image, real ON/OFF nginx web images and real PostgreSQL.
 *
 * Mirrors the accepted `playwright.session.production.config.ts` exactly:
 * no development/test server is launched and no webServer is reused. The
 * browser connects only to the fixed disposable origins below, which use the
 * reserved test hostname `account.openarc.test` mapped to 127.0.0.1 inside
 * Chromium via host-resolver-rules ONLY. No OS DNS change, no proxy and no
 * external host is contacted. The generated self-signed TLS certificate is
 * exempted for these fixed loopback fixture origins only; the real nginx still
 * terminates the connection and verifies its upstream. Traces, screenshots,
 * video and storageState stay OFF so no raw handoff, commerce session, grant,
 * provider session, cookie or CSRF value can be captured.
 *
 * Projects:
 *  - enabled (5491) runs @commerce-on journeys with commerce sessions, actions
 *    and grants ON plus account/tenant reads ON, while policy HTTP, tenant
 *    writes, machine credential HTTP and marketplace stay OFF;
 *  - off (5492) runs @commerce-off journeys with commerce sessions ON and the
 *    action and grant families OFF at the API and the web build.
 *
 * BOTH origins are required exactly. A wrong or absent origin (or a missing
 * fixture opt-in) fails during config load, BEFORE any browser or network
 * activity, and the OFF project is registered unconditionally.
 */

const ENABLED_ORIGIN = "https://account.openarc.test:5491";
const OFF_ORIGIN = "https://account.openarc.test:5492";

const baseURL = process.env["PLAYWRIGHT_COMMERCE_PRODUCTION_BASE_URL"];
if (baseURL !== ENABLED_ORIGIN) {
  throw new Error(`PLAYWRIGHT_COMMERCE_PRODUCTION_BASE_URL must be exactly ${ENABLED_ORIGIN}`);
}
for (const flag of [
  "OPENARC_COMMERCE_PRODUCTION_FIXTURE",
  "OPENARC_SESSION_PRODUCTION_FIXTURE",
  "OPENARC_TENANT_PRODUCTION_FIXTURE",
]) {
  if (process.env[flag] !== "1") throw new Error(`${flag} must be exactly 1`);
}
const offBaseURL = process.env["PLAYWRIGHT_COMMERCE_PRODUCTION_OFF_BASE_URL"];
if (offBaseURL !== OFF_ORIGIN) {
  throw new Error(`PLAYWRIGHT_COMMERCE_PRODUCTION_OFF_BASE_URL must be exactly ${OFF_ORIGIN}`);
}

// Reserved test hostname resolved only inside this Chromium fixture.
const HOST_RESOLVER = "--host-resolver-rules=MAP account.openarc.test 127.0.0.1";

export default defineConfig({
  testDir: "./e2e-commerce-production",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  // Every journey is independent evidence; a failure in one must not hide the
  // result of the others, so the run is not cut short.
  maxFailures: 0,
  reporter: "list",
  timeout: 240_000,
  expect: { timeout: 10_000 },
  use: {
    trace: "off",
    screenshot: "off",
    video: "off",
    storageState: undefined,
    ignoreHTTPSErrors: true,
    actionTimeout: 15_000,
  },
  projects: [
    {
      name: "chromium-commerce-production",
      grep: /@commerce-on/u,
      use: { ...devices["Desktop Chrome"], baseURL, launchOptions: { args: [HOST_RESOLVER] } },
    },
    {
      name: "chromium-commerce-production-off",
      grep: /@commerce-off/u,
      use: {
        ...devices["Desktop Chrome"],
        baseURL: offBaseURL,
        launchOptions: { args: [HOST_RESOLVER] },
      },
    },
  ],
});

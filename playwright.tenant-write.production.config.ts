import { defineConfig, devices } from "@playwright/test";

/**
 * PORT-01 protected tenant WRITE production acceptance against the
 * lead-provisioned real nginx image.
 *
 * No development/test server is launched and no webServer is reused. The
 * browser connects only to the fixed disposable origins below. Those origins
 * use the reserved test hostname `account.openarc.test`, which this fixture
 * maps to 127.0.0.1 inside Chromium via host-resolver-rules ONLY. No OS DNS
 * change, no proxy and no external host is contacted. The generated
 * self-signed TLS certificate is ignored for these fixed loopback fixtures
 * only; the real nginx still terminates the connection and verifies its
 * upstream. Traces, screenshots and video stay off so no credential can be
 * captured.
 *
 * Projects:
 *  - enabled (5443) runs @tenant-write-on journeys with the write flag ON;
 *  - optional off (5444) runs @tenant-write-off journeys with writes OFF but
 *    tenant reads ON. It is registered only when the exact off origin env is
 *    set, and its absence is NOT hidden with test.skip.
 */

const ENABLED_ORIGIN = "https://account.openarc.test:5443";
const OFF_ORIGIN = "https://account.openarc.test:5444";

const baseURL = process.env["PLAYWRIGHT_TENANT_WRITE_PRODUCTION_BASE_URL"];
if (baseURL !== ENABLED_ORIGIN) {
  throw new Error(
    `PLAYWRIGHT_TENANT_WRITE_PRODUCTION_BASE_URL must be exactly ${ENABLED_ORIGIN}`,
  );
}
if (process.env["OPENARC_TENANT_PRODUCTION_FIXTURE"] !== "1") {
  throw new Error("OPENARC_TENANT_PRODUCTION_FIXTURE must be exactly 1");
}

const offBaseURL =
  process.env["PLAYWRIGHT_TENANT_WRITE_PRODUCTION_OFF_BASE_URL"];
if (offBaseURL !== undefined && offBaseURL !== OFF_ORIGIN) {
  throw new Error(
    `PLAYWRIGHT_TENANT_WRITE_PRODUCTION_OFF_BASE_URL must be exactly ${OFF_ORIGIN} when set`,
  );
}

// Reserved test hostname resolved only inside this Chromium fixture.
const HOST_RESOLVER =
  "--host-resolver-rules=MAP account.openarc.test 127.0.0.1";

export default defineConfig({
  testDir: "./e2e-tenant-write-production",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  timeout: 120_000,
  expect: { timeout: 5_000 },
  use: {
    trace: "off",
    screenshot: "off",
    video: "off",
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium-tenant-write-production",
      grep: /@tenant-write-on/u,
      use: {
        ...devices["Desktop Chrome"],
        baseURL,
        launchOptions: { args: [HOST_RESOLVER] },
      },
    },
    ...(offBaseURL === undefined
      ? []
      : [
          {
            name: "chromium-tenant-write-production-off",
            grep: /@tenant-write-off/u,
            use: {
              ...devices["Desktop Chrome"],
              baseURL: offBaseURL,
              launchOptions: { args: [HOST_RESOLVER] },
            },
          },
        ]),
  ],
});

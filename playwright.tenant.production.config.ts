import { defineConfig, devices } from "@playwright/test";

/**
 * PORT-01 protected tenant production acceptance against the lead-provisioned
 * real nginx image.
 *
 * No development/test server is launched and no webServer is reused. The
 * browser connects only to the fixed disposable origins below. Those origins
 * use the reserved test hostname `account.openarc.test`, which this fixture
 * maps to 127.0.0.1 inside Chromium via host-resolver-rules only. No OS DNS
 * change and no external host is contacted. The generated self-signed TLS
 * certificate is ignored for these fixed fixtures only; traces, screenshots
 * and video stay off so no credentials can be captured.
 *
 * Two projects share one spec file:
 *  - the enabled project (5443) runs @tenant-on journeys against the real
 *    API + PostgreSQL + production nginx with the tenant flag ON;
 *  - the optional off project (5444) runs @tenant-off journeys against the
 *    same images with the tenant flag OFF. It is only registered when
 *    PLAYWRIGHT_TENANT_PRODUCTION_OFF_BASE_URL is set exactly.
 */

const ENABLED_ORIGIN = "https://account.openarc.test:5443";
const OFF_ORIGIN = "https://account.openarc.test:5444";

const baseURL = process.env["PLAYWRIGHT_TENANT_PRODUCTION_BASE_URL"];
if (baseURL !== ENABLED_ORIGIN) {
  throw new Error(
    `PLAYWRIGHT_TENANT_PRODUCTION_BASE_URL must be exactly ${ENABLED_ORIGIN}`,
  );
}
if (process.env["OPENARC_TENANT_PRODUCTION_FIXTURE"] !== "1") {
  throw new Error("OPENARC_TENANT_PRODUCTION_FIXTURE must be exactly 1");
}

const offBaseURL = process.env["PLAYWRIGHT_TENANT_PRODUCTION_OFF_BASE_URL"];
if (offBaseURL !== undefined && offBaseURL !== OFF_ORIGIN) {
  throw new Error(
    `PLAYWRIGHT_TENANT_PRODUCTION_OFF_BASE_URL must be exactly ${OFF_ORIGIN} when set`,
  );
}

// Reserved test hostname resolved only inside this Chromium fixture.
const HOST_RESOLVER = "--host-resolver-rules=MAP account.openarc.test 127.0.0.1";

export default defineConfig({
  testDir: "./e2e-tenant-production",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  timeout: 90_000,
  expect: { timeout: 5_000 },
  use: {
    trace: "off",
    screenshot: "off",
    video: "off",
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium-tenant-production",
      grep: /@tenant-on/u,
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
            name: "chromium-tenant-production-off",
            grep: /@tenant-off/u,
            use: {
              ...devices["Desktop Chrome"],
              baseURL: offBaseURL,
              launchOptions: { args: [HOST_RESOLVER] },
            },
          },
        ]),
  ],
});

import { defineConfig, devices } from "@playwright/test";

/**
 * PORT-01 actual production MACHINE credential acceptance against the
 * lead-provisioned real nginx image.
 *
 * No development/test server is launched and no webServer is reused. The
 * browser connects only to the fixed disposable origins below. Those origins
 * use the reserved test hostname `account.openarc.test`, which this fixture
 * maps to 127.0.0.1 inside Chromium via host-resolver-rules ONLY — inside the
 * disposable network namespace the lead runs. No OS DNS change, no proxy and
 * no external host is contacted. The generated self-signed TLS certificate is
 * exempted for these fixed loopback fixture origins only; the real nginx still
 * terminates the connection and verifies its upstream. Traces, screenshots,
 * video and storageState stay off so no raw credential can be captured.
 *
 * Projects:
 *  - enabled (5445) runs @machine-on journeys with machine management ON;
 *  - optional off (5446) runs @machine-off journeys with machine management
 *    OFF. It is registered only when the exact off origin env is set, and its
 *    absence is NOT hidden with test.skip.
 *
 * A wrong or absent enabled origin (and the missing fixture opt-in) fails
 * during config load, BEFORE any browser or network activity.
 */

const ENABLED_ORIGIN = "https://account.openarc.test:5445";
const OFF_ORIGIN = "https://account.openarc.test:5446";

const baseURL = process.env["PLAYWRIGHT_MACHINE_PRODUCTION_BASE_URL"];
if (baseURL !== ENABLED_ORIGIN) {
  throw new Error(
    `PLAYWRIGHT_MACHINE_PRODUCTION_BASE_URL must be exactly ${ENABLED_ORIGIN}`,
  );
}
if (process.env["OPENARC_MACHINE_PRODUCTION_FIXTURE"] !== "1") {
  throw new Error("OPENARC_MACHINE_PRODUCTION_FIXTURE must be exactly 1");
}
if (process.env["OPENARC_TENANT_PRODUCTION_FIXTURE"] !== "1") {
  throw new Error("OPENARC_TENANT_PRODUCTION_FIXTURE must be exactly 1");
}

const offBaseURL =
  process.env["PLAYWRIGHT_MACHINE_PRODUCTION_OFF_BASE_URL"];
if (offBaseURL !== undefined && offBaseURL !== OFF_ORIGIN) {
  throw new Error(
    `PLAYWRIGHT_MACHINE_PRODUCTION_OFF_BASE_URL must be exactly ${OFF_ORIGIN} when set`,
  );
}

// Reserved test hostname resolved only inside this Chromium fixture.
const HOST_RESOLVER =
  "--host-resolver-rules=MAP account.openarc.test 127.0.0.1";

export default defineConfig({
  testDir: "./e2e-machine-production",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  maxFailures: 3,
  reporter: "list",
  timeout: 120_000,
  expect: { timeout: 5_000 },
  use: {
    trace: "off",
    screenshot: "off",
    video: "off",
    ignoreHTTPSErrors: true,
    // A bounded per-action timeout so a genuinely absent selector (for example
    // a role-gated control the running image does not render) fails at its real
    // callsite instead of consuming the whole test timeout and masking the
    // failure during cleanup. This is a LOWER bound; the total test timeout is
    // unchanged and no assertion is relaxed.
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: "chromium-machine-production",
      grep: /@machine-on/u,
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
            name: "chromium-machine-production-off",
            grep: /@machine-off/u,
            use: {
              ...devices["Desktop Chrome"],
              baseURL: offBaseURL,
              launchOptions: { args: [HOST_RESOLVER] },
            },
          },
        ]),
  ],
});

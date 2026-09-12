import { defineConfig, devices } from "@playwright/test";

/**
 * Account production acceptance against the lead-provisioned real nginx image.
 *
 * No development/test server is launched and no webServer is reused. The
 * browser connects only to the fixed disposable origin supplied via
 * PLAYWRIGHT_ACCOUNT_PRODUCTION_BASE_URL. That origin uses the reserved test
 * hostname `account.openarc.test`, which this fixture maps to 127.0.0.1 in
 * Chromium via host-resolver-rules only. No OS DNS change and no external host
 * is contacted. The generated self-signed TLS certificate is ignored for this
 * one fixed fixture only; traces, screenshots and video stay off so no
 * credentials can be captured.
 */

const EXPECTED_ORIGIN = "https://account.openarc.test:5443";

const baseURL = process.env.PLAYWRIGHT_ACCOUNT_PRODUCTION_BASE_URL;
if (baseURL !== EXPECTED_ORIGIN) {
  throw new Error(
    `PLAYWRIGHT_ACCOUNT_PRODUCTION_BASE_URL must be exactly ${EXPECTED_ORIGIN}`,
  );
}

export default defineConfig({
  testDir: "./e2e-account",
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  timeout: 90_000,
  use: {
    baseURL,
    trace: "off",
    screenshot: "off",
    video: "off",
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: "chromium-account-production",
      use: {
        ...devices["Desktop Chrome"],
        // Reserved test hostname resolved only inside this Chromium fixture.
        launchOptions: {
          args: [
            "--host-resolver-rules=MAP account.openarc.test 127.0.0.1",
          ],
        },
      },
      testMatch: /account(?:-wallet|-production)?\.spec\.ts$/u,
    },
  ],
});

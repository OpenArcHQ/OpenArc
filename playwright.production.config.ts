import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e-production",
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.PLAYWRIGHT_PRODUCTION_BASE_URL ?? "http://127.0.0.1:8081",
    reducedMotion: "reduce",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium-production", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit-production", use: { ...devices["Desktop Safari"] } },
  ],
});

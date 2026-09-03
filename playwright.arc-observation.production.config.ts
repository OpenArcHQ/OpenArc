import { defineConfig } from "@playwright/test";

import base from "./playwright.arc-observation.config.js";

export default defineConfig({
  ...base,
  webServer: undefined,
  retries: 0,
  use: {
    ...base.use,
    baseURL: process.env.PLAYWRIGHT_PRODUCTION_BASE_URL ?? "https://127.0.0.1:8444",
    ignoreHTTPSErrors: true,
  },
});

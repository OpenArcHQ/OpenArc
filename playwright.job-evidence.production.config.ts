import { defineConfig } from "@playwright/test";

import base from "./playwright.job-evidence.config.js";

export default defineConfig({
  ...base,
  webServer: undefined,
  retries: 0,
  use: {
    ...base.use,
    baseURL: process.env.PLAYWRIGHT_PRODUCTION_BASE_URL ?? "https://127.0.0.1:8445",
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: { ...base.use?.extraHTTPHeaders, "X-Real-IP": "192.0.2.70" },
  },
});

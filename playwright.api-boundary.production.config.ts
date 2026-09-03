import base from "./playwright.api-boundary.config.js";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  ...base,
  webServer: undefined,
  use: { ...base.use, baseURL: process.env.PLAYWRIGHT_PRODUCTION_BASE_URL ?? "https://127.0.0.1:8443",
    ignoreHTTPSErrors: true },
});

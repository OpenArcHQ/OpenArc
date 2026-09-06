import { defineConfig } from "@playwright/test";
import base from "./playwright.investigations.config.js";
const baseURL = process.env.PLAYWRIGHT_PRODUCTION_BASE_URL ?? "https://127.0.0.1:8446";
const loopback = new URL(baseURL).hostname === "127.0.0.1";
export default defineConfig({ ...base, webServer: undefined, retries: 0,
  use: { ...base.use, baseURL, ignoreHTTPSErrors: loopback, extraHTTPHeaders: loopback ? { "X-Real-IP": "192.0.2.91" } : {} } });

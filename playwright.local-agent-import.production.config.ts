import { defineConfig } from "@playwright/test";
import base from "./playwright.local-agent-import.config.js";

const baseURL = process.env.PLAYWRIGHT_PRODUCTION_BASE_URL ?? "https://127.0.0.1:8445";
const loopbackFixture = new URL(baseURL).hostname === "127.0.0.1";

export default defineConfig({ ...base, webServer: undefined, retries: 0,
  use: { ...base.use, baseURL, ignoreHTTPSErrors: loopbackFixture,
    extraHTTPHeaders: { ...base.use?.extraHTTPHeaders, ...(loopbackFixture ? { "X-Real-IP": "192.0.2.90" } : {}) } },
});

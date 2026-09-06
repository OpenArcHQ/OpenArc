import { defineConfig } from "@playwright/test";
import base from "./playwright.investigations.config.js";
export default defineConfig({ ...base, testIgnore: [], testMatch: "**/flag-off.spec.ts",
  webServer: { ...base.webServer, command: "pnpm --filter @openarc/web dev --port 5191", url: "http://127.0.0.1:5191/workspace", reuseExistingServer: false,
    env: { VITE_ENCRYPTED_WORKSPACE_ENABLED: "true", VITE_INVESTIGATIONS_ENABLED: "false" } } });

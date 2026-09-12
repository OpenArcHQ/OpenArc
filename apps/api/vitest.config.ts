import { defineConfig } from "vitest/config";

/**
 * Ordinary API unit/HTTP-inject suite. The PostgreSQL-backed suite is excluded
 * here and runs only through the explicit `test:postgres` config so the two
 * schema suites never run simultaneously.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/**/*.postgres.test.ts", "**/node_modules/**"],
    fileParallelism: false,
  },
});

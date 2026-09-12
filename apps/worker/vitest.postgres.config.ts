import { defineConfig } from "vitest/config";

/**
 * Explicit real-PostgreSQL suite for the bounded tenant notification worker.
 *
 * It includes ONLY the postgres test file and FAILS when the exact disposable
 * fixture URL is absent: there is no silent skip. The suite resets only the
 * guarded disposable fixture database.
 */
const fixtureUrl = process.env["OPENARC_TEST_DATABASE_URL"];
if (!fixtureUrl) {
  throw new Error(
    "OPENARC_TEST_DATABASE_URL is required for the worker postgres suite.",
  );
}

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/worker.postgres.test.ts"],
    fileParallelism: false,
  },
});

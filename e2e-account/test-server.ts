/**
 * Test-only account API entry.
 *
 * This file is NEVER imported by the application, build or deployment. It
 * bootstraps a disposable PostgreSQL fixture (roles + migrations) through the
 * existing postgres-fixture helpers using the admin connection, then starts
 * the REAL auth runtime over the restricted `openarc_auth_app` role and the
 * REAL Fastify app. No proof, store or auth route is faked here.
 */
import { createDatabasePool, migrate, readSchemaVersion } from "../packages/db/src/index.js";

import { createApp } from "../apps/api/src/app.js";
import { authCookieNames } from "../apps/api/src/auth/cookies.js";
import { startAuthRuntime } from "../apps/api/src/auth/runtime.js";
import { loadConfig } from "../apps/api/src/config.js";
import {
  adminPool,
  appUrl,
  ensureRoles,
  fixtureUrl,
  migratorUrl,
  resetSchema,
} from "../packages/db/test/postgres-fixture.js";

const PORT = 3003;
const ORIGIN = "http://localhost:5201";
const RP_ID = "localhost";
const SECRET = "synthetic_e2e_account_secret_0123456789ABCDEF";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";

async function main(): Promise<void> {
  if (fixtureUrl.length === 0) throw new Error("OPENARC_TEST_DATABASE_URL is required");
  const admin = adminPool();
  await ensureRoles(admin);
  await resetSchema(admin);
  const migrator = createDatabasePool(migratorUrl());
  await migrate(migrator);
  await migrator.end();

  const appPool = createDatabasePool(appUrl());
  await readSchemaVersion(appPool);
  await appPool.end();

  const runtime = await startAuthRuntime({
    authDatabaseUrl: appUrl(),
    authSecret: SECRET,
    appOrigin: ORIGIN,
    rpId: RP_ID,
    environment: "development",
    secureCookies: false,
    cookieNames: authCookieNames(false),
  });

  const config = loadConfig({
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(PORT),
    APP_ORIGIN: ORIGIN,
    COMMIT_SHA: BUILD_SHA,
    LOG_LEVEL: "silent",
    AUTH_ENABLED: "true",
    AUTH_DATABASE_URL: appUrl(),
    AUTH_SECRET: SECRET,
    AUTH_RP_ID: RP_ID,
  });
  const app = createApp({ config, logger: false, authService: runtime.service });
  await app.listen({ host: "127.0.0.1", port: PORT });

  const shutdown = (): void => {
    void app
      .close()
      .then(() => runtime.close())
      .then(() => admin.end())
      .finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

void main().catch(() => {
  process.stderr.write('{"event":"account_test_server_failed"}\n');
  process.exit(1);
});

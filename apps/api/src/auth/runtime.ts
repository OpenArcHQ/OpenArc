import { createDatabasePool, readSchemaVersion, AuthStore } from "@openarc/db";

import { proofs } from "./runtime-proofs.js";
import { AuthService, type AuthServiceConfig } from "./service.js";

/** The reviewed pool type, derived without importing the driver directly. */
type AuthPool = ReturnType<typeof createDatabasePool>;

/**
 * Runtime wiring for the account auth slice.
 *
 * The server NEVER runs migrations. It verifies the connected role is the
 * restricted application role, then verifies schema compatibility through the
 * reviewed `readSchemaVersion` helper. Any failure fails startup closed.
 */

export interface AuthRuntimeDependencies {
  authDatabaseUrl: string;
  authSecret: string;
  appOrigin: string;
  rpId: string;
  environment: "development" | "production";
  secureCookies: boolean;
  cookieNames: AuthServiceConfig["cookieNames"];
  rateLimits?: AuthServiceConfig["rateLimits"];
}

function fail(): never {
  throw new Error("AUTH_RUNTIME_UNAVAILABLE");
}

async function assertAppRole(pool: AuthPool): Promise<void> {
  const result = await pool.query<{
    current_user: string;
    rolsuper: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT current_user,
            r.rolsuper,
            r.rolbypassrls
       FROM pg_roles r
      WHERE r.rolname = current_user`,
  );
  const row = result.rows[0];
  if (row === undefined) fail();
  if (row.current_user !== "openarc_auth_app") fail();
  if (row.rolsuper !== false || row.rolbypassrls !== false) fail();
}

export interface StartedAuthRuntime {
  service: AuthService;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

export async function startAuthRuntime(
  dependencies: AuthRuntimeDependencies,
): Promise<StartedAuthRuntime> {
  let pool: AuthPool;
  try {
    pool = createDatabasePool(dependencies.authDatabaseUrl);
    await assertAppRole(pool);
    await readSchemaVersion(pool);
  } catch {
    fail();
  }

  const store = new AuthStore(pool);
  const service = new AuthService({
    config: {
      authSecret: dependencies.authSecret,
      appOrigin: dependencies.appOrigin,
      rpId: dependencies.rpId,
      environment: dependencies.environment,
      secureCookies: dependencies.secureCookies,
      cookieNames: dependencies.cookieNames,
      ...(dependencies.rateLimits !== undefined
        ? { rateLimits: dependencies.rateLimits }
        : {}),
    },
    store,
    proofs: proofs,
  });
  service.startHousekeeping();

  let ready = true;
  return {
    service,
    async ready(): Promise<boolean> {
      if (!ready) return false;
      try {
        await readSchemaVersion(pool);
        return true;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      ready = false;
      service.stopHousekeeping();
      await pool.end();
    },
  };
}

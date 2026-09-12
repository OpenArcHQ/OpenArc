import { asTenantPool, createDatabasePool, TenantStore } from "@openarc/db";

import { TenantReadService } from "./service.js";
import type { TenantReadAuthPort } from "./ports.js";
import { TenantWriteService } from "./write-service.js";
import type { TenantWriteAuthPort } from "./write-ports.js";

/**
 * Runtime wiring for the protected tenant read family.
 *
 * The server NEVER runs migrations. This runtime creates its OWN dedicated
 * pool bound to the restricted `openarc_tenant_app` role, constructs the
 * accepted TenantStore, then initializes it exactly once so the connected
 * role, bundled schema revision, RLS posture and checksum manifest all match
 * before any route can serve. Any failure closes this runtime's pool and
 * throws a fixed non-echoing error; the caller must fail startup closed.
 */

export interface TenantRuntimeDependencies {
  tenantDatabaseUrl: string;
  auth: TenantReadAuthPort;
  /**
   * Full write auth seam (adds verifyCsrf). Required only when writes are on;
   * the same authenticated AuthService instance satisfies both ports.
   */
  writeAuth?: TenantWriteAuthPort;
  /**
   * Optional tenant write family. Defaults off: when absent or false the
   * runtime constructs NO write service and reads no extra credential.
   */
  writesEnabled?: boolean;
}

export interface StartedTenantRuntime {
  service: TenantReadService;
  writeService?: TenantWriteService;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

function fail(): never {
  throw new Error("TENANT_RUNTIME_UNAVAILABLE");
}

export async function startTenantRuntime(
  dependencies: TenantRuntimeDependencies,
): Promise<StartedTenantRuntime> {
  let pool: ReturnType<typeof createDatabasePool>;
  try {
    pool = createDatabasePool(dependencies.tenantDatabaseUrl);
  } catch {
    fail();
  }

  let store: TenantStore;
  try {
    store = new TenantStore(asTenantPool(pool));
    await store.initialize();
  } catch {
    await pool.end().catch(() => undefined);
    fail();
  }

  const service = new TenantReadService({
    auth: dependencies.auth,
    store,
  });
  let writeService: TenantWriteService | undefined;
  if (dependencies.writesEnabled === true) {
    if (dependencies.writeAuth === undefined) {
      await pool.end().catch(() => undefined);
      fail();
    }
    writeService = new TenantWriteService({
      auth: dependencies.writeAuth,
      store,
    });
  }

  let closed = false;
  return {
    service,
    ...(writeService !== undefined ? { writeService } : {}),
    async ready(): Promise<boolean> {
      if (closed) return false;
      try {
        await store.readiness();
        return true;
      } catch {
        return false;
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await pool.end().catch(() => undefined);
    },
  };
}

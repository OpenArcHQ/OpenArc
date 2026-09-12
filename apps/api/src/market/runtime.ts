import { asMarketPool, createDatabasePool, MarketStore } from "@openarc/db";

import type { TenantWriteAuthPort } from "../tenant/write-ports.js";
import { MarketService } from "./service.js";

/**
 * Dedicated runtime wiring for the protected market listing family.
 *
 * The server NEVER runs migrations. This runtime creates its OWN dedicated
 * pool bound to the restricted `openarc_tenant_app` role, constructs the
 * accepted `MarketStore`, then initializes it EXACTLY once so the connected
 * role, bundled schema revision, RLS posture, helper ACLs and checksum manifest
 * all match before any route can serve. Any failure closes this pool and throws
 * a fixed non-echoing error; the caller must fail startup closed.
 *
 * `ready()` is a bounded read-only readiness re-check that never migrates and
 * returns `false` once closed or on any dependency failure without leaking the
 * URL or role. It is single-flight: concurrent and repeated calls while a probe
 * is still in flight share that one probe, so an uncancellable old probe can
 * never be multiplied. A fixed 2000ms deadline fails the await closed without
 * clearing the underlying task; a late settled result is discarded once the
 * runtime is closed. `close()` ends the pool exactly once.
 */

const READINESS_DEADLINE_MS = 2000;

export interface MarketRuntimeDependencies {
  readonly marketDatabaseUrl: string;
  readonly auth: TenantWriteAuthPort;
}

export interface StartedMarketRuntime {
  readonly service: MarketService;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

function fail(): never {
  throw new Error("MARKET_RUNTIME_UNAVAILABLE");
}

export async function startMarketRuntime(
  dependencies: MarketRuntimeDependencies,
): Promise<StartedMarketRuntime> {
  let pool: ReturnType<typeof createDatabasePool>;
  try {
    pool = createDatabasePool(dependencies.marketDatabaseUrl);
  } catch {
    fail();
  }

  let store: MarketStore;
  try {
    store = new MarketStore(asMarketPool(pool));
    await store.initialize();
  } catch {
    await pool.end().catch(() => undefined);
    fail();
  }

  const service = new MarketService({ auth: dependencies.auth, store });

  let closed = false;
  let inFlight: Promise<boolean> | undefined;

  async function probeReadiness(): Promise<boolean> {
    try {
      await store.readiness();
      // A probe that finishes only after close must never report ready.
      return !closed;
    } catch {
      return false;
    }
  }

  function runSingleFlight(): Promise<boolean> {
    if (inFlight === undefined) {
      // Keep the promise even after a deadline timeout: repeated probes must
      // attach to the same uncancelled task, never pile up new ones.
      inFlight = probeReadiness().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  }

  return {
    service,
    async ready(): Promise<boolean> {
      if (closed) return false;
      const probe = runSingleFlight();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), READINESS_DEADLINE_MS);
      });
      try {
        const result = await Promise.race([probe, deadline]);
        if (closed) return false;
        return result;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await pool.end().catch(() => undefined);
    },
  };
}

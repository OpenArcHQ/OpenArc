import {
  asMarketPool,
  createDatabasePool,
  MarketCatalogStore,
  MarketLifecycleStore,
  MarketStore,
} from "@openarc/db";

import type { TenantWriteAuthPort } from "../tenant/write-ports.js";
import { MarketCatalogService } from "./catalog-service.js";
import { MarketLifecycleService } from "./lifecycle-service.js";
import { MarketService } from "./service.js";

/**
 * Dedicated runtime wiring for the independent marketplace families.
 *
 * The server NEVER runs migrations. This runtime opens EXACTLY ONE dedicated
 * pool bound to the restricted `openarc_tenant_app` role and shares that single
 * pool across the ENABLED stores only:
 *   - draft MarketStore + MarketService when listing management is on,
 *   - MarketLifecycleStore + MarketLifecycleService when listing OR moderation
 *     is on (both protected browser families share the lifecycle store),
 *   - MarketCatalogStore + MarketCatalogService when the public catalog is on.
 * No per-store pool, no global/auth pool and no SQL migration is ever created.
 * Every required `initialize()` completes before the runtime is returned; any
 * failure closes the one owned pool exactly once and throws a fixed
 * non-echoing error so the caller fails startup closed.
 *
 * Input is explicit: three booleans plus the dedicated restricted database URL,
 * with an optional auth port that is REQUIRED when a protected family (listing
 * management or moderation) is enabled and MUST be absent from a catalog-only
 * run. Unknown/non-boolean flags and an all-off call fail closed BEFORE any pool
 * is constructed.
 *
 * `ready()` is a bounded read-only readiness re-check that never migrates. It
 * is single-flight across ALL enabled stores: concurrent and repeated calls
 * while a probe is still in flight share that ONE batch, so an uncancellable
 * old probe can never be multiplied. A fixed 2000ms deadline fails the await
 * closed without clearing the underlying batch; a late completion after close
 * can never promote readiness. `close()` ends the owned pool exactly once.
 */

const READINESS_DEADLINE_MS = 2000;

export interface MarketRuntimeDependencies {
  readonly marketDatabaseUrl: string;
  readonly catalogEnabled: boolean;
  readonly listingManagementEnabled: boolean;
  readonly moderationEnabled: boolean;
  readonly auth?: TenantWriteAuthPort;
}

export interface StartedMarketRuntime {
  /** Present only when listing management is enabled. */
  readonly service?: MarketService;
  /** Present when listing management OR moderation is enabled. */
  readonly lifecycleService?: MarketLifecycleService;
  /** Present only when the public catalog is enabled. */
  readonly catalogService?: MarketCatalogService;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

interface ReadinessStore {
  readiness(): Promise<void>;
}

/** Fixed input rejection raised BEFORE any pool or store is constructed. */
function invalidInput(): never {
  throw new Error("MARKET_RUNTIME_INVALID_INPUT");
}

function unavailable(): never {
  throw new Error("MARKET_RUNTIME_UNAVAILABLE");
}

export async function startMarketRuntime(
  dependencies: MarketRuntimeDependencies,
): Promise<StartedMarketRuntime> {
  const catalogEnabled = dependencies.catalogEnabled;
  const listingEnabled = dependencies.listingManagementEnabled;
  const moderationEnabled = dependencies.moderationEnabled;
  // Reject unknown/non-boolean flags and an all-off call before touching a pool.
  if (
    typeof catalogEnabled !== "boolean" ||
    typeof listingEnabled !== "boolean" ||
    typeof moderationEnabled !== "boolean"
  ) {
    invalidInput();
  }
  if (!catalogEnabled && !listingEnabled && !moderationEnabled) invalidInput();
  // Protected browser families need the accepted auth seam; a catalog-only
  // runtime must not receive (and never dereferences) an auth service.
  if (
    (listingEnabled || moderationEnabled) &&
    dependencies.auth === undefined
  ) {
    invalidInput();
  }

  let pool: ReturnType<typeof createDatabasePool>;
  try {
    pool = createDatabasePool(dependencies.marketDatabaseUrl);
  } catch {
    unavailable();
  }

  const tenantPool = asMarketPool(pool);
  const readinessStores: ReadinessStore[] = [];
  let service: MarketService | undefined;
  let lifecycleService: MarketLifecycleService | undefined;
  let catalogService: MarketCatalogService | undefined;

  try {
    if (listingEnabled) {
      const store = new MarketStore(tenantPool);
      await store.initialize();
      readinessStores.push(store);
      service = new MarketService({ auth: dependencies.auth!, store });
    }
    if (listingEnabled || moderationEnabled) {
      const store = new MarketLifecycleStore(tenantPool);
      await store.initialize();
      readinessStores.push(store);
      lifecycleService = new MarketLifecycleService({
        auth: dependencies.auth!,
        store,
      });
    }
    if (catalogEnabled) {
      const store = new MarketCatalogStore(tenantPool);
      await store.initialize();
      readinessStores.push(store);
      catalogService = new MarketCatalogService({ store });
    }
  } catch {
    // Any initialization failure owns the one pool: close it once, then fail.
    await pool.end().catch(() => undefined);
    unavailable();
  }

  let closed = false;
  let inFlight: Promise<boolean> | undefined;

  async function probeReadiness(): Promise<boolean> {
    try {
      for (const store of readinessStores) {
        await store.readiness();
      }
      // A batch that only finishes after close must never report ready.
      return !closed;
    } catch {
      return false;
    }
  }

  function runSingleFlight(): Promise<boolean> {
    if (inFlight === undefined) {
      // Retain the promise until it ACTUALLY settles: repeated probes after a
      // deadline timeout keep attaching to the same uncancelled batch.
      inFlight = probeReadiness().finally(() => {
        inFlight = undefined;
      });
    }
    return inFlight;
  }

  return {
    ...(service !== undefined ? { service } : {}),
    ...(lifecycleService !== undefined ? { lifecycleService } : {}),
    ...(catalogService !== undefined ? { catalogService } : {}),
    async ready(): Promise<boolean> {
      if (closed) return false;
      const probe = runSingleFlight();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), READINESS_DEADLINE_MS);
      });
      try {
        const result = await Promise.race([probe, deadline]);
        // Late settlement after close can never promote readiness.
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

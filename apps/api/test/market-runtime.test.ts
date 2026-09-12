import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@openarc/db";

import { startMarketRuntime } from "../src/market/runtime.js";

/**
 * Wiring-only tests for the marketplace runtime.
 *
 * `@openarc/db` is HONESTLY MOCKED here (labelled): these tests prove ONE
 * dedicated shared pool, per-store initialize gating, single-flight readiness
 * across all enabled stores, exactly-once cleanup and catalog-without-auth
 * wiring. Real role, schema, RLS, helper ACL and checksum enforcement is
 * covered by the PostgreSQL suite. No mock is a production path.
 */

interface Probe {
  createCalls: number;
  endCalls: number;
  marketInit: number;
  lifecycleInit: number;
  catalogInit: number;
  marketReady: number;
  lifecycleReady: number;
  catalogReady: number;
  initError: "none" | "market" | "lifecycle" | "catalog";
  readyError: "none" | "market" | "lifecycle" | "catalog";
  readinessGate: (() => Promise<void>) | undefined;
  poolRef: unknown;
  storePoolRefs: unknown[];
}

const probe = vi.hoisted<Probe>(() => ({
  createCalls: 0,
  endCalls: 0,
  marketInit: 0,
  lifecycleInit: 0,
  catalogInit: 0,
  marketReady: 0,
  lifecycleReady: 0,
  catalogReady: 0,
  initError: "none",
  readyError: "none",
  readinessGate: undefined,
  poolRef: undefined,
  storePoolRefs: [],
}));

vi.mock("@openarc/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  class FakeMarketStore {
    constructor(pool: unknown) {
      probe.storePoolRefs.push(pool);
    }
    async initialize(): Promise<void> {
      probe.marketInit += 1;
      if (probe.initError === "market") throw new Error("MARKET_INIT_FAILED");
    }
    async readiness(): Promise<void> {
      probe.marketReady += 1;
      if (probe.readinessGate) await probe.readinessGate();
      if (probe.readyError === "market") throw new Error("MARKET_NOT_READY");
    }
  }
  class FakeMarketLifecycleStore {
    constructor(pool: unknown) {
      probe.storePoolRefs.push(pool);
    }
    async initialize(): Promise<void> {
      probe.lifecycleInit += 1;
      if (probe.initError === "lifecycle") throw new Error("LIFECYCLE_INIT_FAILED");
    }
    async readiness(): Promise<void> {
      probe.lifecycleReady += 1;
      if (probe.readinessGate) await probe.readinessGate();
      if (probe.readyError === "lifecycle") throw new Error("LIFECYCLE_NOT_READY");
    }
  }
  class FakeMarketCatalogStore {
    constructor(pool: unknown) {
      probe.storePoolRefs.push(pool);
    }
    async initialize(): Promise<void> {
      probe.catalogInit += 1;
      if (probe.initError === "catalog") throw new Error("CATALOG_INIT_FAILED");
    }
    async readiness(): Promise<void> {
      probe.catalogReady += 1;
      if (probe.readinessGate) await probe.readinessGate();
      if (probe.readyError === "catalog") throw new Error("CATALOG_NOT_READY");
    }
  }
  return {
    ...actual,
    createDatabasePool: () => {
      probe.createCalls += 1;
      const pool = {
        end: async () => {
          probe.endCalls += 1;
        },
      };
      probe.poolRef = pool;
      return pool;
    },
    asMarketPool: (pool: unknown) => pool,
    MarketStore: FakeMarketStore,
    MarketLifecycleStore: FakeMarketLifecycleStore,
    MarketCatalogStore: FakeMarketCatalogStore,
  };
});

const AUTH = {
  verifyCsrf: () => "binding",
  beginTenantRead: async () => ({
    sessionHash: "a".repeat(64),
    accountId: "openarc:account:11111111-1111-4111-8111-111111111111",
  }),
  finishTenantRead: async () => undefined,
};

const URL = "postgres://openarc_tenant_app:y@127.0.0.1:5432/openarc_auth_test";

function base(
  overrides: Partial<{
    catalogEnabled: boolean;
    listingManagementEnabled: boolean;
    moderationEnabled: boolean;
    auth: typeof AUTH | undefined;
  }> = {},
) {
  return {
    marketDatabaseUrl: URL,
    catalogEnabled: overrides.catalogEnabled ?? false,
    listingManagementEnabled: overrides.listingManagementEnabled ?? false,
    moderationEnabled: overrides.moderationEnabled ?? false,
    ...(overrides.auth !== undefined ? { auth: overrides.auth } : {}),
  };
}

beforeEach(() => {
  probe.createCalls = 0;
  probe.endCalls = 0;
  probe.marketInit = 0;
  probe.lifecycleInit = 0;
  probe.catalogInit = 0;
  probe.marketReady = 0;
  probe.lifecycleReady = 0;
  probe.catalogReady = 0;
  probe.initError = "none";
  probe.readyError = "none";
  probe.readinessGate = undefined;
  probe.poolRef = undefined;
  probe.storePoolRefs = [];
});

describe("startMarketRuntime", () => {
  it("starts all enabled stores over exactly ONE shared restricted pool", async () => {
    const runtime = await startMarketRuntime(
      base({
        catalogEnabled: true,
        listingManagementEnabled: true,
        moderationEnabled: true,
        auth: AUTH,
      }),
    );
    expect(probe.createCalls).toBe(1);
    expect(probe.marketInit).toBe(1);
    expect(probe.lifecycleInit).toBe(1);
    expect(probe.catalogInit).toBe(1);
    expect(runtime.service).toBeDefined();
    expect(runtime.lifecycleService).toBeDefined();
    expect(runtime.catalogService).toBeDefined();
    // Every store received the SAME single pool object, never a per-store pool.
    expect(probe.storePoolRefs).toHaveLength(3);
    expect(new Set(probe.storePoolRefs).size).toBe(1);
    expect(probe.storePoolRefs[0]).toBe(probe.poolRef);

    await expect(runtime.ready()).resolves.toBe(true);
    expect(probe.marketReady).toBe(1);
    expect(probe.lifecycleReady).toBe(1);
    expect(probe.catalogReady).toBe(1);

    await runtime.close();
    expect(probe.endCalls).toBe(1);
  });

  it("starts only the public catalog store without any auth port", async () => {
    const runtime = await startMarketRuntime(base({ catalogEnabled: true }));
    expect(probe.createCalls).toBe(1);
    expect(probe.catalogInit).toBe(1);
    expect(probe.marketInit).toBe(0);
    expect(probe.lifecycleInit).toBe(0);
    expect(runtime.service).toBeUndefined();
    expect(runtime.lifecycleService).toBeUndefined();
    expect(runtime.catalogService).toBeDefined();
    await expect(runtime.ready()).resolves.toBe(true);
    expect(probe.catalogReady).toBe(1);
    await runtime.close();
  });

  it("shares the lifecycle store for listing management alone", async () => {
    const runtime = await startMarketRuntime(
      base({ listingManagementEnabled: true, auth: AUTH }),
    );
    expect(probe.marketInit).toBe(1);
    expect(probe.lifecycleInit).toBe(1);
    expect(probe.catalogInit).toBe(0);
    expect(runtime.service).toBeDefined();
    expect(runtime.lifecycleService).toBeDefined();
    expect(runtime.catalogService).toBeUndefined();
    await runtime.close();
  });

  it("shares the lifecycle store for moderation alone", async () => {
    const runtime = await startMarketRuntime(
      base({ moderationEnabled: true, auth: AUTH }),
    );
    expect(probe.marketInit).toBe(0);
    expect(probe.lifecycleInit).toBe(1);
    expect(probe.catalogInit).toBe(0);
    expect(runtime.service).toBeUndefined();
    expect(runtime.lifecycleService).toBeDefined();
    await runtime.close();
  });

  it("rejects an all-off call before constructing any pool", async () => {
    await expect(startMarketRuntime(base())).rejects.toThrow(
      "MARKET_RUNTIME_INVALID_INPUT",
    );
    expect(probe.createCalls).toBe(0);
    expect(probe.endCalls).toBe(0);
  });

  it("rejects non-boolean flags before constructing any pool", async () => {
    await expect(
      startMarketRuntime({
        ...base(),
        catalogEnabled: "true" as unknown as boolean,
      }),
    ).rejects.toThrow("MARKET_RUNTIME_INVALID_INPUT");
    expect(probe.createCalls).toBe(0);
  });

  it("rejects a protected family without the auth seam before any pool", async () => {
    for (const flags of [
      { listingManagementEnabled: true },
      { moderationEnabled: true },
    ] as const) {
      await expect(
        startMarketRuntime(base({ ...flags, catalogEnabled: true })),
      ).rejects.toThrow("MARKET_RUNTIME_INVALID_INPUT");
    }
    expect(probe.createCalls).toBe(0);
  });

  it("fails closed and closes the ONE pool once when initialization fails", async () => {
    probe.initError = "lifecycle";
    await expect(
      startMarketRuntime(
        base({ listingManagementEnabled: true, auth: AUTH }),
      ),
    ).rejects.toThrow("MARKET_RUNTIME_UNAVAILABLE");
    expect(probe.endCalls).toBe(1);
    expect(probe.marketInit).toBe(1);
  });

  it("reports not-ready and never throws when a readiness check fails", async () => {
    probe.readyError = "catalog";
    const runtime = await startMarketRuntime(base({ catalogEnabled: true }));
    await expect(runtime.ready()).resolves.toBe(false);
    await runtime.close();
  });

  it("closes the owned pool exactly once and reports not-ready after close", async () => {
    const runtime = await startMarketRuntime(base({ catalogEnabled: true }));
    await runtime.close();
    await runtime.close();
    expect(probe.endCalls).toBe(1);
    await expect(runtime.ready()).resolves.toBe(false);
  });

  it("single-flights concurrent readiness probes across all stores", async () => {
    const runtime = await startMarketRuntime(
      base({
        catalogEnabled: true,
        listingManagementEnabled: true,
        moderationEnabled: true,
        auth: AUTH,
      }),
    );
    let release!: () => void;
    // ONE shared gate promise: every enabled store's readiness awaits it.
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    probe.readinessGate = () => gate;
    const first = runtime.ready();
    const second = runtime.ready();
    const third = runtime.ready();
    // All three attach to the SAME underlying batch.
    await new Promise((resolve) => setImmediate(resolve));
    expect(probe.marketReady).toBe(1);
    // Stores are probed sequentially: the first gate has not yet released.
    expect(probe.lifecycleReady).toBe(0);
    expect(probe.catalogReady).toBe(0);
    release();
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      true,
      true,
      true,
    ]);
    expect(probe.marketReady).toBe(1);
    expect(probe.lifecycleReady).toBe(1);
    expect(probe.catalogReady).toBe(1);
    await runtime.close();
  });

  it("fails closed after the fixed 2000ms deadline without piling up probes", async () => {
    vi.useFakeTimers();
    try {
      const runtime = await startMarketRuntime(base({ catalogEnabled: true }));
      // An uncancellable probe that never settles.
      probe.readinessGate = () => new Promise<void>(() => undefined);
      const first = runtime.ready();
      const second = runtime.ready();
      await vi.advanceTimersByTimeAsync(0);
      expect(probe.catalogReady).toBe(1);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(first).resolves.toBe(false);
      await expect(second).resolves.toBe(false);
      // A repeated probe while the old batch remains must NOT launch a second.
      const third = runtime.ready();
      await vi.advanceTimersByTimeAsync(2000);
      await expect(third).resolves.toBe(false);
      expect(probe.catalogReady).toBe(1);
      await runtime.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report ready when a pending probe settles after close", async () => {
    const runtime = await startMarketRuntime(base({ catalogEnabled: true }));
    let release!: () => void;
    probe.readinessGate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const pending = runtime.ready();
    await new Promise((resolve) => setImmediate(resolve));
    await runtime.close();
    release();
    await expect(pending).resolves.toBe(false);
    await expect(runtime.ready()).resolves.toBe(false);
  });
});

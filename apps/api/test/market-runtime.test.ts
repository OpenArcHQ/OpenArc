import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@openarc/db";

import { startMarketRuntime } from "../src/market/runtime.js";

/**
 * Wiring-only tests for the market runtime.
 *
 * `@openarc/db` is HONESTLY MOCKED here (labelled): these tests prove dedicated
 * pool ownership, initialize gating, readiness reporting and exactly-once
 * cleanup. Real role, schema, RLS, helper ACL and checksum enforcement is
 * covered by the PostgreSQL suite. No mock is a production path.
 */

interface Probe {
  createCalls: number;
  endCalls: number;
  initializeCalls: number;
  readinessCalls: number;
  initializeError: boolean;
  readinessError: boolean;
  asMarketPool: unknown;
  readinessGate: (() => Promise<void>) | undefined;
}

const probe = vi.hoisted<Probe>(() => ({
  createCalls: 0,
  endCalls: 0,
  initializeCalls: 0,
  readinessCalls: 0,
  initializeError: false,
  readinessError: false,
  asMarketPool: undefined,
  readinessGate: undefined,
}));

vi.mock("@openarc/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  class FakeMarketStore {
    async initialize(): Promise<void> {
      probe.initializeCalls += 1;
      if (probe.initializeError) throw new actual.MarketStoreError("MARKET_STORE_UNAVAILABLE");
    }
    async readiness(): Promise<void> {
      probe.readinessCalls += 1;
      if (probe.readinessGate) await probe.readinessGate();
      if (probe.readinessError) throw new actual.MarketStoreError("MARKET_STORE_UNAVAILABLE");
    }
  }
  return {
    ...actual,
    createDatabasePool: () => {
      probe.createCalls += 1;
      return {
        end: async () => {
          probe.endCalls += 1;
        },
      };
    },
    asMarketPool: (pool: unknown) => {
      probe.asMarketPool = pool;
      return pool;
    },
    MarketStore: FakeMarketStore,
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

beforeEach(() => {
  probe.createCalls = 0;
  probe.endCalls = 0;
  probe.initializeCalls = 0;
  probe.readinessCalls = 0;
  probe.initializeError = false;
  probe.readinessError = false;
  probe.asMarketPool = undefined;
  probe.readinessGate = undefined;
});

describe("startMarketRuntime", () => {
  it("initializes exactly once over a dedicated restricted pool and reports readiness", async () => {
    const runtime = await startMarketRuntime({ marketDatabaseUrl: URL, auth: AUTH });
    expect(probe.createCalls).toBe(1);
    expect(probe.initializeCalls).toBe(1);
    expect(probe.asMarketPool).toBeDefined();
    await expect(runtime.ready()).resolves.toBe(true);
    expect(probe.readinessCalls).toBe(1);
    await runtime.close();
    expect(probe.endCalls).toBe(1);
  });

  it("fails closed and closes the pool when initialization fails", async () => {
    probe.initializeError = true;
    await expect(
      startMarketRuntime({ marketDatabaseUrl: URL, auth: AUTH }),
    ).rejects.toThrow("MARKET_RUNTIME_UNAVAILABLE");
    expect(probe.endCalls).toBe(1);
  });

  it("fails closed without constructing a pool when the URL is invalid", async () => {
    // createDatabasePool throws for a structurally invalid URL.
    const actual = await vi.importActual<typeof DbModule>("@openarc/db");
    expect(() => actual.createDatabasePool("not-a-url")).toThrow();
  });

  it("reports not-ready and never throws when the readiness check fails", async () => {
    probe.readinessError = true;
    const runtime = await startMarketRuntime({ marketDatabaseUrl: URL, auth: AUTH });
    await expect(runtime.ready()).resolves.toBe(false);
    await runtime.close();
  });

  it("closes the owned pool exactly once and reports not-ready after close", async () => {
    const runtime = await startMarketRuntime({ marketDatabaseUrl: URL, auth: AUTH });
    await runtime.close();
    await runtime.close();
    expect(probe.endCalls).toBe(1);
    await expect(runtime.ready()).resolves.toBe(false);
  });

  it("single-flights concurrent readiness probes onto one in-flight task", async () => {
    const runtime = await startMarketRuntime({ marketDatabaseUrl: URL, auth: AUTH });
    let release!: () => void;
    probe.readinessGate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const first = runtime.ready();
    const second = runtime.ready();
    const third = runtime.ready();
    // All three attach to the SAME underlying probe.
    expect(probe.readinessCalls).toBe(1);
    release();
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      true,
      true,
      true,
    ]);
    expect(probe.readinessCalls).toBe(1);
    await runtime.close();
  });

  it("fails closed after the fixed 2000ms deadline without piling up probes", async () => {
    vi.useFakeTimers();
    try {
      const runtime = await startMarketRuntime({ marketDatabaseUrl: URL, auth: AUTH });
      // An uncancellable probe that never settles.
      probe.readinessGate = () => new Promise<void>(() => undefined);
      const first = runtime.ready();
      const second = runtime.ready();
      expect(probe.readinessCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(first).resolves.toBe(false);
      await expect(second).resolves.toBe(false);
      // A repeated probe while the old task remains must NOT launch a second.
      const third = runtime.ready();
      expect(probe.readinessCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(2000);
      await expect(third).resolves.toBe(false);
      expect(probe.readinessCalls).toBe(1);
      await runtime.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report ready when a pending probe settles after close", async () => {
    const runtime = await startMarketRuntime({ marketDatabaseUrl: URL, auth: AUTH });
    let release!: () => void;
    probe.readinessGate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    const pending = runtime.ready();
    await runtime.close();
    release();
    await expect(pending).resolves.toBe(false);
    await expect(runtime.ready()).resolves.toBe(false);
  });
});

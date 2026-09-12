import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DbModule from "@openarc/db";

/**
 * Wiring-only tests for the tenant runtime.
 *
 * `@openarc/db` is HONESTLY MOCKED here: these tests prove pool ownership,
 * initialize gating, readiness reporting and exactly-once cleanup. Real role,
 * schema and checksum enforcement is covered by the PostgreSQL suite. No mock
 * is a production path.
 */

const mocks = vi.hoisted(() => ({
  createDatabasePool: vi.fn(),
  asTenantPool: vi.fn(),
  initialize: vi.fn(),
  readiness: vi.fn(),
  end: vi.fn(),
}));

vi.mock("@openarc/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  class TenantStore {
    initialize = mocks.initialize;
    readiness = mocks.readiness;
  }
  return {
    ...actual,
    createDatabasePool: mocks.createDatabasePool,
    asTenantPool: mocks.asTenantPool,
    TenantStore,
  };
});

import { startTenantRuntime } from "../src/tenant/runtime.js";

const AUTH = {
  beginTenantRead: async () => ({ sessionHash: "0".repeat(64), accountId: "unused" }),
  finishTenantRead: async () => undefined,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.asTenantPool.mockImplementation((pool: unknown) => pool);
  mocks.end.mockResolvedValue(undefined);
  mocks.initialize.mockResolvedValue(undefined);
  mocks.readiness.mockResolvedValue(undefined);
});

describe("startTenantRuntime", () => {
  it("initializes exactly once and reports readiness from the store", async () => {
    const pool = { end: mocks.end };
    mocks.createDatabasePool.mockReturnValue(pool);
    const runtime = await startTenantRuntime({
      tenantDatabaseUrl: "postgres://openarc_tenant_app:y@127.0.0.1:5432/db",
      auth: AUTH,
    });
    expect(mocks.initialize).toHaveBeenCalledTimes(1);
    await expect(runtime.ready()).resolves.toBe(true);
    await runtime.close();
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });

  it("fails closed and closes the pool when initialization fails", async () => {
    const pool = { end: mocks.end };
    mocks.createDatabasePool.mockReturnValue(pool);
    mocks.initialize.mockRejectedValue(new Error("role mismatch"));
    await expect(
      startTenantRuntime({
        tenantDatabaseUrl: "postgres://openarc_tenant_app:y@127.0.0.1:5432/db",
        auth: AUTH,
      }),
    ).rejects.toThrow("TENANT_RUNTIME_UNAVAILABLE");
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });

  it("fails closed without constructing a pool when the URL is invalid", async () => {
    mocks.createDatabasePool.mockImplementation(() => {
      throw new Error("bad url");
    });
    await expect(
      startTenantRuntime({
        tenantDatabaseUrl: "not-a-url",
        auth: AUTH,
      }),
    ).rejects.toThrow("TENANT_RUNTIME_UNAVAILABLE");
    expect(mocks.end).not.toHaveBeenCalled();
  });

  it("reports not-ready and never throws when the store readiness check fails", async () => {
    const pool = { end: mocks.end };
    mocks.createDatabasePool.mockReturnValue(pool);
    mocks.readiness.mockRejectedValue(new Error("down"));
    const runtime = await startTenantRuntime({
      tenantDatabaseUrl: "postgres://openarc_tenant_app:y@127.0.0.1:5432/db",
      auth: AUTH,
    });
    await expect(runtime.ready()).resolves.toBe(false);
    await runtime.close();
  });

  it("closes the owned pool exactly once", async () => {
    const pool = { end: mocks.end };
    mocks.createDatabasePool.mockReturnValue(pool);
    const runtime = await startTenantRuntime({
      tenantDatabaseUrl: "postgres://openarc_tenant_app:y@127.0.0.1:5432/db",
      auth: AUTH,
    });
    await runtime.close();
    await runtime.close();
    expect(mocks.end).toHaveBeenCalledTimes(1);
    await expect(runtime.ready()).resolves.toBe(false);
  });
});

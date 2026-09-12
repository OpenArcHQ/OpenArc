import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DbModule from "@openarc/db";

/**
 * Wiring-only tests for the tenant write runtime.
 *
 * `@openarc/db` is HONESTLY MOCKED here: these tests prove that the write
 * service is constructed only when the flag is on, that a missing write auth
 * dependency fails startup closed and closes the owned pool exactly once, and
 * that readiness/cleanup behavior is unchanged. Real role/schema checks are in
 * the PostgreSQL suite.
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

const READ_AUTH = {
  beginTenantRead: async () => ({ sessionHash: "0".repeat(64), accountId: "unused" }),
  finishTenantRead: async () => undefined,
};

const WRITE_AUTH = {
  verifyCsrf: () => "binding",
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

describe("startTenantRuntime writes", () => {
  it("does not construct a write service by default", async () => {
    const pool = { end: mocks.end };
    mocks.createDatabasePool.mockReturnValue(pool);
    const runtime = await startTenantRuntime({
      tenantDatabaseUrl: "postgres://openarc_tenant_app:y@127.0.0.1:5432/db",
      auth: READ_AUTH,
    });
    expect(runtime.writeService).toBeUndefined();
    await runtime.close();
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });

  it("constructs the write service over the same store when enabled", async () => {
    const pool = { end: mocks.end };
    mocks.createDatabasePool.mockReturnValue(pool);
    const runtime = await startTenantRuntime({
      tenantDatabaseUrl: "postgres://openarc_tenant_app:y@127.0.0.1:5432/db",
      auth: READ_AUTH,
      writesEnabled: true,
      writeAuth: WRITE_AUTH,
    });
    expect(runtime.writeService).toBeDefined();
    await expect(runtime.ready()).resolves.toBe(true);
    await runtime.close();
    await runtime.close();
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });

  it("fails closed and closes the pool once when write auth is absent", async () => {
    const pool = { end: mocks.end };
    mocks.createDatabasePool.mockReturnValue(pool);
    await expect(
      startTenantRuntime({
        tenantDatabaseUrl: "postgres://openarc_tenant_app:y@127.0.0.1:5432/db",
        auth: READ_AUTH,
        writesEnabled: true,
      }),
    ).rejects.toThrow("TENANT_RUNTIME_UNAVAILABLE");
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });

  it("fails closed and closes the pool once on initialize failure", async () => {
    const pool = { end: mocks.end };
    mocks.createDatabasePool.mockReturnValue(pool);
    mocks.initialize.mockRejectedValue(new Error("role mismatch"));
    await expect(
      startTenantRuntime({
        tenantDatabaseUrl: "postgres://openarc_tenant_app:y@127.0.0.1:5432/db",
        auth: READ_AUTH,
        writesEnabled: true,
        writeAuth: WRITE_AUTH,
      }),
    ).rejects.toThrow("TENANT_RUNTIME_UNAVAILABLE");
    expect(mocks.end).toHaveBeenCalledTimes(1);
  });
});

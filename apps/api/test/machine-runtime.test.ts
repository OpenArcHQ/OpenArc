import { randomBytes } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as DbModule from "@openarc/db";

import type * as CryptoModule from "../src/machine/credential-crypto.js";
import type { MachineCredentialKeyring } from "../src/machine/credential-crypto.js";
import { buildMachineKeyring, startMachineRuntime } from "../src/machine/runtime.js";

/**
 * Unit coverage for the machine runtime keyring decoder and fail-closed
 * construction.
 *
 * `@openarc/db` and the crypto class are HONESTLY MOCKED here (labelled): the
 * database is never reached. These tests prove the keyring is decoded and then
 * cleared, that every construction/initialization/service/limiter failure
 * disposes the crypto keyring and the owned pool EXACTLY once, and that close is
 * idempotent with readiness failing after close. Real SQL is covered by
 * machine-api.postgres.test.ts.
 */

interface CryptoProbe {
  constructorCalls: number;
  failConstructor: boolean;
  lastKeyring: MachineCredentialKeyring | undefined;
  disposeCalls: number;
}

const probe = vi.hoisted<CryptoProbe>(() => ({
  constructorCalls: 0,
  failConstructor: false,
  lastKeyring: undefined,
  disposeCalls: 0,
}));

vi.mock("../src/machine/credential-crypto.js", async (importOriginal) => {
  const actual = await importOriginal<typeof CryptoModule>();
  class RecordingCrypto extends actual.MachineCredentialCrypto {
    constructor(keyring: MachineCredentialKeyring) {
      probe.constructorCalls += 1;
      probe.lastKeyring = keyring;
      if (probe.failConstructor) {
        // A failing constructor must still leave the caller-owned arrays clear.
        throw new actual.MachineCredentialError("INVALID_CONFIG");
      }
      super(keyring);
    }
    override dispose(): void {
      probe.disposeCalls += 1;
      super.dispose();
    }
  }
  return { ...actual, MachineCredentialCrypto: RecordingCrypto };
});

interface PoolProbe {
  createCalls: number;
  endCalls: number;
  readiness: boolean;
}

const pools = vi.hoisted<PoolProbe>(() => ({
  createCalls: 0,
  endCalls: 0,
  readiness: true,
}));

const stores = vi.hoisted(() => ({ initializeError: false }));

vi.mock("@openarc/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  class FakeCredentialStore {
    async initialize(): Promise<void> {
      if (stores.initializeError) throw new actual.CredentialStoreError("CREDENTIAL_STORE_UNAVAILABLE");
    }
    async readiness(): Promise<boolean> {
      return pools.readiness;
    }
  }
  return {
    ...actual,
    createDatabasePool: () => {
      pools.createCalls += 1;
      return {
        end: async () => {
          pools.endCalls += 1;
        },
      };
    },
    asCredentialPool: (pool: unknown) => pool,
    CredentialStore: FakeCredentialStore,
  };
});

function pepper(byte: number): string {
  return randomBytes(32).fill(byte).toString("base64url");
}

const RATE_STORE = { consume: async () => ({ allowed: true }) };
const MANAGEMENT_AUTH = {
  verifyCsrf: () => "binding",
  beginTenantRead: async () => ({
    sessionHash: "a".repeat(64),
    accountId: "openarc:account:11111111-1111-4111-8111-111111111111",
  }),
  finishTenantRead: async () => undefined,
};

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    tenantDatabaseUrl: "postgres://openarc_tenant_app:y@127.0.0.1:5432/openarc_auth_test",
    currentPepperVersion: 1,
    currentPepper: pepper(1),
    rateSecret: pepper(2),
    rateLimitStore: RATE_STORE,
    managementAuth: MANAGEMENT_AUTH,
    ...overrides,
  } as Parameters<typeof startMachineRuntime>[0];
}

beforeEach(() => {
  probe.constructorCalls = 0;
  probe.failConstructor = false;
  probe.lastKeyring = undefined;
  probe.disposeCalls = 0;
  pools.createCalls = 0;
  pools.endCalls = 0;
  pools.readiness = true;
  stores.initializeError = false;
});

describe("buildMachineKeyring", () => {
  it("decodes a current pepper and an optional distinct previous pepper", () => {
    const keyring = buildMachineKeyring({
      currentVersion: 3,
      currentPepper: pepper(1),
      previousVersion: 2,
      previousPepper: pepper(2),
    });
    expect(keyring.currentVersion).toBe(3);
    expect(keyring.peppers.size).toBe(2);
    expect(keyring.peppers.get(3)?.byteLength).toBe(32);
    expect(keyring.peppers.get(2)?.byteLength).toBe(32);
  });

  it("fails closed on an out-of-range version, non-canonical material or duplicate version", () => {
    expect(() =>
      buildMachineKeyring({ currentVersion: 0, currentPepper: pepper(1) }),
    ).toThrow("MACHINE_RUNTIME_UNAVAILABLE");
    expect(() =>
      buildMachineKeyring({ currentVersion: 1, currentPepper: "not-a-pepper" }),
    ).toThrow("MACHINE_RUNTIME_UNAVAILABLE");
    expect(() =>
      buildMachineKeyring({
        currentVersion: 1,
        currentPepper: pepper(1),
        previousVersion: 1,
        previousPepper: pepper(2),
      }),
    ).toThrow("MACHINE_RUNTIME_UNAVAILABLE");
    expect(() =>
      buildMachineKeyring({
        currentVersion: 1,
        currentPepper: pepper(1),
        previousVersion: 2,
      }),
    ).toThrow("MACHINE_RUNTIME_UNAVAILABLE");
  });
});

describe("startMachineRuntime fail-closed", () => {
  it("rejects invalid pepper configuration before creating a database pool", async () => {
    await expect(
      startMachineRuntime(dependencies({ currentPepperVersion: 99 })),
    ).rejects.toThrow("MACHINE_RUNTIME_UNAVAILABLE");
    expect(pools.createCalls).toBe(0);
    expect(probe.constructorCalls).toBe(0);
  });

  it("clears the caller-owned keyring after the crypto constructor", async () => {
    const runtime = await startMachineRuntime(dependencies());
    const keyring = probe.lastKeyring;
    expect(keyring).toBeDefined();
    expect(keyring?.peppers.size).toBe(0);
    await runtime.close();
  });

  it("clears the keyring when the crypto constructor fails", async () => {
    probe.failConstructor = true;
    await expect(startMachineRuntime(dependencies())).rejects.toThrow(
      "MACHINE_RUNTIME_UNAVAILABLE",
    );
    const keyring = probe.lastKeyring;
    expect(keyring).toBeDefined();
    for (const material of keyring?.peppers.values() ?? []) {
      expect([...material].every((byte) => byte === 0)).toBe(true);
    }
    expect(keyring?.peppers.size).toBe(0);
    expect(pools.createCalls).toBe(0);
  });

  it("disposes crypto and the owned pool exactly once when store initialization fails", async () => {
    stores.initializeError = true;
    await expect(startMachineRuntime(dependencies())).rejects.toThrow(
      "MACHINE_RUNTIME_UNAVAILABLE",
    );
    expect(probe.disposeCalls).toBe(1);
    expect(pools.endCalls).toBe(1);
  });

  it("disposes crypto and the owned pool exactly once when a later service fails", async () => {
    await expect(
      startMachineRuntime(
        dependencies({ rateLimitStore: null as unknown as typeof RATE_STORE }),
      ),
    ).rejects.toThrow("MACHINE_RUNTIME_UNAVAILABLE");
    expect(probe.disposeCalls).toBe(1);
    expect(pools.endCalls).toBe(1);
  });

  it("closes exactly once and reports not-ready after close", async () => {
    const runtime = await startMachineRuntime(dependencies());
    await expect(runtime.ready()).resolves.toBe(true);
    await runtime.close();
    await runtime.close();
    expect(probe.disposeCalls).toBe(1);
    expect(pools.endCalls).toBe(1);
    await expect(runtime.ready()).resolves.toBe(false);
  });
});

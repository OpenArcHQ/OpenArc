import {
  asCredentialPool,
  createDatabasePool,
  CredentialStore,
} from "@openarc/db";

import { MachineCredentialCrypto } from "./credential-crypto.js";
import { MachineManagementService } from "./management-service.js";
import { MachineRateLimiter } from "./rate-limiter.js";
import { MachineSessionService } from "./session-service.js";
import type {
  MachineManagementAuthPort,
  MachineRateLimitStorePort,
} from "./ports.js";

/**
 * Dedicated runtime wiring for the machine credential/session slice.
 *
 * The server NEVER runs migrations. This runtime owns its OWN dedicated tenant
 * pool bound to the restricted `openarc_tenant_app` role, constructs the
 * accepted `CredentialStore` and initializes its exact schema/checksums/ACL
 * posture exactly once before any route can serve. The pepper keyring is
 * decoded from canonical operator configuration and disposed exactly once on
 * shutdown or construction failure. Any failure closes the pool and throws a
 * fixed non-echoing error; the caller must fail startup closed.
 */

export interface MachineRuntimeDependencies {
  readonly tenantDatabaseUrl: string;
  readonly currentPepperVersion: number;
  readonly currentPepper: string;
  readonly previousPepperVersion?: number;
  readonly previousPepper?: string;
  readonly rateSecret: string;
  readonly rateLimitStore: MachineRateLimitStorePort;
  readonly managementAuth: MachineManagementAuthPort;
}

export interface MachinePepperInput {
  readonly currentVersion: number;
  readonly currentPepper: string;
  readonly previousVersion?: number;
  readonly previousPepper?: string;
}

export interface StartedMachineRuntime {
  readonly managementService: MachineManagementService;
  readonly sessionService: MachineSessionService;
  ready(): Promise<boolean>;
  close(): Promise<void>;
}

const CANONICAL_PEPPER = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;

function fail(): never {
  throw new Error("MACHINE_RUNTIME_UNAVAILABLE");
}

/**
 * Decode the at-most-two canonical 32-byte peppers. Unknown/invalid versions
 * or material fail closed; key bytes are copied into the keyring.
 */
export function buildMachineKeyring(input: MachinePepperInput): {
  currentVersion: number;
  peppers: Map<number, Uint8Array>;
} {
  const currentVersion = input.currentVersion;
  if (
    !Number.isInteger(currentVersion) ||
    currentVersion < 1 ||
    currentVersion > 16
  ) {
    fail();
  }
  const peppers = new Map<number, Uint8Array>();
  const decode = (value: unknown): Uint8Array | null => {
    if (typeof value !== "string" || !CANONICAL_PEPPER.test(value)) return null;
    const buffer = Buffer.from(value, "base64url");
    if (buffer.length !== 32 || buffer.toString("base64url") !== value) {
      buffer.fill(0);
      return null;
    }
    try {
      return new Uint8Array(buffer);
    } finally {
      // The Uint8Array is an independent copy; never leave the temporary
      // decode buffer holding key material.
      buffer.fill(0);
    }
  };
  const current = decode(input.currentPepper);
  if (current === null) {
    for (const pepper of peppers.values()) pepper.fill(0);
    fail();
  }
  peppers.set(currentVersion, current);
  if (input.previousVersion !== undefined || input.previousPepper !== undefined) {
    if (
      input.previousVersion === undefined ||
      input.previousPepper === undefined
    ) {
      for (const pepper of peppers.values()) pepper.fill(0);
      fail();
    }
    if (
      !Number.isInteger(input.previousVersion) ||
      input.previousVersion < 1 ||
      input.previousVersion > 16 ||
      input.previousVersion === currentVersion
    ) {
      for (const pepper of peppers.values()) pepper.fill(0);
      fail();
    }
    const previous = decode(input.previousPepper);
    if (previous === null) {
      for (const pepper of peppers.values()) pepper.fill(0);
      fail();
    }
    peppers.set(input.previousVersion, previous);
  }
  return { currentVersion, peppers };
}

export async function startMachineRuntime(
  dependencies: MachineRuntimeDependencies,
): Promise<StartedMachineRuntime> {
  const keyring = buildMachineKeyring({
    currentVersion: dependencies.currentPepperVersion,
    currentPepper: dependencies.currentPepper,
    ...(dependencies.previousPepperVersion !== undefined
      ? { previousVersion: dependencies.previousPepperVersion }
      : {}),
    ...(dependencies.previousPepper !== undefined
      ? { previousPepper: dependencies.previousPepper }
      : {}),
  });

  /** Clear the caller-owned decoded pepper material and drop the map. */
  const clearKeyring = (): void => {
    for (const pepper of keyring.peppers.values()) pepper.fill(0);
    keyring.peppers.clear();
  };

  let crypto: MachineCredentialCrypto;
  try {
    crypto = new MachineCredentialCrypto(keyring);
  } catch {
    clearKeyring();
    fail();
  } finally {
    // `MachineCredentialCrypto` deep-copies the material, so the caller-owned
    // arrays are never retained. Clear them on both success and failure.
    clearKeyring();
  }

  let pool: ReturnType<typeof createDatabasePool>;
  try {
    pool = createDatabasePool(dependencies.tenantDatabaseUrl);
  } catch {
    crypto.dispose();
    fail();
  }

  let store: CredentialStore;
  try {
    store = new CredentialStore(asCredentialPool(pool));
    await store.initialize();
  } catch {
    crypto.dispose();
    await pool.end().catch(() => undefined);
    fail();
  }

  let managementService: MachineManagementService;
  let sessionService: MachineSessionService;
  try {
    const limits = new MachineRateLimiter({
      secret: dependencies.rateSecret,
      store: dependencies.rateLimitStore,
    });
    managementService = new MachineManagementService({
      auth: dependencies.managementAuth,
      store,
      crypto,
      limits,
    });
    sessionService = new MachineSessionService({
      store,
      crypto,
      limits,
    });
  } catch {
    // Any later initialization failure owns the crypto keyring and the pool:
    // dispose/close each exactly once and fail closed.
    crypto.dispose();
    await pool.end().catch(() => undefined);
    fail();
  }

  let closed = false;
  return {
    managementService,
    sessionService,
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
      crypto.dispose();
      await pool.end().catch(() => undefined);
    },
  };
}

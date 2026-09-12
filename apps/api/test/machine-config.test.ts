import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

/**
 * Unit coverage for the machine flags / shared machine secrets configuration.
 *
 * These tests exercise the pure `loadConfig` schema only; no database, crypto
 * or network is touched. Every secret below is synthetic fixture material.
 */

function secret(byte = 1): string {
  return randomBytes(32).fill(byte).toString("base64url");
}

const AUTH_SECRET = "synthetic_auth_secret_for_machine_config_tests_0123456789";

function baseMachineEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    NODE_ENV: "test",
    AUTH_ENABLED: "true",
    AUTH_DATABASE_URL: "postgres://openarc_auth_app:x@127.0.0.1:5432/openarc_auth_test",
    AUTH_SECRET,
    AUTH_RP_ID: "localhost",
    TENANT_READS_ENABLED: "true",
    TENANT_DATABASE_URL: "postgres://openarc_tenant_app:y@127.0.0.1:5432/openarc_auth_test",
    TENANT_WRITES_ENABLED: "true",
    MACHINE_CREDENTIAL_MANAGEMENT_ENABLED: "true",
    MACHINE_CREDENTIAL_PEPPER_VERSION: "3",
    MACHINE_CREDENTIAL_PEPPER: secret(1),
    MACHINE_RATE_SECRET: secret(2),
    ...overrides,
  };
}

describe("machine config flags default off", () => {
  it("defaults both machine flags off and requires no machine secrets", () => {
    const config = loadConfig({});
    expect(config.MACHINE_CREDENTIAL_MANAGEMENT_ENABLED).toBe(false);
    expect(config.MACHINE_SESSION_EXCHANGE_ENABLED).toBe(false);
    expect(config.MACHINE_CREDENTIAL_PEPPER).toBeUndefined();
    expect(config.MACHINE_RATE_SECRET).toBeUndefined();
  });

  it("accepts management with distinct canonical secrets and an optional previous pepper", () => {
    const config = loadConfig(
      baseMachineEnv({
        MACHINE_CREDENTIAL_PREVIOUS_VERSION: "2",
        MACHINE_CREDENTIAL_PREVIOUS_PEPPER: secret(3),
      }),
    );
    expect(config.MACHINE_CREDENTIAL_MANAGEMENT_ENABLED).toBe(true);
    expect(config.MACHINE_CREDENTIAL_PEPPER_VERSION).toBe(3);
    expect(config.MACHINE_CREDENTIAL_PREVIOUS_VERSION).toBe(2);
  });

  it("accepts exchange independently of management when it has its own database", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      AUTH_ENABLED: "true",
      AUTH_DATABASE_URL: "postgres://openarc_auth_app:x@127.0.0.1:5432/openarc_auth_test",
      AUTH_SECRET,
      AUTH_RP_ID: "localhost",
      TENANT_READS_ENABLED: "true",
      TENANT_DATABASE_URL: "postgres://openarc_tenant_app:y@127.0.0.1:5432/openarc_auth_test",
      MACHINE_SESSION_EXCHANGE_ENABLED: "true",
      MACHINE_CREDENTIAL_PEPPER_VERSION: "1",
      MACHINE_CREDENTIAL_PEPPER: secret(4),
      MACHINE_RATE_SECRET: secret(5),
    });
    expect(config.MACHINE_SESSION_EXCHANGE_ENABLED).toBe(true);
    expect(config.MACHINE_CREDENTIAL_MANAGEMENT_ENABLED).toBe(false);
    expect(config.TENANT_WRITES_ENABLED).toBe(false);
  });
});

describe("machine config fail-closed", () => {
  it("rejects management without the protected tenant write family", () => {
    expect(() =>
      loadConfig(baseMachineEnv({ TENANT_WRITES_ENABLED: "false" })),
    ).toThrow();
  });

  it("rejects exchange without a dedicated tenant database", () => {
    expect(() =>
      loadConfig({
        AUTH_ENABLED: "true",
        AUTH_DATABASE_URL: "postgres://openarc_auth_app:x@127.0.0.1:5432/openarc_auth_test",
        AUTH_SECRET,
        AUTH_RP_ID: "localhost",
        TENANT_READS_ENABLED: "true",
        MACHINE_SESSION_EXCHANGE_ENABLED: "true",
        MACHINE_CREDENTIAL_PEPPER_VERSION: "1",
        MACHINE_CREDENTIAL_PEPPER: secret(4),
        MACHINE_RATE_SECRET: secret(5),
      }),
    ).toThrow();
  });

  it("rejects a missing pepper version or material", () => {
    expect(() =>
      loadConfig(baseMachineEnv({ MACHINE_CREDENTIAL_PEPPER_VERSION: "" })),
    ).toThrow();
    const withoutPepper = baseMachineEnv();
    delete withoutPepper["MACHINE_CREDENTIAL_PEPPER"];
    expect(() => loadConfig(withoutPepper)).toThrow();
  });

  it("rejects a rate secret equal to the pepper or AUTH_SECRET", () => {
    expect(() =>
      loadConfig(baseMachineEnv({ MACHINE_RATE_SECRET: secret(1) })),
    ).toThrow();
    expect(() =>
      loadConfig(baseMachineEnv({ MACHINE_RATE_SECRET: AUTH_SECRET })),
    ).toThrow();
    expect(() =>
      loadConfig(baseMachineEnv({ MACHINE_CREDENTIAL_PEPPER: AUTH_SECRET })),
    ).toThrow();
  });

  it("rejects a non-canonical pepper or rate secret", () => {
    expect(() =>
      loadConfig(baseMachineEnv({ MACHINE_CREDENTIAL_PEPPER: "short" })),
    ).toThrow();
    // 43 chars but non-canonical final character (nonzero padding bits).
    expect(() =>
      loadConfig(baseMachineEnv({ MACHINE_RATE_SECRET: `${"A".repeat(42)}B` })),
    ).toThrow();
    // A trailing newline must not slip past a bare `$` anchor.
    expect(() =>
      loadConfig(baseMachineEnv({ MACHINE_CREDENTIAL_PEPPER: `${secret(6)}\n` })),
    ).toThrow();
    expect(() =>
      loadConfig(baseMachineEnv({ MACHINE_RATE_SECRET: `${secret(6)}\r` })),
    ).toThrow();
  });

  it("accepts only canonical decimal pepper versions 1..16", () => {
    expect(
      loadConfig(baseMachineEnv({ MACHINE_CREDENTIAL_PEPPER_VERSION: "16" }))
        .MACHINE_CREDENTIAL_PEPPER_VERSION,
    ).toBe(16);
    for (const version of ["0", "01", "1e0", " 1", "1.0", "1\n", "17", "+1", "0x1"]) {
      expect(
        () => loadConfig(baseMachineEnv({ MACHINE_CREDENTIAL_PEPPER_VERSION: version })),
        version,
      ).toThrow();
    }
    expect(() =>
      loadConfig(
        baseMachineEnv({
          MACHINE_CREDENTIAL_PEPPER_VERSION: true as unknown as string,
        }),
      ),
    ).toThrow();
  });

  it("rejects a previous pepper that collides with any other configured material", () => {
    const current = secret(1);
    const rate = secret(2);
    expect(() =>
      loadConfig(
        baseMachineEnv({
          MACHINE_CREDENTIAL_PREVIOUS_VERSION: "2",
          MACHINE_CREDENTIAL_PREVIOUS_PEPPER: current,
        }),
      ),
    ).toThrow();
    expect(() =>
      loadConfig(
        baseMachineEnv({
          MACHINE_CREDENTIAL_PREVIOUS_VERSION: "2",
          MACHINE_CREDENTIAL_PREVIOUS_PEPPER: rate,
        }),
      ),
    ).toThrow();
    const canonicalAuth = secret(3);
    expect(() =>
      loadConfig(
        baseMachineEnv({
          AUTH_SECRET: canonicalAuth,
          MACHINE_CREDENTIAL_PREVIOUS_VERSION: "2",
          MACHINE_CREDENTIAL_PREVIOUS_PEPPER: canonicalAuth,
        }),
      ),
    ).toThrow();
  });

  it("rejects an unpaired previous pepper and a duplicate previous version", () => {
    expect(() =>
      loadConfig(baseMachineEnv({ MACHINE_CREDENTIAL_PREVIOUS_VERSION: "2" })),
    ).toThrow();
    expect(() =>
      loadConfig(
        baseMachineEnv({
          MACHINE_CREDENTIAL_PREVIOUS_VERSION: "3",
          MACHINE_CREDENTIAL_PREVIOUS_PEPPER: secret(3),
        }),
      ),
    ).toThrow();
  });
});

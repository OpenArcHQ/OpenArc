import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

/**
 * Configuration tests for the protected tenant read flag and its dedicated
 * restricted-role database URL. No dependency is loaded and no connection is
 * attempted here.
 */

const ORIGIN = "http://localhost:5183";
const RP_ID = "localhost";
const AUTH_SECRET = "synthetic_auth_secret_for_config_tests_0123456789";
const AUTH_URL = "postgres://openarc_auth_app:x@127.0.0.1:5432/openarc_auth_test";
const TENANT_URL = "postgres://openarc_tenant_app:y@127.0.0.1:5432/openarc_auth_test";

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    ...extra,
  } as NodeJS.ProcessEnv;
}

function enabledEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return baseEnv({
    AUTH_ENABLED: "true",
    AUTH_DATABASE_URL: AUTH_URL,
    AUTH_SECRET,
    AUTH_RP_ID: RP_ID,
    TENANT_READS_ENABLED: "true",
    TENANT_DATABASE_URL: TENANT_URL,
    ...extra,
  });
}

describe("tenant read configuration", () => {
  it("defaults the flag off and the tenant URL absent", () => {
    const config = loadConfig(baseEnv());
    expect(config.TENANT_READS_ENABLED).toBe(false);
    expect(config.TENANT_DATABASE_URL).toBeUndefined();
  });

  it("parses the exact string flag types only", () => {
    expect(
      loadConfig(enabledEnv({ TENANT_READS_ENABLED: "true" }))
        .TENANT_READS_ENABLED,
    ).toBe(true);
    for (const value of ["1", "yes", "TRUE", "on", ""]) {
      let parsed: unknown = null;
      try {
        parsed = loadConfig(baseEnv({ TENANT_READS_ENABLED: value }));
      } catch {
        parsed = null;
      }
      expect(parsed, `flag ${value}`).toBeNull();
    }
  });

  it("rejects the flag without authentication enabled", () => {
    expect(() =>
      loadConfig(
        baseEnv({
          TENANT_READS_ENABLED: "true",
          TENANT_DATABASE_URL: TENANT_URL,
        }),
      ),
    ).toThrow();
  });

  it("rejects the flag without a tenant database URL", () => {
    expect(() =>
      loadConfig(
        baseEnv({
          AUTH_ENABLED: "true",
          AUTH_DATABASE_URL: AUTH_URL,
          AUTH_SECRET,
          AUTH_RP_ID: RP_ID,
          TENANT_READS_ENABLED: "true",
        }),
      ),
    ).toThrow();
  });

  it("rejects exact reuse of the auth database URL", () => {
    expect(() =>
      loadConfig(enabledEnv({ TENANT_DATABASE_URL: AUTH_URL })),
    ).toThrow();
  });

  it("rejects a non-postgres tenant URL and an oversize URL", () => {
    expect(() =>
      loadConfig(enabledEnv({ TENANT_DATABASE_URL: "mysql://x@y/z" })),
    ).toThrow();
    expect(() =>
      loadConfig(
        enabledEnv({
          TENANT_DATABASE_URL: `postgres://a@b/${"x".repeat(4100)}`,
        }),
      ),
    ).toThrow();
  });

  it("accepts a distinct tenant URL and leaves the legacy shape unchanged", () => {
    const config = loadConfig(enabledEnv());
    expect(config.TENANT_READS_ENABLED).toBe(true);
    expect(config.TENANT_DATABASE_URL).toBe(TENANT_URL);
    // Legacy flags remain default-off and untouched by the new fields.
    expect(config.API_BOUNDARY_ENABLED).toBe(false);
    expect(config.ARC_OBSERVATION_ENABLED).toBe(false);
    expect(config.AGENT_REGISTRY_ENABLED).toBe(false);
    expect(config.AGENT_JOBS_ENABLED).toBe(false);
    expect(config.GATEWAY_EVIDENCE_ENABLED).toBe(false);
    expect(config.AUTH_ENABLED).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

/**
 * Configuration tests for TENANT_WRITES_ENABLED. No dependency is loaded and
 * no connection is attempted here.
 */

const ORIGIN = "http://localhost:5183";
const RP_ID = "localhost";
const AUTH_SECRET = "synthetic_auth_secret_for_write_config_0123456789";
const AUTH_URL = "postgres://openarc_auth_app:x@127.0.0.1:5432/openarc_auth_test";
const TENANT_URL = "postgres://openarc_tenant_app:y@127.0.0.1:5432/openarc_auth_test";

function baseEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { NODE_ENV: "test", APP_ORIGIN: ORIGIN, ...extra } as NodeJS.ProcessEnv;
}

function enabledEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return baseEnv({
    AUTH_ENABLED: "true",
    AUTH_DATABASE_URL: AUTH_URL,
    AUTH_SECRET,
    AUTH_RP_ID: RP_ID,
    TENANT_READS_ENABLED: "true",
    TENANT_DATABASE_URL: TENANT_URL,
    TENANT_WRITES_ENABLED: "true",
    ...extra,
  });
}

describe("tenant write configuration", () => {
  it("defaults the flag off and leaves the read flag unchanged", () => {
    const config = loadConfig(baseEnv());
    expect(config.TENANT_WRITES_ENABLED).toBe(false);
    expect(config.TENANT_READS_ENABLED).toBe(false);
  });

  it("parses only the exact boolean strings", () => {
    expect(loadConfig(enabledEnv()).TENANT_WRITES_ENABLED).toBe(true);
    for (const value of ["1", "yes", "TRUE", "on", ""]) {
      let parsed: unknown = null;
      try {
        parsed = loadConfig(baseEnv({ TENANT_WRITES_ENABLED: value }));
      } catch {
        parsed = null;
      }
      expect(parsed, `flag ${value}`).toBeNull();
    }
  });

  it("requires the cumulative read family and authentication", () => {
    expect(() =>
      loadConfig(
        baseEnv({
          AUTH_ENABLED: "true",
          AUTH_DATABASE_URL: AUTH_URL,
          AUTH_SECRET,
          AUTH_RP_ID: RP_ID,
          TENANT_READS_ENABLED: "true",
          TENANT_DATABASE_URL: TENANT_URL,
          TENANT_WRITES_ENABLED: "true",
        }),
      ),
    ).not.toThrow();
    expect(() =>
      loadConfig(
        baseEnv({
          AUTH_ENABLED: "true",
          AUTH_DATABASE_URL: AUTH_URL,
          AUTH_SECRET,
          AUTH_RP_ID: RP_ID,
          TENANT_WRITES_ENABLED: "true",
          TENANT_DATABASE_URL: TENANT_URL,
        }),
      ),
    ).toThrow();
    expect(() =>
      loadConfig(
        baseEnv({
          TENANT_READS_ENABLED: "true",
          TENANT_DATABASE_URL: TENANT_URL,
          TENANT_WRITES_ENABLED: "true",
        }),
      ),
    ).toThrow();
  });

  it("requires a dedicated tenant database distinct from auth", () => {
    expect(() =>
      loadConfig(
        baseEnv({
          AUTH_ENABLED: "true",
          AUTH_DATABASE_URL: AUTH_URL,
          AUTH_SECRET,
          AUTH_RP_ID: RP_ID,
          TENANT_READS_ENABLED: "true",
          TENANT_WRITES_ENABLED: "true",
        }),
      ),
    ).toThrow();
    expect(() =>
      loadConfig(enabledEnv({ TENANT_DATABASE_URL: AUTH_URL })),
    ).toThrow();
  });
});

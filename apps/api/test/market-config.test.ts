import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { loadConfig } from "../src/config.js";

/**
 * Configuration flag matrix for LISTING_MANAGEMENT_ENABLED.
 *
 * The flag defaults off, legacy default mode is unchanged, and enabling it
 * requires AUTH_ENABLED + TENANT_READS_ENABLED + a dedicated TENANT_DATABASE_URL
 * but deliberately NOT TENANT_WRITES or the machine family. Failure messages
 * are fixed and never echo the database URL or a secret.
 */

const ORIGIN = "http://localhost:5183";
const RP_ID = "localhost";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const SECRET = "synthetic_auth_secret_for_market_config_0123456789";
const AUTH_URL = "postgres://openarc_auth_app:x@127.0.0.1:5432/openarc_auth_test";
const TENANT_URL = "postgres://openarc_tenant_app:y@127.0.0.1:5432/openarc_auth_test";

function base(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    COMMIT_SHA: SHA,
    AUTH_ENABLED: "true",
    AUTH_DATABASE_URL: AUTH_URL,
    AUTH_SECRET: SECRET,
    AUTH_RP_ID: RP_ID,
    ...overrides,
  };
}

function issues(input: Record<string, string>): string[] {
  try {
    loadConfig(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ZodError);
    return (error as ZodError).issues.map((issue) => issue.path.join("."));
  }
  throw new Error("expected config rejection");
}

function rejectionMessage(input: Record<string, string>): string {
  try {
    loadConfig(input);
  } catch (error) {
    return JSON.stringify((error as ZodError).issues);
  }
  throw new Error("expected config rejection");
}

describe("listing management configuration", () => {
  it("defaults the flag off and preserves legacy default mode", () => {
    expect(loadConfig(base()).LISTING_MANAGEMENT_ENABLED).toBe(false);
    expect(loadConfig(base({ LISTING_MANAGEMENT_ENABLED: "false" })).LISTING_MANAGEMENT_ENABLED).toBe(false);
  });

  it("enables with auth + tenant reads + a dedicated tenant database and no writes", () => {
    const config = loadConfig(base({
      TENANT_READS_ENABLED: "true",
      TENANT_DATABASE_URL: TENANT_URL,
      LISTING_MANAGEMENT_ENABLED: "true",
    }));
    expect(config.LISTING_MANAGEMENT_ENABLED).toBe(true);
    expect(config.TENANT_WRITES_ENABLED).toBe(false);
  });

  it("rejects enabled without authentication", () => {
    expect(issues({
      ...base({ AUTH_ENABLED: "false" }),
      TENANT_READS_ENABLED: "true",
      TENANT_DATABASE_URL: TENANT_URL,
      LISTING_MANAGEMENT_ENABLED: "true",
    })).toContain("LISTING_MANAGEMENT_ENABLED");
  });

  it("rejects enabled without the protected tenant read family", () => {
    expect(issues(base({ LISTING_MANAGEMENT_ENABLED: "true" }))).toContain(
      "LISTING_MANAGEMENT_ENABLED",
    );
  });

  it("rejects enabled without a dedicated restricted database URL", () => {
    expect(issues(base({
      TENANT_READS_ENABLED: "true",
      LISTING_MANAGEMENT_ENABLED: "true",
    }))).toContain("LISTING_MANAGEMENT_ENABLED");
  });

  it("rejects reusing the auth connection as the tenant connection", () => {
    expect(issues(base({
      TENANT_READS_ENABLED: "true",
      TENANT_DATABASE_URL: AUTH_URL,
      LISTING_MANAGEMENT_ENABLED: "true",
    }))).toContain("TENANT_DATABASE_URL");
  });

  it("never echoes the URL or a secret in a fixed rejection message", () => {
    const message = rejectionMessage(base({
      TENANT_READS_ENABLED: "true",
      TENANT_DATABASE_URL: AUTH_URL,
      LISTING_MANAGEMENT_ENABLED: "true",
    }));
    expect(message).not.toContain(AUTH_URL);
    expect(message).not.toContain(TENANT_URL);
    expect(message).not.toContain(SECRET);
    expect(message).toContain("dedicated restricted role connection");
  });
});


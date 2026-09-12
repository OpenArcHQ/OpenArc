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

/**
 * Independent marketplace family matrix. The three flags are independent;
 * each enabled family requires the dedicated restricted TENANT_DATABASE_URL,
 * with only listing management needing AUTH + TENANT_READS and moderation
 * needing AUTH. TENANT_WRITES and machine flags are never required.
 */

const MARKET_FLAGS = [
  "MARKET_CATALOG_ENABLED",
  "LISTING_MANAGEMENT_ENABLED",
  "MARKET_MODERATION_ENABLED",
] as const;

function full(overrides: Record<string, string>): Record<string, string> {
  return {
    ...base({
      TENANT_READS_ENABLED: "true",
      TENANT_DATABASE_URL: TENANT_URL,
    }),
    ...overrides,
  };
}

describe("independent marketplace family configuration", () => {
  it("accepts all eight combinations of the three independent flags", () => {
    const accepted: string[] = [];
    for (let mask = 0; mask < 8; mask += 1) {
      const overrides: Record<string, string> = {};
      MARKET_FLAGS.forEach((name, index) => {
        overrides[name] = (mask & (1 << index)) !== 0 ? "true" : "false";
      });
      const config = loadConfig(full(overrides));
      accepted.push(
        MARKET_FLAGS.map((name) =>
          config[name] === true ? "1" : "0",
        ).join(""),
      );
    }
    expect(accepted).toHaveLength(8);
    expect(new Set(accepted).size).toBe(8);
  });

  it("enables the public catalog with AUTH off and no tenant reads", () => {
    const config = loadConfig({
      ...base({ AUTH_ENABLED: "false" }),
      MARKET_CATALOG_ENABLED: "true",
      TENANT_DATABASE_URL: TENANT_URL,
    });
    expect(config.MARKET_CATALOG_ENABLED).toBe(true);
    expect(config.AUTH_ENABLED).toBe(false);
    expect(config.TENANT_READS_ENABLED).toBe(false);
  });

  it("enables moderation with AUTH on and tenant reads off, without writes", () => {
    const config = loadConfig(base({
      MARKET_MODERATION_ENABLED: "true",
      TENANT_DATABASE_URL: TENANT_URL,
    }));
    expect(config.MARKET_MODERATION_ENABLED).toBe(true);
    expect(config.TENANT_READS_ENABLED).toBe(false);
    expect(config.TENANT_WRITES_ENABLED).toBe(false);
  });

  it("enables listing management without tenant writes", () => {
    const config = loadConfig(base({
      TENANT_READS_ENABLED: "true",
      TENANT_DATABASE_URL: TENANT_URL,
      LISTING_MANAGEMENT_ENABLED: "true",
    }));
    expect(config.LISTING_MANAGEMENT_ENABLED).toBe(true);
    expect(config.TENANT_WRITES_ENABLED).toBe(false);
  });

  it("rejects every enabled family when its dedicated restricted URL is missing", () => {
    for (const name of MARKET_FLAGS) {
      expect(issues(base({ [name]: "true" })), name).toContain(name);
    }
  });

  it("rejects moderation without authentication", () => {
    expect(issues({
      ...base({ AUTH_ENABLED: "false" }),
      MARKET_MODERATION_ENABLED: "true",
      TENANT_DATABASE_URL: TENANT_URL,
    })).toContain("MARKET_MODERATION_ENABLED");
  });

  it("rejects listing management without the protected tenant read family", () => {
    expect(issues(base({
      LISTING_MANAGEMENT_ENABLED: "true",
      TENANT_DATABASE_URL: TENANT_URL,
    }))).toContain("LISTING_MANAGEMENT_ENABLED");
  });

  it("rejects any enabled family that reuses the auth connection", () => {
    for (const name of MARKET_FLAGS) {
      const input = {
        ...base({ TENANT_READS_ENABLED: name === "LISTING_MANAGEMENT_ENABLED" ? "true" : "false" }),
        TENANT_DATABASE_URL: AUTH_URL,
        [name]: "true",
      };
      expect(issues(input), name).toContain("TENANT_DATABASE_URL");
    }
  });

  it("keeps defaults closed with no database configuration", () => {
    const config = loadConfig({
      NODE_ENV: "test",
      APP_ORIGIN: ORIGIN,
      COMMIT_SHA: SHA,
    });
    expect(config.MARKET_CATALOG_ENABLED).toBe(false);
    expect(config.LISTING_MANAGEMENT_ENABLED).toBe(false);
    expect(config.MARKET_MODERATION_ENABLED).toBe(false);
    expect(config.AUTH_DATABASE_URL).toBeUndefined();
    expect(config.TENANT_DATABASE_URL).toBeUndefined();
  });

  it("never echoes the URL or a secret in a fixed family rejection message", () => {
    const message = rejectionMessage(base({ MARKET_CATALOG_ENABLED: "true" }));
    expect(message).not.toContain(AUTH_URL);
    expect(message).not.toContain(TENANT_URL);
    expect(message).not.toContain(SECRET);
    expect(message).toContain("MARKET_CATALOG_ENABLED");
  });
});

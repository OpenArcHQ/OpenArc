import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import {
  API_CLIENT_HEADER,
  MARKETPLACE_CAPABILITIES_PATH,
  MARKETPLACE_CAPABILITY_FAMILY_ORDER,
  MARKETPLACE_ROUTES,
  MarketplaceCapabilitiesSuccessEnvelopeSchema,
  type MarketplaceCapabilityFamily,
  type MarketplaceCapabilityState,
} from "@openarc/shared";

import { createApp } from "../src/app.js";
import type { AuthService } from "../src/auth/service.js";
import type { MarketCatalogService } from "../src/market/catalog-service.js";
import type { MarketLifecycleService } from "../src/market/lifecycle-service.js";
import type { MarketService } from "../src/market/service.js";
import type { TenantReadService } from "../src/tenant/service.js";
import { loadConfig } from "../src/config.js";
import type {
  MarketplaceCapabilityFlags,
  MarketplaceCapabilityReadiness,
} from "../src/commerce/marketplace-capabilities.js";

/**
 * Focused unit/inject coverage for the public `GET
 * /v2/public/marketplace-capabilities` surface. Readiness callbacks are
 * SYNTHETIC and honestly labelled: no PostgreSQL, AuthService or network is
 * required. This suite proves the strict three-family / 18-route manifest, the
 * enabled-family readiness mapping with zero calls when all flags are off, the
 * single in-flight probe batch with a fail-closed deadline, and the strict
 * credentialless transport.
 */

const ORIGIN = "http://localhost:5183";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const SECRET_CANARY = "SECRET_CANARY_DO_NOT_ECHO";

type App = ReturnType<typeof createApp>;

const apps: App[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

const ALL_OFF_FLAGS: MarketplaceCapabilityFlags = {
  authEnabled: false,
  tenantReadsEnabled: false,
  marketCatalogEnabled: false,
  listingManagementEnabled: false,
  marketModerationEnabled: false,
};

function harness(
  flagOverrides: Partial<MarketplaceCapabilityFlags> = {},
  readiness: {
    authReady?: () => Promise<boolean>;
    tenantReady?: () => Promise<boolean>;
    marketReady?: () => Promise<boolean>;
  } = {},
  maxResponseBytes?: number,
) {
  const flags: MarketplaceCapabilityFlags = {
    ...ALL_OFF_FLAGS,
    ...flagOverrides,
  };
  const protectedFamily =
    flags.listingManagementEnabled || flags.marketModerationEnabled;
  const config = loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    COMMIT_SHA: BUILD_SHA,
    MARKET_CATALOG_ENABLED: flags.marketCatalogEnabled ? "true" : "false",
    LISTING_MANAGEMENT_ENABLED: flags.listingManagementEnabled ? "true" : "false",
    MARKET_MODERATION_ENABLED: flags.marketModerationEnabled ? "true" : "false",
    ...(flags.authEnabled || protectedFamily
      ? {
          AUTH_ENABLED: "true",
          AUTH_DATABASE_URL:
            "postgres://openarc_auth_app:x@127.0.0.1:5432/openarc_auth_test",
          AUTH_SECRET: "synthetic_auth_secret_for_marketplace_tests_0123456789",
          AUTH_RP_ID: "localhost",
        }
      : {}),
    ...(flags.tenantReadsEnabled || flags.listingManagementEnabled
      ? { TENANT_READS_ENABLED: "true" }
      : {}),
    ...(flags.marketCatalogEnabled ||
    flags.listingManagementEnabled ||
    flags.marketModerationEnabled
      ? {
          TENANT_DATABASE_URL:
            "postgres://openarc_tenant_app:y@127.0.0.1:5432/openarc_auth_test",
        }
      : {}),
  });
  const app = createApp({
    config,
    logger: false,
    ...(config.AUTH_ENABLED ? { authService: {} as AuthService } : {}),
    ...(config.TENANT_READS_ENABLED
      ? { tenantReadService: {} as TenantReadService }
      : {}),
    ...(config.LISTING_MANAGEMENT_ENABLED
      ? { marketService: {} as MarketService }
      : {}),
    ...(config.LISTING_MANAGEMENT_ENABLED || config.MARKET_MODERATION_ENABLED
      ? { marketLifecycleService: {} as MarketLifecycleService }
      : {}),
    ...(config.MARKET_CATALOG_ENABLED
      ? { marketCatalogService: {} as MarketCatalogService }
      : {}),
    ...(readiness.authReady !== undefined ? { authReady: readiness.authReady } : {}),
    ...(readiness.tenantReady !== undefined
      ? { tenantReady: readiness.tenantReady }
      : {}),
    ...(readiness.marketReady !== undefined
      ? { marketReady: readiness.marketReady }
      : {}),
    ...(maxResponseBytes !== undefined ? { marketMaxResponseBytes: maxResponseBytes } : {}),
  });
  apps.push(app);
  return { app, flags };
}

function states(
  body: {
    data: {
      capabilities: ReadonlyArray<{ family: string; state: string }>;
    };
  },
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const entry of body.data.capabilities) output[entry.family] = entry.state;
  return output;
}

describe("public marketplace capability manifest", () => {
  it("serves the exact frozen manifest and 18-route registry with all flags off", async () => {
    let calls = 0;
    const { app } = harness(ALL_OFF_FLAGS, {
      authReady: async () => {
        calls += 1;
        return true;
      },
      tenantReady: async () => {
        calls += 1;
        return true;
      },
      marketReady: async () => {
        calls += 1;
        return true;
      },
    });
    const response = await app.inject({
      method: "GET",
      url: MARKETPLACE_CAPABILITIES_PATH,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();

    const parsed = MarketplaceCapabilitiesSuccessEnvelopeSchema.parse(
      response.json(),
    );
    expect(parsed.data.capabilities).toHaveLength(3);
    expect(parsed.data.routes).toHaveLength(18);
    expect(parsed.data.routes).toEqual(MARKETPLACE_ROUTES);
    expect(states(response.json())).toEqual(
      Object.fromEntries(
        MARKETPLACE_CAPABILITY_FAMILY_ORDER.map((family) => [
          family,
          "built_disabled",
        ]),
      ),
    );
    expect(parsed.meta.buildSha).toBe(BUILD_SHA);
    // All off: ZERO readiness callback calls.
    expect(calls).toBe(0);
    expect(response.body).not.toContain(SECRET_CANARY);
  });

  it("lists exactly the three frozen families in order", async () => {
    const { app } = harness();
    const response = await app.inject({
      method: "GET",
      url: MARKETPLACE_CAPABILITIES_PATH,
    });
    expect(
      response.json().data.capabilities.map(
        (entry: { family: string }) => entry.family,
      ),
    ).toEqual([...MARKETPLACE_CAPABILITY_FAMILY_ORDER]);
  });
});

describe("enabled-family readiness mapping", () => {
  it("maps catalog / listing / moderation and their partial readiness states", async () => {
    const cases: ReadonlyArray<{
      readonly flags: Partial<MarketplaceCapabilityFlags>;
      readonly readiness: MarketplaceCapabilityReadiness;
      readonly expected: Record<MarketplaceCapabilityFamily, MarketplaceCapabilityState>;
    }> = [
      {
        flags: { marketCatalogEnabled: true },
        readiness: { marketReady: async () => true },
        expected: {
          public_catalog: "enabled",
          listing_management: "built_disabled",
          moderation: "built_disabled",
        },
      },
      {
        flags: { marketCatalogEnabled: true },
        readiness: {},
        expected: {
          public_catalog: "unavailable",
          listing_management: "built_disabled",
          moderation: "built_disabled",
        },
      },
      {
        flags: {
          authEnabled: true,
          tenantReadsEnabled: true,
          listingManagementEnabled: true,
        },
        readiness: {
          authReady: async () => true,
          tenantReady: async () => true,
          marketReady: async () => true,
        },
        expected: {
          public_catalog: "built_disabled",
          listing_management: "enabled",
          moderation: "built_disabled",
        },
      },
      {
        flags: { authEnabled: true, marketModerationEnabled: true },
        readiness: {
          authReady: async () => true,
          marketReady: async () => true,
        },
        expected: {
          public_catalog: "built_disabled",
          listing_management: "built_disabled",
          moderation: "enabled",
        },
      },
      {
        flags: { authEnabled: true, marketModerationEnabled: true },
        readiness: {
          authReady: async () => false,
          marketReady: async () => true,
        },
        expected: {
          public_catalog: "built_disabled",
          listing_management: "built_disabled",
          moderation: "unavailable",
        },
      },
      {
        // Moderation needs no tenant reads.
        flags: {
          authEnabled: true,
          marketModerationEnabled: true,
          tenantReadsEnabled: true,
        },
        readiness: {
          authReady: async () => true,
          tenantReady: async () => false,
          marketReady: async () => true,
        },
        expected: {
          public_catalog: "built_disabled",
          listing_management: "built_disabled",
          moderation: "enabled",
        },
      },
    ];

    for (const entry of cases) {
      const { app } = harness(entry.flags, entry.readiness);
      const response = await app.inject({
        method: "GET",
        url: MARKETPLACE_CAPABILITIES_PATH,
      });
      expect(response.statusCode).toBe(200);
      expect(states(response.json()), JSON.stringify(entry.flags)).toEqual(
        entry.expected,
      );
    }
  });

  it("invokes only the callbacks an enabled family actually requires", async () => {
    const calls = { auth: 0, tenant: 0, market: 0 };
    const readiness: MarketplaceCapabilityReadiness = {
      authReady: async () => {
        calls.auth += 1;
        return true;
      },
      tenantReady: async () => {
        calls.tenant += 1;
        return true;
      },
      marketReady: async () => {
        calls.market += 1;
        return true;
      },
    };

    // Catalog only: market is probed, auth/tenant are never invoked.
    const catalog = harness({ marketCatalogEnabled: true }, readiness);
    await catalog.app.inject({
      method: "GET",
      url: MARKETPLACE_CAPABILITIES_PATH,
    });
    expect(calls).toEqual({ auth: 0, tenant: 0, market: 1 });

    calls.auth = 0;
    calls.tenant = 0;
    calls.market = 0;
    // Moderation: auth + market, no tenant.
    const moderation = harness(
      { authEnabled: true, marketModerationEnabled: true },
      readiness,
    );
    await moderation.app.inject({
      method: "GET",
      url: MARKETPLACE_CAPABILITIES_PATH,
    });
    expect(calls).toEqual({ auth: 1, tenant: 0, market: 1 });
  });
});

describe("readiness batch coordination", () => {
  it("shares one in-flight batch across concurrent calls and re-checks after settlement", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { app } = harness(
      { marketCatalogEnabled: true },
      {
        marketReady: async () => {
          calls += 1;
          await gate;
          return true;
        },
      },
    );

    const first = app.inject({
      method: "GET",
      url: MARKETPLACE_CAPABILITIES_PATH,
    });
    const second = app.inject({
      method: "GET",
      url: MARKETPLACE_CAPABILITIES_PATH,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls).toBe(1);
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);

    const third = await app.inject({
      method: "GET",
      url: MARKETPLACE_CAPABILITIES_PATH,
    });
    expect(third.statusCode).toBe(200);
    expect(calls).toBe(2);
  });

  it("fails closed after the deadline without a second overlapping batch and a late result cannot promote", async () => {
    let calls = 0;
    let lateResolve!: (value: boolean) => void;
    const { app } = harness(
      { marketCatalogEnabled: true },
      {
        marketReady: () => {
          calls += 1;
          return new Promise<boolean>((resolve) => {
            lateResolve = resolve;
          });
        },
      },
    );

    const started = Date.now();
    const response = await app.inject({
      method: "GET",
      url: MARKETPLACE_CAPABILITIES_PATH,
    });
    const elapsed = Date.now() - started;
    expect(response.statusCode).toBe(200);
    expect(states(response.json()).public_catalog).toBe("unavailable");
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(calls).toBe(1);

    // The underlying callback is still pending: no second overlapping batch.
    const concurrent = await app.inject({
      method: "GET",
      url: MARKETPLACE_CAPABILITIES_PATH,
    });
    expect(concurrent.statusCode).toBe(200);
    expect(calls).toBe(1);
    lateResolve(true);
    await new Promise((resolve) => setImmediate(resolve));
  }, 15_000);

  it("preserves independently settled auth/market readiness across a hung dependency deadline", async () => {
    let authCalls = 0;
    let tenantCalls = 0;
    let marketCalls = 0;
    let releaseMarket!: (value: boolean) => void;
    const { app } = harness(
      {
        authEnabled: true,
        tenantReadsEnabled: true,
        listingManagementEnabled: true,
      },
      {
        authReady: async () => {
          authCalls += 1;
          return true;
        },
        tenantReady: async () => {
          tenantCalls += 1;
          return true;
        },
        marketReady: () => {
          marketCalls += 1;
          if (marketCalls > 1) return Promise.resolve(true);
          return new Promise<boolean>((resolve) => {
            releaseMarket = resolve;
          });
        },
      },
    );

    const started = Date.now();
    const first = app.inject({
      method: "GET",
      url: MARKETPLACE_CAPABILITIES_PATH,
    });
    const second = app.inject({
      method: "GET",
      url: MARKETPLACE_CAPABILITIES_PATH,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(authCalls).toBe(1);
    expect(tenantCalls).toBe(1);
    expect(marketCalls).toBe(1);

    const [a, b] = await Promise.all([first, second]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1900);
    const firstStates = states(a.json());
    // Independent auth/tenant readiness is preserved; the hung market
    // dependency fails closed at the deadline.
    expect(firstStates.public_catalog).toBe("built_disabled");
    expect(firstStates.listing_management).toBe("unavailable");
    expect(firstStates.moderation).toBe("built_disabled");
    expect(marketCalls).toBe(1);
    expect(states(b.json())).toEqual(firstStates);

    releaseMarket(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(states(a.json())).toEqual(firstStates);
  }, 15_000);

  it("does not echo a failing callback error and reports the family unavailable", async () => {
    const { app } = harness(
      { marketCatalogEnabled: true },
      {
        marketReady: async () => {
          throw new Error(SECRET_CANARY);
        },
      },
    );
    const response = await app.inject({
      method: "GET",
      url: MARKETPLACE_CAPABILITIES_PATH,
    });
    expect(response.statusCode).toBe(200);
    expect(states(response.json()).public_catalog).toBe("unavailable");
    expect(response.body).not.toContain(SECRET_CANARY);
  });
});

describe("public marketplace capability transport", () => {
  it("accepts credentialless exact GET originless and with the browser marker", async () => {
    const { app } = harness();
    for (const headers of [
      {},
      { "x-openarc-client": API_CLIENT_HEADER },
      { origin: ORIGIN },
      { origin: ORIGIN, "x-openarc-client": API_CLIENT_HEADER },
    ]) {
      const response = await app.inject({
        method: "GET",
        url: MARKETPLACE_CAPABILITIES_PATH,
        headers: headers as Record<string, string>,
      });
      expect(response.statusCode, JSON.stringify(headers)).toBe(200);
    }
  });

  it("rejects cookies, credentials, CSRF, idempotency and unknown client metadata", async () => {
    const { app } = harness();
    const forbidden: Record<string, string>[] = [
      { cookie: "openarc_session=abc" },
      { authorization: "Bearer x" },
      { "proxy-authorization": "Basic x" },
      { "x-openarc-csrf": "t" },
      { "idempotency-key": "k" },
      { "x-openarc-client": "other" },
      { "x-unknown-client": "x" },
    ];
    for (const headers of forbidden) {
      const response = await app.inject({
        method: "GET",
        url: MARKETPLACE_CAPABILITIES_PATH,
        headers: headers as Record<string, string>,
      });
      expect(response.statusCode, JSON.stringify(headers)).toBe(400);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("returns a fixed v2 INVALID_ORIGIN envelope for a cross origin", async () => {
    const { app } = harness();
    const response = await app.inject({
      method: "GET",
      url: MARKETPLACE_CAPABILITIES_PATH,
      headers: { origin: "https://evil.example" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("INVALID_ORIGIN");
    expect(response.json().meta.schemaVersion).toBe("openarc.api.v2");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("rejects wrong methods and bodies with a fixed v2 INVALID_REQUEST", async () => {
    const { app } = harness();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const) {
      const response = await app.inject({
        method,
        url: MARKETPLACE_CAPABILITIES_PATH,
        payload: {},
      });
      expect(response.statusCode, method).toBe(405);
      expect(response.json().meta.schemaVersion, method).toBe("openarc.api.v2");
      expect(response.json().error.code, method).toBe("INVALID_REQUEST");
    }
  });

  it("rejects any query including a bare ? and oversized URLs with no raw echo", async () => {
    const { app } = harness();
    const queried = await app.inject({
      method: "GET",
      url: `${MARKETPLACE_CAPABILITIES_PATH}?x=1`,
    });
    expect(queried.statusCode).toBe(400);
    expect(queried.body).not.toContain("x=1");

    const port = await listeningPort(app);
    const bare = await rawHttp(
      port,
      "GET",
      `${MARKETPLACE_CAPABILITIES_PATH}?`,
      [],
    );
    expect(bare.status).toBe(400);
    expect(bare.text).toContain('"code":"INVALID_REQUEST"');

    const oversized = await app.inject({
      method: "GET",
      url: `${MARKETPLACE_CAPABILITIES_PATH}?${"x".repeat(2100)}`,
    });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json().meta.schemaVersion).toBe("openarc.api.v2");
    expect(oversized.body).not.toContain("x".repeat(2100));
  });

  it("caps the response with the fixed v2 INTERNAL_ERROR", async () => {
    const { app } = harness({}, {}, 10);
    const response = await app.inject({
      method: "GET",
      url: MARKETPLACE_CAPABILITIES_PATH,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("INTERNAL_ERROR");
  });

  it("leaves lookalike prefixes with no authority", async () => {
    const { app } = harness();
    for (const url of [
      `${MARKETPLACE_CAPABILITIES_PATH}/extra`,
      "/v2/public/marketplace-capabilitiesXYZ",
      "/v2/public/marketXYZ",
      "/v2/moderator/organizationsXYZ",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
    }
  });
});

/**
 * SECOND-EDGE REPRODUCTION: nginx strips the incoming transport headers and
 * uses the public HTTPS API upstream, after which Railway's second edge inserts
 * fresh routing headers BEFORE the API sees them. These are opaque, untrusted
 * informational proxy metadata: they must be ignored (never trusted, persisted,
 * echoed, logged, used for routing/origin) without weakening the credential,
 * Origin/Fetch-Site or request-shape protections.
 */
describe("second-edge Railway transport metadata is ignored", () => {
  const RAILWAY_EDGE_HEADERS: Record<string, string> = {
    "x-real-ip": "203.0.113.7",
    "x-forwarded-proto": "https",
    "x-forwarded-host": "capabilities.openarc.test",
    "x-railway-edge": "lhr1",
    "x-request-start": "1700000000.123",
    "x-railway-request-id": "railway-req-abc",
  };
  const STANDARD_PROXY_HEADERS: Record<string, string> = {
    "x-forwarded-for": "203.0.113.7, 198.51.100.9",
    forwarded: "for=203.0.113.7;proto=https;host=capabilities.openarc.test",
  };
  const UUID_V4 =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it("accepts the exact eight documented names simultaneously and separately", async () => {
    const { app } = harness();
    const single: ReadonlyArray<readonly [string, string]> = Object.entries(
      RAILWAY_EDGE_HEADERS,
    );
    const accepted: Record<string, string>[] = [
      RAILWAY_EDGE_HEADERS,
      ...Object.entries(STANDARD_PROXY_HEADERS).map(([name, value]) => ({
        [name]: value,
      })),
      ...single.map(([name, value]) => ({ [name]: value })),
    ];
    for (const headers of accepted) {
      const response = await app.inject({
        method: "GET",
        url: MARKETPLACE_CAPABILITIES_PATH,
        headers,
      });
      expect(response.statusCode, JSON.stringify(headers)).toBe(200);
      expect(
        MarketplaceCapabilitiesSuccessEnvelopeSchema.parse(response.json())
          .data.capabilities,
      ).toHaveLength(3);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    }
  });

  it("never reflects spoofed proxy metadata and keeps the app requestId in charge", async () => {
    const { app } = harness();
    const spoofed: Record<string, string> = {
      ...RAILWAY_EDGE_HEADERS,
      ...STANDARD_PROXY_HEADERS,
      "x-railway-request-id": "attacker-supplied-request-id",
      "x-real-ip": "6.6.6.6",
      "x-forwarded-host": "<script>alert(1)</script>",
    };
    const response = await app.inject({
      method: "GET",
      url: MARKETPLACE_CAPABILITIES_PATH,
      headers: spoofed,
    });
    expect(response.statusCode).toBe(200);
    const parsed = MarketplaceCapabilitiesSuccessEnvelopeSchema.parse(
      response.json(),
    );
    expect(parsed.meta.requestId).toMatch(UUID_V4);
    expect(parsed.meta.requestId).not.toBe("attacker-supplied-request-id");
    const headerValues = Object.values(response.headers).map((value) =>
      String(value),
    );
    for (const value of Object.values(spoofed)) {
      expect(response.body, value).not.toContain(value);
      expect(headerValues, value).not.toContain(value);
    }
  });

  it("does not let edge metadata authorize credentials or weaken origin/method guards", async () => {
    const { app } = harness();
    const forbidden: Record<string, string>[] = [
      { cookie: "openarc_session=abc" },
      { authorization: "Bearer x" },
      { "x-openarc-csrf": "t" },
      { "idempotency-key": "k" },
      { "x-openarc-client": "other" },
      { "x-unknown-client": "x" },
    ];
    for (const extra of forbidden) {
      const response = await app.inject({
        method: "GET",
        url: MARKETPLACE_CAPABILITIES_PATH,
        headers: { ...RAILWAY_EDGE_HEADERS, ...extra },
      });
      expect(response.statusCode, JSON.stringify(extra)).toBe(400);
      expect(response.json().error.code, JSON.stringify(extra)).toBe(
        "INVALID_REQUEST",
      );
    }

    const foreignOrigin = await app.inject({
      method: "GET",
      url: MARKETPLACE_CAPABILITIES_PATH,
      headers: { ...RAILWAY_EDGE_HEADERS, origin: "https://evil.example" },
    });
    expect(foreignOrigin.statusCode).toBe(403);
    expect(foreignOrigin.json().error.code).toBe("INVALID_ORIGIN");
  });

  it("still rejects raw duplicate critical headers including Cookie and Origin", async () => {
    const { app } = harness();
    const port = await listeningPort(app);
    const duplicates: ReadonlyArray<readonly string[]> = [
      ["Cookie: a=1", "Cookie: b=2"],
      ["Authorization: Bearer x", "Authorization: Bearer y"],
      ["Origin: " + ORIGIN, "Origin: " + ORIGIN],
      ["Idempotency-Key: a", "Idempotency-Key: b"],
      ["X-OpenArc-Csrf: a", "X-OpenArc-Csrf: b"],
      ["X-OpenArc-Client: browser-v1", "X-OpenArc-Client: browser-v1"],
    ];
    for (const duplicate of duplicates) {
      const response = await rawHttp(
        port,
        "GET",
        MARKETPLACE_CAPABILITIES_PATH,
        [...duplicate],
      );
      expect(response.status, duplicate.join("|")).toBe(400);
      expect(response.text).toContain('"code":"INVALID_REQUEST"');
      expect(response.text.toLowerCase()).not.toContain("set-cookie");
    }
  });
});

function rawHttp(
  port: number,
  method: string,
  path: string,
  headers: readonly string[],
  body = "",
): Promise<{ status: number; text: string }> {
  const payload = Buffer.from(body, "utf8");
  const lines = [
    `${method} ${path} HTTP/1.1`,
    "Host: 127.0.0.1",
    ...headers,
    ...(payload.byteLength > 0 ? [`Content-Length: ${payload.byteLength}`] : []),
    "Connection: close",
    "",
    "",
  ];
  const wire = Buffer.concat([Buffer.from(lines.join("\r\n"), "utf8"), payload]);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.on("connect", () => socket.write(wire));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      resolve({ status: Number.parseInt(text.slice(9, 12), 10), text });
    });
  });
}

async function listeningPort(app: App): Promise<number> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected TCP address");
  }
  return address.port;
}

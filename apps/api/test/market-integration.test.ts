import { afterEach, describe, expect, it } from "vitest";

import {
  COMMERCE_ROUTES,
  MARKETPLACE_CAPABILITIES_PATH,
  MARKETPLACE_CAPABILITY_FAMILY_ORDER,
  MARKETPLACE_ROUTES,
  MarketplaceCapabilitiesSuccessEnvelopeSchema,
  CommerceCapabilitiesSuccessEnvelopeSchema,
  type CommerceListingPublicVersion,
} from "@openarc/shared";

import { createApp, type CompletionLog } from "../src/app.js";
import type { AuthService } from "../src/auth/service.js";
import { loadConfig } from "../src/config.js";
import { MarketCatalogService } from "../src/market/catalog-service.js";
import type { MarketCatalogStorePort } from "../src/market/catalog-ports.js";
import { MarketLifecycleService } from "../src/market/lifecycle-service.js";
import type {
  MarketLifecycleMutationStatus,
  MarketLifecycleStorePort,
} from "../src/market/lifecycle-ports.js";
import type { MarketStorePort } from "../src/market/ports.js";
import { MarketService } from "../src/market/service.js";
import type { TenantReadService } from "../src/tenant/service.js";
import type { TenantWriteAuthPort } from "../src/tenant/write-ports.js";

/**
 * Integration coverage for the REAL `createApp` over real Fastify. The
 * repository/auth ports are HONESTLY MOCKED; no PostgreSQL, network, Redis or
 * server is claimed. This suite proves the exact 18-route family mount across
 * all eight flag combinations, fixed missing-service startup, disabled-family
 * 404s, the fixed v2 framework envelope, the public catalog guards, root
 * readiness wiring and the new-vs-old capability contracts.
 */

const ORIGIN = "http://localhost:5183";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const AUTH_URL = "postgres://openarc_auth_app:x@127.0.0.1:5432/openarc_auth_test";
const TENANT_URL = "postgres://openarc_tenant_app:y@127.0.0.1:5432/openarc_auth_test";

const PUBLIC_LISTING: CommerceListingPublicVersion = {
  schemaVersion: "openarc.listing-public-version.v1",
  listingId: "openarc:listing:11111111-1111-4111-8111-111111111111",
  providerId: "openarc:provider:11111111-1111-4111-8111-111111111111",
  version: "1",
  kind: "api",
  title: "Example API",
  description: "An example marketplace listing.",
  manifest: {
    schemaVersion: "openarc.listing-manifest.v1",
    inputSchemaDigest: `sha256:${"b".repeat(64)}`,
    outputSchemaDigest: `sha256:${"b".repeat(64)}`,
  },
  price: {
    amount: {
      schemaVersion: "openarc.usdc-amount.v1",
      networkId: "eip155:5042002",
      asset: "USDC",
      atomicAmount: "1000000",
      representation: "erc20",
      decimals: 6,
    },
    pricingModel: "fixed",
  },
  evidenceContract: {
    schemaVersion: "openarc.receipt-contract.v1",
    receiptType: "example_receipt",
    receiptSchemaDigest: `sha256:${"b".repeat(64)}`,
    deliveryFields: ["receipt_id"],
  },
  endpointOrigin: "https://api.example.com",
  termsRevision: "terms-v1",
  privacySummary: "No personal data is collected.",
  paymentLane: "unavailable",
  availability: { status: "available", rateLimitPerMinute: "60" },
  status: "active",
  publishedAt: "2026-01-01T00:00:00.000Z",
};

class FakeStores
  implements MarketStorePort, MarketLifecycleStorePort, MarketCatalogStorePort
{
  async listPublicListings(): Promise<{ items: []; nextCursor: null }> {
    return { items: [], nextCursor: null };
  }
  async getPublicListing(): Promise<CommerceListingPublicVersion> {
    return PUBLIC_LISTING;
  }
  async getPublicProvider(): Promise<null> {
    return null;
  }
  async listOwnerListings(): Promise<never> {
    throw new Error("unused");
  }
  async getOwnerListingVersion(): Promise<null> {
    return null;
  }
  async getOwnerListing(): Promise<null> {
    return null;
  }
  async listMarketProviders(): Promise<{ items: []; nextCursor: null }> {
    return { items: [], nextCursor: null };
  }
  async getModeratorListingVersion(): Promise<null> {
    return null;
  }
  async getLifecycleMutationStatus(): Promise<MarketLifecycleMutationStatus> {
    return { status: "not_found" };
  }
  async createListingDraft(): Promise<never> {
    throw new Error("unused");
  }
  async createListingVersion(): Promise<never> {
    throw new Error("unused");
  }
  async listOwnerListingVersions(): Promise<never> {
    throw new Error("unused");
  }
  async getMarketMutationStatus(): Promise<never> {
    throw new Error("unused");
  }
  async recordOriginReview(): Promise<never> {
    throw new Error("unused");
  }
  async publishListingVersion(): Promise<never> {
    throw new Error("unused");
  }
  async pauseListingVersion(): Promise<never> {
    throw new Error("unused");
  }
  async retireListingVersion(): Promise<never> {
    throw new Error("unused");
  }
}

const AUTH: TenantWriteAuthPort = {
  verifyCsrf: () => "binding",
  beginTenantRead: async () => ({
    sessionHash: "a".repeat(64),
    accountId: "openarc:account:11111111-1111-4111-8111-111111111111",
  }),
  finishTenantRead: async () => undefined,
};

interface FamilyFlags {
  readonly catalog: boolean;
  readonly listing: boolean;
  readonly moderation: boolean;
}

interface BuildOptions {
  readonly flags: FamilyFlags;
  readonly omitCatalogService?: boolean;
  readonly omitLifecycleService?: boolean;
  readonly omitDraftService?: boolean;
  readonly marketReady?: () => Promise<boolean>;
  readonly logs?: CompletionLog[];
}

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function build(options: BuildOptions) {
  const { flags } = options;
  const protectedFamily = flags.listing || flags.moderation;
  const config = loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    COMMIT_SHA: BUILD_SHA,
    MARKET_CATALOG_ENABLED: flags.catalog ? "true" : "false",
    LISTING_MANAGEMENT_ENABLED: flags.listing ? "true" : "false",
    MARKET_MODERATION_ENABLED: flags.moderation ? "true" : "false",
    ...(protectedFamily
      ? {
          AUTH_ENABLED: "true",
          AUTH_DATABASE_URL: AUTH_URL,
          AUTH_SECRET: "synthetic_auth_secret_for_market_integration_01234",
          AUTH_RP_ID: "localhost",
        }
      : {}),
    ...(flags.listing
      ? { TENANT_READS_ENABLED: "true" }
      : {}),
    ...(flags.catalog || flags.listing || flags.moderation
      ? { TENANT_DATABASE_URL: TENANT_URL }
      : {}),
  });
  const stores = new FakeStores();
  const shared = {
    config,
    logger: false,
    ...(options.logs !== undefined ? { logSink: (entry: CompletionLog) => options.logs!.push(entry) } : {}),
    ...(config.AUTH_ENABLED ? { authService: AUTH as unknown as AuthService } : {}),
    ...(config.TENANT_READS_ENABLED
      ? { tenantReadService: {} as TenantReadService }
      : {}),
    ...(flags.listing && !options.omitDraftService
      ? { marketService: new MarketService({ auth: AUTH, store: stores }) }
      : {}),
    ...(protectedFamily && !options.omitLifecycleService
      ? {
          marketLifecycleService: new MarketLifecycleService({
            auth: AUTH,
            store: stores,
          }),
        }
      : {}),
    ...(flags.catalog && !options.omitCatalogService
      ? { marketCatalogService: new MarketCatalogService({ store: stores }) }
      : {}),
    ...(options.marketReady !== undefined ? { marketReady: options.marketReady } : {}),
  };
  const app = createApp(shared);
  apps.push(app);
  return app;
}

function allCombos(): FamilyFlags[] {
  const combos: FamilyFlags[] = [];
  for (let mask = 0; mask < 8; mask += 1) {
    combos.push({
      catalog: (mask & 1) !== 0,
      listing: (mask & 2) !== 0,
      moderation: (mask & 4) !== 0,
    });
  }
  return combos;
}

function expectedRoutes(flags: FamilyFlags): ReadonlySet<string> {
  const present = new Set<string>();
  for (const route of MARKETPLACE_ROUTES) {
    const enabled =
      (route.family === "public_catalog" && flags.catalog) ||
      (route.family === "listing_management" && flags.listing) ||
      (route.family === "moderation" && flags.moderation);
    if (enabled) present.add(`${route.method} ${route.path}`);
  }
  return present;
}

function actualMarketRoutes(app: ReturnType<typeof createApp>): Set<string> {
  const actual = new Set<string>();
  for (const route of MARKETPLACE_ROUTES) {
    if (app.hasRoute({ method: route.method, url: route.path })) {
      actual.add(`${route.method} ${route.path}`);
    }
  }
  return actual;
}

describe("marketplace family mount across all eight combinations", () => {
  it("registers exactly the enabled families' real routes", () => {
    for (const flags of allCombos()) {
      const app = build({ flags });
      expect(
        actualMarketRoutes(app),
        JSON.stringify(flags),
      ).toEqual(expectedRoutes(flags));
    }
  });

  it("registers all 18 real routes when every family is on", () => {
    const app = build({ flags: { catalog: true, listing: true, moderation: true } });
    expect(MARKETPLACE_ROUTES).toHaveLength(18);
    for (const route of MARKETPLACE_ROUTES) {
      expect(
        app.hasRoute({ method: route.method, url: route.path }),
        `${route.method} ${route.path}`,
      ).toBe(true);
    }
    expect(actualMarketRoutes(app).size).toBe(18);
  });
});

describe("missing marketplace service dependencies fail startup closed", () => {
  it("throws a fixed error for each enabled family without its service", () => {
    expect(() =>
      build({ flags: { catalog: true, listing: false, moderation: false }, omitCatalogService: true }),
    ).toThrow("Market catalog dependencies are unavailable");
    expect(() =>
      build({ flags: { catalog: false, listing: true, moderation: false }, omitDraftService: true }),
    ).toThrow("Market listing dependencies are unavailable");
    expect(() =>
      build({ flags: { catalog: false, listing: false, moderation: true }, omitLifecycleService: true }),
    ).toThrow("Market lifecycle dependencies are unavailable");
  });

  it("rejects a listing-only run without the lifecycle service before any route", () => {
    // Listing enabled REQUIRES the lifecycle dependency: a missing service is a
    // fixed startup error, never a silent six-route downgrade while the
    // manifest still advertises all twelve listing-management routes.
    expect(() =>
      build({
        flags: { catalog: false, listing: true, moderation: false },
        omitLifecycleService: true,
      }),
    ).toThrow("Market lifecycle dependencies are unavailable");
  });
});

describe("disabled families and the fixed v2 framework envelope", () => {
  it("returns a bounded v2 404 for every disabled family route", async () => {
    const app = build({ flags: { catalog: false, listing: false, moderation: false } });
    for (const route of MARKETPLACE_ROUTES) {
      const response = await app.inject({ method: route.method, url: route.path });
      expect(response.statusCode, `${route.method} ${route.path}`).toBe(404);
      expect(response.json().meta.schemaVersion, route.path).toBe("openarc.api.v2");
      expect(response.json().error.code, route.path).toBe("FEATURE_DISABLED");
    }
  });

  it("keeps lookalike prefixes on the legacy envelope", async () => {
    const app = build({ flags: { catalog: false, listing: false, moderation: false } });
    for (const url of [
      "/v2/provider/organizationsXYZ",
      "/v2/moderator/organizationsXYZ",
      "/v2/public/marketXYZ",
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(response.json().meta.schemaVersion, url).toBe("openarc.api.v1");
    }
  });

  it("returns a fixed 405 v2 envelope for a wrong method on an enabled route", async () => {
    const app = build({ flags: { catalog: true, listing: true, moderation: true } });
    const response = await app.inject({
      method: "DELETE",
      url: "/v2/provider/organizations/openarc:org:11111111-1111-4111-8111-111111111111/listings",
    });
    expect(response.statusCode).toBe(405);
    expect(response.json().meta.schemaVersion).toBe("openarc.api.v2");
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("returns a fixed 405 v2 envelope for a wrong method on the capability route", async () => {
    const app = build({ flags: { catalog: false, listing: false, moderation: false } });
    const response = await app.inject({
      method: "POST",
      url: MARKETPLACE_CAPABILITIES_PATH,
      payload: {},
    });
    expect(response.statusCode).toBe(405);
    expect(response.json().meta.schemaVersion).toBe("openarc.api.v2");
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });
});

describe("public catalog transport guards", () => {
  it("rejects credentials, foreign origin and unknown list queries", async () => {
    const app = build({ flags: { catalog: true, listing: false, moderation: false } });
    const base = "/v2/public/market/listings";

    const cookie = await app.inject({
      method: "GET",
      url: base,
      headers: { cookie: "openarc_session=abc" },
    });
    expect(cookie.statusCode).toBe(400);
    expect(cookie.json().error.code).toBe("INVALID_REQUEST");

    const foreign = await app.inject({
      method: "GET",
      url: base,
      headers: { origin: "https://evil.example" },
    });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json().error.code).toBe("INVALID_ORIGIN");

    const query = await app.inject({
      method: "GET",
      url: `${base}?unknown=1`,
    });
    expect(query.statusCode).toBe(400);
    expect(query.body).not.toContain("unknown");
  });

  it("serves the list with a valid credentialless request and no Set-Cookie/CORS", async () => {
    const app = build({ flags: { catalog: true, listing: false, moderation: false } });
    const response = await app.inject({
      method: "GET",
      url: "/v2/public/market/listings?limit=1",
      headers: { "x-openarc-client": "browser-v1" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.items).toEqual([]);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("root readiness wiring", () => {
  it("fails market readiness closed when the market callback is down", async () => {
    const app = build({
      flags: { catalog: true, listing: false, moderation: false },
      marketReady: async () => false,
    });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json().checks.marketDatabase).toBe("down");
  });

  it("reports market readiness up without inventing auth/tenant databases", async () => {
    const app = build({
      flags: { catalog: true, listing: false, moderation: false },
      marketReady: async () => true,
    });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    expect(response.json().checks.marketDatabase).toBe("up");
    expect(response.json().checks).not.toHaveProperty("authDatabase");
    expect(response.json().checks).not.toHaveProperty("tenantDatabase");
  });

  it("never invokes market readiness when every market flag is off", async () => {
    let calls = 0;
    const logs: CompletionLog[] = [];
    const app = build({
      flags: { catalog: false, listing: false, moderation: false },
      logs,
      marketReady: async () => {
        calls += 1;
        return true;
      },
    });
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(200);
    expect(response.json().checks).not.toHaveProperty("marketDatabase");
    expect(calls).toBe(0);
    // The coarse metrics/log label never leaks a raw path or input name.
    for (const entry of logs) {
      expect(JSON.stringify(entry)).not.toContain("marketDatabase");
      expect(entry.route).not.toContain("/v2/");
    }
  });
});

describe("new and legacy capability contracts", () => {
  it("serves the new capability manifest and leaves the legacy 5/41 unchanged", async () => {
    const app = build({ flags: { catalog: false, listing: false, moderation: false } });
    const marketplace = await app.inject({
      method: "GET",
      url: MARKETPLACE_CAPABILITIES_PATH,
    });
    expect(marketplace.statusCode).toBe(200);
    const parsed = MarketplaceCapabilitiesSuccessEnvelopeSchema.parse(
      marketplace.json(),
    );
    expect(parsed.data.capabilities).toHaveLength(3);
    expect(parsed.data.routes).toHaveLength(18);
    expect(
      parsed.data.capabilities.map((entry) => entry.family),
    ).toEqual([...MARKETPLACE_CAPABILITY_FAMILY_ORDER]);

    const legacy = await app.inject({ method: "GET", url: "/v2/public/capabilities" });
    expect(legacy.statusCode).toBe(200);
    const commerce = CommerceCapabilitiesSuccessEnvelopeSchema.parse(
      legacy.json(),
    );
    expect(commerce.data.capabilities).toHaveLength(5);
    expect(commerce.data.routes).toHaveLength(41);
    expect(commerce.data.routes).toEqual(COMMERCE_ROUTES);
  });
});

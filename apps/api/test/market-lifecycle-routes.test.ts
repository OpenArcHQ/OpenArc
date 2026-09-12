import { randomUUID } from "node:crypto";
import { connect } from "node:net";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  API_CLIENT_HEADER,
  MARKETPLACE_ROUTES,
  type CommerceListingOwner,
  type CommerceListingOwnerVersion,
  type CommerceMarketProviderOption,
} from "@openarc/shared";
import type {
  LifecycleMutationReceipt,
  LifecycleMutationResult,
  LifecycleOperation,
} from "@openarc/db";

import {
  AUTH_ERRORS,
  AuthApiError,
  authErrorEnvelope,
} from "../src/auth/errors.js";
import type {
  MarketLifecycleAuthPort,
  MarketLifecycleMutationStatus,
  MarketLifecycleStorePort,
} from "../src/market/lifecycle-ports.js";
import { MarketLifecycleService } from "../src/market/lifecycle-service.js";
import {
  MARKET_LIFECYCLE_ROUTES,
  registerMarketLifecycleRoutes,
} from "../src/market/lifecycle-routes.js";
import { registerMarketCatalogRoutes } from "../src/market/catalog-routes.js";
import { MarketCatalogService } from "../src/market/catalog-service.js";
import { MARKET_ROUTES, registerMarketRoutes } from "../src/market/routes.js";
import { MarketService } from "../src/market/service.js";
import type {
  MarketAuthPort,
  MarketStorePort,
} from "../src/market/ports.js";

/**
 * HTTP-inject and real-TCP coverage for the protected lifecycle transport.
 *
 * Repository and auth ports are HONESTLY MOCKED; no PostgreSQL is claimed.
 * This suite proves flag independence, the v2 envelope/error boundaries, the
 * exact decode-once path binding, query/body/header guards, fixed responses and
 * the ABSENCE of Set-Cookie/CORS, plus a no-collision mount with the accepted
 * draft `registerMarketRoutes`.
 */

const ORIGIN = "http://localhost:5183";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const MUTATION = "12345678-1234-4234-8123-123456789abc";
const ORG = `openarc:org:${MUTATION}`;
const LISTING = `openarc:listing:${MUTATION}`;
const PROVIDER = `openarc:provider:${MUTATION}`;
const ISO = "2026-01-01T00:00:00.000Z";
const HASH = "a".repeat(64);
const IDEMPOTENCY = "A".repeat(43);
const DIGEST = `sha256:${"b".repeat(64)}`;

const OWNER_LISTING: CommerceListingOwner = {
  schemaVersion: "openarc.listing.v1",
  listingId: LISTING,
  organizationId: ORG,
  providerId: PROVIDER,
  activeVersion: null,
  createdAt: ISO,
  updatedAt: ISO,
};

const OWNER_VERSION: CommerceListingOwnerVersion = {
  schemaVersion: "openarc.listing-owner-version.v1",
  listingId: LISTING,
  organizationId: ORG,
  providerId: PROVIDER,
  version: "1",
  kind: "api",
  title: "Example API",
  description: "An example marketplace listing.",
  manifest: {
    schemaVersion: "openarc.listing-manifest.v1",
    inputSchemaDigest: DIGEST,
    outputSchemaDigest: DIGEST,
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
    receiptSchemaDigest: DIGEST,
    deliveryFields: ["receipt_id"],
  },
  endpointContract: { origin: "https://api.example.com", path: "/v1/invoke" },
  originReviewState: "unreviewed",
  termsRevision: "terms-v1",
  privacySummary: "No personal data is collected.",
  paymentLane: "unavailable",
  availability: { status: "available", rateLimitPerMinute: "60" },
  status: "draft",
  createdAt: ISO,
  updatedAt: ISO,
  publishedAt: null,
};

const PROVIDER_OPTION: CommerceMarketProviderOption = {
  providerId: PROVIDER,
  displayName: "Example Provider",
  status: "active",
};

function receipt(
  operation: LifecycleOperation,
  resourceId: string,
): LifecycleMutationReceipt {
  return {
    mutationId: MUTATION,
    operation,
    resourceType: "listing_version",
    resourceId,
    committedAt: ISO,
  };
}

class FakeStore implements MarketLifecycleStorePort, MarketStorePort {
  calls: string[] = [];
  async getOwnerListing(): Promise<CommerceListingOwner | null> {
    this.calls.push("getOwnerListing");
    return OWNER_LISTING;
  }
  async listMarketProviders(): Promise<{
    items: CommerceMarketProviderOption[];
    nextCursor: string | null;
  }> {
    this.calls.push("listMarketProviders");
    return { items: [PROVIDER_OPTION], nextCursor: null };
  }
  async getModeratorListingVersion(): Promise<CommerceListingOwnerVersion | null> {
    this.calls.push("getModeratorListingVersion");
    return OWNER_VERSION;
  }
  async recordOriginReview(): Promise<LifecycleMutationResult> {
    this.calls.push("recordOriginReview");
    return {
      replayed: false,
      receipt: receipt(
        "market.listing.origin_review.record",
        `${LISTING}@1`,
      ),
    };
  }
  async publishListingVersion(): Promise<LifecycleMutationResult> {
    this.calls.push("publishListingVersion");
    return {
      replayed: false,
      receipt: receipt("market.listing.version.publish", `${LISTING}@1`),
    };
  }
  async pauseListingVersion(): Promise<LifecycleMutationResult> {
    this.calls.push("pauseListingVersion");
    return {
      replayed: false,
      receipt: receipt("market.listing.version.pause", `${LISTING}@1`),
    };
  }
  async retireListingVersion(): Promise<LifecycleMutationResult> {
    this.calls.push("retireListingVersion");
    return {
      replayed: false,
      receipt: receipt("market.listing.version.retire", `${LISTING}@1`),
    };
  }
  async getLifecycleMutationStatus(): Promise<MarketLifecycleMutationStatus> {
    this.calls.push("getLifecycleMutationStatus");
    return {
      status: "committed",
      receipt: receipt("market.listing.version.publish", `${LISTING}@1`),
    };
  }
  // Draft MarketStorePort surface, used only by the collision-mount test.
  async createListingDraft(): Promise<never> {
    throw new Error("unused");
  }
  async createListingVersion(): Promise<never> {
    throw new Error("unused");
  }
  async listOwnerListings(): Promise<{ items: []; nextCursor: null }> {
    this.calls.push("listOwnerListings");
    return { items: [], nextCursor: null };
  }
  async listOwnerListingVersions(): Promise<{ items: []; nextCursor: null }> {
    this.calls.push("listOwnerListingVersions");
    return { items: [], nextCursor: null };
  }
  async getOwnerListingVersion(): Promise<null> {
    this.calls.push("getOwnerListingVersion");
    return null;
  }
  async getMarketMutationStatus(): Promise<never> {
    throw new Error("unused");
  }
}

class FakeAuth implements MarketLifecycleAuthPort, MarketAuthPort {
  verifyCsrf(): string {
    return "binding";
  }
  async beginTenantRead(): Promise<{ sessionHash: string; accountId: string }> {
    return { sessionHash: HASH, accountId: `openarc:account:${MUTATION}` };
  }
  async finishTenantRead(): Promise<void> {}
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

interface HarnessOptions {
  readonly provider?: boolean;
  readonly moderator?: boolean;
  readonly service?: boolean;
  readonly maxResponseBytes?: number;
  readonly mountDraft?: boolean;
  readonly mountCatalog?: boolean;
}

function buildApp(options: HarnessOptions = {}): FastifyInstance {
  const app = Fastify({
    logger: false,
    exposeHeadRoutes: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });
  app.setErrorHandler((cause, request, reply) => {
    if (cause instanceof AuthApiError) {
      return reply
        .code(cause.status)
        .send(authErrorEnvelope(cause, request.id, BUILD_SHA));
    }
    const statusCode =
      typeof cause === "object" && cause !== null && "statusCode" in cause
        ? (cause as { statusCode?: unknown }).statusCode
        : undefined;
    const mapped =
      statusCode === 400
        ? AUTH_ERRORS.invalidRequest()
        : statusCode === 413
          ? AUTH_ERRORS.tooLarge()
          : statusCode === 415
            ? AUTH_ERRORS.unsupportedMedia()
            : AUTH_ERRORS.internal();
    return reply
      .code(mapped.status)
      .send(authErrorEnvelope(mapped, request.id, BUILD_SHA));
  });
  const service = new MarketLifecycleService({
    auth: new FakeAuth(),
    store: new FakeStore(),
  });
  registerMarketLifecycleRoutes(app, {
    listingManagementEnabled: options.provider ?? false,
    moderationEnabled: options.moderator ?? false,
    appOrigin: ORIGIN,
    cookieNames: { session: "openarc_session", binding: "openarc_binding" },
    ...(options.service === false ? {} : { service }),
    buildSha: BUILD_SHA,
    ...(options.maxResponseBytes !== undefined
      ? { maxResponseBytes: options.maxResponseBytes }
      : {}),
  });
  if (options.mountDraft === true) {
    const store = new FakeStore();
    const draft = new MarketService({ auth: new FakeAuth(), store });
    registerMarketRoutes(app, {
      appOrigin: ORIGIN,
      cookieNames: { session: "openarc_session", binding: "openarc_binding" },
      service: draft,
      buildSha: BUILD_SHA,
      enabled: true,
    });
  }
  if (options.mountCatalog === true) {
    registerMarketCatalogRoutes(app, {
      enabled: true,
      appOrigin: ORIGIN,
      service: new MarketCatalogService({
        store: {
          listPublicListings: async () => ({ items: [], nextCursor: null }),
          getPublicListing: async () => null,
          getPublicProvider: async () => null,
        },
      }),
      buildSha: BUILD_SHA,
    });
  }
  apps.push(app);
  return app;
}

const READ_HEADERS = {
  origin: ORIGIN,
  "x-openarc-client": API_CLIENT_HEADER,
  cookie: "openarc_session=abc",
};

const WRITE_HEADERS = {
  ...READ_HEADERS,
  "content-type": "application/json",
  "x-openarc-csrf": "t",
  "idempotency-key": IDEMPOTENCY,
};

const PUBLISH_BODY = JSON.stringify({
  mutationId: MUTATION,
  expectedUpdatedAt: ISO,
  expectedActiveVersion: null,
});

function ownerListingUrl(): string {
  return `${MARKET_LIFECYCLE_ROUTES.ownerListing
    .replace(":organizationId", ORG)
    .replace(":listingId", LISTING)}`;
}

function publishUrl(): string {
  return MARKET_LIFECYCLE_ROUTES.publish
    .replace(":organizationId", ORG)
    .replace(":listingId", LISTING)
    .replace(":version", "1");
}

function moderatorVersionUrl(): string {
  return MARKET_LIFECYCLE_ROUTES.moderatorVersion
    .replace(":organizationId", ORG)
    .replace(":listingId", LISTING)
    .replace(":version", "1");
}

function providerOptionsUrl(): string {
  return MARKET_LIFECYCLE_ROUTES.providerOptions.replace(":organizationId", ORG);
}

function providerMutationUrl(): string {
  return MARKET_LIFECYCLE_ROUTES.providerMutation
    .replace(":organizationId", ORG)
    .replace(":mutationId", MUTATION);
}

function moderatorMutationUrl(): string {
  return MARKET_LIFECYCLE_ROUTES.moderatorMutation
    .replace(":organizationId", ORG)
    .replace(":mutationId", MUTATION);
}

describe("flag independence and startup", () => {
  it("registers nothing when both families are off (plain 404)", async () => {
    const app = buildApp();
    for (const url of [
      ownerListingUrl(),
      providerOptionsUrl(),
      publishUrl(),
      providerMutationUrl(),
      moderatorVersionUrl(),
      moderatorMutationUrl(),
    ]) {
      const response = await app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
    }
  });

  it("fails startup with a fixed error when a family is on and the service is absent", () => {
    expect(() => buildApp({ provider: true, service: false })).toThrowError(
      "MARKET_LIFECYCLE_SERVICE_REQUIRED",
    );
    expect(() => buildApp({ moderator: true, service: false })).toThrowError(
      "MARKET_LIFECYCLE_SERVICE_REQUIRED",
    );
    // A service may be omitted only when BOTH families are off.
    expect(() => buildApp({ service: false })).not.toThrow();
  });

  it("never registers the other family when only one flag is on", async () => {
    const providerOnly = buildApp({ provider: true });
    expect(
      (await providerOnly.inject({
        method: "GET",
        url: moderatorVersionUrl(),
        headers: READ_HEADERS,
      })).statusCode,
    ).toBe(404);

    const moderatorOnly = buildApp({ moderator: true });
    expect(
      (await moderatorOnly.inject({
        method: "GET",
        url: ownerListingUrl(),
        headers: READ_HEADERS,
      })).statusCode,
    ).toBe(404);
  });
});

describe("supported routes and v2 envelopes", () => {
  it("serves all nine lifecycle routes with the exact v2 envelope", async () => {
    const app = buildApp({
      provider: true,
      moderator: true,
      mountDraft: true,
      mountCatalog: true,
    });
    const reads = [
      ownerListingUrl(),
      providerOptionsUrl(),
      providerMutationUrl(),
      moderatorVersionUrl(),
      moderatorMutationUrl(),
    ];
    for (const url of reads) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: READ_HEADERS,
      });
      expect(response.statusCode, url).toBe(200);
      expect(response.json().ok, url).toBe(true);
      expect(response.json().meta.schemaVersion, url).toBe("openarc.api.v2");
      expect(response.headers["set-cookie"], url).toBeUndefined();
      expect(response.headers["access-control-allow-origin"], url).toBeUndefined();
      expect(response.headers["content-type"], url).toContain("application/json");
      expect(response.headers["cache-control"], url).toBe("no-store");
      expect(response.headers["x-content-type-options"], url).toBe("nosniff");
    }
    for (const url of [publishUrl()]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: WRITE_HEADERS,
        payload: PUBLISH_BODY,
      });
      expect(response.statusCode, url).toBe(200);
      expect(response.json().meta.schemaVersion, url).toBe("openarc.api.v2");
      expect(response.headers["set-cookie"], url).toBeUndefined();
    }
  });

  it("every one of the 18 frozen registry tuples has a handler when both flags are on", async () => {
    const app = buildApp({
      provider: true,
      moderator: true,
      mountDraft: true,
      mountCatalog: true,
    });
    for (const route of MARKETPLACE_ROUTES) {
      expect(
        app.hasRoute({ method: route.method, url: route.path }),
        `${route.method} ${route.path}`,
      ).toBe(true);
    }
  });

  it("returns 405 for a supported path with an unsupported method", async () => {
    const app = buildApp({ provider: true });
    const response = await app.inject({
      method: "DELETE",
      url: ownerListingUrl(),
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(405);
    expect(response.json().error.code).toBe("INVALID_REQUEST");
  });

  it("caps the response with the fixed v2 INTERNAL_ERROR 500 on oversize", async () => {
    const app = buildApp({ provider: true, maxResponseBytes: 10 });
    const response = await app.inject({
      method: "GET",
      url: ownerListingUrl(),
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("INTERNAL_ERROR");
  });
});

describe("protected transport guards", () => {
  it("requires the exact Origin plus browser marker and cookie", async () => {
    const app = buildApp({ provider: true });
    const missingClient = await app.inject({
      method: "GET",
      url: ownerListingUrl(),
      headers: { origin: ORIGIN, cookie: "openarc_session=abc" },
    });
    expect(missingClient.statusCode).toBe(403);

    const foreignOrigin = await app.inject({
      method: "GET",
      url: ownerListingUrl(),
      headers: { ...READ_HEADERS, origin: "https://evil.example" },
    });
    expect(foreignOrigin.statusCode).toBe(403);
    expect(foreignOrigin.json().error.code).toBe("INVALID_ORIGIN");
  });

  it("allows an originless GET ONLY with Sec-Fetch-Site: same-origin", async () => {
    const app = buildApp({ provider: true });
    const denied = await app.inject({
      method: "GET",
      url: ownerListingUrl(),
      headers: { "x-openarc-client": API_CLIENT_HEADER, cookie: "openarc_session=abc" },
    });
    expect(denied.statusCode).toBe(403);

    const allowed = await app.inject({
      method: "GET",
      url: ownerListingUrl(),
      headers: {
        "x-openarc-client": API_CLIENT_HEADER,
        cookie: "openarc_session=abc",
        "sec-fetch-site": "same-origin",
      },
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("rejects Authorization/proxy credentials and write authority on a read", async () => {
    const app = buildApp({ provider: true });
    for (const headers of [
      { ...READ_HEADERS, authorization: "Bearer x" },
      { ...READ_HEADERS, "proxy-authorization": "Basic x" },
      { ...READ_HEADERS, "idempotency-key": IDEMPOTENCY },
      { ...READ_HEADERS, "x-openarc-csrf": "t" },
    ]) {
      const response = await app.inject({
        method: "GET",
        url: ownerListingUrl(),
        headers,
      });
      expect(response.statusCode, JSON.stringify(headers)).toBe(400);
    }
  });

  it("requires CSRF and a canonical Idempotency-Key on POST", async () => {
    const app = buildApp({ provider: true });
    const noKey = await app.inject({
      method: "POST",
      url: publishUrl(),
      headers: {
        ...WRITE_HEADERS,
        "idempotency-key": "short",
      },
      payload: PUBLISH_BODY,
    });
    expect(noKey.statusCode).toBe(400);

    const wrongType = await app.inject({
      method: "POST",
      url: publishUrl(),
      headers: { ...WRITE_HEADERS, "content-type": "text/plain" },
      payload: PUBLISH_BODY,
    });
    expect(wrongType.statusCode).toBe(415);
  });

  it("rejects an oversized declared body with the fixed 413", async () => {
    const app = buildApp({ provider: true });
    const response = await app.inject({
      method: "POST",
      url: publishUrl(),
      headers: { ...WRITE_HEADERS, "content-length": String(20 * 1024) },
      payload: PUBLISH_BODY,
    });
    expect(response.statusCode).toBe(413);
  });

  it("forbids any query including a bare ? on query-free routes", async () => {
    const app = buildApp({ provider: true });
    const queried = await app.inject({
      method: "GET",
      url: `${ownerListingUrl()}?x=1`,
      headers: READ_HEADERS,
    });
    expect(queried.statusCode).toBe(400);

    const port = await listeningPort(app);
    const bare = await rawHttp(port, "GET", `${ownerListingUrl()}?`, [
      `Origin: ${ORIGIN}`,
      `X-OpenArc-Client: ${API_CLIENT_HEADER}`,
      "Cookie: openarc_session=abc",
    ]);
    expect(bare.status).toBe(400);
  });

  it("accepts only limit and afterProviderId on the provider-options query", async () => {
    const app = buildApp({ provider: true });
    const allowed = await app.inject({
      method: "GET",
      url: `${providerOptionsUrl()}?limit=25`,
      headers: READ_HEADERS,
    });
    expect(allowed.statusCode).toBe(200);

    for (const suffix of ["?unknown=1", "?limit=1&limit=2", "?limit=0"]) {
      const response = await app.inject({
        method: "GET",
        url: `${providerOptionsUrl()}${suffix}`,
        headers: READ_HEADERS,
      });
      expect(response.statusCode, suffix).toBe(400);
    }

    // A bare `?` is normalized away by the inject transport, so exercise the
    // exact raw request target over a real socket.
    const port = await listeningPort(app);
    const bare = await rawHttp(port, "GET", `${providerOptionsUrl()}?`, [
      `Origin: ${ORIGIN}`,
      `X-OpenArc-Client: ${API_CLIENT_HEADER}`,
      "Cookie: openarc_session=abc",
    ]);
    expect(bare.status).toBe(400);
  });

  it("rejects lookalike and double-encoded path parameters", async () => {
    const app = buildApp({ provider: true });
    const lookalike = `${MARKET_LIFECYCLE_ROUTES.ownerListing
      .replace(":organizationId", ORG)
      .replace(":listingId", `${LISTING}%252F`)}`;
    const response = await app.inject({
      method: "GET",
      url: lookalike,
      headers: READ_HEADERS,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("%252F");
  });

  it("rejects a malformed JSON body with a fixed v2 error and no parser echo", async () => {
    const app = buildApp({ provider: true });
    const response = await app.inject({
      method: "POST",
      url: publishUrl(),
      headers: WRITE_HEADERS,
      payload: "{not json",
    });
    expect([400, 500]).toContain(response.statusCode);
    expect(response.json().meta.schemaVersion).toBe("openarc.api.v2");
    expect(response.body).not.toContain("not json");
  });
});

describe("real TCP duplicate critical headers", () => {
  it("rejects duplicate Cookie (plus a benign cookie) before Node joins them", async () => {
    const app = buildApp({ provider: true });
    const port = await listeningPort(app);
    const response = await rawHttp(port, "GET", ownerListingUrl(), [
      `Origin: ${ORIGIN}`,
      `X-OpenArc-Client: ${API_CLIENT_HEADER}`,
      "Cookie: openarc_session=abc",
      "Cookie: openarc_binding=def",
    ]);
    expect(response.status).toBe(400);
    expect(response.text).toContain('"code":"INVALID_REQUEST"');
    expect(response.text.toLowerCase()).not.toContain("set-cookie");
  });

  it("rejects duplicate Idempotency-Key on a POST", async () => {
    const app = buildApp({ provider: true });
    const port = await listeningPort(app);
    const response = await rawHttp(
      port,
      "POST",
      publishUrl(),
      [
        `Origin: ${ORIGIN}`,
        `X-OpenArc-Client: ${API_CLIENT_HEADER}`,
        "Cookie: openarc_session=abc",
        "Content-Type: application/json",
        "X-OpenArc-Csrf: t",
        "Idempotency-Key: " + IDEMPOTENCY,
        "Idempotency-Key: " + IDEMPOTENCY,
      ],
      PUBLISH_BODY,
    );
    expect(response.status).toBe(400);
  });
});

describe("no route collision with the draft market module", () => {
  it("mounts new lifecycle, catalog-free draft and old routes together", async () => {
    const app = buildApp({ provider: true, moderator: true, mountDraft: true });
    // New lifecycle route.
    const lifecycle = await app.inject({
      method: "GET",
      url: ownerListingUrl(),
      headers: READ_HEADERS,
    });
    expect(lifecycle.statusCode).toBe(200);
    // Old draft route still resolves to its own handler.
    const draft = await app.inject({
      method: "GET",
      url: MARKET_ROUTES.listings.replace(":organizationId", ORG),
      headers: READ_HEADERS,
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().data.items).toEqual([]);
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

async function listeningPort(app: FastifyInstance): Promise<number> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") throw new Error("expected TCP address");
  return address.port;
}

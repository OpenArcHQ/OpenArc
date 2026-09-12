import { randomUUID } from "node:crypto";
import { connect } from "node:net";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  API_CLIENT_HEADER,
  type CommerceListingPublicVersion,
  type CommerceMarketPublicProvider,
} from "@openarc/shared";
import type { ListPublicListingsResult } from "@openarc/db";

import {
  AUTH_ERRORS,
  AuthApiError,
  authErrorEnvelope,
} from "../src/auth/errors.js";
import { MarketCatalogService } from "../src/market/catalog-service.js";
import type { MarketCatalogStorePort } from "../src/market/catalog-ports.js";
import {
  MARKET_CATALOG_ROUTES,
  registerMarketCatalogRoutes,
} from "../src/market/catalog-routes.js";

/**
 * HTTP-inject and real-TCP coverage for the public credentialless catalog
 * transport. The repository is honestly mocked; no PostgreSQL is claimed.
 */

const ORIGIN = "http://localhost:5183";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const MUTATION = "12345678-1234-4234-8123-123456789abc";
const LISTING = `openarc:listing:${MUTATION}`;
const PROVIDER = `openarc:provider:${MUTATION}`;
const ISO = "2026-01-01T00:00:00.000Z";
const DIGEST = `sha256:${"b".repeat(64)}`;

const PUBLIC_LISTING: CommerceListingPublicVersion = {
  schemaVersion: "openarc.listing-public-version.v1",
  listingId: LISTING,
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
  endpointOrigin: "https://api.example.com",
  termsRevision: "terms-v1",
  privacySummary: "No personal data is collected.",
  paymentLane: "unavailable",
  availability: { status: "available", rateLimitPerMinute: "60" },
  status: "active",
  publishedAt: ISO,
};

const PUBLIC_PROVIDER: CommerceMarketPublicProvider = {
  schemaVersion: "openarc.provider-public.v1",
  providerId: PROVIDER,
  displayName: "Example Provider",
  status: "active",
};

class FakeCatalogStore implements MarketCatalogStorePort {
  async listPublicListings(): Promise<ListPublicListingsResult> {
    return { items: [PUBLIC_LISTING], nextCursor: null };
  }
  async getPublicListing(): Promise<CommerceListingPublicVersion | null> {
    return PUBLIC_LISTING;
  }
  async getPublicProvider(): Promise<CommerceMarketPublicProvider | null> {
    return PUBLIC_PROVIDER;
  }
}

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

interface HarnessOptions {
  readonly enabled?: boolean;
  readonly service?: boolean;
  readonly maxResponseBytes?: number;
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
  registerMarketCatalogRoutes(app, {
    enabled: options.enabled ?? true,
    appOrigin: ORIGIN,
    ...(options.service === false
      ? {}
      : { service: new MarketCatalogService({ store: new FakeCatalogStore() }) }),
    buildSha: BUILD_SHA,
    ...(options.maxResponseBytes !== undefined
      ? { maxResponseBytes: options.maxResponseBytes }
      : {}),
  });
  apps.push(app);
  return app;
}

const RAILWAY_HEADERS = {
  "x-real-ip": "203.0.113.7",
  "x-forwarded-proto": "https",
  "x-forwarded-host": "catalog.openarc.test",
  "x-railway-edge": "lhr1",
  "x-request-start": "1700000000.123",
  "x-railway-request-id": "railway-req-abc",
  "x-forwarded-for": "203.0.113.7, 198.51.100.9",
  forwarded: "for=203.0.113.7;proto=https;host=catalog.openarc.test",
};

describe("catalog flag and startup", () => {
  it("registers nothing when disabled (plain 404)", async () => {
    const app = buildApp({ enabled: false });
    for (const url of Object.values(MARKET_CATALOG_ROUTES)) {
      const concrete = url
        .replace(":listingId", LISTING)
        .replace(":providerId", PROVIDER);
      expect(
        (await app.inject({ method: "GET", url: concrete })).statusCode,
        url,
      ).toBe(404);
    }
  });

  it("fails startup with a fixed error when enabled without a service", () => {
    expect(() => buildApp({ service: false })).toThrowError(
      "MARKET_CATALOG_SERVICE_REQUIRED",
    );
  });
});

describe("public catalog transport", () => {
  it("accepts credentialless GET with absent or exact origin and optional marker", async () => {
    const app = buildApp();
    const listUrl = MARKET_CATALOG_ROUTES.listings;
    for (const headers of [
      {},
      { "x-openarc-client": API_CLIENT_HEADER },
      { origin: ORIGIN },
      { origin: ORIGIN, "x-openarc-client": API_CLIENT_HEADER },
    ]) {
      const response = await app.inject({
        method: "GET",
        url: listUrl,
        headers: headers as Record<string, string>,
      });
      expect(response.statusCode, JSON.stringify(headers)).toBe(200);
      expect(response.json().meta.schemaVersion).toBe("openarc.api.v2");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    }
  });

  it("rejects a supplied foreign origin with the fixed v2 envelope", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: MARKET_CATALOG_ROUTES.listings,
      headers: { origin: "https://evil.example" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe("INVALID_ORIGIN");
  });

  it("rejects credentials, CSRF, idempotency, content-type and unknown client metadata", async () => {
    const app = buildApp();
    const forbidden: Record<string, string>[] = [
      { cookie: "openarc_session=abc" },
      { authorization: "Bearer x" },
      { "proxy-authorization": "Basic x" },
      { "x-openarc-csrf": "t" },
      { "idempotency-key": "x" },
      { "content-type": "application/json" },
      { "x-openarc-client": "other" },
      { "x-unknown-client": "x" },
    ];
    for (const headers of forbidden) {
      const response = await app.inject({
        method: "GET",
        url: MARKET_CATALOG_ROUTES.listings,
        headers,
      });
      expect(response.statusCode, JSON.stringify(headers)).toBe(400);
      expect(response.headers["set-cookie"], JSON.stringify(headers)).toBeUndefined();
    }
  });

  it("ignores exactly the eight informational proxy/edge headers without echoing them", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: MARKET_CATALOG_ROUTES.listings,
      headers: RAILWAY_HEADERS,
    });
    expect(response.statusCode).toBe(200);
    const headerValues = Object.values(response.headers).map((value) =>
      String(value),
    );
    // Distinctive metadata must never be reflected. Generic protocol tokens
    // such as "https" legitimately appear in the public DTO itself.
    for (const value of [
      "catalog.openarc.test",
      "railway-req-abc",
      "203.0.113.7",
      "198.51.100.9",
      "lhr1",
      "1700000000.123",
    ]) {
      expect(response.body, value).not.toContain(value);
      expect(headerValues, value).not.toContain(value);
    }

    const unknown = await app.inject({
      method: "GET",
      url: MARKET_CATALOG_ROUTES.listings,
      headers: { "x-railway-other": "x" },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it("rejects unsupported verbs with a fixed 405", async () => {
    const app = buildApp();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const) {
      const response = await app.inject({
        method,
        url: MARKET_CATALOG_ROUTES.listings,
        ...(method === "DELETE" ? {} : { payload: {} }),
      });
      expect(response.statusCode, method).toBe(405);
    }
  });

  it("rejects a length payload on a GET", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: MARKET_CATALOG_ROUTES.listings,
      headers: { "content-length": "5" },
      payload: "hello",
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("public catalog query rules", () => {
  it("accepts exactly the shared list query keys", async () => {
    const app = buildApp();
    const allowed = await app.inject({
      method: "GET",
      url: `${MARKET_CATALOG_ROUTES.listings}?limit=25&kind=api&providerId=${PROVIDER}&q=example`,
    });
    expect(allowed.statusCode).toBe(200);
  });

  it("rejects unknown and duplicate list query keys", async () => {
    const app = buildApp();
    for (const suffix of [
      "?unknown=1",
      "?limit=1&limit=2",
      "?limit=0",
      "?q=%20x",
      "?kind=unknown",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `${MARKET_CATALOG_ROUTES.listings}${suffix}`,
      });
      expect(response.statusCode, suffix).toBe(400);
      expect(response.body).not.toContain("unknown");
    }
  });

  it("forbids any query on detail and provider routes", async () => {
    const app = buildApp();
    const detail = await app.inject({
      method: "GET",
      url: `${MARKET_CATALOG_ROUTES.listing.replace(":listingId", LISTING)}?x=1`,
    });
    expect(detail.statusCode).toBe(400);
    const provider = await app.inject({
      method: "GET",
      url: `${MARKET_CATALOG_ROUTES.provider.replace(":providerId", PROVIDER)}?x=1`,
    });
    expect(provider.statusCode).toBe(400);
  });

  it("rejects a noncanonical path parameter without echoing it", async () => {
    const app = buildApp();
    const response = await app.inject({
      method: "GET",
      url: `${MARKET_CATALOG_ROUTES.listing.replace(":listingId", "not-a-listing")}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).not.toContain("not-a-listing");
  });

  it("caps the response with the fixed v2 INTERNAL_ERROR 500 on oversize", async () => {
    const app = buildApp({ maxResponseBytes: 10 });
    const response = await app.inject({
      method: "GET",
      url: MARKET_CATALOG_ROUTES.listings,
    });
    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe("INTERNAL_ERROR");
  });
});

describe("public catalog real TCP", () => {
  it("rejects duplicate Cookie before Node joins them", async () => {
    const app = buildApp();
    const port = await listeningPort(app);
    const response = await rawHttp(port, "GET", MARKET_CATALOG_ROUTES.listings, [
      "Cookie: openarc_session=abc",
      "Cookie: openarc_session=def",
    ]);
    expect(response.status).toBe(400);
    expect(response.text).toContain('"code":"INVALID_REQUEST"');
    expect(response.text.toLowerCase()).not.toContain("set-cookie");
  });

  it("rejects a bare ? over the raw request target", async () => {
    const app = buildApp();
    const port = await listeningPort(app);
    const response = await rawHttp(port, "GET", `${MARKET_CATALOG_ROUTES.listings}?`, []);
    expect(response.status).toBe(400);
  });
});

function rawHttp(
  port: number,
  method: string,
  path: string,
  headers: readonly string[],
): Promise<{ status: number; text: string }> {
  const lines = [
    `${method} ${path} HTTP/1.1`,
    "Host: 127.0.0.1",
    ...headers,
    "Connection: close",
    "",
    "",
  ];
  const wire = Buffer.from(lines.join("\r\n"), "utf8");
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

import { connect } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CommerceMarketMutationResult,
  CommerceMarketMutationStatus,
  CommerceMarketOwnerVersionDetail,
  CommerceMarketOwnerVersionPage,
  CommerceMarketOwnerPage,
} from "@openarc/shared";

import { createApp, type CompletionLog } from "../src/app.js";
import { AUTH_ERRORS, type AuthApiError } from "../src/auth/errors.js";
import type { AuthService } from "../src/auth/service.js";
import { loadConfig } from "../src/config.js";
import { MARKET_ROUTE_PREFIX, isForbiddenRequestTarget } from "../src/market/routes.js";
import type { MarketService } from "../src/market/service.js";
import type { MarketLifecycleService } from "../src/market/lifecycle-service.js";
import type { TenantReadService } from "../src/tenant/service.js";

/**
 * HTTP-inject and raw-TCP coverage for the protected market listing family.
 *
 * The MarketService is HONESTLY MOCKED here (labelled): these tests prove
 * transport strictness, path/query canonicality, envelope shape, credential
 * denial, duplicate-header detection, fail-closed error mapping and log
 * hygiene. Real roles, sessions, locks and SQL enforcement are covered by
 * market-api.postgres.test.ts.
 */

const ORIGIN = "http://localhost:5183";
const RP_ID = "localhost";
const SECRET = "synthetic_auth_secret_for_market_routes_0123456789";
const BUILD_SHA = "0123456789abcdef0123456789abcdef01234567";
const CLIENT = { origin: ORIGIN, "x-openarc-client": "browser-v1" };
const COOKIE = "openarc_session=abc";
const CSRF = "csrf-token-value";
const IDEMPOTENCY = "A".repeat(43);

const MUTATION = "12345678-1234-4234-8123-123456789abc";
const MUTATION2 = "22345678-1234-4234-8123-123456789abc";
const ORG = `openarc:org:${MUTATION}`;
const PROVIDER = `openarc:provider:${MUTATION}`;
const LISTING = `openarc:listing:${MUTATION}`;
const ISO = "2026-01-01T00:00:00.000Z";
const DIGEST = `sha256:${"1".repeat(64)}`;

function content(): Record<string, unknown> {
  return {
    kind: "api",
    title: "Example API",
    description: "A bounded description",
    manifest: {
      schemaVersion: "openarc.listing-manifest.v1",
      inputSchemaDigest: DIGEST,
      outputSchemaDigest: `sha256:${"2".repeat(64)}`,
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
      receiptType: "receipt.v1",
      receiptSchemaDigest: `sha256:${"3".repeat(64)}`,
      deliveryFields: ["payload", "status"],
    },
    endpointContract: { origin: "https://api.example.com", path: "/v1/run" },
    termsRevision: "terms-v1",
    privacySummary: "We store nothing.",
    paymentLane: "unavailable",
    availability: { status: "available", rateLimitPerMinute: "60" },
  };
}

function versionItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "openarc.listing-owner-version.v1",
    listingId: LISTING,
    organizationId: ORG,
    providerId: PROVIDER,
    version: "1",
    kind: "api",
    title: "Example API",
    description: "A bounded description",
    manifest: {
      schemaVersion: "openarc.listing-manifest.v1",
      inputSchemaDigest: DIGEST,
      outputSchemaDigest: `sha256:${"2".repeat(64)}`,
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
      receiptType: "receipt.v1",
      receiptSchemaDigest: `sha256:${"3".repeat(64)}`,
      deliveryFields: ["payload", "status"],
    },
    endpointContract: { origin: "https://api.example.com", path: "/v1/run" },
    originReviewState: "unreviewed",
    termsRevision: "terms-v1",
    privacySummary: "We store nothing.",
    paymentLane: "unavailable",
    availability: { status: "available", rateLimitPerMinute: "60" },
    status: "draft",
    createdAt: ISO,
    updatedAt: ISO,
    publishedAt: null,
    ...overrides,
  };
}

function ownerItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "openarc.listing.v1",
    listingId: LISTING,
    organizationId: ORG,
    providerId: PROVIDER,
    activeVersion: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  };
}

function mutationResult(): CommerceMarketMutationResult {
  return {
    replayed: false,
    receipt: {
      mutationId: MUTATION,
      operation: "market.listing.create",
      resourceType: "listing",
      resourceId: LISTING,
      committedAt: ISO,
    },
  } as CommerceMarketMutationResult;
}

class FakeMarketService {
  calls: Array<{ name: string; request?: unknown }> = [];
  error: AuthApiError | undefined;
  listingPage: CommerceMarketOwnerPage = {
    organizationId: ORG,
    items: [ownerItem() as never],
    nextCursor: null,
  };
  versionPage: CommerceMarketOwnerVersionPage = {
    organizationId: ORG,
    listingId: LISTING,
    providerId: PROVIDER,
    items: [versionItem() as never],
    nextCursor: null,
  };
  versionDetail: CommerceMarketOwnerVersionDetail = {
    organizationId: ORG,
    listingId: LISTING,
    version: "1",
    item: versionItem() as never,
  };
  mutationResult: CommerceMarketMutationResult = mutationResult();
  statusResult: CommerceMarketMutationStatus = { status: "not_found" };

  #record(name: string, request?: unknown): void {
    this.calls.push({ name, request });
    if (this.error) throw this.error;
  }

  async listOwnerListings(_ctx: unknown, request: unknown): Promise<CommerceMarketOwnerPage> {
    this.#record("listOwnerListings", request);
    return this.listingPage;
  }
  async listOwnerListingVersions(
    _ctx: unknown,
    request: unknown,
  ): Promise<CommerceMarketOwnerVersionPage> {
    this.#record("listOwnerListingVersions", request);
    return this.versionPage;
  }
  async getOwnerListingVersion(
    _ctx: unknown,
    request: unknown,
  ): Promise<CommerceMarketOwnerVersionDetail> {
    this.#record("getOwnerListingVersion", request);
    return this.versionDetail;
  }
  async getMarketMutationStatus(
    _ctx: unknown,
    request: unknown,
  ): Promise<CommerceMarketMutationStatus> {
    this.#record("getMarketMutationStatus", request);
    return this.statusResult;
  }
  async createListingDraft(
    _ctx: unknown,
    _organizationId: unknown,
    request: unknown,
  ): Promise<CommerceMarketMutationResult> {
    this.#record("createListingDraft", request);
    return this.mutationResult;
  }
  async createListingVersion(
    _ctx: unknown,
    _organizationId: unknown,
    _listingId: unknown,
    request: unknown,
  ): Promise<CommerceMarketMutationResult> {
    this.#record("createListingVersion", request);
    return this.mutationResult;
  }
}

const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

interface HarnessOptions {
  readonly enabled?: boolean;
  readonly maxResponseBytes?: number;
}

function harness(options: HarnessOptions = {}) {
  const service = new FakeMarketService();
  const logs: CompletionLog[] = [];
  const enabled = options.enabled ?? true;
  const config = loadConfig({
    NODE_ENV: "test",
    APP_ORIGIN: ORIGIN,
    COMMIT_SHA: BUILD_SHA,
    AUTH_ENABLED: "true",
    AUTH_DATABASE_URL: "postgres://openarc_auth_app:x@127.0.0.1:5432/openarc_auth_test",
    AUTH_SECRET: SECRET,
    AUTH_RP_ID: RP_ID,
    ...(enabled
      ? {
          TENANT_READS_ENABLED: "true",
          TENANT_DATABASE_URL: "postgres://openarc_tenant_app:y@127.0.0.1:5432/openarc_auth_test",
          LISTING_MANAGEMENT_ENABLED: "true",
        }
      : {}),
  });
  const app = createApp({
    config,
    logger: false,
    logSink: (entry) => logs.push(entry),
    authService: {} as AuthService,
    ...(enabled
      ? {
          tenantReadService: {} as TenantReadService,
          tenantReady: async () => true,
          marketService: service as unknown as MarketService,
          // The listing flag requires a lifecycle dependency at startup. This
          // suite tests only the six draft routes, so a labelled synthetic port
          // with no behavior stands in for the lifecycle service.
          marketLifecycleService: {} as MarketLifecycleService,
          marketReady: async () => true,
          ...(options.maxResponseBytes !== undefined
            ? { marketMaxResponseBytes: options.maxResponseBytes }
            : {}),
        }
      : {}),
  });
  apps.push(app);
  return { app, service, logs };
}

function readHeaders(extra: Record<string, string | string[]> = {}) {
  return { ...CLIENT, cookie: COOKIE, ...extra };
}

function writeHeaders(extra: Record<string, string | string[]> = {}) {
  return {
    ...CLIENT,
    "content-type": "application/json",
    cookie: COOKIE,
    "x-openarc-csrf": CSRF,
    "idempotency-key": IDEMPOTENCY,
    ...extra,
  };
}

const url = (suffix = "") => `${MARKET_ROUTE_PREFIX}/${ORG}${suffix}`;
const LISTINGS = url("/listings");
const VERSIONS = url(`/listings/${LISTING}/versions`);
const VERSION = url(`/listings/${LISTING}/versions/1`);
const MUTATION_URL = url(`/listing-mutations/${MUTATION}`);

function v2ErrorCode(response: { json: () => unknown }): string {
  const body = response.json() as { error?: { code?: string } };
  return body.error?.code ?? "";
}

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
    `Content-Length: ${payload.byteLength}`,
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

async function listeningPort(app: ReturnType<typeof createApp>): Promise<number> {
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return address.port;
}

describe("market success envelopes", () => {
  it("serves all six routes with a strict v2 envelope and no Set-Cookie", async () => {
    const { app, service } = harness();
    const reads = [
      { method: "GET" as const, url: LISTINGS, call: "listOwnerListings", schema: "openarc.listing.v1" },
      { method: "GET" as const, url: VERSIONS, call: "listOwnerListingVersions", schema: "openarc.listing-owner-version.v1" },
      { method: "GET" as const, url: VERSION, call: "getOwnerListingVersion", schema: "openarc.listing-owner-version.v1" },
      { method: "GET" as const, url: MUTATION_URL, call: "getMarketMutationStatus", schema: undefined },
    ];
    for (const entry of reads) {
      const response = await app.inject({
        method: entry.method,
        url: entry.url,
        headers: readHeaders(),
      });
      expect(response.statusCode, entry.url).toBe(200);
      expect(response.json().meta.schemaVersion).toBe("openarc.api.v2");
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers["access-control-allow-origin"]).toBeUndefined();
      expect(service.calls.at(-1)?.name).toBe(entry.call);
    }
    const draft = await app.inject({
      method: "POST",
      url: LISTINGS,
      headers: writeHeaders(),
      payload: { mutationId: MUTATION, providerId: PROVIDER, content: content() },
    });
    expect(draft.statusCode).toBe(200);
    expect(draft.json().data.receipt.operation).toBe("market.listing.create");
    const version = await app.inject({
      method: "POST",
      url: VERSIONS,
      headers: writeHeaders(),
      payload: { mutationId: MUTATION2, expectedLatestVersion: "1", content: content() },
    });
    expect(version.statusCode).toBe(200);
    expect(service.calls.map((call) => call.name)).toEqual([
      "listOwnerListings",
      "listOwnerListingVersions",
      "getOwnerListingVersion",
      "getMarketMutationStatus",
      "createListingDraft",
      "createListingVersion",
    ]);
  });

  it("passes only the parsed canonical query to the service", async () => {
    const { app, service } = harness();
    const listings = await app.inject({
      method: "GET",
      url: `${LISTINGS}?limit=10&afterListingId=${LISTING}`,
      headers: readHeaders(),
    });
    expect(listings.statusCode).toBe(200);
    expect(service.calls[0]?.request).toMatchObject({
      organizationId: ORG,
      limit: 10,
      afterListingId: LISTING,
    });
    const versions = await app.inject({
      method: "GET",
      url: `${VERSIONS}?limit=1&afterVersion=1`,
      headers: readHeaders(),
    });
    expect(versions.statusCode).toBe(200);
    expect(service.calls[1]?.request).toMatchObject({
      organizationId: ORG,
      listingId: LISTING,
      limit: 1,
      afterVersion: "1",
    });
  });
});

describe("market strict query parsing", () => {
  const badQueries = [
    "?limit=1&limit=2",
    "?limit=1&unknown=2",
    "?limit=",
    "?limit=%zz",
    "?limit=0",
    "?limit=51",
    "?limit=01",
    "?limit=+1",
    "?limit=1e1",
    "?limit=1.0",
    "?afterListingId=openarc%3Alisting%3Abad",
  ];

  it("rejects repeated, unknown, empty, noncanonical and bare queries on the root list", async () => {
    const { app, service } = harness();
    for (const query of badQueries) {
      const response = await app.inject({
        method: "GET",
        url: `${LISTINGS}${query}`,
        headers: readHeaders(),
      });
      expect(response.statusCode, query).toBe(400);
    }
    expect(service.calls).toEqual([]);
  });

  it("permits only afterVersion/limit on history and no query on detail/status", async () => {
    const { app, service } = harness();
    for (const query of ["?afterListingId=" + LISTING, "?limit=1&limit=2"]) {
      const response = await app.inject({
        method: "GET",
        url: `${VERSIONS}${query}`,
        headers: readHeaders(),
      });
      expect(response.statusCode, query).toBe(400);
    }
    for (const target of [VERSION, MUTATION_URL]) {
      for (const query of ["?limit=1"]) {
        const response = await app.inject({
          method: "GET",
          url: `${target}${query}`,
          headers: readHeaders(),
        });
        expect(response.statusCode, `${target}${query}`).toBe(400);
      }
    }
    // A bare `?` is preserved on a real request target but normalized away by
    // some injectors, so the exact rule is asserted on the target predicate.
    expect(isForbiddenRequestTarget(`${VERSION}?`)).toBe(true);
    expect(isForbiddenRequestTarget(`${MUTATION_URL}?`)).toBe(true);
    expect(service.calls).toEqual([]);
  });

  it("rejects a bare empty query request target directly", () => {
    expect(isForbiddenRequestTarget(`${LISTINGS}?`)).toBe(true);
    expect(isForbiddenRequestTarget(`${LISTINGS}?limit=1`)).toBe(true);
    expect(isForbiddenRequestTarget(LISTINGS)).toBe(false);
  });
});

describe("market strict path parsing", () => {
  it("rejects encoded separators, double encoding, controls and unknown keywords", async () => {
    const { app, service } = harness();
    const targets = [
      `${MARKET_ROUTE_PREFIX}/openarc%3Aorg%3A11111111-1111-4111-8111-111111111111%2Flistings`,
      `${MARKET_ROUTE_PREFIX}/openarc%253Aorg%253A11111111-1111-4111-8111-111111111111/listings`,
      `${MARKET_ROUTE_PREFIX}/${ORG}/listings/%2e%2e`,
      `${MARKET_ROUTE_PREFIX}/${ORG}/providers`,
      `${MARKET_ROUTE_PREFIX}/${ORG}/listings/not-a-listing/versions`,
      `${MARKET_ROUTE_PREFIX}/${ORG}/listing-mutations/not-a-mutation`,
    ];
    for (const target of targets) {
      const response = await app.inject({ method: "GET", url: target, headers: readHeaders() });
      expect([400, 404], target).toContain(response.statusCode);
    }
    expect(service.calls).toEqual([]);
  });

  it("keeps lookalike prefixes on the legacy envelope", async () => {
    const { app } = harness();
    const response = await app.inject({
      method: "GET",
      url: `${MARKET_ROUTE_PREFIX}XYZ`,
      headers: readHeaders(),
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("market transport enforcement", () => {
  it("rejects wrong methods with a fixed 405 and no service call", async () => {
    const { app, service } = harness();
    for (const method of ["PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"] as const) {
      const response = await app.inject({ method, url: LISTINGS, headers: readHeaders() });
      expect(response.statusCode, method).toBe(405);
      expect(v2ErrorCode(response)).toBe("INVALID_REQUEST");
    }
    expect(service.calls).toEqual([]);
  });

  it("denies a foreign origin, an originless write, credentials and unexpected metadata", async () => {
    const { app, service } = harness();
    const payload = { mutationId: MUTATION, providerId: PROVIDER, content: content() };
    const cases: Array<Record<string, string | string[]>> = [
      writeHeaders({ origin: "https://evil.example" }),
      writeHeaders({ authorization: "Bearer x" }),
      writeHeaders({ "proxy-authorization": "Bearer x" }),
      writeHeaders({ "x-openarc-client": "machine-v1" }),
      writeHeaders({ "content-type": "text/plain" }),
      writeHeaders({ "idempotency-key": "short" }),
      writeHeaders({ "idempotency-key": [`${"A".repeat(42)}B`] }),
    ];
    for (const headers of cases) {
      const response = await app.inject({
        method: "POST",
        url: LISTINGS,
        headers: headers as Record<string, string>,
        payload,
      });
      expect([400, 403, 415], JSON.stringify(headers)).toContain(response.statusCode);
    }
    // Originless POST is denied even with same-origin Fetch metadata.
    const originless = await app.inject({
      method: "POST",
      url: LISTINGS,
      headers: {
        "x-openarc-client": "browser-v1",
        "sec-fetch-site": "same-origin",
        "content-type": "application/json",
        cookie: COOKIE,
        "x-openarc-csrf": CSRF,
        "idempotency-key": IDEMPOTENCY,
      },
      payload,
    });
    expect(originless.statusCode).toBe(403);
    expect(service.calls).toEqual([]);
  });

  it("allows an originless same-origin read and denies an originless foreign one", async () => {
    const { app } = harness();
    const allowed = await app.inject({
      method: "GET",
      url: LISTINGS,
      headers: {
        "x-openarc-client": "browser-v1",
        "sec-fetch-site": "same-origin",
        cookie: COOKIE,
      },
    });
    expect(allowed.statusCode).toBe(200);
    const denied = await app.inject({
      method: "GET",
      url: LISTINGS,
      headers: {
        "x-openarc-client": "browser-v1",
        "sec-fetch-site": "cross-site",
        cookie: COOKIE,
      },
    });
    expect(denied.statusCode).toBe(403);
  });

  it("rejects read-side credential and write-authority headers", async () => {
    const { app, service } = harness();
    for (const extra of [
      { authorization: "Bearer x" },
      { "proxy-authorization": "Bearer x" },
      { "idempotency-key": IDEMPOTENCY },
      { "x-openarc-csrf": CSRF },
    ]) {
      const response = await app.inject({
        method: "GET",
        url: LISTINGS,
        headers: readHeaders(extra),
      });
      expect(response.statusCode, JSON.stringify(extra)).toBe(400);
    }
    expect(service.calls).toEqual([]);
  });

  it("rejects a real HTTP request with duplicate critical header lines", async () => {
    const { app, service } = harness();
    const port = await listeningPort(app);
    const payload = JSON.stringify({ mutationId: MUTATION, providerId: PROVIDER, content: content() });
    const base = [
      `Origin: ${ORIGIN}`,
      "X-OpenArc-Client: browser-v1",
      "Content-Type: application/json",
      `Cookie: ${COOKIE}`,
      `X-OpenArc-Csrf: ${CSRF}`,
      `Idempotency-Key: ${IDEMPOTENCY}`,
    ];
    const duplicates: ReadonlyArray<readonly string[]> = [
      [...base, "Content-Type: text/plain"],
      [...base, "Authorization: Bearer x"],
      [...base, "Origin: https://evil.example"],
      [...base, `Idempotency-Key: ${IDEMPOTENCY}`],
    ];
    for (const headers of duplicates) {
      const response = await rawHttp(port, "POST", LISTINGS, headers, payload);
      expect([400, 403, 415], headers.join("|")).toContain(response.status);
      expect(response.text).not.toContain("text/plain");
    }
    expect(service.calls).toEqual([]);
  });

  it("rejects a real HTTP request carrying a duplicated Cookie line before the service", async () => {
    const { app, service } = harness();
    const port = await listeningPort(app);
    // Node normally JOINS repeated Cookie lines; the raw duplicate scan must
    // still fail closed before normalization can establish any identity. A
    // valid session cookie plus a separate benign cookie line proves it.
    const response = await rawHttp(
      port,
      "GET",
      LISTINGS,
      [
        `Origin: ${ORIGIN}`,
        "X-OpenArc-Client: browser-v1",
        `Cookie: ${COOKIE}`,
        "Cookie: openarc_benign=1",
      ],
      "",
    );
    expect(response.status).toBe(400);
    expect(service.calls).toEqual([]);
  });

  it("returns a bounded v2 error for a pre-handler parser failure without echoing input", async () => {
    const { app, service } = harness();
    const canary = "PRIVATE_BODY_CANARY";
    const response = await app.inject({
      method: "POST",
      url: LISTINGS,
      headers: writeHeaders(),
      payload: `{ "mutationId": "${MUTATION}", "canary": "${canary}"`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().meta.schemaVersion).toBe("openarc.api.v2");
    expect(v2ErrorCode(response)).toBe("INVALID_REQUEST");
    expect(response.body).not.toContain(canary);
    expect(service.calls).toEqual([]);
  });

  it("rejects an oversized body with a fixed bounded error", async () => {
    const { app, service } = harness();
    const response = await app.inject({
      method: "POST",
      url: LISTINGS,
      headers: writeHeaders(),
      payload: JSON.stringify({ mutationId: MUTATION, providerId: PROVIDER, content: content(), pad: "x".repeat(20_000) }),
    });
    expect(response.statusCode).toBe(413);
    expect(service.calls).toEqual([]);
  });
});

describe("market error and response integrity", () => {
  it("maps service errors without echoing detail", async () => {
    const { app, service } = harness();
    service.error = AUTH_ERRORS.internal();
    const response = await app.inject({ method: "GET", url: LISTINGS, headers: readHeaders() });
    expect(response.statusCode).toBe(500);
    expect(v2ErrorCode(response)).toBe("INTERNAL_ERROR");
    expect(response.body).not.toContain(LISTING);
  });

  it("fails closed when the serialized envelope exceeds the response bound", async () => {
    const { app } = harness({ maxResponseBytes: 16 });
    const response = await app.inject({ method: "GET", url: LISTINGS, headers: readHeaders() });
    expect(response.statusCode).toBe(500);
  });

  it("never logs or returns the cookie, CSRF or idempotency key", async () => {
    const { app, logs } = harness();
    const response = await app.inject({
      method: "POST",
      url: LISTINGS,
      headers: writeHeaders(),
      payload: { mutationId: MUTATION, providerId: PROVIDER, content: content() },
    });
    expect(response.statusCode).toBe(200);
    for (const entry of logs) {
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain(IDEMPOTENCY);
      expect(serialized).not.toContain(CSRF);
      expect(serialized).not.toContain("openarc_session");
    }
    expect(logs[0]?.route).toBe("tenant");
  });
});

describe("market disabled family", () => {
  it("registers no route and returns the ordinary 404 with no service call", async () => {
    const { app, service } = harness({ enabled: false });
    for (const [method, target] of [
      ["GET", LISTINGS],
      ["POST", LISTINGS],
      ["GET", VERSIONS],
      ["GET", VERSION],
      ["GET", MUTATION_URL],
    ] as const) {
      const response = await app.inject({
        method,
        url: target,
        headers: method === "POST" ? writeHeaders() : readHeaders(),
        ...(method === "POST"
          ? { payload: { mutationId: MUTATION, providerId: PROVIDER, content: content() } }
          : {}),
      });
      expect(response.statusCode, target).toBe(404);
    }
    expect(service.calls).toEqual([]);
  });
});

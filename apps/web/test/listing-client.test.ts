import {
  API_MAX_RESPONSE_BYTES,
  API_CLIENT_HEADER,
  COMMERCE_API_ERRORS,
  COMMERCE_API_SCHEMA_VERSION,
  MARKETPLACE_CAPABILITIES_PATH,
} from "@openarc/shared";
import { describe, expect, it, vi } from "vitest";

import {
  LISTING_MAX_BODY_BYTES,
  LISTING_REQUEST_TIMEOUT_MS,
  ListingApiError,
  ListingClient,
  readListingManagementCapability,
} from "../src/tenant/listing-client.js";

const META = {
  schemaVersion: COMMERCE_API_SCHEMA_VERSION,
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

const V4 = "12345678-1234-4234-8123-123456789abc";
const V4_B = "87654321-4321-4321-b123-abcdefabcdef";
const ORG = `openarc:org:${V4}`;
const ORG_B = `openarc:org:${V4_B}`;
const LISTING = `openarc:listing:${V4}`;
const PROVIDER = `openarc:provider:${V4}`;
const ISO = "2026-01-01T00:00:00.000Z";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const MUTATION = V4;
const IDEMPOTENCY = `${"A".repeat(42)}A`;

function success(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data, meta: META }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorEnvelope(code: keyof typeof COMMERCE_API_ERRORS, status: number): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code, message: COMMERCE_API_ERRORS[code].message, retryable: false },
      meta: META,
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function ownerVersion(version: string, listingId = LISTING, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: "openarc.listing-owner-version.v1",
    listingId,
    organizationId: ORG,
    providerId: PROVIDER,
    version,
    kind: "api",
    title: "Listing title",
    description: "Listing description",
    manifest: {
      schemaVersion: "openarc.listing-manifest.v1",
      inputSchemaDigest: DIGEST_A,
      outputSchemaDigest: DIGEST_B,
    },
    price: {
      amount: {
        schemaVersion: "openarc.usdc-amount.v1",
        networkId: "eip155:5042002",
        asset: "USDC",
        representation: "erc20",
        decimals: 6,
        atomicAmount: "1000000",
      },
      pricingModel: "fixed",
    },
    evidenceContract: {
      schemaVersion: "openarc.receipt-contract.v1",
      receiptType: "receipt",
      receiptSchemaDigest: DIGEST_B,
      deliveryFields: ["field"],
    },
    endpointContract: { origin: "https://api.example.com", path: "/deliver" },
    originReviewState: "unreviewed",
    termsRevision: "v1",
    privacySummary: "Privacy summary",
    paymentLane: "unavailable",
    availability: { status: "unavailable", rateLimitPerMinute: null },
    status: "draft",
    createdAt: ISO,
    updatedAt: ISO,
    publishedAt: null,
    ...overrides,
  };
}

function content() {
  return {
    kind: "api",
    title: "Listing title",
    description: "Listing description",
    manifest: {
      schemaVersion: "openarc.listing-manifest.v1",
      inputSchemaDigest: DIGEST_A,
      outputSchemaDigest: DIGEST_B,
    },
    price: {
      amount: {
        schemaVersion: "openarc.usdc-amount.v1",
        networkId: "eip155:5042002",
        asset: "USDC",
        representation: "erc20",
        decimals: 6,
        atomicAmount: "1000000",
      },
      pricingModel: "fixed",
    },
    evidenceContract: {
      schemaVersion: "openarc.receipt-contract.v1",
      receiptType: "receipt",
      receiptSchemaDigest: DIGEST_B,
      deliveryFields: ["field"],
    },
    endpointContract: { origin: "https://api.example.com", path: "/deliver" },
    termsRevision: "v1",
    privacySummary: "Privacy summary",
    paymentLane: "unavailable",
    availability: { status: "unavailable", rateLimitPerMinute: null },
  };
}

function receipt(operation: string, resourceId: string, mutationId = MUTATION) {
  const resourceType = operation === "market.listing.create" ? "listing" : "listing_version";
  return {
    mutationId,
    operation,
    resourceType,
    resourceId,
    committedAt: ISO,
  };
}

function mutationResult(operation: string, resourceId: string, mutationId = MUTATION) {
  return { replayed: false, receipt: receipt(operation, resourceId, mutationId) };
}

function clientWith(fetcher: typeof fetch) {
  return new ListingClient({ fetcher: fetcher as unknown as typeof fetch });
}

describe("listing client reads", () => {
  it("sends a relative same-origin GET with only the browser marker", async () => {
    const fetcher = vi.fn(async () =>
      success({ organizationId: ORG, items: [], nextCursor: null }),
    );
    const page = await clientWith(fetcher as unknown as typeof fetch).listRoots(
      { organizationId: ORG },
      new AbortController().signal,
    );
    expect(page).toEqual({ organizationId: ORG, items: [], nextCursor: null });
    expect(fetcher).toHaveBeenCalledWith(
      "/v2/provider/organizations/openarc%3Aorg%3A12345678-1234-4234-8123-123456789abc/listings?limit=25",
      {
        method: "GET",
        headers: { "X-OpenArc-Client": API_CLIENT_HEADER, Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: expect.any(AbortSignal),
      },
    );
  });

  it("rejects a mismatched page organization", async () => {
    const fetcher = vi.fn(async () =>
      success({ organizationId: ORG_B, items: [], nextCursor: null }),
    );
    await expect(
      clientWith(fetcher as unknown as typeof fetch).listRoots(
        { organizationId: ORG },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("encodes a canonical listing id exactly once and never a freeform path", async () => {
    const fetcher = vi.fn(async () =>
      success({ organizationId: ORG, listingId: LISTING, item: null }),
    );
    await clientWith(fetcher as unknown as typeof fetch).readRoot(
      { organizationId: ORG, listingId: LISTING },
      new AbortController().signal,
    );
    const [path] = (fetcher.mock.calls as unknown as Array<[string]>)[0]!;
    expect(path).toBe(
      `/v2/provider/organizations/${encodeURIComponent(ORG)}/listings/${encodeURIComponent(LISTING)}`,
    );
    await expect(
      clientWith(fetcher as unknown as typeof fetch).readRoot(
        { organizationId: ORG, listingId: "../evil" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failure: { kind: "pre-send" } });
  });

  it("lists versions with an ascending afterVersion cursor", async () => {
    const fetcher = vi.fn(async () =>
      success({ organizationId: ORG, listingId: LISTING, providerId: PROVIDER, items: [], nextCursor: null }),
    );
    await clientWith(fetcher as unknown as typeof fetch).listVersions(
      { organizationId: ORG, listingId: LISTING, afterVersion: "10", limit: 50 },
      new AbortController().signal,
    );
    const [path] = (fetcher.mock.calls as unknown as Array<[string]>)[0]!;
    expect(path).toBe(
      `/v2/provider/organizations/${encodeURIComponent(ORG)}/listings/${encodeURIComponent(LISTING)}/versions?afterVersion=10&limit=50`,
    );
  });

  it("reads a version detail and rejects a mismatched version binding", async () => {
    const ok = vi.fn(async () =>
      success({ organizationId: ORG, listingId: LISTING, version: "2", item: ownerVersion("2") }),
    );
    const detail = await clientWith(ok as unknown as typeof fetch).readVersion(
      { organizationId: ORG, listingId: LISTING, version: "2" },
      new AbortController().signal,
    );
    expect(detail.version).toBe("2");
    const bad = vi.fn(async () =>
      success({ organizationId: ORG, listingId: LISTING, version: "3", item: ownerVersion("3") }),
    );
    await expect(
      clientWith(bad as unknown as typeof fetch).readVersion(
        { organizationId: ORG, listingId: LISTING, version: "2" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("lists provider options with a bounded explicit cursor", async () => {
    const fetcher = vi.fn(async () => success({ organizationId: ORG, items: [], nextCursor: null }));
    await clientWith(fetcher as unknown as typeof fetch).listProviderOptions(
      { organizationId: ORG, afterProviderId: PROVIDER, limit: 25 },
      new AbortController().signal,
    );
    const [path] = (fetcher.mock.calls as unknown as Array<[string]>)[0]!;
    expect(path).toBe(
      `/v2/provider/organizations/${encodeURIComponent(ORG)}/listing-providers?afterProviderId=${encodeURIComponent(PROVIDER)}&limit=25`,
    );
  });

  it("maps 400/401/403/404/409/503 without reflecting server text", async () => {
    const cases: Array<[number, string]> = [
      [400, "validation"],
      [401, "unauthenticated"],
      [403, "forbidden"],
      [404, "not-found"],
      [409, "conflict"],
      [503, "unavailable"],
    ];
    for (const [status, kind] of cases) {
      const fetcher = vi.fn(async () => new Response("nope", { status }));
      await expect(
        clientWith(fetcher as unknown as typeof fetch).listRoots(
          { organizationId: ORG },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ failure: { kind } });
    }
  });

  it("maps a structured error code and never echoes the message", async () => {
    const fetcher = vi.fn(async () => errorEnvelope("FORBIDDEN", 403));
    const error = await clientWith(fetcher as unknown as typeof fetch)
      .listRoots({ organizationId: ORG }, new AbortController().signal)
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ListingApiError);
    expect((error as ListingApiError).message).toBe("forbidden");
    expect(JSON.stringify(error)).not.toContain(COMMERCE_API_ERRORS.FORBIDDEN.message);
  });

  it("aborts a read on an already-aborted signal without calling fetch", async () => {
    const fetcher = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(
      clientWith(fetcher as unknown as typeof fetch).listRoots(
        { organizationId: ORG },
        controller.signal,
      ),
    ).rejects.toMatchObject({ failure: { kind: "aborted" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports an unavailable read when the transport throws", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    });
    await expect(
      clientWith(fetcher as unknown as typeof fetch).listRoots(
        { organizationId: ORG },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failure: { kind: "unavailable" } });
  });

  it("rejects a malformed success envelope", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, data: { organizationId: ORG, items: [], nextCursor: null } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      clientWith(fetcher as unknown as typeof fetch).listRoots(
        { organizationId: ORG },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });
});

const SMALLER_LISTING = "openarc:listing:00000000-0000-4000-8000-000000000000";

function rootsPageOf(listingIds: readonly string[]) {
  return {
    organizationId: ORG,
    items: listingIds.map((listingId) => ({
      schemaVersion: "openarc.listing.v1",
      listingId,
      organizationId: ORG,
      providerId: PROVIDER,
      activeVersion: null,
      createdAt: ISO,
      updatedAt: ISO,
    })),
    nextCursor: null,
  };
}

describe("listing client input and page bindings", () => {
  it("rejects an invalid afterVersion before any fetch", async () => {
    const fetcher = vi.fn();
    await expect(
      clientWith(fetcher as unknown as typeof fetch).listVersions(
        { organizationId: ORG, listingId: LISTING, afterVersion: "01" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failure: { kind: "pre-send" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an invalid version path and mutation id before any fetch", async () => {
    const fetcher = vi.fn();
    await expect(
      clientWith(fetcher as unknown as typeof fetch).readVersion(
        { organizationId: ORG, listingId: LISTING, version: "1.0" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failure: { kind: "pre-send" } });
    await expect(
      clientWith(fetcher as unknown as typeof fetch).readDraftMutationStatus({
        organizationId: ORG,
        mutationId: "not-a-uuid",
        operation: "market.listing.create",
        resourceId: `openarc:listing:${MUTATION}`,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ failure: { kind: "pre-send" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an oversized page relative to the requested limit", async () => {
    const fetcher = vi.fn(async () =>
      success(rootsPageOf([SMALLER_LISTING, `openarc:listing:${MUTATION}`])),
    );
    await expect(
      clientWith(fetcher as unknown as typeof fetch).listRoots(
        { organizationId: ORG, limit: 1 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("rejects a continuation page whose first row is not past the requested cursor", async () => {
    const fetcher = vi.fn(async () => success(rootsPageOf([SMALLER_LISTING])));
    await expect(
      clientWith(fetcher as unknown as typeof fetch).listRoots(
        { organizationId: ORG, afterListingId: `openarc:listing:${MUTATION}` },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("accepts a strictly-after continuation page", async () => {
    const fetcher = vi.fn(async () => success(rootsPageOf([`openarc:listing:${MUTATION}`])));
    const page = await clientWith(fetcher as unknown as typeof fetch).listRoots(
      { organizationId: ORG, afterListingId: SMALLER_LISTING },
      new AbortController().signal,
    );
    expect(page.items).toHaveLength(1);
  });

  it("rejects a stale/smaller version cursor and an oversized provider page", async () => {
    const versions = vi.fn(async () =>
      success({ organizationId: ORG, listingId: LISTING, providerId: PROVIDER, items: [ownerVersion("1")], nextCursor: null }),
    );
    await expect(
      clientWith(versions as unknown as typeof fetch).listVersions(
        { organizationId: ORG, listingId: LISTING, afterVersion: "10" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });

    const providers = vi.fn(async () =>
      success({
        organizationId: ORG,
        items: [
          { providerId: PROVIDER, displayName: "A", status: "active" },
          { providerId: `openarc:provider:${V4_B}`, displayName: "B", status: "active" },
        ],
        nextCursor: null,
      }),
    );
    await expect(
      clientWith(providers as unknown as typeof fetch).listProviderOptions(
        { organizationId: ORG, limit: 1 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });
});

describe("listing client writes", () => {
  it.each([
    ["create", (client: ListingClient) => client.createDraft({
      organizationId: ORG,
      csrfToken: "csrf",
      idempotencyKey: IDEMPOTENCY,
      signal: new AbortController().signal,
      body: { mutationId: MUTATION, providerId: PROVIDER, content: content() },
    }), "market.listing.create", `openarc:listing:${MUTATION}`],
  ] as const)("sends a create draft with CSRF and idempotency headers", async (_label, run, operation, resourceId) => {
    const fetcher = vi.fn(async () =>
      success(mutationResult(operation, resourceId, MUTATION)),
    );
    const result = await run(clientWith(fetcher as unknown as typeof fetch));
    expect(result.receipt.operation).toBe(operation);
    const [, init] = (fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-OpenArc-CSRF"]).toBe("csrf");
    expect(headers["Idempotency-Key"]).toBe(IDEMPOTENCY);
    expect(headers["X-OpenArc-Client"]).toBe(API_CLIENT_HEADER);
    expect(init.credentials).toBe("same-origin");
    expect(init.redirect).toBe("error");
  });

  it("sends create version with expectedLatestVersion and binds resource version 2", async () => {
    const fetcher = vi.fn(async () =>
      success(mutationResult("market.listing.version.create", `${LISTING}@2`, MUTATION)),
    );
    const result = await clientWith(fetcher as unknown as typeof fetch).createVersion({
      organizationId: ORG,
      listingId: LISTING,
      csrfToken: "csrf",
      idempotencyKey: IDEMPOTENCY,
      signal: new AbortController().signal,
      body: { mutationId: MUTATION, expectedLatestVersion: "1", content: content() },
    });
    expect(result.receipt.resourceId).toBe(`${LISTING}@2`);
    const [path, init] = (fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
    expect(path).toBe(
      `/v2/provider/organizations/${encodeURIComponent(ORG)}/listings/${encodeURIComponent(LISTING)}/versions`,
    );
    const body = JSON.parse(String(init.body)) as { expectedLatestVersion: string };
    expect(body.expectedLatestVersion).toBe("1");
  });

  it.each([
    ["publish", "market.listing.version.publish"],
    ["pause", "market.listing.version.pause"],
    ["retire", "market.listing.version.retire"],
  ] as const)("sends a %s lifecycle body with expected CAS", async (op, operation) => {
    const fetcher = vi.fn(async () =>
      success(mutationResult(operation, `${LISTING}@1`, MUTATION)),
    );
    const client = clientWith(fetcher as unknown as typeof fetch);
    const result = await client[op]({
      organizationId: ORG,
      listingId: LISTING,
      version: "1",
      csrfToken: "csrf",
      idempotencyKey: IDEMPOTENCY,
      signal: new AbortController().signal,
      body: { mutationId: MUTATION, expectedUpdatedAt: ISO, expectedActiveVersion: null },
    });
    expect(result.receipt.operation).toBe(operation);
    const [path, init] = (fetcher.mock.calls as unknown as Array<[string, RequestInit]>)[0]!;
    expect(path).toContain(`/versions/1/${op}`);
    const body = JSON.parse(String(init.body)) as { expectedUpdatedAt: string; expectedActiveVersion: string | null };
    expect(body.expectedUpdatedAt).toBe(ISO);
    expect(body.expectedActiveVersion).toBeNull();
  });

  it("rejects a mismatched receipt mutation id", async () => {
    const fetcher = vi.fn(async () =>
      success(mutationResult("market.listing.create", `openarc:listing:${V4_B}`, V4_B)),
    );
    await expect(
      clientWith(fetcher as unknown as typeof fetch).createDraft({
        organizationId: ORG,
        csrfToken: "csrf",
        idempotencyKey: IDEMPOTENCY,
        signal: new AbortController().signal,
        body: { mutationId: MUTATION, providerId: PROVIDER, content: content() },
      }),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("rejects an oversized write body before fetch", async () => {
    const fetcher = vi.fn();
    const huge = { mutationId: MUTATION, providerId: PROVIDER, content: { ...content(), title: "x".repeat(LISTING_MAX_BODY_BYTES) } };
    await expect(
      clientWith(fetcher as unknown as typeof fetch).createDraft({
        organizationId: ORG,
        csrfToken: "csrf",
        idempotencyKey: IDEMPOTENCY,
        signal: new AbortController().signal,
        body: huge,
      }),
    ).rejects.toMatchObject({ failure: { kind: "pre-send" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects an empty CSRF token and a malformed idempotency key before send", async () => {
    const fetcher = vi.fn();
    await expect(
      clientWith(fetcher as unknown as typeof fetch).createDraft({
        organizationId: ORG,
        csrfToken: "",
        idempotencyKey: IDEMPOTENCY,
        signal: new AbortController().signal,
        body: { mutationId: MUTATION, providerId: PROVIDER, content: content() },
      }),
    ).rejects.toMatchObject({ failure: { kind: "pre-send" } });
    await expect(
      clientWith(fetcher as unknown as typeof fetch).createDraft({
        organizationId: ORG,
        csrfToken: "csrf",
        idempotencyKey: "short",
        signal: new AbortController().signal,
        body: { mutationId: MUTATION, providerId: PROVIDER, content: content() },
      }),
    ).rejects.toMatchObject({ failure: { kind: "pre-send" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports outcome-unknown for a transport failure after send and 5xx", async () => {
    const network = vi.fn(async () => {
      throw new Error("reset");
    });
    await expect(
      clientWith(network as unknown as typeof fetch).createDraft({
        organizationId: ORG,
        csrfToken: "csrf",
        idempotencyKey: IDEMPOTENCY,
        signal: new AbortController().signal,
        body: { mutationId: MUTATION, providerId: PROVIDER, content: content() },
      }),
    ).rejects.toMatchObject({ failure: { kind: "outcome-unknown" } });
    const server = vi.fn(async () => new Response("boom", { status: 500 }));
    await expect(
      clientWith(server as unknown as typeof fetch).createDraft({
        organizationId: ORG,
        csrfToken: "csrf",
        idempotencyKey: IDEMPOTENCY,
        signal: new AbortController().signal,
        body: { mutationId: MUTATION, providerId: PROVIDER, content: content() },
      }),
    ).rejects.toMatchObject({ failure: { kind: "outcome-unknown" } });
  });
});

describe("listing mutation status", () => {
  it("reads a committed draft status by mutation id", async () => {
    const fetcher = vi.fn(async () =>
      success({ status: "committed", receipt: receipt("market.listing.create", `openarc:listing:${MUTATION}`, MUTATION) }),
    );
    const status = await clientWith(fetcher as unknown as typeof fetch).readDraftMutationStatus({
      organizationId: ORG,
      mutationId: MUTATION,
      operation: "market.listing.create",
      resourceId: `openarc:listing:${MUTATION}`,
      signal: new AbortController().signal,
    });
    expect(status.status).toBe("committed");
    const [path] = (fetcher.mock.calls as unknown as Array<[string]>)[0]!;
    expect(path).toBe(
      `/v2/provider/organizations/${encodeURIComponent(ORG)}/listing-mutations/${MUTATION}`,
    );
  });

  it("accepts a truthful not_found status with no successor fiction", async () => {
    const fetcher = vi.fn(async () => success({ status: "not_found" }));
    const status = await clientWith(fetcher as unknown as typeof fetch).readDraftMutationStatus({
      organizationId: ORG,
      mutationId: MUTATION,
      operation: "market.listing.create",
      resourceId: `openarc:listing:${MUTATION}`,
      signal: new AbortController().signal,
    });
    expect(status).toEqual({ status: "not_found" });
  });
});

describe("listing capability transport", () => {
  it("omits credentials and sends no browser marker", async () => {
    const manifest = {
      capabilityVersion: "openarc.capabilities.marketplace.v1",
      environment: "testnet",
      network: "eip155:5042002",
      capabilities: [
        { family: "public_catalog", audience: "public", state: "enabled", dependencies: ["marketDatabase"] },
        { family: "listing_management", audience: "browser", state: "enabled", dependencies: ["auth", "tenantDatabase", "marketDatabase"] },
        { family: "moderation", audience: "browser", state: "enabled", dependencies: ["auth", "marketDatabase"] },
      ],
      routes: [],
    };
    // The strict manifest schema requires exactly 18 routes; use the frozen
    // registry from the shared package rather than hand-building them here.
    const frozen = await import("@openarc/shared");
    const full = { ...manifest, routes: frozen.MARKETPLACE_ROUTES.map((route) => ({ ...route })) };
    const fetcher = vi.fn(async () => success(full));
    const state = await readListingManagementCapability(
      new AbortController().signal,
      fetcher as unknown as typeof fetch,
    );
    expect(state).toBe("enabled");
    expect(fetcher).toHaveBeenCalledWith(MARKETPLACE_CAPABILITIES_PATH, {
      method: "GET",
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: expect.any(AbortSignal),
    });
  });
});

/**
 * A response whose headers are available but whose body stalls after one
 * chunk: the second `reader.read()` never settles. This proves the deadline
 * covers the BODY, not just the response headers.
 */
function stalledBodyResponse(firstChunk = "{", status = 200): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        if (firstChunk.length > 0) controller.enqueue(encoder.encode(firstChunk));
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function bodyOfBytes(bytes: Uint8Array, status = 200): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

describe("listing client total transport deadline (headers + body)", () => {
  it("times a stalled GET body out as unavailable, never stuck loading", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => stalledBodyResponse());
      const promise = clientWith(fetcher as unknown as typeof fetch).listRoots(
        { organizationId: ORG },
        new AbortController().signal,
      );
      const assertion = expect(promise).rejects.toMatchObject({ failure: { kind: "unavailable" } });
      await vi.advanceTimersByTimeAsync(LISTING_REQUEST_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("times a stalled capability body out as unavailable", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => stalledBodyResponse());
      const promise = readListingManagementCapability(
        new AbortController().signal,
        fetcher as unknown as typeof fetch,
      );
      const assertion = expect(promise).rejects.toMatchObject({ failure: { kind: "unavailable" } });
      await vi.advanceTimersByTimeAsync(LISTING_REQUEST_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("times a stalled SENT write body out as outcome-unknown", async () => {
    vi.useFakeTimers();
    try {
      const fetcher = vi.fn(async () => stalledBodyResponse());
      const promise = clientWith(fetcher as unknown as typeof fetch).createDraft({
        organizationId: ORG,
        csrfToken: "csrf",
        idempotencyKey: IDEMPOTENCY,
        signal: new AbortController().signal,
        body: { mutationId: MUTATION, providerId: PROVIDER, content: content() },
      });
      const assertion = expect(promise).rejects.toMatchObject({ failure: { kind: "outcome-unknown" } });
      await vi.advanceTimersByTimeAsync(LISTING_REQUEST_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays silent (aborted) when the caller aborts a stalled body", async () => {
    const fetcher = vi.fn(async () => stalledBodyResponse());
    const controller = new AbortController();
    const promise = clientWith(fetcher as unknown as typeof fetch).listRoots(
      { organizationId: ORG },
      controller.signal,
    );
    const assertion = expect(promise).rejects.toMatchObject({ failure: { kind: "aborted" } });
    controller.abort();
    await assertion;
  });

  it("keeps the 64KiB streamed-body bound and UTF-8 validation intact", async () => {
    const encoder = new TextEncoder();
    const oversized = bodyOfBytes(encoder.encode(`"${"x".repeat(API_MAX_RESPONSE_BYTES)}"`));
    await expect(
      clientWith((async () => oversized) as unknown as typeof fetch).listRoots(
        { organizationId: ORG },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });

    const invalidUtf8 = bodyOfBytes(new Uint8Array([0xff, 0xfe, 0xfd]));
    await expect(
      clientWith((async () => invalidUtf8) as unknown as typeof fetch).listRoots(
        { organizationId: ORG },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });
});

describe("listing client exact receipt and status binding", () => {
  it("rejects a create-version receipt for the wrong next version number", async () => {
    const fetcher = vi.fn(async () =>
      success(mutationResult("market.listing.version.create", `${LISTING}@5`, MUTATION)),
    );
    await expect(
      clientWith(fetcher as unknown as typeof fetch).createVersion({
        organizationId: ORG,
        listingId: LISTING,
        csrfToken: "csrf",
        idempotencyKey: IDEMPOTENCY,
        signal: new AbortController().signal,
        body: { mutationId: MUTATION, expectedLatestVersion: "1", content: content() },
      }),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("rejects a valid receipt addressed to another listing resource", async () => {
    const fetcher = vi.fn(async () =>
      success(mutationResult("market.listing.version.publish", `openarc:listing:${V4_B}@1`, MUTATION)),
    );
    await expect(
      clientWith(fetcher as unknown as typeof fetch).publish({
        organizationId: ORG,
        listingId: LISTING,
        version: "1",
        csrfToken: "csrf",
        idempotencyKey: IDEMPOTENCY,
        signal: new AbortController().signal,
        body: { mutationId: MUTATION, expectedUpdatedAt: ISO, expectedActiveVersion: null },
      }),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("rejects a status committed for another operation family despite the same mutation id", async () => {
    const fetcher = vi.fn(async () =>
      success({
        status: "committed",
        receipt: receipt("market.listing.version.publish", `${LISTING}@1`, MUTATION),
      }),
    );
    await expect(
      clientWith(fetcher as unknown as typeof fetch).readDraftMutationStatus({
        organizationId: ORG,
        mutationId: MUTATION,
        operation: "market.listing.create",
        resourceId: `openarc:listing:${MUTATION}`,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("rejects a status with the correct mutation id but a mismatched resource", async () => {
    const fetcher = vi.fn(async () =>
      success({
        status: "committed",
        receipt: receipt("market.listing.version.create", `${LISTING}@9`, MUTATION),
      }),
    );
    await expect(
      clientWith(fetcher as unknown as typeof fetch).readDraftMutationStatus({
        organizationId: ORG,
        mutationId: MUTATION,
        operation: "market.listing.version.create",
        resourceId: `${LISTING}@2`,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });

  it("accepts the exact committed lifecycle receipt and rejects a wrong action", async () => {
    const ok = vi.fn(async () =>
      success({
        status: "committed",
        receipt: receipt("market.listing.version.pause", `${LISTING}@1`, MUTATION),
      }),
    );
    const status = await clientWith(ok as unknown as typeof fetch).readLifecycleMutationStatus({
      organizationId: ORG,
      listingId: LISTING,
      version: "1",
      mutationId: MUTATION,
      operation: "market.listing.version.pause",
      signal: new AbortController().signal,
    });
    expect(status.status).toBe("committed");

    const wrongAction = vi.fn(async () =>
      success({
        status: "committed",
        receipt: receipt("market.listing.version.retire", `${LISTING}@1`, MUTATION),
      }),
    );
    await expect(
      clientWith(wrongAction as unknown as typeof fetch).readLifecycleMutationStatus({
        organizationId: ORG,
        listingId: LISTING,
        version: "1",
        mutationId: MUTATION,
        operation: "market.listing.version.pause",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ failure: { kind: "invalid-response" } });
  });
});

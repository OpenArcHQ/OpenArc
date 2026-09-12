import {
  COMMERCE_API_ERRORS,
  COMMERCE_API_SCHEMA_VERSION,
  buildMarketplaceCapabilityManifest,
  type CommerceListingPublicVersion,
} from "@openarc/shared";
import { describe, expect, it, vi } from "vitest";

import {
  MARKET_REQUEST_DEADLINE_MS,
  MarketApiError,
  MarketClient,
} from "../src/market/market-client.js";

const META = {
  schemaVersion: COMMERCE_API_SCHEMA_VERSION,
  requestId: "018f47a2-3b4c-7def-8123-456789abcdef",
  buildSha: "0123456789abcdef0123456789abcdef01234567",
};

const V4_A = "12345678-1234-4234-8123-123456789abc";
const V4_B = "87654321-4321-4321-b123-abcdefabcdef";
const LISTING_A = `openarc:listing:${V4_A}`;
const LISTING_B = `openarc:listing:${V4_B}`;
const PROVIDER_A = `openarc:provider:${V4_A}`;
const ISO = "2024-01-01T00:00:00.000Z";
const DIGEST = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

const signal = () => new AbortController().signal;

function success(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ ok: true, data, meta: META }), {
    status,
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

export function publicVersion(
  overrides: Partial<CommerceListingPublicVersion> = {},
): CommerceListingPublicVersion {
  return {
    schemaVersion: "openarc.listing-public-version.v1",
    listingId: LISTING_A,
    providerId: PROVIDER_A,
    version: "1",
    kind: "api",
    title: "Synthetic declared API",
    description: "A labelled contract fixture; this is not a database claim.",
    manifest: {
      schemaVersion: "openarc.listing-manifest.v1",
      inputSchemaDigest: DIGEST,
      outputSchemaDigest: DIGEST_B,
    },
    price: {
      amount: {
        schemaVersion: "openarc.usdc-amount.v1",
        networkId: "eip155:5042002",
        asset: "USDC",
        atomicAmount: "2500000",
        representation: "erc20",
        decimals: 6,
      },
      pricingModel: "fixed",
    },
    evidenceContract: {
      schemaVersion: "openarc.receipt-contract.v1",
      receiptType: "openarc.delivery.v1",
      receiptSchemaDigest: DIGEST,
      deliveryFields: ["result", "status"],
    },
    endpointOrigin: "https://provider.example.com",
    termsRevision: "terms-2024-01-01",
    privacySummary: "The provider declares its own handling of request inputs.",
    paymentLane: "unavailable",
    availability: { status: "available", rateLimitPerMinute: "60" },
    status: "active",
    publishedAt: ISO,
    ...overrides,
  };
}

function page(items: CommerceListingPublicVersion[], nextCursor: string | null) {
  return { items, nextCursor };
}

function enabledManifest() {
  return buildMarketplaceCapabilityManifest({
    auth: false,
    tenantReads: false,
    marketCatalog: true,
    listingManagement: false,
    marketModeration: false,
    authReady: false,
    tenantDatabaseReady: false,
    marketDatabaseReady: true,
  });
}

describe("public marketplace client transport", () => {
  it("reads capabilities from the fixed same-origin path with browser headers", async () => {
    const fetcher = vi.fn(async () => success(enabledManifest()));
    const client = new MarketClient({ fetcher: fetcher as unknown as typeof fetch });
    const manifest = await client.readCapabilities(signal());
    expect(manifest.capabilityVersion).toBe("openarc.capabilities.marketplace.v1");
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/v2/public/marketplace-capabilities");
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({
      "X-OpenArc-Client": "browser-v1",
      Accept: "application/json",
    });
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("error");
    expect(init.cache).toBe("no-store");
    expect(init.referrerPolicy).toBe("no-referrer");
    // No credential-shaped header, body or query is ever sent.
    const headers = init.headers as Record<string, string>;
    expect(Object.keys(headers).sort()).toEqual(["Accept", "X-OpenArc-Client"]);
    expect(init.body).toBeUndefined();
    expect(url).not.toContain("?");
  });

  it("builds the canonical listing path and allowlisted query once", async () => {
    const fetcher = vi.fn(async () => success(page([], null)));
    const client = new MarketClient({ fetcher: fetcher as unknown as typeof fetch });
    await client.listListings(
      { limit: 25, kind: "api", providerId: PROVIDER_A, q: "synthetic catalog" },
      signal(),
    );
    const [url] = fetcher.mock.calls[0] as unknown as [string];
    expect(url.startsWith("/v2/public/market/listings?")).toBe(true);
    const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect([...params.keys()].sort()).toEqual(["kind", "limit", "providerId", "q"]);
    expect(params.get("limit")).toBe("25");
    expect(params.get("kind")).toBe("api");
    expect(params.get("providerId")).toBe(PROVIDER_A);
    expect(params.get("q")).toBe("synthetic catalog");
    expect(url).not.toContain("afterListingId");
  });

  it("omits absent query fields and encodes one validated id exactly once", async () => {
    const fetcher = vi.fn(async () => success(page([], null)));
    const client = new MarketClient({ fetcher: fetcher as unknown as typeof fetch });
    await client.listListings({}, signal());
    const [plainUrl] = fetcher.mock.calls[0] as unknown as [string];
    expect(plainUrl).toBe("/v2/public/market/listings");

    fetcher.mockClear();
    fetcher.mockResolvedValueOnce(
      success({ listingId: LISTING_A, item: publicVersion() }),
    );
    await client.readListing(LISTING_A, signal());
    const [detailUrl] = fetcher.mock.calls[0] as unknown as [string];
    expect(detailUrl).toBe(`/v2/public/market/listings/${encodeURIComponent(LISTING_A)}`);
    expect(detailUrl).not.toContain("%253A");
  });

  it("rejects an invalid id before sending any request", async () => {
    const fetcher = vi.fn(async () => success(page([], null)));
    const client = new MarketClient({ fetcher: fetcher as unknown as typeof fetch });
    await expect(client.readListing("not-a-listing", signal())).rejects.toBeInstanceOf(MarketApiError);
    await expect(client.readProvider("https://evil.example.com", signal())).rejects.toBeInstanceOf(
      MarketApiError,
    );
    await expect(
      client.listListings({ limit: 51 }, signal()),
    ).rejects.toBeInstanceOf(MarketApiError);
    await expect(
      client.listListings({ q: " leading" }, signal()),
    ).rejects.toBeInstanceOf(MarketApiError);
    await expect(
      client.listListings({ q: "x".repeat(81) }, signal()),
    ).rejects.toBeInstanceOf(MarketApiError);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("validates the full response DTO and the exact envelope key set", async () => {
    const valid = page([publicVersion()], null);
    const fetcher = vi.fn(async () => success(valid));
    const client = new MarketClient({ fetcher: fetcher as unknown as typeof fetch });
    const result = await client.listListings({}, signal());
    expect(result.items[0]?.listingId).toBe(LISTING_A);

    // Unknown extra envelope key is rejected, not stripped.
    fetcher.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, data: valid, meta: META, extra: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(client.listListings({}, signal())).rejects.toMatchObject({
      failure: { kind: "invalid-response" },
    });

    // A private organization field is not representable by the strict DTO.
    fetcher.mockResolvedValueOnce(
      success(
        page(
          [
            Object.assign({}, publicVersion(), {
              organizationId: `openarc:org:${V4_A}`,
            }) as CommerceListingPublicVersion,
          ],
          null,
        ),
      ),
    );
    await expect(client.listListings({}, signal())).rejects.toMatchObject({
      failure: { kind: "invalid-response" },
    });
  });

  it("binds a page cursor to the last item and rejects a non-ascending page", async () => {
    const fetcher = vi.fn(async () => success(page([], "openarc:listing:" + V4_A)));
    const client = new MarketClient({ fetcher: fetcher as unknown as typeof fetch });
    await expect(client.listListings({}, signal())).rejects.toMatchObject({
      failure: { kind: "invalid-response" },
    });

    const descending = page(
      [
        publicVersion({ listingId: LISTING_B, providerId: `openarc:provider:${V4_B}` }),
        publicVersion({ listingId: LISTING_A }),
      ],
      null,
    );
    fetcher.mockResolvedValueOnce(success(descending));
    await expect(client.listListings({}, signal())).rejects.toMatchObject({
      failure: { kind: "invalid-response" },
    });
  });

  it("maps a null detail 200 to a truthful not-found, not an auth failure", async () => {
    const fetcher = vi.fn(async () => success({ listingId: LISTING_A, item: null }));
    const client = new MarketClient({ fetcher: fetcher as unknown as typeof fetch });
    const detail = await client.readListing(LISTING_A, signal());
    expect(detail.item).toBeNull();

    fetcher.mockResolvedValueOnce(
      success({ providerId: PROVIDER_A, item: null }),
    );
    const provider = await client.readProvider(PROVIDER_A, signal());
    expect(provider.item).toBeNull();
  });

  it("maps FEATURE_DISABLED and 5xx to bounded failures without echoing raw input", async () => {
    const fetcher = vi.fn(async () => errorEnvelope("FEATURE_DISABLED", 404));
    const client = new MarketClient({ fetcher: fetcher as unknown as typeof fetch });
    const featureError = await client.readCapabilities(signal()).catch((error: unknown) => error);
    expect(featureError).toMatchObject({ failure: { kind: "feature-disabled" } });
    expect((featureError as Error).message).toBe("feature-disabled");
    expect(JSON.stringify((featureError as MarketApiError).failure)).not.toContain("openarc:");

    fetcher.mockResolvedValueOnce(new Response("boom", { status: 503 }));
    await expect(client.readCapabilities(signal())).rejects.toMatchObject({
      failure: { kind: "unavailable" },
    });
  });

  it("rejects a non-JSON content type, invalid UTF-8 and an oversized body", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const client = new MarketClient({ fetcher: fetcher as unknown as typeof fetch });
    await expect(client.readCapabilities(signal())).rejects.toMatchObject({
      failure: { kind: "invalid-response" },
    });

    const invalidUtf8 = new Uint8Array([0xff, 0xfe, 0xfd]);
    fetcher.mockResolvedValueOnce(
      new Response(invalidUtf8, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(client.readCapabilities(signal())).rejects.toMatchObject({
      failure: { kind: "invalid-response" },
    });

    fetcher.mockResolvedValueOnce(
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "999999999" },
      }),
    );
    await expect(client.readCapabilities(signal())).rejects.toMatchObject({
      failure: { kind: "invalid-response" },
    });
  });

  it("honours abort before send and during a late body", async () => {
    const fetcher = vi.fn(async () => success(enabledManifest()));
    const client = new MarketClient({ fetcher: fetcher as unknown as typeof fetch });
    const aborted = new AbortController();
    aborted.abort();
    await expect(client.readCapabilities(aborted.signal)).rejects.toMatchObject({
      failure: { kind: "aborted" },
    });
    expect(fetcher).not.toHaveBeenCalled();

    // A redirect is rejected by the `redirect: "error"` contract; the client
    // maps the transport error to a bounded unavailable.
    fetcher.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(client.readCapabilities(signal())).rejects.toMatchObject({
      failure: { kind: "unavailable" },
    });
  });

  it("bounds the total request deadline", () => {
    expect(MARKET_REQUEST_DEADLINE_MS).toBe(10_000);
  });
});

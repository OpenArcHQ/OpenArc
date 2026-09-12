import {
  COMMERCE_API_ERRORS,
  COMMERCE_API_SCHEMA_VERSION,
  buildMarketplaceCapabilityManifest,
  type MarketplaceCapabilityManifest,
} from "@openarc/shared";
import { describe, expect, it, vi } from "vitest";

import { MarketApiError, MarketClient } from "../src/market/market-client.js";
import {
  MARKET_CURSOR_STACK_LIMIT,
  MarketController,
  resolveMarketRoute,
} from "../src/market/market-controller.js";
import { publicVersion } from "./market-client.test.js";

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
const PROVIDER_B = `openarc:provider:${V4_B}`;

function success(data: unknown): Response {
  return new Response(JSON.stringify({ ok: true, data, meta: META }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function failure(code: keyof typeof COMMERCE_API_ERRORS, status: number): Response {
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code, message: COMMERCE_API_ERRORS[code].message, retryable: false },
      meta: META,
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

function enabledManifest(): MarketplaceCapabilityManifest {
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

function disabledManifest(): MarketplaceCapabilityManifest {
  return buildMarketplaceCapabilityManifest({
    auth: false,
    tenantReads: false,
    marketCatalog: false,
    listingManagement: false,
    marketModeration: false,
    authReady: false,
    tenantDatabaseReady: false,
    marketDatabaseReady: false,
  });
}

/** Routes a scripted list of responses by URL, recording every request. */
function routedFetcher(
  handlers: Array<{
    match: (url: string) => boolean;
    respond: (url: string) => Response;
  }>,
) {
  const calls: string[] = [];
  const fetcher = vi.fn(async (url: string) => {
    calls.push(url);
    for (const handler of handlers) {
      if (handler.match(url)) return handler.respond(url);
    }
    throw new TypeError("no route");
  });
  return { fetcher: fetcher as unknown as typeof fetch, calls };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * A `200` JSON response whose body stream never enqueues or closes, modelling a
 * stalled provider body. The client must still exit `loading` on its deadline.
 */
function stallingResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start() {
      // Intentionally never enqueue or close.
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("public marketplace controller", () => {
  it("is disabled and issues no request when the gate is off", async () => {
    const fetcher = vi.fn(async () => success(enabledManifest()));
    const controller = new MarketController({
      client: new MarketClient({ fetcher: fetcher as unknown as typeof fetch }),
      enabled: false,
    });
    expect(controller.state.gate).toBe("disabled");
    await controller.loadCapabilities();
    await controller.loadList();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires the public_catalog family enabled before any catalog read", async () => {
    const { fetcher, calls } = routedFetcher([
      {
        match: (url) => url === "/v2/public/marketplace-capabilities",
        respond: () => success(disabledManifest()),
      },
      { match: () => true, respond: () => success({ items: [], nextCursor: null }) },
    ]);
    const controller = new MarketController({
      client: new MarketClient({ fetcher }),
      enabled: true,
    });
    await controller.loadCapabilities();
    expect(controller.state.gate).toBe("unavailable");
    await controller.loadList();
    expect(calls).toEqual(["/v2/public/marketplace-capabilities"]);
  });

  it("becomes unavailable on a missing or malformed capability response", async () => {
    const fetcher = vi.fn(async () => failure("SOURCE_UNAVAILABLE", 503));
    const controller = new MarketController({
      client: new MarketClient({ fetcher: fetcher as unknown as typeof fetch }),
      enabled: true,
    });
    await controller.loadCapabilities();
    expect(controller.state.gate).toBe("unavailable");

    const bad = new MarketController({
      client: new MarketClient({
        fetcher: vi.fn(async () =>
          success({ wrong: true }),
        ) as unknown as typeof fetch,
      }),
      enabled: true,
    });
    await bad.loadCapabilities();
    expect(bad.state.gate).toBe("unavailable");
  });

  it("loads a bounded first page with active filters and no auth credential", async () => {
    const { fetcher, calls } = routedFetcher([
      {
        match: (url) => url === "/v2/public/marketplace-capabilities",
        respond: () => success(enabledManifest()),
      },
      {
        match: (url) => url.startsWith("/v2/public/market/listings"),
        respond: () => success({ items: [publicVersion()], nextCursor: null }),
      },
    ]);
    const controller = new MarketController({
      client: new MarketClient({ fetcher }),
      enabled: true,
    });
    await controller.loadCapabilities();
    expect(controller.state.gate).toBe("enabled");
    await controller.applyFilters({
      q: "synthetic",
      kind: "api",
      providerId: PROVIDER_A,
    });
    expect(controller.state.filters.kind).toBe("api");
    expect(controller.state.list.status).toBe("ready");
    expect(controller.state.list.items).toHaveLength(1);
    const listUrl = calls[calls.length - 1] as string;
    expect(listUrl).toContain("kind=api");
    expect(listUrl).toContain(`providerId=${encodeURIComponent(PROVIDER_A)}`);
    expect(listUrl).toContain("q=synthetic");
    expect(listUrl).toContain("limit=50");
  });

  it("rejects an invalid filter value instead of coercing it", async () => {
    const { fetcher, calls } = routedFetcher([
      {
        match: (url) => url === "/v2/public/marketplace-capabilities",
        respond: () => success(enabledManifest()),
      },
    ]);
    const controller = new MarketController({
      client: new MarketClient({ fetcher }),
      enabled: true,
    });
    await controller.loadCapabilities();
    const before = calls.length;
    await controller.applyFilters({
      q: null,
      kind: "not-a-kind" as never,
      providerId: null,
    });
    await controller.applyFilters({ q: null, kind: null, providerId: "not-an-id" });
    expect(calls.length).toBe(before);
  });

  it("navigates next then previous with a bounded cursor stack and no auto-page", async () => {
    const pages: Record<string, unknown> = {
      "/v2/public/market/listings?limit=50": {
        items: [publicVersion()],
        nextCursor: LISTING_A,
      },
      [`/v2/public/market/listings?afterListingId=${encodeURIComponent(LISTING_A)}&limit=50`]: {
        items: [publicVersion({ listingId: LISTING_B, providerId: `openarc:provider:${V4_B}` })],
        nextCursor: LISTING_B,
      },
    };
    const { fetcher, calls } = routedFetcher([
      {
        match: (url) => url === "/v2/public/marketplace-capabilities",
        respond: () => success(enabledManifest()),
      },
      {
        match: (url) => url.startsWith("/v2/public/market/listings"),
        respond: (url) => success(pages[url] ?? { items: [], nextCursor: null }),
      },
    ]);
    const controller = new MarketController({
      client: new MarketClient({ fetcher }),
      enabled: true,
    });
    await controller.loadCapabilities();
    await controller.loadList();
    expect(controller.state.list.hasPrevious).toBe(false);
    const listReadsAfterFirst = calls.filter((url) =>
      url.startsWith("/v2/public/market/listings"),
    ).length;
    expect(listReadsAfterFirst).toBe(1);

    await controller.loadNextList();
    expect(controller.state.list.hasPrevious).toBe(true);
    expect(controller.state.list.items[0]?.listingId).toBe(LISTING_B);

    await controller.loadPreviousList();
    expect(controller.state.list.hasPrevious).toBe(false);
    expect(controller.state.list.items[0]?.listingId).toBe(LISTING_A);
    expect(MARKET_CURSOR_STACK_LIMIT).toBe(20);
  });

  it("drops a stale list response from an earlier generation", async () => {
    const first = deferred<Response>();
    const capabilities = success(enabledManifest());
    let call = 0;
    const fetcher = vi.fn(async () => {
      call += 1;
      if (call === 1) return capabilities;
      if (call === 2) return first.promise;
      return success({ items: [publicVersion({ title: "Newest title" })], nextCursor: null });
    });
    const controller = new MarketController({
      client: new MarketClient({ fetcher: fetcher as unknown as typeof fetch }),
      enabled: true,
    });
    await controller.loadCapabilities();
    const slow = controller.loadList();
    // A second explicit read advances the generation and aborts the first.
    const fast = controller.applyFilters({ q: "new", kind: null, providerId: null });
    first.resolve(success({ items: [publicVersion({ title: "Stale title" })], nextCursor: null }));
    await Promise.all([slow, fast]);
    expect(controller.state.list.items[0]?.title).toBe("Newest title");
  });

  it("shows an empty page as empty and a detail miss as not-found", async () => {
    const { fetcher } = routedFetcher([
      {
        match: (url) => url === "/v2/public/marketplace-capabilities",
        respond: () => success(enabledManifest()),
      },
      {
        match: (url) => url.startsWith("/v2/public/market/listings/"),
        respond: (url) =>
          url.endsWith(encodeURIComponent(LISTING_B))
            ? success({ listingId: LISTING_B, item: null })
            : success({ listingId: LISTING_A, item: publicVersion() }),
      },
      {
        match: (url) => url.startsWith("/v2/public/market/listings"),
        respond: () => success({ items: [], nextCursor: null }),
      },
    ]);
    const controller = new MarketController({
      client: new MarketClient({ fetcher }),
      enabled: true,
    });
    await controller.loadCapabilities();
    await controller.loadList();
    expect(controller.state.list.status).toBe("ready");
    expect(controller.state.list.items).toHaveLength(0);

    await controller.loadListing(LISTING_A);
    expect(controller.state.detail.status).toBe("ready");
    expect(controller.state.detail.item?.listingId).toBe(LISTING_A);

    await controller.loadListing(LISTING_B);
    expect(controller.state.detail.status).toBe("not-found");
    expect(controller.state.detail.item).toBeNull();
  });

  it("clears a previous detail synchronously when a new detail starts", async () => {
    const { fetcher } = routedFetcher([
      {
        match: (url) => url === "/v2/public/marketplace-capabilities",
        respond: () => success(enabledManifest()),
      },
      {
        match: (url) => url.endsWith(encodeURIComponent(LISTING_A)),
        respond: () => success({ listingId: LISTING_A, item: publicVersion() }),
      },
      {
        match: (url) => url.endsWith(encodeURIComponent(LISTING_B)),
        respond: () => success({ listingId: LISTING_B, item: publicVersion({ listingId: LISTING_B, title: "Second" }) }),
      },
    ]);
    const controller = new MarketController({
      client: new MarketClient({ fetcher }),
      enabled: true,
    });
    await controller.loadCapabilities();
    await controller.loadListing(LISTING_A);
    expect(controller.state.detail.item?.listingId).toBe(LISTING_A);
    const pending = controller.loadListing(LISTING_B);
    // Synchronously after the call, the old detail is already cleared.
    expect(controller.state.detail.status).toBe("loading");
    expect(controller.state.detail.item).toBeNull();
    await pending;
    expect(controller.state.detail.item?.listingId).toBe(LISTING_B);
  });

  it("turns a stalled detail body deadline into a retryable error, not stuck loading", async () => {
    vi.useFakeTimers();
    try {
      const { fetcher } = routedFetcher([
        {
          match: (url) => url === "/v2/public/marketplace-capabilities",
          respond: () => success(enabledManifest()),
        },
        {
          match: (url) => url.startsWith("/v2/public/market/listings/"),
          respond: () => stallingResponse(),
        },
      ]);
      const controller = new MarketController({
        client: new MarketClient({ fetcher }),
        enabled: true,
      });
      await controller.loadCapabilities();
      const pending = controller.loadListing(LISTING_A);
      expect(controller.state.detail.status).toBe("loading");

      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      expect(controller.state.detail.status).toBe("error");
      expect(controller.state.detail.failure).toBe("unavailable");
      expect(controller.state.detail.requestedListingId).toBe(LISTING_A);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not publish a stale error when a caller abort supersedes a stalled detail", async () => {
    vi.useFakeTimers();
    try {
      const { fetcher } = routedFetcher([
        {
          match: (url) => url === "/v2/public/marketplace-capabilities",
          respond: () => success(enabledManifest()),
        },
        {
          match: (url) => url.startsWith("/v2/public/market/listings/"),
          respond: () => stallingResponse(),
        },
      ]);
      const controller = new MarketController({
        client: new MarketClient({ fetcher }),
        enabled: true,
      });
      await controller.loadCapabilities();
      const pending = controller.loadListing(LISTING_A);
      // A route change supersedes the read and aborts it.
      controller.reset();
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      expect(controller.state.detail.status).toBe("none");
      expect(controller.state.detail.failure).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns a stalled provider body deadline into a retryable error", async () => {
    vi.useFakeTimers();
    try {
      const { fetcher } = routedFetcher([
        {
          match: (url) => url === "/v2/public/marketplace-capabilities",
          respond: () => success(enabledManifest()),
        },
        {
          match: (url) => url.startsWith("/v2/public/market/providers/"),
          respond: () => stallingResponse(),
        },
      ]);
      const controller = new MarketController({
        client: new MarketClient({ fetcher }),
        enabled: true,
      });
      await controller.loadCapabilities();
      const pending = controller.loadProvider(PROVIDER_A);
      expect(controller.state.provider.status).toBe("loading");

      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      expect(controller.state.provider.status).toBe("error");
      expect(controller.state.provider.provider).toBeNull();
      expect(controller.state.provider.requestedProviderId).toBe(PROVIDER_A);
    } finally {
      vi.useRealTimers();
    }
  });

  it("loads a provider profile and its provider-filtered listings", async () => {
    const { fetcher, calls } = routedFetcher([
      {
        match: (url) => url === "/v2/public/marketplace-capabilities",
        respond: () => success(enabledManifest()),
      },
      {
        match: (url) => url.startsWith("/v2/public/market/providers/"),
        respond: () =>
          success({
            providerId: PROVIDER_A,
            item: {
              schemaVersion: "openarc.provider-public.v1",
              providerId: PROVIDER_A,
              displayName: "Synthetic Provider",
              status: "active",
            },
          }),
      },
      {
        match: (url) => url.startsWith("/v2/public/market/listings"),
        respond: () => success({ items: [publicVersion()], nextCursor: null }),
      },
    ]);
    const controller = new MarketController({
      client: new MarketClient({ fetcher }),
      enabled: true,
    });
    await controller.loadCapabilities();
    await controller.loadProvider(PROVIDER_A);
    expect(controller.state.provider.status).toBe("ready");
    expect(controller.state.provider.provider?.displayName).toBe("Synthetic Provider");
    const listUrl = calls[calls.length - 1] as string;
    expect(listUrl).toContain(`providerId=${encodeURIComponent(PROVIDER_A)}`);

    await controller.loadProvider(PROVIDER_B);
    // A same-kind response for a different provider is never accepted: the
    // strict binding check yields the bounded error state, not a wrong profile.
    expect(controller.state.provider.status).toBe("error");
  });

  it("maps a bare provider 404 to not-found and a null item 200 to not-found", async () => {
    const { fetcher } = routedFetcher([
      {
        match: (url) => url === "/v2/public/marketplace-capabilities",
        respond: () => success(enabledManifest()),
      },
      {
        match: (url) => url.startsWith("/v2/public/market/providers/"),
        respond: () => new Response("missing", { status: 404 }),
      },
    ]);
    const controller = new MarketController({
      client: new MarketClient({ fetcher }),
      enabled: true,
    });
    await controller.loadCapabilities();
    await controller.loadProvider(PROVIDER_A);
    expect(controller.state.provider.status).toBe("not-found");

    const nullItem = routedFetcher([
      {
        match: (url) => url === "/v2/public/marketplace-capabilities",
        respond: () => success(enabledManifest()),
      },
      {
        match: (url) => url.startsWith("/v2/public/market/providers/"),
        respond: () => success({ providerId: PROVIDER_A, item: null }),
      },
    ]);
    const nullController = new MarketController({
      client: new MarketClient({ fetcher: nullItem.fetcher }),
      enabled: true,
    });
    await nullController.loadCapabilities();
    await nullController.loadProvider(PROVIDER_A);
    expect(nullController.state.provider.status).toBe("not-found");
  });

  it("resets all visible state and aborts in-flight reads on route change", async () => {
    const pending = deferred<Response>();
    let call = 0;
    const fetcher = vi.fn(async () => {
      call += 1;
      if (call === 1) return success(enabledManifest());
      return pending.promise;
    });
    const controller = new MarketController({
      client: new MarketClient({ fetcher: fetcher as unknown as typeof fetch }),
      enabled: true,
    });
    await controller.loadCapabilities();
    void controller.loadList();
    controller.reset();
    expect(controller.state.list).toMatchObject({ status: "none", items: [] });
    expect(controller.state.detail.item).toBeNull();
    expect(controller.state.provider.provider).toBeNull();
    pending.reject(new MarketApiError({ kind: "aborted" }));
  });

  it("stops publishing state after dispose", async () => {
    const fetcher = vi.fn(async () => success(enabledManifest()));
    const controller = new MarketController({
      client: new MarketClient({ fetcher: fetcher as unknown as typeof fetch }),
      enabled: true,
    });
    await controller.loadCapabilities();
    expect(controller.state.gate).toBe("enabled");
    controller.dispose();
    expect(controller.disposed).toBe(true);
    expect(controller.state.gate).toBe("loading-capabilities");
    await controller.loadList();
    expect(controller.state.list.status).toBe("none");
  });

  it("sends no cookie, auth or credential header on any catalog read", async () => {
    const requestInit: RequestInit[] = [];
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
      requestInit.push(init ?? {});
      return success(enabledManifest());
    });
    const controller = new MarketController({
      client: new MarketClient({ fetcher: fetcher as unknown as typeof fetch }),
      enabled: true,
    });
    await controller.loadCapabilities();
    for (const init of requestInit) {
      const headers = init.headers as Record<string, string>;
      expect(Object.keys(headers).sort()).toEqual(["Accept", "X-OpenArc-Client"]);
      expect(init.credentials).toBe("omit");
    }
  });
});

describe("public marketplace route grammar", () => {
  it("accepts a single validated encoded id and normalizes one trailing slash", () => {
    const encoded = encodeURIComponent(LISTING_A);
    expect(resolveMarketRoute(`/market/${encoded}`)).toEqual({
      kind: "detail",
      listingId: LISTING_A,
    });
    expect(resolveMarketRoute(`/market/${encoded}/`)).toEqual({
      kind: "detail",
      listingId: LISTING_A,
    });
    expect(resolveMarketRoute(`/providers/${encodeURIComponent(PROVIDER_A)}`)).toEqual({
      kind: "provider",
      providerId: PROVIDER_A,
    });
  });

  it("rejects interior empty segments before decoding", () => {
    const encoded = encodeURIComponent(LISTING_A);
    expect(resolveMarketRoute(`/market//${encoded}`)).toEqual({ kind: "not-found" });
    expect(resolveMarketRoute(`/providers//${encodeURIComponent(PROVIDER_A)}`)).toEqual({
      kind: "not-found",
    });
    // All trailing slashes are normalized away; that is not an interior empty.
    expect(resolveMarketRoute(`/market/${encoded}//`)).toEqual({
      kind: "detail",
      listingId: LISTING_A,
    });
  });

  it("bounds escaped separators, residual encoding and extra suffixes", () => {
    const escapedSeparator = encodeURIComponent(`${LISTING_A}/extra`);
    expect(resolveMarketRoute(`/market/${escapedSeparator}`)).toEqual({ kind: "not-found" });
    // A double-encoded colon decodes exactly once to a non-canonical id.
    const residual = encodeURIComponent(LISTING_A).replace(/%3A/giu, "%253A");
    expect(resolveMarketRoute(`/market/${residual}`)).toEqual({ kind: "not-found" });
    expect(resolveMarketRoute(`/market/${encodeURIComponent(LISTING_A)}/extra`)).toEqual({
      kind: "not-found",
    });
    expect(resolveMarketRoute("/market/%E0%A4%A")).toEqual({ kind: "invalid" });
  });

  it("maps static info routes and never treats a bare root as a catalog route", () => {
    expect(resolveMarketRoute("/docs")).toEqual({ kind: "info", info: "docs" });
    expect(resolveMarketRoute("/status/")).toEqual({ kind: "info", info: "status" });
    expect(resolveMarketRoute("/legal")).toEqual({ kind: "info", info: "legal" });
    expect(resolveMarketRoute("/")).toEqual({ kind: "not-found" });
    expect(resolveMarketRoute("/market")).toEqual({ kind: "list" });
  });
});

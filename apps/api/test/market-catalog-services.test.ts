import { describe, expect, it } from "vitest";

import type {
  CommerceListingPublicVersion,
  CommerceMarketPublicProvider,
} from "@openarc/shared";
import {
  MarketStoreError,
  type ListPublicListingsResult,
} from "@openarc/db";

import { AUTH_ERRORS, type AuthApiError } from "../src/auth/errors.js";
import { MarketCatalogService } from "../src/market/catalog-service.js";
import type { MarketCatalogStorePort } from "../src/market/catalog-ports.js";

/**
 * Focused unit coverage for the public catalog service.
 *
 * The catalog repository is HONESTLY MOCKED. This suite proves the whole-DTO
 * strict projection, target/filter/cursor/page bindings, lookahead defence,
 * truthful nullable misses and the fixed 400/500/503 error split. No
 * PostgreSQL, AuthService, session, wallet or external fetch is claimed.
 */

const MUTATION = "12345678-1234-4234-8123-123456789abc";
const OTHER = "87654321-1234-4234-8123-123456789abc";
const LISTING = `openarc:listing:${MUTATION}`;
const OTHER_LISTING = `openarc:listing:${OTHER}`;
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
  calls: string[] = [];
  error: unknown;
  override: unknown;
  page: ListPublicListingsResult = {
    items: [PUBLIC_LISTING],
    nextCursor: null,
  };
  listing: CommerceListingPublicVersion | null = PUBLIC_LISTING;
  provider: CommerceMarketPublicProvider | null = PUBLIC_PROVIDER;

  #record(name: string): unknown {
    this.calls.push(name);
    if (this.error) throw this.error;
    return this.override;
  }

  async listPublicListings(): Promise<ListPublicListingsResult> {
    const value = this.#record("listPublicListings");
    if (value !== undefined) return value as ListPublicListingsResult;
    return this.page;
  }
  async getPublicListing(): Promise<CommerceListingPublicVersion | null> {
    const value = this.#record("getPublicListing");
    if (value !== undefined) return value as CommerceListingPublicVersion | null;
    return this.listing;
  }
  async getPublicProvider(): Promise<CommerceMarketPublicProvider | null> {
    const value = this.#record("getPublicProvider");
    if (value !== undefined) return value as CommerceMarketPublicProvider | null;
    return this.provider;
  }
}

function harness() {
  const store = new FakeCatalogStore();
  return { store, service: new MarketCatalogService({ store }) };
}

async function expectError(
  work: Promise<unknown>,
  code: string,
  status: number,
): Promise<void> {
  await expect(work).rejects.toMatchObject({ code, status });
}

describe("public catalog list projection", () => {
  it("projects a strict page with no auth dependency", async () => {
    const { store, service } = harness();
    const page = await service.listPublicListings({});
    expect(store.calls).toEqual(["listPublicListings"]);
    expect(page.items).toEqual([PUBLIC_LISTING]);
    expect(page.nextCursor).toBeNull();
  });

  it("rejects a page larger than the requested/default limit (lookahead)", async () => {
    const { store, service } = harness();
    store.page = {
      items: [PUBLIC_LISTING, { ...PUBLIC_LISTING, listingId: OTHER_LISTING }],
      nextCursor: null,
    };
    await expectError(service.listPublicListings({ limit: 1 }), "INTERNAL_ERROR", 500);
  });

  it("rejects an item that does not strictly follow afterListingId", async () => {
    const { store, service } = harness();
    store.page = { items: [PUBLIC_LISTING], nextCursor: null };
    await expectError(
      service.listPublicListings({ afterListingId: OTHER_LISTING }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("rejects an item that violates the supplied kind filter", async () => {
    const { service } = harness();
    await expectError(
      service.listPublicListings({ kind: "data" }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("rejects an item that violates the supplied provider filter", async () => {
    const { service } = harness();
    await expectError(
      service.listPublicListings({
        providerId: `openarc:provider:${OTHER}`,
      }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("rejects a malformed page envelope with an extra key", async () => {
    const { store, service } = harness();
    store.override = { items: [PUBLIC_LISTING], nextCursor: null, extra: true };
    await expectError(service.listPublicListings({}), "INTERNAL_ERROR", 500);
  });

  it("rejects a private-field canary injected into a public item", async () => {
    const { store, service } = harness();
    store.page = {
      items: [
        {
          ...PUBLIC_LISTING,
          organizationId: `openarc:org:${MUTATION}`,
        } as unknown as CommerceListingPublicVersion,
      ],
      nextCursor: null,
    };
    await expectError(service.listPublicListings({}), "INTERNAL_ERROR", 500);
  });

  it("rejects caller query text with control characters or bad trim", async () => {
    const { service } = harness();
    await expectError(service.listPublicListings({ q: " x" }), "INVALID_REQUEST", 400);
    await expectError(
      service.listPublicListings({ q: "x\u0000y" }),
      "INVALID_REQUEST",
      400,
    );
  });
});

describe("public catalog detail and provider", () => {
  it("projects a strict listing detail bound to the target", async () => {
    const { service } = harness();
    const detail = await service.getPublicListing(LISTING);
    expect(detail.item?.listingId).toBe(LISTING);
  });

  it("returns a truthful nullable 200 on a listing miss", async () => {
    const { store, service } = harness();
    store.listing = null;
    const detail = await service.getPublicListing(LISTING);
    expect(detail).toEqual({ listingId: LISTING, item: null });
  });

  it("rejects a listing item whose id does not bind the target", async () => {
    const { store, service } = harness();
    store.listing = { ...PUBLIC_LISTING, listingId: OTHER_LISTING };
    await expectError(service.getPublicListing(LISTING), "INTERNAL_ERROR", 500);
  });

  it("projects a strict provider detail bound to the target", async () => {
    const { service } = harness();
    const detail = await service.getPublicProvider(PROVIDER);
    expect(detail.item?.providerId).toBe(PROVIDER);
  });

  it("returns a truthful nullable 200 on a provider miss", async () => {
    const { store, service } = harness();
    store.provider = null;
    const detail = await service.getPublicProvider(PROVIDER);
    expect(detail).toEqual({ providerId: PROVIDER, item: null });
  });

  it("rejects an inactive or malformed provider DTO", async () => {
    const { store, service } = harness();
    store.provider = { ...PUBLIC_PROVIDER, status: "suspended" } as never;
    await expectError(service.getPublicProvider(PROVIDER), "INTERNAL_ERROR", 500);
  });
});

describe("public catalog error mapping", () => {
  it("maps repository input-invalid to a fixed 400", async () => {
    const { store, service } = harness();
    store.error = new MarketStoreError("MARKET_STORE_INPUT_INVALID");
    await expectError(service.listPublicListings({}), "INVALID_REQUEST", 400);
  });

  it("maps repository unavailable/outcome-unknown to a fixed 503", async () => {
    for (const code of [
      "MARKET_STORE_UNAVAILABLE",
      "MARKET_STORE_OUTCOME_UNKNOWN",
    ] as const) {
      const { store, service } = harness();
      store.error = new MarketStoreError(code);
      await expectError(service.listPublicListings({}), "INTERNAL_ERROR", 503);
    }
  });

  it("maps an unexpected thrown error to a fixed 503 with no raw echo", async () => {
    const { store, service } = harness();
    store.error = new Error("raw driver detail canary");
    try {
      await service.listPublicListings({});
      throw new Error("expected rejection");
    } catch (error) {
      const api = error as AuthApiError;
      expect(api.status).toBe(503);
      expect(api.message).not.toContain("canary");
    }
  });

  it("never reflects the private Vault or a raw row", async () => {
    const { store, service } = harness();
    store.error = { privateVault: "secret-canary" };
    await expectError(service.listPublicListings({}), "INTERNAL_ERROR", 503);
  });
});

void AUTH_ERRORS;

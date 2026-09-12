import { describe, expect, it } from "vitest";

import {
  MarketStoreError,
  type MarketMutationResult,
  type MarketMutationStatus,
} from "@openarc/db";
import type {
  CommerceListingOwner,
  CommerceListingOwnerVersion,
} from "@openarc/shared";

import { AUTH_ERRORS, type AuthApiError } from "../src/auth/errors.js";
import type { AuthRequestContext } from "../src/auth/service.js";
import { MarketService } from "../src/market/service.js";
import type { MarketAuthPort, MarketStorePort } from "../src/market/ports.js";

/**
 * Unit coverage for the protected market service.
 *
 * The MarketStore and auth seam are HONESTLY MOCKED: these tests prove request
 * validation BEFORE auth, CSRF-then-begin ordering for writes, exactly one
 * repository invocation, begin/repository/finish ordering for reads, strict
 * projection/binding, closed store-error mapping and result redaction. Real
 * roles, sessions, locks, idempotency, CAS and SQL enforcement are covered by
 * market-api.postgres.test.ts.
 */

const MUTATION = "12345678-1234-4234-8123-123456789abc";
const MUTATION2 = "22345678-1234-4234-8123-123456789abc";
const MUTATION3 = "32345678-1234-4234-8123-123456789abc";
const ORG = `openarc:org:${MUTATION}`;
const PROVIDER = `openarc:provider:${MUTATION}`;
const PROVIDER2 = `openarc:provider:${MUTATION2}`;
const LISTING = `openarc:listing:${MUTATION}`;
const LISTING2 = `openarc:listing:${MUTATION2}`;
const HASH = "a".repeat(64);
const ACCOUNT = `openarc:account:${MUTATION}`;
const IDEMPOTENCY = "A".repeat(43);
const ISO = "2026-01-01T00:00:00.000Z";

const DIGEST = `sha256:${"1".repeat(64)}`;

function content(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    ...overrides,
  };
}

function versionItem(
  overrides: Record<string, unknown> = {},
): CommerceListingOwnerVersion {
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
  } as CommerceListingOwnerVersion;
}

function ownerItem(overrides: Record<string, unknown> = {}): CommerceListingOwner {
  return {
    schemaVersion: "openarc.listing.v1",
    listingId: LISTING,
    organizationId: ORG,
    providerId: PROVIDER,
    activeVersion: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...overrides,
  } as CommerceListingOwner;
}

function listingReceipt(mutationId = MUTATION): MarketMutationResult {
  return {
    replayed: false,
    receipt: {
      mutationId,
      operation: "market.listing.create",
      resourceType: "listing",
      resourceId: `openarc:listing:${mutationId}`,
      committedAt: ISO,
    },
  } as MarketMutationResult;
}

function versionReceipt(
  listingId = LISTING,
  version = "2",
  mutationId = MUTATION2,
): MarketMutationResult {
  return {
    replayed: false,
    receipt: {
      mutationId,
      operation: "market.listing.version.create",
      resourceType: "listing_version",
      resourceId: `${listingId}@${version}`,
      committedAt: ISO,
    },
  } as MarketMutationResult;
}

class FakeStore implements MarketStorePort {
  calls: string[] = [];
  error: unknown;
  listingResult: unknown;
  versionPageResult: unknown;
  versionResult: unknown;
  statusResult: unknown;
  draftResult: unknown = listingReceipt();
  createVersionResult: unknown = versionReceipt();

  #record(name: string): void {
    this.calls.push(name);
    if (this.error) throw this.error;
  }

  async createListingDraft(): Promise<MarketMutationResult> {
    this.#record("createListingDraft");
    return this.draftResult as MarketMutationResult;
  }
  async createListingVersion(): Promise<MarketMutationResult> {
    this.#record("createListingVersion");
    return this.createVersionResult as MarketMutationResult;
  }
  async listOwnerListings(): Promise<{ items: CommerceListingOwner[]; nextCursor: string | null }> {
    this.#record("listOwnerListings");
    return this.listingResult as { items: CommerceListingOwner[]; nextCursor: string | null };
  }
  async listOwnerListingVersions(): Promise<{
    items: CommerceListingOwnerVersion[];
    nextCursor: string | null;
  }> {
    this.#record("listOwnerListingVersions");
    return this.versionPageResult as {
      items: CommerceListingOwnerVersion[];
      nextCursor: string | null;
    };
  }
  async getOwnerListingVersion(): Promise<CommerceListingOwnerVersion | null> {
    this.#record("getOwnerListingVersion");
    return this.versionResult as CommerceListingOwnerVersion | null;
  }
  async getMarketMutationStatus(): Promise<MarketMutationStatus> {
    this.#record("getMarketMutationStatus");
    return this.statusResult as MarketMutationStatus;
  }
}

class FakeAuth implements MarketAuthPort {
  csrfCalls = 0;
  beginCalls = 0;
  finishCalls = 0;
  csrfError: AuthApiError | undefined;
  beginError: AuthApiError | undefined;
  finishError: AuthApiError | undefined;

  verifyCsrf(): string {
    this.csrfCalls += 1;
    if (this.csrfError) throw this.csrfError;
    return "binding";
  }
  async beginTenantRead(): Promise<{ sessionHash: string; accountId: string }> {
    this.beginCalls += 1;
    if (this.beginError) throw this.beginError;
    return { sessionHash: HASH, accountId: ACCOUNT };
  }
  async finishTenantRead(): Promise<void> {
    this.finishCalls += 1;
    if (this.finishError) throw this.finishError;
  }
}

function ctx(): AuthRequestContext {
  return { peerIp: "127.0.0.1", cookies: { session: null, binding: null } };
}

function harness() {
  const store = new FakeStore();
  const auth = new FakeAuth();
  const service = new MarketService({ auth, store });
  return { store, auth, service };
}

function writeEnvelope(body: unknown) {
  return {
    ctx: ctx(),
    csrf: "csrf",
    idempotencyKey: IDEMPOTENCY,
    body,
  };
}

function statusOf(error: unknown): number | undefined {
  return (error as { status?: number }).status;
}

describe("market service list binding", () => {
  it("lists owner listings through begin -> one read -> finish", async () => {
    const { store, auth, service } = harness();
    store.listingResult = { items: [ownerItem()], nextCursor: null };
    const page = await service.listOwnerListings(ctx(), { organizationId: ORG });
    expect(page.organizationId).toBe(ORG);
    expect(page.items).toHaveLength(1);
    expect(auth.beginCalls).toBe(1);
    expect(auth.finishCalls).toBe(1);
    expect(store.calls).toEqual(["listOwnerListings"]);
  });

  it("rejects items not strictly beyond the cursor and over-limit pages", async () => {
    const over = harness();
    over.store.listingResult = {
      items: [ownerItem({ listingId: LISTING }), ownerItem({ listingId: LISTING2 })],
      nextCursor: LISTING2,
    };
    await expect(
      over.service.listOwnerListings(ctx(), { organizationId: ORG, afterListingId: LISTING2 }),
    ).rejects.toMatchObject({ status: 500 });

    const limit = harness();
    limit.store.listingResult = {
      items: [ownerItem({ listingId: LISTING })],
      nextCursor: null,
    };
    await expect(
      limit.service.listOwnerListings(ctx(), { organizationId: ORG, limit: 0 }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("does not strip an extra store envelope key before validation", async () => {
    const { store, service } = harness();
    store.listingResult = { items: [], nextCursor: null, secret: "PRIVATE" };
    await expect(
      service.listOwnerListings(ctx(), { organizationId: ORG }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("binds items to the requested organization", async () => {
    const { store, service } = harness();
    store.listingResult = { items: [ownerItem({ organizationId: LISTING })], nextCursor: null };
    await expect(
      service.listOwnerListings(ctx(), { organizationId: ORG }),
    ).rejects.toMatchObject({ status: 500 });
  });
});

describe("market service version history", () => {
  it("reads immutable version1 for the provider id in the same authorized read", async () => {
    const { store, auth, service } = harness();
    const items = [versionItem(), versionItem({ version: "2" })];
    store.versionResult = versionItem();
    store.versionPageResult = { items, nextCursor: null };
    const page = await service.listOwnerListingVersions(ctx(), {
      organizationId: ORG,
      listingId: LISTING,
    });
    expect(page.providerId).toBe(PROVIDER);
    expect(page.items.map((item) => item.version)).toEqual(["1", "2"]);
    expect(auth.beginCalls).toBe(1);
    expect(auth.finishCalls).toBe(1);
    expect(store.calls).toEqual(["getOwnerListingVersion", "listOwnerListingVersions"]);
  });

  it("keeps a truthful provider id on an empty page", async () => {
    const { store, service } = harness();
    store.versionResult = versionItem();
    store.versionPageResult = { items: [], nextCursor: null };
    const page = await service.listOwnerListingVersions(ctx(), {
      organizationId: ORG,
      listingId: LISTING,
    });
    expect(page.items).toEqual([]);
    expect(page.providerId).toBe(PROVIDER);
  });

  it("denies a missing version1 with a fixed 403 and fabricates no page", async () => {
    const { store, service } = harness();
    store.versionResult = null;
    await expect(
      service.listOwnerListingVersions(ctx(), { organizationId: ORG, listingId: LISTING }),
    ).rejects.toMatchObject({ status: 403 });
    expect(store.calls).toEqual(["getOwnerListingVersion"]);
  });

  it("rejects a mixed-provider or out-of-order page", async () => {
    const mixed = harness();
    mixed.store.versionResult = versionItem();
    mixed.store.versionPageResult = {
      items: [versionItem({ providerId: PROVIDER2 })],
      nextCursor: null,
    };
    await expect(
      mixed.service.listOwnerListingVersions(ctx(), { organizationId: ORG, listingId: LISTING }),
    ).rejects.toMatchObject({ status: 500 });

    const order = harness();
    order.store.versionResult = versionItem();
    order.store.versionPageResult = {
      items: [versionItem({ version: "2" }), versionItem({ version: "10" })],
      nextCursor: null,
    };
    await expect(
      order.service.listOwnerListingVersions(ctx(), {
        organizationId: ORG,
        listingId: LISTING,
        afterVersion: "2",
      }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("rejects malformed/extra version items without stripping", async () => {
    const { store, service } = harness();
    store.versionResult = versionItem();
    store.versionPageResult = {
      items: [{ ...versionItem(), secret: "PRIVATE" }],
      nextCursor: null,
    };
    await expect(
      service.listOwnerListingVersions(ctx(), { organizationId: ORG, listingId: LISTING }),
    ).rejects.toMatchObject({ status: 500 });
  });
});

describe("market service version detail", () => {
  it("returns {item:null} 200 for an authorized explicit miss", async () => {
    const { store, service } = harness();
    store.versionResult = null;
    const detail = await service.getOwnerListingVersion(ctx(), {
      organizationId: ORG,
      listingId: LISTING,
      version: "7",
    });
    expect(detail.item).toBeNull();
    expect(detail.version).toBe("7");
  });

  it("binds a present version to the requested org/listing/version", async () => {
    const { store, service } = harness();
    store.versionResult = versionItem();
    const detail = await service.getOwnerListingVersion(ctx(), {
      organizationId: ORG,
      listingId: LISTING,
      version: "1",
    });
    expect(detail.item?.listingId).toBe(LISTING);

    const mismatch = harness();
    mismatch.store.versionResult = versionItem({ version: "2" });
    await expect(
      mismatch.service.getOwnerListingVersion(ctx(), {
        organizationId: ORG,
        listingId: LISTING,
        version: "1",
      }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("rejects an extra key on a present version item", async () => {
    const { store, service } = harness();
    store.versionResult = { ...versionItem(), extra: "PRIVATE" };
    await expect(
      service.getOwnerListingVersion(ctx(), {
        organizationId: ORG,
        listingId: LISTING,
        version: "1",
      }),
    ).rejects.toMatchObject({ status: 500 });
  });
});

describe("market service mutation status", () => {
  it("returns committed/not_found and always finishes the read", async () => {
    const committed = harness();
    committed.store.statusResult = {
      status: "committed",
      receipt: versionReceipt().receipt,
    };
    const result = await committed.service.getMarketMutationStatus(ctx(), {
      organizationId: ORG,
      mutationId: MUTATION2,
    });
    expect(result.status).toBe("committed");
    expect(committed.auth.finishCalls).toBe(1);

    const missing = harness();
    missing.store.statusResult = { status: "not_found" };
    const miss = await missing.service.getMarketMutationStatus(ctx(), {
      organizationId: ORG,
      mutationId: MUTATION2,
    });
    expect(miss.status).toBe("not_found");
    expect(missing.auth.finishCalls).toBe(1);
  });

  it("fails closed when the receipt mutation id is not the requested one", async () => {
    const { store, service } = harness();
    store.statusResult = { status: "committed", receipt: versionReceipt(LISTING, "2", MUTATION3).receipt };
    await expect(
      service.getMarketMutationStatus(ctx(), { organizationId: ORG, mutationId: MUTATION2 }),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("rejects extra keys on a committed or not_found status without stripping", async () => {
    const committed = harness();
    committed.store.statusResult = {
      status: "committed",
      receipt: versionReceipt().receipt,
      secret: "PRIVATE",
    };
    await expect(
      committed.service.getMarketMutationStatus(ctx(), {
        organizationId: ORG,
        mutationId: MUTATION2,
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(committed.auth.finishCalls).toBe(1);

    const missing = harness();
    missing.store.statusResult = { status: "not_found", secret: "PRIVATE" };
    await expect(
      missing.service.getMarketMutationStatus(ctx(), {
        organizationId: ORG,
        mutationId: MUTATION2,
      }),
    ).rejects.toMatchObject({ status: 500 });
    expect(missing.auth.finishCalls).toBe(1);
  });

  it("rejects a lifecycle receipt through this draft-only status method", async () => {
    const { store, service } = harness();
    store.statusResult = {
      status: "committed",
      receipt: {
        mutationId: MUTATION2,
        operation: "market.listing.version.publish",
        resourceType: "listing_version",
        resourceId: `${LISTING}@2`,
        committedAt: ISO,
      },
    };
    await expect(
      service.getMarketMutationStatus(ctx(), { organizationId: ORG, mutationId: MUTATION2 }),
    ).rejects.toMatchObject({ status: 500 });
    expect(store.calls).toEqual(["getMarketMutationStatus"]);
  });

  it("returns 401 with no receipt when finish rejects after the read", async () => {
    const { store, auth, service } = harness();
    store.statusResult = { status: "committed", receipt: versionReceipt().receipt };
    auth.finishError = AUTH_ERRORS.unauthenticated();
    await expect(
      service.getMarketMutationStatus(ctx(), { organizationId: ORG, mutationId: MUTATION2 }),
    ).rejects.toMatchObject({ status: 401 });
    expect(store.calls).toEqual(["getMarketMutationStatus"]);
  });
});

describe("market service writes", () => {
  it("invokes exactly one draft mutation after CSRF and begin, with no finish", async () => {
    const { store, auth, service } = harness();
    const result = await service.createListingDraft(ctx(), ORG, writeEnvelope({
      mutationId: MUTATION,
      providerId: PROVIDER,
      content: content(),
    }));
    expect(result.receipt.operation).toBe("market.listing.create");
    expect(result.receipt.resourceId).toBe(LISTING);
    expect(auth.csrfCalls).toBe(1);
    expect(auth.beginCalls).toBe(1);
    expect(auth.finishCalls).toBe(0);
    expect(store.calls).toEqual(["createListingDraft"]);
  });

  it("derives the next version and binds the version receipt", async () => {
    const { store, auth, service } = harness();
    const result = await service.createListingVersion(ctx(), ORG, LISTING, writeEnvelope({
      mutationId: MUTATION2,
      expectedLatestVersion: "1",
      content: content(),
    }));
    expect(result.receipt.operation).toBe("market.listing.version.create");
    expect(result.receipt.resourceId).toBe(`${LISTING}@2`);
    expect(auth.finishCalls).toBe(0);
    expect(store.calls).toEqual(["createListingVersion"]);
  });

  it("validates input before any auth or repository call", async () => {
    const { store, auth, service } = harness();
    const cases: Array<{ org?: string; body: unknown }> = [
      { body: { mutationId: MUTATION, providerId: PROVIDER } },
      { body: { mutationId: MUTATION, providerId: PROVIDER, content: content(), extra: 1 } },
      { body: { mutationId: MUTATION.toUpperCase(), providerId: PROVIDER, content: content() } },
      { org: "not-an-org", body: { mutationId: MUTATION, providerId: PROVIDER, content: content() } },
    ];
    for (const entry of cases) {
      await expect(
        service.createListingDraft(
          ctx(),
          entry.org ?? ORG,
          writeEnvelope(entry.body),
        ),
        JSON.stringify(entry.body),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(store.calls).toEqual([]);
    expect(auth.csrfCalls).toBe(0);
    expect(auth.beginCalls).toBe(0);
  });

  it("runs CSRF before begin and stops before the repository when CSRF fails", async () => {
    const { store, auth, service } = harness();
    auth.csrfError = AUTH_ERRORS.csrfRejected();
    await expect(
      service.createListingDraft(ctx(), ORG, writeEnvelope({
        mutationId: MUTATION,
        providerId: PROVIDER,
        content: content(),
      })),
    ).rejects.toMatchObject({ status: 403 });
    expect(auth.csrfCalls).toBe(1);
    expect(auth.beginCalls).toBe(0);
    expect(store.calls).toEqual([]);
  });

  it("never touches the repository when begin rejects", async () => {
    const { store, auth, service } = harness();
    auth.beginError = AUTH_ERRORS.unauthenticated();
    await expect(
      service.createListingDraft(ctx(), ORG, writeEnvelope({
        mutationId: MUTATION,
        providerId: PROVIDER,
        content: content(),
      })),
    ).rejects.toMatchObject({ status: 401 });
    expect(store.calls).toEqual([]);
  });

  it("does not retry or finish after an unknown commit outcome", async () => {
    const { store, auth, service } = harness();
    store.error = new MarketStoreError("MARKET_STORE_OUTCOME_UNKNOWN");
    await expect(
      service.createListingDraft(ctx(), ORG, writeEnvelope({
        mutationId: MUTATION,
        providerId: PROVIDER,
        content: content(),
      })),
    ).rejects.toMatchObject({ status: 503 });
    expect(store.calls).toEqual(["createListingDraft"]);
    expect(auth.finishCalls).toBe(0);
  });
});

describe("market service error mapping and projection", () => {
  const cases: Array<[string, number, string]> = [
    ["MARKET_STORE_INPUT_INVALID", 400, "INVALID_REQUEST"],
    ["MARKET_STORE_SESSION_INVALID", 401, "UNAUTHENTICATED"],
    ["MARKET_STORE_FORBIDDEN", 403, "FORBIDDEN"],
    ["MARKET_STORE_NOT_FOUND", 403, "FORBIDDEN"],
    ["MARKET_STORE_CONFLICT", 409, "POLICY_DENIED"],
    ["MARKET_STORE_IDEMPOTENCY_CONFLICT", 409, "IDEMPOTENCY_CONFLICT"],
    ["MARKET_STORE_UNAVAILABLE", 503, "INTERNAL_ERROR"],
    ["MARKET_STORE_OUTCOME_UNKNOWN", 503, "INTERNAL_ERROR"],
  ];

  it("maps every closed store code to a fixed, non-echoing error", async () => {
    for (const [code, status, envelopeCode] of cases) {
      const { store, service } = harness();
      store.error = new MarketStoreError(code as never);
      try {
        await service.listOwnerListings(ctx(), { organizationId: ORG });
        throw new Error("expected rejection");
      } catch (error) {
        expect(statusOf(error), code).toBe(status);
        expect((error as AuthApiError).code, code).toBe(envelopeCode);
        expect((error as Error).message, code).not.toContain("/workspace");
      }
    }
  });

  it("maps an unknown repository error to a non-reflecting 503", async () => {
    const { store, service } = harness();
    store.error = new Error("raw driver detail PRIVATE");
    try {
      await service.listOwnerListings(ctx(), { organizationId: ORG });
      throw new Error("expected rejection");
    } catch (error) {
      expect((error as AuthApiError).status).toBe(503);
      expect((error as Error).message).not.toContain("PRIVATE");
    }
  });

  it("fails closed with 500 on a wrong operation or resource id", async () => {
    const wrongOperation = harness();
    wrongOperation.store.draftResult = versionReceipt(LISTING, "2", MUTATION);
    await expect(
      wrongOperation.service.createListingDraft(ctx(), ORG, writeEnvelope({
        mutationId: MUTATION,
        providerId: PROVIDER,
        content: content(),
      })),
    ).rejects.toMatchObject({ status: 500 });

    const wrongResource = harness();
    wrongResource.store.draftResult = listingReceipt(MUTATION2);
    await expect(
      wrongResource.service.createListingDraft(ctx(), ORG, writeEnvelope({
        mutationId: MUTATION,
        providerId: PROVIDER,
        content: content(),
      })),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("accepts a synthetic replayed receipt unchanged", async () => {
    const { store, service } = harness();
    store.draftResult = { ...listingReceipt(), replayed: true };
    const result = await service.createListingDraft(ctx(), ORG, writeEnvelope({
      mutationId: MUTATION,
      providerId: PROVIDER,
      content: content(),
    }));
    expect(result.replayed).toBe(true);
  });

  it("rejects extra keys on replayed and non-replayed write results", async () => {
    const nonReplayed = harness();
    nonReplayed.store.draftResult = { ...listingReceipt(), secret: "PRIVATE" };
    await expect(
      nonReplayed.service.createListingDraft(ctx(), ORG, writeEnvelope({
        mutationId: MUTATION,
        providerId: PROVIDER,
        content: content(),
      })),
    ).rejects.toMatchObject({ status: 500 });
    expect(nonReplayed.store.calls).toEqual(["createListingDraft"]);
    expect(nonReplayed.auth.finishCalls).toBe(0);

    const replayed = harness();
    replayed.store.draftResult = {
      ...listingReceipt(),
      replayed: true,
      secret: "PRIVATE",
    };
    await expect(
      replayed.service.createListingDraft(ctx(), ORG, writeEnvelope({
        mutationId: MUTATION,
        providerId: PROVIDER,
        content: content(),
      })),
    ).rejects.toMatchObject({ status: 500 });
    expect(replayed.store.calls).toEqual(["createListingDraft"]);
  });

  it("rejects an extra key on a version write result without a retry", async () => {
    const { store, auth, service } = harness();
    store.createVersionResult = {
      ...versionReceipt(LISTING, "2", MUTATION2),
      secret: "PRIVATE",
    };
    await expect(
      service.createListingVersion(ctx(), ORG, LISTING, writeEnvelope({
        mutationId: MUTATION2,
        expectedLatestVersion: "1",
        content: content(),
      })),
    ).rejects.toMatchObject({ status: 500 });
    expect(store.calls).toEqual(["createListingVersion"]);
    expect(auth.csrfCalls).toBe(1);
    expect(auth.beginCalls).toBe(1);
  });
});

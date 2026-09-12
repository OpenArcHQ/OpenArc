import { describe, expect, it } from "vitest";

import {
  CommerceMarketOriginReviewBodySchema,
  type CommerceListingOwner,
  type CommerceListingOwnerVersion,
  type CommerceMarketMutationStatus,
  type CommerceMarketProviderOption,
} from "@openarc/shared";
import {
  MarketStoreError,
  type LifecycleMutationReceipt,
  type LifecycleMutationResult,
  type LifecycleOperation,
} from "@openarc/db";

import { AUTH_ERRORS, type AuthApiError } from "../src/auth/errors.js";
import type { AuthRequestContext } from "../src/auth/service.js";
import type {
  MarketLifecycleAuthPort,
  MarketLifecycleMutationStatus,
  MarketLifecycleStorePort,
} from "../src/market/lifecycle-ports.js";
import { MarketLifecycleService } from "../src/market/lifecycle-service.js";

/**
 * Focused unit coverage for the protected marketplace lifecycle service.
 *
 * The lifecycle repository and auth port are HONESTLY MOCKED: this suite proves
 * strict parse ordering, the CSRF-before-begin contract, exactly-one repository
 * write per mutation, the absence of any post-commit read/auth check, closed
 * DB error mapping and strict receipt/status projection binding. Real roles,
 * sessions, locks, grants, idempotency rows and SQL enforcement are NOT claimed
 * here and are deferred to the PostgreSQL packet after DB7.
 */

const MUTATION = "12345678-1234-4234-8123-123456789abc";
const ORG = `openarc:org:${MUTATION}`;
const LISTING = `openarc:listing:${MUTATION}`;
const PROVIDER = `openarc:provider:${MUTATION}`;
const VERSION = "1";
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
  version: VERSION,
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
  mutationId = MUTATION,
): LifecycleMutationReceipt {
  return {
    mutationId,
    operation,
    resourceType: "listing_version",
    resourceId,
    committedAt: ISO,
  };
}

function result(
  operation: LifecycleOperation,
  resourceId: string,
  replayed = false,
): LifecycleMutationResult {
  return { replayed, receipt: receipt(operation, resourceId) };
}

class FakeStore implements MarketLifecycleStorePort {
  calls: string[] = [];
  error: unknown;
  override: unknown;
  ownerListing: CommerceListingOwner | null = OWNER_LISTING;
  version: CommerceListingOwnerVersion | null = OWNER_VERSION;
  providers: CommerceMarketProviderOption[] = [PROVIDER_OPTION];
  providerCursor: string | null = null;
  statusResult: MarketLifecycleMutationStatus = {
    status: "committed",
    receipt: receipt("market.listing.version.publish", `${LISTING}@${VERSION}`),
  };

  #record(name: string): unknown {
    this.calls.push(name);
    if (this.error) throw this.error;
    return this.override;
  }

  async getOwnerListing(): Promise<CommerceListingOwner | null> {
    const value = this.#record("getOwnerListing");
    if (value !== undefined) return value as CommerceListingOwner | null;
    return this.ownerListing;
  }
  async listMarketProviders(): Promise<{
    items: CommerceMarketProviderOption[];
    nextCursor: string | null;
  }> {
    const value = this.#record("listMarketProviders");
    if (value !== undefined) return value as never;
    return { items: this.providers, nextCursor: this.providerCursor };
  }
  async getModeratorListingVersion(): Promise<CommerceListingOwnerVersion | null> {
    const value = this.#record("getModeratorListingVersion");
    if (value !== undefined) return value as CommerceListingOwnerVersion | null;
    return this.version;
  }
  async recordOriginReview(): Promise<LifecycleMutationResult> {
    const value = this.#record("recordOriginReview");
    if (value !== undefined) return value as LifecycleMutationResult;
    return result(
      "market.listing.origin_review.record",
      `${LISTING}@${VERSION}`,
    );
  }
  async publishListingVersion(): Promise<LifecycleMutationResult> {
    const value = this.#record("publishListingVersion");
    if (value !== undefined) return value as LifecycleMutationResult;
    return result("market.listing.version.publish", `${LISTING}@${VERSION}`);
  }
  async pauseListingVersion(): Promise<LifecycleMutationResult> {
    const value = this.#record("pauseListingVersion");
    if (value !== undefined) return value as LifecycleMutationResult;
    return result("market.listing.version.pause", `${LISTING}@${VERSION}`);
  }
  async retireListingVersion(): Promise<LifecycleMutationResult> {
    const value = this.#record("retireListingVersion");
    if (value !== undefined) return value as LifecycleMutationResult;
    return result("market.listing.version.retire", `${LISTING}@${VERSION}`);
  }
  async getLifecycleMutationStatus(): Promise<MarketLifecycleMutationStatus> {
    const value = this.#record("getLifecycleMutationStatus");
    if (value !== undefined) return value as MarketLifecycleMutationStatus;
    return this.statusResult;
  }
}

class FakeAuth implements MarketLifecycleAuthPort {
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
    return { sessionHash: HASH, accountId: `openarc:account:${MUTATION}` };
  }
  async finishTenantRead(): Promise<void> {
    this.finishCalls += 1;
    if (this.finishError) throw this.finishError;
  }
}

const CTX: AuthRequestContext = {
  peerIp: "127.0.0.1",
  cookies: { session: "s", binding: "b" },
};

function harness() {
  const store = new FakeStore();
  const auth = new FakeAuth();
  const service = new MarketLifecycleService({ auth, store });
  return { store, auth, service };
}

async function expectError(
  work: Promise<unknown>,
  code: string,
  status: number,
): Promise<void> {
  await expect(work).rejects.toMatchObject({ code, status });
}

const PUBLISH_BODY = {
  mutationId: MUTATION,
  expectedUpdatedAt: ISO,
  expectedActiveVersion: null,
};

const REVIEW_BODY = {
  mutationId: MUTATION,
  expectedUpdatedAt: ISO,
  decision: "approved",
  reviewedEndpointDigest: DIGEST,
  reasonCode: "manual_review",
  reasonDigest: null,
};

describe("lifecycle reads", () => {
  it("begin -> exactly one store read -> finish, then binds the root detail", async () => {
    const { store, auth, service } = harness();
    const data = await service.getOwnerListing(CTX, {
      organizationId: ORG,
      listingId: LISTING,
    });
    expect(store.calls).toEqual(["getOwnerListing"]);
    expect(auth.beginCalls).toBe(1);
    expect(auth.finishCalls).toBe(1);
    expect(data.item?.listingId).toBe(LISTING);
  });

  it("returns a truthful nullable 200 for an owner miss", async () => {
    const { store, service } = harness();
    store.ownerListing = null;
    const data = await service.getOwnerListing(CTX, {
      organizationId: ORG,
      listingId: LISTING,
    });
    expect(data.item).toBeNull();
    expect(data.listingId).toBe(LISTING);
  });

  it("rejects invalid input BEFORE any auth or store work", async () => {
    const { store, auth, service } = harness();
    await expectError(
      service.getOwnerListing(CTX, { organizationId: "bad", listingId: LISTING }),
      "INVALID_REQUEST",
      400,
    );
    expect(auth.beginCalls).toBe(0);
    expect(store.calls).toEqual([]);
  });

  it("rejects a root detail whose item does not bind the path target", async () => {
    const { store, service } = harness();
    store.ownerListing = { ...OWNER_LISTING, listingId: `openarc:listing:${"c".repeat(8)}-1234-4234-8123-123456789abc` };
    await expectError(
      service.getOwnerListing(CTX, { organizationId: ORG, listingId: LISTING }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("binds moderator version detail to the exact path target", async () => {
    const { service } = harness();
    const data = await service.getModeratorListingVersion(CTX, {
      organizationId: ORG,
      listingId: LISTING,
      version: VERSION,
    });
    expect(data.item?.version).toBe(VERSION);
  });
});

describe("lifecycle provider options page", () => {
  it("projects a strict ordered unique page with the default limit", async () => {
    const { service } = harness();
    const page = await service.listMarketProviders(CTX, {
      organizationId: ORG,
    });
    expect(page.organizationId).toBe(ORG);
    expect(page.items).toEqual([PROVIDER_OPTION]);
  });

  it("rejects a page larger than the requested limit", async () => {
    const { store, service } = harness();
    store.providers = [
      { ...PROVIDER_OPTION, providerId: `openarc:provider:${MUTATION}` },
      {
        ...PROVIDER_OPTION,
        providerId: `openarc:provider:${"c".repeat(8)}-1234-4234-8123-123456789abc`,
      },
    ];
    await expectError(
      service.listMarketProviders(CTX, { organizationId: ORG, limit: 1 }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("rejects a non-ascending page", async () => {
    const { store, service } = harness();
    store.providers = [
      {
        ...PROVIDER_OPTION,
        providerId: `openarc:provider:${"c".repeat(8)}-1234-4234-8123-123456789abc`,
      },
      PROVIDER_OPTION,
    ];
    await expectError(
      service.listMarketProviders(CTX, { organizationId: ORG }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("rejects an item not strictly after the supplied cursor", async () => {
    const { store, service } = harness();
    store.providers = [PROVIDER_OPTION];
    await expectError(
      service.listMarketProviders(CTX, {
        organizationId: ORG,
        afterProviderId: `openarc:provider:ffffffff-1234-4234-8123-123456789abc`,
      }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("rejects a malformed page envelope with an extra key", async () => {
    const { store, service } = harness();
    store.override = { items: [], nextCursor: null, extra: true };
    await expectError(
      service.listMarketProviders(CTX, { organizationId: ORG }),
      "INTERNAL_ERROR",
      500,
    );
  });
});

describe("lifecycle writes", () => {
  it("parses input before CSRF and CSRF before begin", async () => {
    const { store, auth, service } = harness();
    await expectError(
      service.publishListingVersion(CTX, ORG, LISTING, VERSION, {
        ctx: CTX,
        csrf: "t",
        idempotencyKey: IDEMPOTENCY,
        body: { unexpected: true },
      }),
      "INVALID_REQUEST",
      400,
    );
    expect(auth.csrfCalls).toBe(0);
    expect(auth.beginCalls).toBe(0);
    expect(store.calls).toEqual([]);
  });

  it("does not begin or write when CSRF verification fails", async () => {
    const { store, auth, service } = harness();
    auth.csrfError = AUTH_ERRORS.csrfRejected();
    await expectError(
      service.publishListingVersion(CTX, ORG, LISTING, VERSION, {
        ctx: CTX,
        csrf: "t",
        idempotencyKey: IDEMPOTENCY,
        body: PUBLISH_BODY,
      }),
      "CSRF_REJECTED",
      403,
    );
    expect(auth.beginCalls).toBe(0);
    expect(store.calls).toEqual([]);
  });

  it("invokes exactly one store write with no finish or post-commit read", async () => {
    const { store, auth, service } = harness();
    const data = await service.publishListingVersion(CTX, ORG, LISTING, VERSION, {
      ctx: CTX,
      csrf: "t",
      idempotencyKey: IDEMPOTENCY,
      body: PUBLISH_BODY,
    });
    expect(store.calls).toEqual(["publishListingVersion"]);
    expect(auth.beginCalls).toBe(1);
    expect(auth.finishCalls).toBe(0);
    expect(data.receipt.operation).toBe("market.listing.version.publish");
    expect(data.receipt.resourceId).toBe(`${LISTING}@${VERSION}`);
  });

  it("returns the ORIGINAL replayed receipt unchanged", async () => {
    const { store, service } = harness();
    const original = result(
      "market.listing.version.publish",
      `${LISTING}@${VERSION}`,
      true,
    );
    store.override = original;
    const data = await service.publishListingVersion(CTX, ORG, LISTING, VERSION, {
      ctx: CTX,
      csrf: "t",
      idempotencyKey: IDEMPOTENCY,
      body: PUBLISH_BODY,
    });
    expect(data).toEqual(original);
  });

  it("rejects a receipt whose operation does not match the invoked write", async () => {
    const { store, service } = harness();
    store.override = result(
      "market.listing.version.pause",
      `${LISTING}@${VERSION}`,
    );
    await expectError(
      service.publishListingVersion(CTX, ORG, LISTING, VERSION, {
        ctx: CTX,
        csrf: "t",
        idempotencyKey: IDEMPOTENCY,
        body: PUBLISH_BODY,
      }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("rejects a receipt whose resource id does not bind listingId@version", async () => {
    const { store, service } = harness();
    store.override = result("market.listing.version.publish", `${LISTING}@2`);
    await expectError(
      service.publishListingVersion(CTX, ORG, LISTING, VERSION, {
        ctx: CTX,
        csrf: "t",
        idempotencyKey: IDEMPOTENCY,
        body: PUBLISH_BODY,
      }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("rejects a draft operation observed through a lifecycle write", async () => {
    const { store, service } = harness();
    store.override = {
      replayed: false,
      receipt: {
        mutationId: MUTATION,
        operation: "market.listing.create",
        resourceType: "listing",
        resourceId: `openarc:listing:${MUTATION}`,
        committedAt: ISO,
      },
    };
    await expectError(
      service.publishListingVersion(CTX, ORG, LISTING, VERSION, {
        ctx: CTX,
        csrf: "t",
        idempotencyKey: IDEMPOTENCY,
        body: PUBLISH_BODY,
      }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("maps origin-review input and returns the review-record receipt", async () => {
    const { store, service } = harness();
    expect(
      CommerceMarketOriginReviewBodySchema.safeParse(REVIEW_BODY).success,
    ).toBe(true);
    const data = await service.recordOriginReview(CTX, ORG, LISTING, VERSION, {
      ctx: CTX,
      csrf: "t",
      idempotencyKey: IDEMPOTENCY,
      body: REVIEW_BODY,
    });
    expect(store.calls).toEqual(["recordOriginReview"]);
    expect(data.receipt.operation).toBe("market.listing.origin_review.record");
  });

  it("never trusts a body-supplied role", async () => {
    const { auth, service } = harness();
    await expectError(
      service.pauseListingVersion(CTX, ORG, LISTING, VERSION, {
        ctx: CTX,
        csrf: "t",
        idempotencyKey: IDEMPOTENCY,
        body: { ...PUBLISH_BODY, role: "owner" },
      }),
      "INVALID_REQUEST",
      400,
    );
    expect(auth.csrfCalls).toBe(0);
  });
});

describe("closed DB error mapping", () => {
  const table: ReadonlyArray<readonly [string, number, string]> = [
    ["MARKET_STORE_INPUT_INVALID", 400, "INVALID_REQUEST"],
    ["MARKET_STORE_SESSION_INVALID", 401, "UNAUTHENTICATED"],
    ["MARKET_STORE_FORBIDDEN", 403, "FORBIDDEN"],
    ["MARKET_STORE_NOT_FOUND", 403, "FORBIDDEN"],
    ["MARKET_STORE_CONFLICT", 409, "POLICY_DENIED"],
    ["MARKET_STORE_IDEMPOTENCY_CONFLICT", 409, "IDEMPOTENCY_CONFLICT"],
    ["MARKET_STORE_UNAVAILABLE", 503, "INTERNAL_ERROR"],
    ["MARKET_STORE_OUTCOME_UNKNOWN", 503, "INTERNAL_ERROR"],
  ];

  for (const [storeCode, status, code] of table) {
    it(`maps ${storeCode} to a fixed ${status} ${code}`, async () => {
      const { store, service } = harness();
      store.error = new MarketStoreError(
        storeCode as ConstructorParameters<typeof MarketStoreError>[0],
      );
      await expectError(
        service.getOwnerListing(CTX, { organizationId: ORG, listingId: LISTING }),
        code,
        status,
      );
    });
  }
});

describe("lifecycle mutation status", () => {
  it("returns a committed lifecycle receipt with an own-actor binding", async () => {
    const { service } = harness();
    const status: CommerceMarketMutationStatus =
      await service.getLifecycleMutationStatus(CTX, {
        organizationId: ORG,
        mutationId: MUTATION,
      });
    if (status.status !== "committed") throw new Error("expected committed");
    expect(status.receipt.mutationId).toBe(MUTATION);
  });

  it("returns not_found verbatim", async () => {
    const { store, service } = harness();
    store.statusResult = { status: "not_found" };
    const status = await service.getLifecycleMutationStatus(CTX, {
      organizationId: ORG,
      mutationId: MUTATION,
    });
    expect(status).toEqual({ status: "not_found" });
  });

  it("rejects the two draft operations observed through a lifecycle status", async () => {
    const { store, service } = harness();
    store.statusResult = {
      status: "committed",
      receipt: receipt("market.listing.version.publish", `${LISTING}@1`, MUTATION),
    };
    store.override = {
      status: "committed",
      receipt: {
        mutationId: MUTATION,
        operation: "market.listing.version.create",
        resourceType: "listing_version",
        resourceId: `${LISTING}@2`,
        committedAt: ISO,
      },
    };
    await expectError(
      service.getLifecycleMutationStatus(CTX, {
        organizationId: ORG,
        mutationId: MUTATION,
      }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("rejects a tenant operation observed through a lifecycle status", async () => {
    const { store, service } = harness();
    store.override = {
      status: "committed",
      receipt: {
        mutationId: MUTATION,
        operation: "tenant.organization.create",
        resourceType: "organization",
        resourceId: ORG,
        committedAt: ISO,
      },
    };
    await expectError(
      service.getLifecycleMutationStatus(CTX, {
        organizationId: ORG,
        mutationId: MUTATION,
      }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("rejects a status whose mutation id does not match the request", async () => {
    const { store, service } = harness();
    store.override = {
      status: "committed",
      receipt: receipt(
        "market.listing.version.publish",
        `${LISTING}@1`,
        "ffffffff-1234-4234-8123-123456789abc",
      ),
    };
    await expectError(
      service.getLifecycleMutationStatus(CTX, {
        organizationId: ORG,
        mutationId: MUTATION,
      }),
      "INTERNAL_ERROR",
      500,
    );
  });

  it("rejects a status envelope with an extra key", async () => {
    const { store, service } = harness();
    store.override = {
      status: "committed",
      receipt: receipt("market.listing.version.publish", `${LISTING}@1`),
      extra: true,
    };
    await expectError(
      service.getLifecycleMutationStatus(CTX, {
        organizationId: ORG,
        mutationId: MUTATION,
      }),
      "INTERNAL_ERROR",
      500,
    );
  });
});

describe("final finishTenantRead rejection after a successful store read", () => {
  // The strict read ordering is parse -> begin -> exactly one store read ->
  // finish -> project. The repository read succeeds and returns a DTO that
  // WOULD have projected, but the FINAL authenticated step (`finishTenantRead`)
  // rejects with the genuine accepted-catalog unauthenticated error. The
  // service must surface that exact error, return NO protected DTO, invoke
  // exactly one begin/store/finish and never retry the read.
  const NO_DTO = "NO_DTO";

  async function expectFinishDenied(work: Promise<unknown>): Promise<void> {
    let leaked: unknown = NO_DTO;
    await expect(
      work.then(
        (value) => {
          leaked = value;
        },
        (error: unknown) => {
          throw error;
        },
      ),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED", status: 401 });
    expect(leaked).toBe(NO_DTO);
  }

  it("denies an otherwise valid root detail after the store read", async () => {
    const { store, auth, service } = harness();
    auth.finishError = AUTH_ERRORS.unauthenticated();
    await expectFinishDenied(
      service.getOwnerListing(CTX, { organizationId: ORG, listingId: LISTING }),
    );
    expect(store.calls).toEqual(["getOwnerListing"]);
    expect(auth.beginCalls).toBe(1);
    expect(auth.finishCalls).toBe(1);
  });

  it("denies an otherwise valid provider options page after the store read", async () => {
    const { store, auth, service } = harness();
    auth.finishError = AUTH_ERRORS.unauthenticated();
    await expectFinishDenied(
      service.listMarketProviders(CTX, { organizationId: ORG }),
    );
    expect(store.calls).toEqual(["listMarketProviders"]);
    expect(auth.beginCalls).toBe(1);
    expect(auth.finishCalls).toBe(1);
  });

  it("denies an otherwise valid moderator version detail after the store read", async () => {
    const { store, auth, service } = harness();
    auth.finishError = AUTH_ERRORS.unauthenticated();
    await expectFinishDenied(
      service.getModeratorListingVersion(CTX, {
        organizationId: ORG,
        listingId: LISTING,
        version: VERSION,
      }),
    );
    expect(store.calls).toEqual(["getModeratorListingVersion"]);
    expect(auth.beginCalls).toBe(1);
    expect(auth.finishCalls).toBe(1);
  });

  it("denies an otherwise valid committed lifecycle status after the store read", async () => {
    const { store, auth, service } = harness();
    auth.finishError = AUTH_ERRORS.unauthenticated();
    await expectFinishDenied(
      service.getLifecycleMutationStatus(CTX, {
        organizationId: ORG,
        mutationId: MUTATION,
      }),
    );
    expect(store.calls).toEqual(["getLifecycleMutationStatus"]);
    expect(auth.beginCalls).toBe(1);
    expect(auth.finishCalls).toBe(1);
  });

  it("denies an otherwise valid not_found lifecycle status after the store read", async () => {
    const { store, auth, service } = harness();
    store.statusResult = { status: "not_found" };
    auth.finishError = AUTH_ERRORS.unauthenticated();
    await expectFinishDenied(
      service.getLifecycleMutationStatus(CTX, {
        organizationId: ORG,
        mutationId: MUTATION,
      }),
    );
    expect(store.calls).toEqual(["getLifecycleMutationStatus"]);
    expect(auth.beginCalls).toBe(1);
    expect(auth.finishCalls).toBe(1);
  });
});

import { describe, expect, expectTypeOf, it, vi } from "vitest";

import {
  CommerceMarketDraftCreateBodySchema,
  CommerceMarketListingContentSchema,
  CommerceMarketMutationReceiptSchema,
  CommerceMarketMutationResultResponseSchema,
  CommerceMarketMutationResultSchema,
  CommerceMarketMutationStatusRequestSchema,
  CommerceMarketMutationStatusResponseSchema,
  CommerceMarketMutationStatusSchema,
  CommerceMarketOwnerListRequestSchema,
  CommerceMarketOwnerPageResponseSchema,
  CommerceMarketOwnerPageSchema,
  CommerceMarketOwnerVersionDetailResponseSchema,
  CommerceMarketOwnerVersionDetailSchema,
  CommerceMarketOwnerVersionPageResponseSchema,
  CommerceMarketOwnerVersionPageSchema,
  CommerceMarketOwnerVersionRequestSchema,
  CommerceMarketOwnerVersionsRequestSchema,
  CommerceMarketPublicDetailRequestSchema,
  CommerceMarketPublicDetailResponseSchema,
  CommerceMarketPublicDetailSchema,
  CommerceMarketPublicListRequestSchema,
  CommerceMarketPublicPageResponseSchema,
  CommerceMarketPublicPageSchema,
  CommerceMarketPublicProviderDetailResponseSchema,
  CommerceMarketPublicProviderDetailSchema,
  CommerceMarketPublicProviderRequestSchema,
  CommerceMarketPublicProviderSchema,
  CommerceMarketVersionCreateBodySchema,
  CommerceMarketVersionResourceIdSchema,
  type CommerceMarketListingContent,
  type CommerceMarketMutationReceipt,
  type CommerceMarketMutationResult,
  type CommerceMarketMutationStatus,
  type CommerceMarketOwnerVersionPage,
  type CommerceMarketPublicListRequest,
  type CommerceMarketPublicProvider,
} from "../src/index.js";
import {
  CommerceMarketOwnerPageSchema as DirectOwnerPageSchema,
  CommerceMarketPublicProviderSchema as DirectPublicProviderSchema,
} from "../src/commerce/market.js";

const V4 = "12345678-1234-4234-8123-123456789abc";
const V4_B = "87654321-4321-4321-b123-abcdefabcdef";
const V4_C = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const MUTATION = V4;
const MUTATION_B = V4_B;

const LISTING_ID = `openarc:listing:${V4}`;
const LISTING_ID_B = `openarc:listing:${V4_B}`;
const ORG_ID = `openarc:org:${V4}`;
const ORG_ID_B = `openarc:org:${V4_B}`;
const PROVIDER_ID = `openarc:provider:${V4_B}`;
const PROVIDER_ID_B = `openarc:provider:${V4_C}`;

const CREATED_AT = "2025-01-01T00:00:00.000Z";
const UPDATED_AT = "2025-01-02T00:00:00.000Z";
const PUBLISHED_AT = "2025-01-01T12:00:00.000Z";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;

const CANARY = "PRIVATE_CANARY_DO_NOT_ECHO";
const SAMPLE_UUID = "9f1c2d34-5e6a-4b7c-8d9e-0f1a2b3c4d5e";
const SAMPLE_SHA = "0123456789abcdef0123456789abcdef01234567";

const META = {
  schemaVersion: "openarc.api.v2" as const,
  requestId: SAMPLE_UUID,
  buildSha: SAMPLE_SHA,
};

function usdc(atomicAmount: string): Record<string, unknown> {
  return {
    schemaVersion: "openarc.usdc-amount.v1",
    networkId: "eip155:5042002",
    asset: "USDC",
    representation: "erc20",
    decimals: 6,
    atomicAmount,
  };
}

function manifest(): Record<string, unknown> {
  return {
    schemaVersion: "openarc.listing-manifest.v1",
    inputSchemaDigest: DIGEST_A,
    outputSchemaDigest: DIGEST_B,
  };
}

function evidenceContract(): Record<string, unknown> {
  return {
    schemaVersion: "openarc.receipt-contract.v1",
    receiptType: "api_call",
    receiptSchemaDigest: DIGEST_C,
    deliveryFields: ["request_id", "status"],
  };
}

function content(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    kind: "api",
    title: "Weather API",
    description: "Returns short-range forecasts.",
    manifest: manifest(),
    price: { amount: usdc("1000000"), pricingModel: "fixed" },
    evidenceContract: evidenceContract(),
    endpointContract: {
      origin: "https://api.example.com",
      path: "/v1/messages",
    },
    termsRevision: "2025-01",
    privacySummary: "Request metadata is retained for 30 days.",
    paymentLane: "unavailable",
    availability: { status: "available", rateLimitPerMinute: "60" },
    ...overrides,
  };
}

function ownerRoot(
  listingId = LISTING_ID,
  organizationId = ORG_ID,
  providerId = PROVIDER_ID,
  activeVersion: string | null = null,
): Record<string, unknown> {
  return {
    schemaVersion: "openarc.listing.v1",
    listingId,
    organizationId,
    providerId,
    activeVersion,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

function ownerVersion(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: "openarc.listing-owner-version.v1",
    listingId: LISTING_ID,
    organizationId: ORG_ID,
    providerId: PROVIDER_ID,
    version: "1",
    ...content(),
    originReviewState: "approved",
    status: "active",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    publishedAt: PUBLISHED_AT,
    ...overrides,
  };
}

function publicVersion(
  listingId = LISTING_ID,
  providerId = PROVIDER_ID,
  version = "1",
): Record<string, unknown> {
  return {
    schemaVersion: "openarc.listing-public-version.v1",
    listingId,
    providerId,
    version,
    kind: "api",
    title: "Weather API",
    description: "Returns short-range forecasts.",
    manifest: manifest(),
    price: { amount: usdc("1000000"), pricingModel: "fixed" },
    evidenceContract: evidenceContract(),
    endpointOrigin: "https://api.example.com",
    termsRevision: "2025-01",
    privacySummary: "Request metadata is retained for 30 days.",
    paymentLane: "unavailable",
    availability: { status: "available", rateLimitPerMinute: "60" },
    status: "active",
    publishedAt: PUBLISHED_AT,
  };
}

function publicProvider(providerId = PROVIDER_ID): Record<string, unknown> {
  return {
    schemaVersion: "openarc.provider-public.v1",
    providerId,
    displayName: "Acme Provider",
    status: "active",
  };
}

/** Zero-padded hex UUIDs that sort lexically in the same order as `n`. */
function listIdFor(n: number): string {
  return `openarc:listing:00000000-0000-4000-8000-${n
    .toString(16)
    .padStart(12, "0")}`;
}

function listingReceipt(
  mutationId = MUTATION,
  resourceId = LISTING_ID,
): Record<string, unknown> {
  return {
    mutationId,
    operation: "market.listing.create",
    resourceType: "listing",
    resourceId,
    committedAt: CREATED_AT,
  };
}

function versionReceipt(
  mutationId = MUTATION,
  resourceId = `${LISTING_ID}@2`,
): Record<string, unknown> {
  return {
    mutationId,
    operation: "market.listing.version.create",
    resourceType: "listing_version",
    resourceId,
    committedAt: CREATED_AT,
  };
}

type ParseableSchema = {
  safeParse(value: unknown): { success: boolean };
};

describe("market listing content", () => {
  it("accepts the exact allowlisted content leaves", () => {
    expect(CommerceMarketListingContentSchema.safeParse(content()).success).toBe(
      true,
    );
    const parsed = CommerceMarketListingContentSchema.parse(content());
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "availability",
        "description",
        "endpointContract",
        "evidenceContract",
        "kind",
        "manifest",
        "paymentLane",
        "price",
        "privacySummary",
        "termsRevision",
        "title",
      ].sort(),
    );
  });

  it("keeps paymentLane unavailable and rejects every forbidden leaf", () => {
    const forbidden = [
      "schemaVersion",
      "listingId",
      "organizationId",
      "providerId",
      "version",
      "status",
      "originReviewState",
      "createdAt",
      "updatedAt",
      "publishedAt",
      "actor",
      "key",
      "secret",
      "payment",
      "reputation",
      "arbitrary",
    ];
    for (const key of forbidden) {
      expect(
        CommerceMarketListingContentSchema.safeParse({
          ...content(),
          [key]: CANARY,
        }).success,
        `expected rejection of forbidden leaf ${key}`,
      ).toBe(false);
    }
    expect(
      CommerceMarketListingContentSchema.safeParse(
        content({ paymentLane: "available" }),
      ).success,
    ).toBe(false);
  });

  it("rejects missing leaves and extra keys at every nested level", () => {
    const missingTitle: Record<string, unknown> = { ...content() };
    delete missingTitle.title;
    expect(
      CommerceMarketListingContentSchema.safeParse(missingTitle).success,
    ).toBe(false);

    expect(
      CommerceMarketListingContentSchema.safeParse(
        content({
          price: {
            amount: usdc("1000000"),
            pricingModel: "fixed",
            tax: "0",
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      CommerceMarketListingContentSchema.safeParse(
        content({
          price: {
            amount: { ...usdc("1000000"), extraAtomic: CANARY },
            pricingModel: "fixed",
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      CommerceMarketListingContentSchema.safeParse(
        content({ manifest: { ...manifest(), extra: CANARY } }),
      ).success,
    ).toBe(false);
    expect(
      CommerceMarketListingContentSchema.safeParse(
        content({
          endpointContract: {
            origin: "https://api.example.com",
            path: "/v1",
            host: CANARY,
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      CommerceMarketListingContentSchema.safeParse(
        content({
          availability: {
            status: "available",
            rateLimitPerMinute: "60",
            extra: 1,
          },
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects a money model that is not erc20/6 positive USDC", () => {
    const badAmounts = [
      usdc("0"),
      { ...usdc("1000000"), decimals: 18, representation: "native" },
      { ...usdc("1000000"), networkId: "eip155:1" },
      { ...usdc("1000000"), asset: "DAI" },
      { ...usdc("1000000"), schemaVersion: "openarc.usdc-amount.v2" },
      { ...usdc("1000000"), atomicAmount: "01" },
      { ...usdc("1000000"), atomicAmount: "1e6" },
    ];
    for (const amount of badAmounts) {
      expect(
        CommerceMarketListingContentSchema.safeParse(
          content({ price: { amount, pricingModel: "fixed" } }),
        ).success,
        `expected rejection of amount ${JSON.stringify(amount)}`,
      ).toBe(false);
    }
    expect(
      CommerceMarketListingContentSchema.safeParse(
        content({
          price: { amount: usdc("1000000"), pricingModel: "metered" },
        }),
      ).success,
    ).toBe(false);
  });
});

describe("market write bodies", () => {
  it("accepts the exact draft create body", () => {
    expect(
      CommerceMarketDraftCreateBodySchema.safeParse({
        mutationId: MUTATION,
        providerId: PROVIDER_ID,
        content: content(),
      }).success,
    ).toBe(true);
  });

  it("accepts the version body with canonical expected version", () => {
    for (const expectedLatestVersion of ["1", "2", "999999999"]) {
      expect(
        CommerceMarketVersionCreateBodySchema.safeParse({
          mutationId: MUTATION,
          expectedLatestVersion,
          content: content(),
        }).success,
      ).toBe(true);
    }
    for (const expectedLatestVersion of [
      "0",
      "00",
      "01",
      "1000000000",
      "1e3",
      "1.0",
      1,
      null,
    ]) {
      expect(
        CommerceMarketVersionCreateBodySchema.safeParse({
          mutationId: MUTATION,
          expectedLatestVersion,
          content: content(),
        }).success,
        `expected rejection of expectedLatestVersion ${String(
          expectedLatestVersion,
        )}`,
      ).toBe(false);
    }
  });

  it("never duplicates organization/listing targets in the body", () => {
    for (const key of [
      "organizationId",
      "listingId",
      "version",
      "status",
      "idempotencyKey",
      "principal",
      "session",
      "actor",
      "secret",
    ]) {
      expect(
        CommerceMarketDraftCreateBodySchema.safeParse({
          mutationId: MUTATION,
          providerId: PROVIDER_ID,
          content: content(),
          [key]: CANARY,
        }).success,
      ).toBe(false);
      expect(
        CommerceMarketVersionCreateBodySchema.safeParse({
          mutationId: MUTATION,
          expectedLatestVersion: "1",
          content: content(),
          [key]: CANARY,
        }).success,
      ).toBe(false);
    }
    expect(
      CommerceMarketDraftCreateBodySchema.safeParse({
        mutationId: MUTATION,
        providerId: PROVIDER_ID,
        content: { ...content(), listingId: LISTING_ID },
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketDraftCreateBodySchema.safeParse({
        mutationId: MUTATION,
        providerId: `openarc:org:${V4}`,
        content: content(),
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketDraftCreateBodySchema.safeParse({
        mutationId: MUTATION.toUpperCase(),
        providerId: PROVIDER_ID,
        content: content(),
      }).success,
    ).toBe(false);
  });
});

describe("market read request objects", () => {
  it("accepts owner list requests with omitted or supplied optionals", () => {
    expect(
      CommerceMarketOwnerListRequestSchema.safeParse({ organizationId: ORG_ID })
        .success,
    ).toBe(true);
    expect(
      CommerceMarketOwnerListRequestSchema.safeParse({
        organizationId: ORG_ID,
        afterListingId: LISTING_ID,
        limit: 1,
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketOwnerListRequestSchema.safeParse({
        organizationId: ORG_ID,
        limit: 50,
      }).success,
    ).toBe(true);
  });

  it("rejects unknown keys and explicit undefined optionals", () => {
    expect(
      CommerceMarketOwnerListRequestSchema.safeParse({
        organizationId: ORG_ID,
        accountId: CANARY,
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketOwnerListRequestSchema.safeParse({
        organizationId: ORG_ID,
        afterListingId: undefined,
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketOwnerListRequestSchema.safeParse({
        organizationId: ORG_ID,
        limit: undefined,
      }).success,
    ).toBe(false);
    const parsed = CommerceMarketOwnerListRequestSchema.parse({
      organizationId: ORG_ID,
    });
    expect("limit" in parsed).toBe(false);
    expect("afterListingId" in parsed).toBe(false);
  });

  it("enforces integer limits 1..50 on every paged request", () => {
    const cases: readonly (readonly [ParseableSchema, Record<string, unknown>])[] = [
      [CommerceMarketOwnerListRequestSchema, { organizationId: ORG_ID }],
      [
        CommerceMarketOwnerVersionsRequestSchema,
        { organizationId: ORG_ID, listingId: LISTING_ID },
      ],
      [CommerceMarketPublicListRequestSchema, {}],
    ];
    for (const [schema, base] of cases) {
      for (const limit of [0, 51, 1.5, -1, Number.NaN, "1", null]) {
        expect(
          schema.safeParse({ ...base, limit }).success,
          `expected rejection of limit ${String(limit)}`,
        ).toBe(false);
      }
      expect(schema.safeParse({ ...base, limit: 25 }).success).toBe(true);
    }
  });

  it("validates owner version, detail and mutation status requests", () => {
    expect(
      CommerceMarketOwnerVersionsRequestSchema.safeParse({
        organizationId: ORG_ID,
        listingId: LISTING_ID,
        afterVersion: "2",
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketOwnerVersionRequestSchema.safeParse({
        organizationId: ORG_ID,
        listingId: LISTING_ID,
        version: "10",
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketMutationStatusRequestSchema.safeParse({
        organizationId: ORG_ID,
        mutationId: MUTATION,
      }).success,
    ).toBe(true);
    for (const version of ["0", "01", "1000000000"]) {
      expect(
        CommerceMarketOwnerVersionRequestSchema.safeParse({
          organizationId: ORG_ID,
          listingId: LISTING_ID,
          version,
        }).success,
      ).toBe(false);
    }
    expect(
      CommerceMarketMutationStatusRequestSchema.safeParse({
        organizationId: ORG_ID,
        mutationId: MUTATION_B,
        idempotencyKey: CANARY,
      }).success,
    ).toBe(false);
  });

  it("accepts the public catalog list with every optional filter", () => {
    expect(CommerceMarketPublicListRequestSchema.safeParse({}).success).toBe(
      true,
    );
    expect(
      CommerceMarketPublicListRequestSchema.safeParse({
        afterListingId: LISTING_ID,
        limit: 25,
        kind: "mcp_tool",
        providerId: PROVIDER_ID,
        q: "weather forecast",
      }).success,
    ).toBe(true);
  });

  it("validates q as trimmed control-free public search text 1..80", () => {
    const rejected = [
      "",
      " leading",
      "trailing ",
      "a".repeat(81),
      "a\u0000b",
      "a\u007fb",
      "a\u0085b",
      42,
      null,
    ];
    for (const q of rejected) {
      expect(
        CommerceMarketPublicListRequestSchema.safeParse({ q }).success,
        `expected rejection of q ${String(q)}`,
      ).toBe(false);
    }
    expect(
      CommerceMarketPublicListRequestSchema.safeParse({ q: "a".repeat(80) })
        .success,
    ).toBe(true);
    for (const kind of ["api", "data", "workflow"]) {
      expect(
        CommerceMarketPublicListRequestSchema.safeParse({ kind }).success,
      ).toBe(true);
    }
    expect(
      CommerceMarketPublicListRequestSchema.safeParse({ kind: "unknown" })
        .success,
    ).toBe(false);
  });

  it("rejects organization scope on public requests and unknown filters", () => {
    expect(
      CommerceMarketPublicListRequestSchema.safeParse({
        organizationId: ORG_ID,
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketPublicListRequestSchema.safeParse({
        reviewState: "approved",
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketPublicDetailRequestSchema.safeParse({
        listingId: LISTING_ID,
        organizationId: ORG_ID,
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketPublicProviderRequestSchema.safeParse({
        providerId: PROVIDER_ID,
        organizationId: ORG_ID,
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketPublicDetailRequestSchema.safeParse({
        listingId: ORG_ID,
      }).success,
    ).toBe(false);
  });
});

describe("market public provider projection", () => {
  it("accepts exactly the current public profile shape", () => {
    expect(
      CommerceMarketPublicProviderSchema.safeParse(publicProvider()).success,
    ).toBe(true);
    expect(
      CommerceMarketPublicProviderSchema.parse(publicProvider()),
    ).toEqual({
      schemaVersion: "openarc.provider-public.v1",
      providerId: PROVIDER_ID,
      displayName: "Acme Provider",
      status: "active",
    });
  });

  it("rejects organization, account, wallet, key, timestamp and internal status", () => {
    for (const key of [
      "organizationId",
      "accountId",
      "walletAddress",
      "apiKey",
      "createdAt",
      "updatedAt",
      "internalStatus",
      "reputation",
      "claimed",
    ]) {
      expect(
        CommerceMarketPublicProviderSchema.safeParse({
          ...publicProvider(),
          [key]: CANARY,
        }).success,
        `expected rejection of provider leaf ${key}`,
      ).toBe(false);
    }
    expect(
      CommerceMarketPublicProviderSchema.safeParse({
        ...publicProvider(),
        status: "suspended",
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketPublicProviderSchema.safeParse({
        ...publicProvider(),
        displayName: " Bad",
      }).success,
    ).toBe(false);
  });
});

describe("market version resource id", () => {
  it("accepts canonical listing@version with version at least 2", () => {
    for (const version of ["2", "10", "999999999"]) {
      expect(
        CommerceMarketVersionResourceIdSchema.safeParse(
          `${LISTING_ID}@${version}`,
        ).success,
      ).toBe(true);
    }
  });

  it("rejects version 1, missing/extra @ and wrong namespace", () => {
    const rejected = [
      `${LISTING_ID}@1`,
      `${LISTING_ID}@0`,
      `${LISTING_ID}@01`,
      `${LISTING_ID}@1000000000`,
      LISTING_ID,
      `${LISTING_ID}@`,
      "@2",
      `${LISTING_ID}@2@3`,
      `openarc:org:${V4}@2`,
      "openarc:listing:not-a-uuid@2",
      ` ${LISTING_ID}@2`,
      `${LISTING_ID}@2 `,
      `${LISTING_ID}@2\n`,
      42,
      null,
    ];
    for (const value of rejected) {
      expect(
        CommerceMarketVersionResourceIdSchema.safeParse(value).success,
        `expected rejection of ${String(value)}`,
      ).toBe(false);
    }
  });

  it("caps length before splitting and rejects oversized values", () => {
    const oversized = `${LISTING_ID}@${"2".repeat(80)}`;
    expect(oversized.length).toBeGreaterThan(128);
    expect(
      CommerceMarketVersionResourceIdSchema.safeParse(oversized).success,
    ).toBe(false);
  });

  it("stops at the length bound before splitting the raw resource", () => {
    const oversized = `${LISTING_ID}@${"2".repeat(80)}`;
    expect(oversized.length).toBeGreaterThan(128);
    const result = CommerceMarketVersionResourceIdSchema.safeParse(oversized);
    expect(result.success).toBe(false);
    if (result.success) return;
    // Early return on the bound leaves only the `.max` issue; if the raw value
    // were split, the "exactly one @" check would add a second issue.
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]?.message).toBe(
      "version resourceId must be at most 128 characters",
    );

    // A value that is oversized and also structurally split-looking must be
    // rejected without the split-derived "@" diagnostic.
    const oversizedNoAt = "openarc:listing:".padEnd(129, "x");
    const noAtResult =
      CommerceMarketVersionResourceIdSchema.safeParse(oversizedNoAt);
    expect(noAtResult.success).toBe(false);
    if (noAtResult.success) return;
    expect(noAtResult.error.issues).toHaveLength(1);
    expect(noAtResult.error.issues[0]?.message).toBe(
      "version resourceId must be at most 128 characters",
    );
  });
});

describe("market mutation receipt", () => {
  it("accepts the closed operation/resource discriminated union", () => {
    expect(
      CommerceMarketMutationReceiptSchema.safeParse(listingReceipt()).success,
    ).toBe(true);
    expect(
      CommerceMarketMutationReceiptSchema.safeParse(versionReceipt()).success,
    ).toBe(true);
  });

  it("binds the listing draft resourceId deterministically to the mutationId", () => {
    expect(
      CommerceMarketMutationReceiptSchema.safeParse({
        ...listingReceipt(),
        mutationId: MUTATION_B,
        resourceId: `openarc:listing:${MUTATION_B}`,
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketMutationReceiptSchema.safeParse(
        listingReceipt(MUTATION, LISTING_ID_B),
      ).success,
    ).toBe(false);
    expect(
      CommerceMarketMutationReceiptSchema.safeParse(
        listingReceipt(MUTATION, ORG_ID),
      ).success,
    ).toBe(false);
  });

  it("requires version resource ids at version >= 2", () => {
    expect(
      CommerceMarketMutationReceiptSchema.safeParse(
        versionReceipt(MUTATION, `${LISTING_ID}@1`),
      ).success,
    ).toBe(false);
    expect(
      CommerceMarketMutationReceiptSchema.safeParse(
        versionReceipt(MUTATION, LISTING_ID),
      ).success,
    ).toBe(false);
  });

  it("rejects wrong operation/resourceType pairings and unknown operations", () => {
    const mismatched = [
      { ...listingReceipt(), resourceType: "listing_version" },
      { ...versionReceipt(), resourceType: "listing" },
      { ...listingReceipt(), operation: "market.listing.version.create" },
      { ...versionReceipt(), operation: "market.listing.create" },
      { ...listingReceipt(), operation: "market.listing.publish" },
      { ...versionReceipt(), resourceId: `${LISTING_ID}@2@3` },
    ];
    for (const receipt of mismatched) {
      expect(
        CommerceMarketMutationReceiptSchema.safeParse(receipt).success,
      ).toBe(false);
    }
  });

  it("rejects body, display name, hash, endpoint, key, actor and session blobs", () => {
    for (const key of [
      "body",
      "displayName",
      "hash",
      "endpoint",
      "key",
      "actor",
      "session",
      "role",
      "referenceBlob",
      "idempotencyKey",
    ]) {
      expect(
        CommerceMarketMutationReceiptSchema.safeParse({
          ...listingReceipt(),
          [key]: CANARY,
        }).success,
      ).toBe(false);
      expect(
        CommerceMarketMutationReceiptSchema.safeParse({
          ...versionReceipt(),
          [key]: CANARY,
        }).success,
      ).toBe(false);
    }
    expect(
      CommerceMarketMutationReceiptSchema.safeParse({
        ...listingReceipt(),
        committedAt: "2025-13-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});

describe("market mutation result and status", () => {
  it("accepts replayed results with either receipt", () => {
    for (const replayed of [true, false]) {
      expect(
        CommerceMarketMutationResultSchema.safeParse({
          replayed,
          receipt: listingReceipt(),
        }).success,
      ).toBe(true);
      expect(
        CommerceMarketMutationResultSchema.safeParse({
          replayed,
          receipt: versionReceipt(),
        }).success,
      ).toBe(true);
    }
  });

  it("rejects non-boolean replay flags and organization/listing payloads", () => {
    for (const replayed of ["true", 0, 1, null, undefined]) {
      expect(
        CommerceMarketMutationResultSchema.safeParse({
          replayed,
          receipt: listingReceipt(),
        }).success,
      ).toBe(false);
    }
    for (const key of [
      "organizationId",
      "listingId",
      "providerId",
      "payload",
    ]) {
      expect(
        CommerceMarketMutationResultSchema.safeParse({
          replayed: false,
          receipt: listingReceipt(),
          [key]: CANARY,
        }).success,
      ).toBe(false);
    }
  });

  it("accepts committed and not_found status without pending fiction", () => {
    expect(
      CommerceMarketMutationStatusSchema.safeParse({
        status: "committed",
        receipt: listingReceipt(),
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketMutationStatusSchema.safeParse({
        status: "committed",
        receipt: versionReceipt(),
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketMutationStatusSchema.safeParse({ status: "not_found" })
        .success,
    ).toBe(true);
  });

  it("rejects pending/success status and status-specific extra fields", () => {
    for (const status of ["pending", "success", "succeeded", "failed", ""]) {
      expect(
        CommerceMarketMutationStatusSchema.safeParse({
          status,
          receipt: listingReceipt(),
        }).success,
        `expected rejection of status ${status}`,
      ).toBe(false);
    }
    expect(
      CommerceMarketMutationStatusSchema.safeParse({
        status: "not_found",
        receipt: listingReceipt(),
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketMutationStatusSchema.safeParse({
        status: "committed",
        receipt: listingReceipt(),
        organizationId: ORG_ID,
      }).success,
    ).toBe(false);
  });
});

describe("market owner pages and details", () => {
  it("accepts ascending unique root pages and the empty page", () => {
    expect(
      CommerceMarketOwnerPageSchema.safeParse({
        organizationId: ORG_ID,
        items: [],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketOwnerPageSchema.safeParse({
        organizationId: ORG_ID,
        items: [ownerRoot(LISTING_ID), ownerRoot(LISTING_ID_B)],
        nextCursor: LISTING_ID_B,
      }).success,
    ).toBe(true);
  });

  it("accepts a nonempty final page terminated by a null cursor", () => {
    // Null is always a valid terminator: a nonempty page may be the last page.
    expect(
      CommerceMarketOwnerPageSchema.safeParse({
        organizationId: ORG_ID,
        items: [ownerRoot(LISTING_ID)],
        nextCursor: null,
      }).success,
      "owner root final page with null cursor",
    ).toBe(true);
    expect(
      CommerceMarketOwnerVersionPageSchema.safeParse({
        organizationId: ORG_ID,
        listingId: LISTING_ID,
        providerId: PROVIDER_ID,
        items: [ownerVersion({ version: "1" })],
        nextCursor: null,
      }).success,
      "owner version final page with null cursor",
    ).toBe(true);
    expect(
      CommerceMarketPublicPageSchema.safeParse({
        items: [publicVersion()],
        nextCursor: null,
      }).success,
      "public catalog final page with null cursor",
    ).toBe(true);
  });

  it("rejects duplicate, unsorted and cross-organization root pages", () => {
    expect(
      CommerceMarketOwnerPageSchema.safeParse({
        organizationId: ORG_ID,
        items: [ownerRoot(LISTING_ID), ownerRoot(LISTING_ID)],
        nextCursor: LISTING_ID,
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketOwnerPageSchema.safeParse({
        organizationId: ORG_ID,
        items: [ownerRoot(LISTING_ID_B), ownerRoot(LISTING_ID)],
        nextCursor: LISTING_ID,
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketOwnerPageSchema.safeParse({
        organizationId: ORG_ID,
        items: [ownerRoot(LISTING_ID, ORG_ID_B)],
        nextCursor: LISTING_ID,
      }).success,
    ).toBe(false);
  });

  it("requires a last-item cursor and enforces the 50-item maximum", () => {
    // REVIEW-01: a null cursor is always a valid terminator, including for a
    // nonempty final page (asserted in the null-cursor test above). Keep the
    // wrong-non-null-cursor rejection here.
    expect(
      CommerceMarketOwnerPageSchema.safeParse({
        organizationId: ORG_ID,
        items: [ownerRoot(LISTING_ID)],
        nextCursor: LISTING_ID_B,
      }).success,
    ).toBe(false);
    const fifty = Array.from({ length: 50 }, (_value, index) =>
      ownerRoot(listIdFor(index + 1)),
    );
    expect(
      CommerceMarketOwnerPageSchema.safeParse({
        organizationId: ORG_ID,
        items: fifty,
        nextCursor: listIdFor(50),
      }).success,
    ).toBe(true);
    const fiftyOne = [...fifty, ownerRoot(listIdFor(51))];
    expect(
      CommerceMarketOwnerPageSchema.safeParse({
        organizationId: ORG_ID,
        items: fiftyOne,
        nextCursor: listIdFor(51),
      }).success,
    ).toBe(false);
  });

  it("refuses to treat a public version as an owner root item", () => {
    expect(
      CommerceMarketOwnerPageSchema.safeParse({
        organizationId: ORG_ID,
        items: [publicVersion()],
        nextCursor: LISTING_ID,
      }).success,
    ).toBe(false);
  });

  it("orders owner version history numerically (1, 2, 10)", () => {
    expect(
      CommerceMarketOwnerVersionPageSchema.safeParse({
        organizationId: ORG_ID,
        listingId: LISTING_ID,
        providerId: PROVIDER_ID,
        items: [
          ownerVersion({ version: "1" }),
          ownerVersion({ version: "2" }),
          ownerVersion({ version: "10" }),
        ],
        nextCursor: "10",
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketOwnerVersionPageSchema.safeParse({
        organizationId: ORG_ID,
        listingId: LISTING_ID,
        providerId: PROVIDER_ID,
        items: [
          ownerVersion({ version: "1" }),
          ownerVersion({ version: "10" }),
          ownerVersion({ version: "2" }),
        ],
        nextCursor: "2",
      }).success,
    ).toBe(false);
  });

  it("safe-parses malformed and oversized history versions without throwing or coercing", () => {
    const base = {
      organizationId: ORG_ID,
      listingId: LISTING_ID,
      providerId: PROVIDER_ID,
    };
    const spy = vi.spyOn(globalThis, "BigInt");
    try {
      const result = CommerceMarketOwnerVersionPageSchema.safeParse({
        ...base,
        items: [
          ownerVersion({ version: "1" }),
          ownerVersion({ version: "invalid" }),
        ],
        nextCursor: null,
      });
      expect(result.success, "malformed second version must be invalid").toBe(
        false,
      );

      expect(() => {
        expect(
          CommerceMarketOwnerVersionPageSchema.safeParse({
            ...base,
            items: [
              ownerVersion({ version: "1" }),
              ownerVersion({ version: "9".repeat(500) }),
            ],
            nextCursor: null,
          }).success,
          "500-digit second version must be invalid",
        ).toBe(false);
      }).not.toThrow();

      // Oversized first version with a valid second version: must reject and
      // never hand the oversized string to BigInt.
      expect(() => {
        const oversizedFirst = CommerceMarketOwnerVersionPageSchema.safeParse({
          ...base,
          items: [
            ownerVersion({ version: "9".repeat(500) }),
            ownerVersion({ version: "2" }),
          ],
          nextCursor: null,
        });
        expect(oversizedFirst.success).toBe(false);
      }).not.toThrow();

      // The accepted version regex allows at most 9 digits; any BigInt call seen
      // here must have come from an already-canonical leaf, never from the
      // malformed or 500-digit strings this page-level guard handles.
      for (const call of spy.mock.calls) {
        const argument = String(call[0]);
        expect(
          /^[1-9][0-9]{0,8}$/.test(argument),
          `BigInt received non-canonical input ${argument.slice(0, 24)}`,
        ).toBe(true);
      }

      // A well-formed canonical pair still orders numerically after the guard.
      expect(
        CommerceMarketOwnerVersionPageSchema.safeParse({
          ...base,
          items: [
            ownerVersion({ version: "1" }),
            ownerVersion({ version: "2" }),
            ownerVersion({ version: "10" }),
          ],
          nextCursor: "10",
        }).success,
      ).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects version pages with mismatched bindings, duplicates or cursor", () => {
    const base = {
      organizationId: ORG_ID,
      listingId: LISTING_ID,
      providerId: PROVIDER_ID,
    };
    expect(
      CommerceMarketOwnerVersionPageSchema.safeParse({
        ...base,
        items: [ownerVersion({ version: "1" }), ownerVersion({ version: "1" })],
        nextCursor: "1",
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketOwnerVersionPageSchema.safeParse({
        ...base,
        items: [ownerVersion({ version: "2", listingId: LISTING_ID_B })],
        nextCursor: "2",
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketOwnerVersionPageSchema.safeParse({
        ...base,
        items: [ownerVersion({ version: "2", providerId: PROVIDER_ID_B })],
        nextCursor: "2",
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketOwnerVersionPageSchema.safeParse({
        ...base,
        items: [ownerVersion({ version: "2", organizationId: ORG_ID_B })],
        nextCursor: "2",
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketOwnerVersionPageSchema.safeParse({
        ...base,
        items: [ownerVersion({ version: "2" })],
        // REVIEW-01: null is always a valid terminator; use a wrong non-null
        // cursor to keep the mismatched-cursor rejection assertion.
        nextCursor: "3",
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketOwnerVersionPageSchema.safeParse({
        ...base,
        items: [],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });

  it("binds owner version detail to every requested target", () => {
    expect(
      CommerceMarketOwnerVersionDetailSchema.safeParse({
        organizationId: ORG_ID,
        listingId: LISTING_ID,
        version: "2",
        item: ownerVersion({ version: "2" }),
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketOwnerVersionDetailSchema.safeParse({
        organizationId: ORG_ID,
        listingId: LISTING_ID,
        version: "2",
        item: null,
      }).success,
    ).toBe(true);
    for (const item of [
      ownerVersion({ version: "2", organizationId: ORG_ID_B }),
      ownerVersion({ version: "2", listingId: LISTING_ID_B }),
      ownerVersion({ version: "3" }),
      ownerRoot(),
      publicVersion(),
    ]) {
      expect(
        CommerceMarketOwnerVersionDetailSchema.safeParse({
          organizationId: ORG_ID,
          listingId: LISTING_ID,
          version: "2",
          item,
        }).success,
      ).toBe(false);
    }
  });
});

describe("market public pages and details", () => {
  it("accepts ascending unique public pages and rejects duplicates", () => {
    expect(
      CommerceMarketPublicPageSchema.safeParse({
        items: [publicVersion(LISTING_ID), publicVersion(LISTING_ID_B)],
        nextCursor: LISTING_ID_B,
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketPublicPageSchema.safeParse({
        items: [publicVersion(LISTING_ID), publicVersion(LISTING_ID)],
        nextCursor: LISTING_ID,
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketPublicPageSchema.safeParse({
        items: [publicVersion(LISTING_ID_B), publicVersion(LISTING_ID)],
        nextCursor: LISTING_ID,
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketPublicPageSchema.safeParse({
        items: [],
        nextCursor: LISTING_ID,
      }).success,
    ).toBe(false);
  });

  it("never carries organization, path, review, account or receipt metadata", () => {
    for (const key of [
      "organizationId",
      "endpointContract",
      "originReviewState",
      "accountId",
      "cookies",
      "policy",
      "rawOutput",
      "receipt",
      "privateNotes",
    ]) {
      expect(
        CommerceMarketPublicPageSchema.safeParse({
          items: [{ ...publicVersion(), [key]: CANARY }],
          nextCursor: LISTING_ID,
        }).success,
      ).toBe(false);
      expect(
        CommerceMarketPublicDetailSchema.safeParse({
          listingId: LISTING_ID,
          item: { ...publicVersion(), [key]: CANARY },
        }).success,
      ).toBe(false);
    }
  });

  it("binds public detail to the requested listing id", () => {
    expect(
      CommerceMarketPublicDetailSchema.safeParse({
        listingId: LISTING_ID,
        item: publicVersion(LISTING_ID),
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketPublicDetailSchema.safeParse({
        listingId: LISTING_ID,
        item: null,
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketPublicDetailSchema.safeParse({
        listingId: LISTING_ID,
        item: publicVersion(LISTING_ID_B),
      }).success,
    ).toBe(false);
  });

  it("binds public provider detail to the requested provider id", () => {
    expect(
      CommerceMarketPublicProviderDetailSchema.safeParse({
        providerId: PROVIDER_ID,
        item: publicProvider(PROVIDER_ID),
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketPublicProviderDetailSchema.safeParse({
        providerId: PROVIDER_ID,
        item: null,
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketPublicProviderDetailSchema.safeParse({
        providerId: PROVIDER_ID,
        item: publicProvider(PROVIDER_ID_B),
      }).success,
    ).toBe(false);
  });
});

describe("market success envelopes", () => {
  const ownerPage = {
    organizationId: ORG_ID,
    items: [ownerRoot()],
    nextCursor: LISTING_ID,
  };
  const ownerVersionPage = {
    organizationId: ORG_ID,
    listingId: LISTING_ID,
    providerId: PROVIDER_ID,
    items: [ownerVersion()],
    nextCursor: "1",
  };
  const ownerVersionDetail = {
    organizationId: ORG_ID,
    listingId: LISTING_ID,
    version: "1",
    item: ownerVersion(),
  };
  const publicPage = {
    items: [publicVersion()],
    nextCursor: LISTING_ID,
  };
  const publicDetail = { listingId: LISTING_ID, item: publicVersion() };
  const providerDetail = {
    providerId: PROVIDER_ID,
    item: publicProvider(),
  };
  const mutationResult = { replayed: false, receipt: listingReceipt() };
  const mutationStatus = {
    status: "committed" as const,
    receipt: listingReceipt(),
  };

  const cases: readonly (readonly [ParseableSchema, Record<string, unknown>, string])[] = [
    [CommerceMarketOwnerPageResponseSchema, ownerPage, "owner page"],
    [
      CommerceMarketOwnerVersionPageResponseSchema,
      ownerVersionPage,
      "owner version page",
    ],
    [
      CommerceMarketOwnerVersionDetailResponseSchema,
      ownerVersionDetail,
      "owner version detail",
    ],
    [CommerceMarketPublicPageResponseSchema, publicPage, "public page"],
    [CommerceMarketPublicDetailResponseSchema, publicDetail, "public detail"],
    [
      CommerceMarketPublicProviderDetailResponseSchema,
      providerDetail,
      "public provider detail",
    ],
    [
      CommerceMarketMutationResultResponseSchema,
      mutationResult,
      "mutation result",
    ],
    [
      CommerceMarketMutationStatusResponseSchema,
      mutationStatus,
      "mutation status",
    ],
  ];

  it("wraps every data object in a strict v2 success envelope", () => {
    for (const [schema, data, label] of cases) {
      expect(
        schema.safeParse({ ok: true, data, meta: { ...META } }).success,
        `expected envelope acceptance for ${label}`,
      ).toBe(true);
      expect(
        schema.safeParse({ ok: false, data, meta: { ...META } }).success,
        `expected ok:false rejection for ${label}`,
      ).toBe(false);
      expect(
        schema.safeParse({
          ok: true,
          data: { ...data, rawMetadata: CANARY },
          meta: { ...META },
        }).success,
        `expected raw metadata rejection for ${label}`,
      ).toBe(false);
      expect(
        schema.safeParse({
          ok: true,
          data,
          meta: { ...META, buildLabel: CANARY },
        }).success,
        `expected meta mutation rejection for ${label}`,
      ).toBe(false);
      expect(
        schema.safeParse({
          ok: true,
          data,
          meta: { ...META, schemaVersion: "openarc.api.v1" },
        }).success,
        `expected v1 meta rejection for ${label}`,
      ).toBe(false);
    }
  });

  it("exports the exact wrapped data schema instance identities", () => {
    expect(CommerceMarketOwnerPageResponseSchema.shape.data).toBe(
      CommerceMarketOwnerPageSchema,
    );
    expect(CommerceMarketOwnerVersionPageResponseSchema.shape.data).toBe(
      CommerceMarketOwnerVersionPageSchema,
    );
    expect(CommerceMarketOwnerVersionDetailResponseSchema.shape.data).toBe(
      CommerceMarketOwnerVersionDetailSchema,
    );
    expect(CommerceMarketPublicPageResponseSchema.shape.data).toBe(
      CommerceMarketPublicPageSchema,
    );
    expect(CommerceMarketPublicDetailResponseSchema.shape.data).toBe(
      CommerceMarketPublicDetailSchema,
    );
    expect(CommerceMarketPublicProviderDetailResponseSchema.shape.data).toBe(
      CommerceMarketPublicProviderDetailSchema,
    );
    expect(CommerceMarketMutationResultResponseSchema.shape.data).toBe(
      CommerceMarketMutationResultSchema,
    );
    expect(CommerceMarketMutationStatusResponseSchema.shape.data).toBe(
      CommerceMarketMutationStatusSchema,
    );
  });
});

describe("market root exports and inference", () => {
  it("re-exports the same schema instances from the package root", () => {
    expect(CommerceMarketOwnerPageSchema).toBe(DirectOwnerPageSchema);
    expect(CommerceMarketPublicProviderSchema).toBe(DirectPublicProviderSchema);
  });

  it("infers the exact content, price and provider types", () => {
    expectTypeOf<CommerceMarketListingContent["paymentLane"]>().toEqualTypeOf<
      "unavailable"
    >();
    expectTypeOf<CommerceMarketListingContent["kind"]>().toEqualTypeOf<
      "api" | "mcp_tool" | "data" | "model" | "workflow" | "agent"
    >();
    type ContentPriceAmount = CommerceMarketListingContent["price"]["amount"];
    expectTypeOf<ContentPriceAmount["representation"]>().toEqualTypeOf<"erc20">();
    expectTypeOf<ContentPriceAmount["decimals"]>().toEqualTypeOf<6>();
    expectTypeOf<ContentPriceAmount["networkId"]>().toEqualTypeOf<"eip155:5042002">();
    expectTypeOf<ContentPriceAmount["asset"]>().toEqualTypeOf<"USDC">();
    expectTypeOf<ContentPriceAmount["atomicAmount"]>().toEqualTypeOf<string>();
    expectTypeOf<CommerceMarketPublicProvider["status"]>().toEqualTypeOf<"active">();
    expectTypeOf<CommerceMarketPublicProvider["schemaVersion"]>().toEqualTypeOf<
      "openarc.provider-public.v1"
    >();
  });

  it("infers strict request, receipt, result and status types", () => {
    expectTypeOf<CommerceMarketPublicListRequest["limit"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<CommerceMarketPublicListRequest["q"]>().toEqualTypeOf<
      string | undefined
    >();
    expectTypeOf<CommerceMarketPublicListRequest["kind"]>().toEqualTypeOf<
      | "api"
      | "mcp_tool"
      | "data"
      | "model"
      | "workflow"
      | "agent"
      | undefined
    >();
    expectTypeOf<CommerceMarketMutationReceipt["operation"]>().toEqualTypeOf<
      "market.listing.create" | "market.listing.version.create"
    >();
    expectTypeOf<CommerceMarketMutationResult["replayed"]>().toEqualTypeOf<boolean>();
    expectTypeOf<CommerceMarketMutationStatus["status"]>().toEqualTypeOf<
      "committed" | "not_found"
    >();
    expectTypeOf<CommerceMarketOwnerVersionPage["nextCursor"]>().toEqualTypeOf<
      string | null
    >();
  });
});

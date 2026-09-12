import { describe, expect, expectTypeOf, it } from "vitest";

import {
  CommerceMarketLifecycleMutationReceiptSchema,
  CommerceMarketLifecycleResourceIdSchema,
  CommerceMarketMutationReceiptSchema,
  CommerceMarketMutationResultResponseSchema,
  CommerceMarketMutationResultSchema,
  CommerceMarketMutationStatusResponseSchema,
  CommerceMarketMutationStatusSchema,
  CommerceMarketOriginReviewBodySchema,
  CommerceMarketOriginReviewDecisionSchema,
  CommerceMarketOriginReviewReasonCodeSchema,
  CommerceMarketOwnerRootDetailResponseSchema,
  CommerceMarketOwnerRootDetailSchema,
  CommerceMarketOwnerRootRequestSchema,
  CommerceMarketPauseBodySchema,
  CommerceMarketProviderOptionSchema,
  CommerceMarketProviderOptionsPageSchema,
  CommerceMarketProviderOptionsRequestSchema,
  CommerceMarketProviderOptionsResponseSchema,
  CommerceMarketPublishBodySchema,
  CommerceMarketRetireBodySchema,
  type CommerceMarketLifecycleMutationReceipt,
  type CommerceMarketLifecycleResourceId,
  type CommerceMarketMutationReceipt,
  type CommerceMarketMutationResult,
  type CommerceMarketMutationStatus,
  type CommerceMarketOriginReviewBody,
  type CommerceMarketOwnerRootDetail,
  type CommerceMarketPauseBody,
  type CommerceMarketProviderOption,
  type CommerceMarketProviderOptionsPage,
  type CommerceMarketProviderOptionsRequest,
  type CommerceMarketPublishBody,
  type CommerceMarketRetireBody,
} from "../src/index.js";
import type { CommerceListingOwner } from "../src/commerce/listing.js";
import {
  CommerceMarketLifecycleMutationReceiptSchema as DirectLifecycleReceiptSchema,
  CommerceMarketOriginReviewBodySchema as DirectOriginReviewBodySchema,
} from "../src/commerce/market-lifecycle.js";

const V4 = "12345678-1234-4234-8123-123456789abc";
const V4_B = "87654321-4321-4321-b123-abcdefabcdef";

const MUTATION = V4;
const MUTATION_B = V4_B;

const LISTING_ID = `openarc:listing:${V4}`;
const LISTING_ID_B = `openarc:listing:${V4_B}`;
const ORG_ID = `openarc:org:${V4}`;
const ORG_ID_B = `openarc:org:${V4_B}`;
const PROVIDER_ID = `openarc:provider:${V4}`;
const PROVIDER_ID_B = `openarc:provider:${V4_B}`;

const CREATED_AT = "2025-01-01T00:00:00.000Z";
const UPDATED_AT = "2025-01-02T00:00:00.000Z";

const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;

const CANARY = "PRIVATE_CANARY_DO_NOT_ECHO";
const SAMPLE_UUID = "9f1c2d34-5e6a-4b7c-8d9e-0f1a2b3c4d5e";
const SAMPLE_SHA = "0123456789abcdef0123456789abcdef01234567";

const META = {
  schemaVersion: "openarc.api.v2" as const,
  requestId: SAMPLE_UUID,
  buildSha: SAMPLE_SHA,
};

function originReviewBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mutationId: MUTATION,
    expectedUpdatedAt: UPDATED_AT,
    decision: "approved",
    reviewedEndpointDigest: DIGEST_A,
    reasonCode: "manual_review",
    reasonDigest: DIGEST_B,
    ...overrides,
  };
}

function pointerBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mutationId: MUTATION,
    expectedUpdatedAt: UPDATED_AT,
    expectedActiveVersion: null,
    ...overrides,
  };
}

function ownerRoot(
  listingId = LISTING_ID,
  organizationId = ORG_ID,
  activeVersion: string | null = null,
): Record<string, unknown> {
  return {
    schemaVersion: "openarc.listing.v1",
    listingId,
    organizationId,
    providerId: PROVIDER_ID,
    activeVersion,
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

function providerOption(
  providerId = PROVIDER_ID,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    providerId,
    displayName: "Acme Provider",
    status: "active",
    ...overrides,
  };
}

function lifecycleReceipt(
  operation: string,
  resourceId = `${LISTING_ID}@1`,
  mutationId = MUTATION,
): Record<string, unknown> {
  return {
    mutationId,
    operation,
    resourceType: "listing_version",
    resourceId,
    committedAt: CREATED_AT,
  };
}

const LIFECYCLE_OPERATIONS = [
  "market.listing.origin_review.record",
  "market.listing.version.publish",
  "market.listing.version.pause",
  "market.listing.version.retire",
] as const;

describe("market lifecycle origin review body", () => {
  it("accepts the exact body with a nullable reason digest", () => {
    expect(
      CommerceMarketOriginReviewBodySchema.safeParse(originReviewBody()).success,
    ).toBe(true);
    expect(
      CommerceMarketOriginReviewBodySchema.safeParse(
        originReviewBody({ reasonDigest: null }),
      ).success,
    ).toBe(true);
    const parsed = CommerceMarketOriginReviewBodySchema.parse(originReviewBody());
    expect(Object.keys(parsed).sort()).toEqual(
      [
        "decision",
        "expectedUpdatedAt",
        "mutationId",
        "reasonCode",
        "reasonDigest",
        "reviewedEndpointDigest",
      ].sort(),
    );
  });

  it("requires reasonDigest to be present and nullable, never omitted", () => {
    const missing: Record<string, unknown> = { ...originReviewBody() };
    delete missing.reasonDigest;
    expect(
      CommerceMarketOriginReviewBodySchema.safeParse(missing).success,
    ).toBe(false);
    for (const reasonDigest of [
      undefined,
      "",
      "sha256:short",
      `sha256:${"A".repeat(64)}`,
      42,
    ]) {
      expect(
        CommerceMarketOriginReviewBodySchema.safeParse(
          originReviewBody({ reasonDigest }),
        ).success,
        `expected rejection of reasonDigest ${String(reasonDigest)}`,
      ).toBe(false);
    }
  });

  it("accepts only the closed decision and reason-code enums", () => {
    for (const decision of ["approved", "rejected"]) {
      expect(
        CommerceMarketOriginReviewDecisionSchema.safeParse(decision).success,
      ).toBe(true);
    }
    for (const decision of ["", "APPROVED", "approve", "pending", null]) {
      expect(
        CommerceMarketOriginReviewBodySchema.safeParse(
          originReviewBody({ decision }),
        ).success,
      ).toBe(false);
    }
    for (const reasonCode of [
      "manual_review",
      "origin_policy",
      "terms_policy",
      "manifest_policy",
      "other",
    ]) {
      expect(
        CommerceMarketOriginReviewReasonCodeSchema.safeParse(reasonCode)
          .success,
      ).toBe(true);
    }
    for (const reasonCode of ["", "MANUAL_REVIEW", "spam", "other_reason", 1]) {
      expect(
        CommerceMarketOriginReviewBodySchema.safeParse(
          originReviewBody({ reasonCode }),
        ).success,
      ).toBe(false);
    }
  });

  it("rejects missing, invalid-id, invalid-timestamp and invalid-digest fields", () => {
    for (const key of [
      "mutationId",
      "expectedUpdatedAt",
      "decision",
      "reviewedEndpointDigest",
      "reasonCode",
      "reasonDigest",
    ]) {
      const missing: Record<string, unknown> = { ...originReviewBody() };
      delete missing[key];
      expect(
        CommerceMarketOriginReviewBodySchema.safeParse(missing).success,
        `expected rejection of missing ${key}`,
      ).toBe(false);
    }
    expect(
      CommerceMarketOriginReviewBodySchema.safeParse(
        originReviewBody({ mutationId: MUTATION.toUpperCase() }),
      ).success,
    ).toBe(false);
    expect(
      CommerceMarketOriginReviewBodySchema.safeParse(
        originReviewBody({ mutationId: "not-a-uuid" }),
      ).success,
    ).toBe(false);
    for (const expectedUpdatedAt of [
      "2025-01-02T00:00:00Z+00:00",
      "2025-13-01T00:00:00.000Z",
      "2025-01-02",
      1700000000000,
      null,
    ]) {
      expect(
        CommerceMarketOriginReviewBodySchema.safeParse(
          originReviewBody({ expectedUpdatedAt }),
        ).success,
      ).toBe(false);
    }
    for (const reviewedEndpointDigest of [
      DIGEST_A.toUpperCase(),
      `sha256:${"a".repeat(63)}`,
      `sha256:${"a".repeat(65)}`,
      "sha256:",
      CANARY,
    ]) {
      expect(
        CommerceMarketOriginReviewBodySchema.safeParse(
          originReviewBody({ reviewedEndpointDigest }),
        ).success,
      ).toBe(false);
    }
  });

  it("rejects identity, content, status, cookie and plaintext note injection", () => {
    for (const key of [
      "organizationId",
      "listingId",
      "version",
      "providerId",
      "reviewerId",
      "accountId",
      "reviewedBy",
      "authority",
      "notes",
      "privateNotes",
      "content",
      "status",
      "idempotencyKey",
      "cookie",
      "key",
      "secret",
      "endpoint",
    ]) {
      expect(
        CommerceMarketOriginReviewBodySchema.safeParse(
          originReviewBody({ [key]: CANARY }),
        ).success,
        `expected rejection of origin review extra leaf ${key}`,
      ).toBe(false);
    }
  });

  it("does not treat the endpoint digest as authority and has no reviewer field", () => {
    expect(
      CommerceMarketOriginReviewBodySchema.safeParse(
        originReviewBody({ reviewedEndpointDigest: DIGEST_B }),
      ).success,
    ).toBe(true);
    expect(
      CommerceMarketOriginReviewBodySchema.safeParse(
        originReviewBody({ reviewer: { accountId: CANARY } }),
      ).success,
    ).toBe(false);
  });
});

describe("market lifecycle publish/pause/retire bodies", () => {
  it("accepts the exact pointer CAS bodies for null and canonical versions", () => {
    for (const expectedActiveVersion of [null, "1", "2", "999999999"]) {
      for (const schema of [
        CommerceMarketPublishBodySchema,
        CommerceMarketPauseBodySchema,
        CommerceMarketRetireBodySchema,
      ]) {
        expect(
          schema.safeParse(pointerBody({ expectedActiveVersion })).success,
          `expected acceptance of expectedActiveVersion ${String(
            expectedActiveVersion,
          )}`,
        ).toBe(true);
      }
    }
  });

  it("rejects wrong version forms for every pointer body", () => {
    for (const expectedActiveVersion of [
      "0",
      "00",
      "01",
      "1000000000",
      "1e2",
      "1.0",
      1,
    ]) {
      for (const schema of [
        CommerceMarketPublishBodySchema,
        CommerceMarketPauseBodySchema,
        CommerceMarketRetireBodySchema,
      ]) {
        expect(
          schema.safeParse(pointerBody({ expectedActiveVersion })).success,
          `expected rejection of expectedActiveVersion ${String(
            expectedActiveVersion,
          )}`,
        ).toBe(false);
      }
    }
    // An omitted key is not a null pointer: it must be present as null.
    const omitted: Record<string, unknown> = { ...pointerBody() };
    delete omitted.expectedActiveVersion;
    expect(
      CommerceMarketPublishBodySchema.safeParse(omitted).success,
    ).toBe(false);
  });

  it("rejects missing and invalid CAS/timestamp/mutation fields", () => {
    for (const schema of [
      CommerceMarketPublishBodySchema,
      CommerceMarketPauseBodySchema,
      CommerceMarketRetireBodySchema,
    ]) {
      for (const key of ["mutationId", "expectedUpdatedAt", "expectedActiveVersion"]) {
        const missing: Record<string, unknown> = { ...pointerBody() };
        delete missing[key];
        expect(
          schema.safeParse(missing).success,
          `expected rejection of missing ${key}`,
        ).toBe(false);
      }
      expect(
        schema.safeParse(pointerBody({ mutationId: MUTATION_B.toUpperCase() }))
          .success,
      ).toBe(false);
      expect(
        schema.safeParse(pointerBody({ expectedUpdatedAt: "not-a-timestamp" }))
          .success,
      ).toBe(false);
    }
  });

  it("rejects content, review state, status and authority injection", () => {
    for (const key of [
      "content",
      "originReviewState",
      "status",
      "decision",
      "authority",
      "listingId",
      "organizationId",
      "reasonDigest",
      "idempotencyKey",
      "notes",
    ]) {
      for (const schema of [
        CommerceMarketPublishBodySchema,
        CommerceMarketPauseBodySchema,
        CommerceMarketRetireBodySchema,
      ]) {
        expect(
          schema.safeParse(pointerBody({ [key]: CANARY })).success,
          `expected rejection of pointer body extra leaf ${key}`,
        ).toBe(false);
      }
    }
  });

  it("exposes three distinct exported schema instances of the same shape", () => {
    expect(CommerceMarketPublishBodySchema).not.toBe(
      CommerceMarketPauseBodySchema,
    );
    expect(CommerceMarketPauseBodySchema).not.toBe(
      CommerceMarketRetireBodySchema,
    );
    expect(CommerceMarketPublishBodySchema).not.toBe(
      CommerceMarketRetireBodySchema,
    );
  });
});

describe("market lifecycle owner root detail", () => {
  it("accepts the exact request shape", () => {
    expect(
      CommerceMarketOwnerRootRequestSchema.safeParse({
        organizationId: ORG_ID,
        listingId: LISTING_ID,
      }).success,
    ).toBe(true);
    for (const key of ["providerId", "version", "item", "status"]) {
      expect(
        CommerceMarketOwnerRootRequestSchema.safeParse({
          organizationId: ORG_ID,
          listingId: LISTING_ID,
          [key]: CANARY,
        }).success,
      ).toBe(false);
    }
    expect(
      CommerceMarketOwnerRootRequestSchema.safeParse({
        organizationId: ORG_ID,
        listingId: ORG_ID,
      }).success,
    ).toBe(false);
  });

  it("binds a present item to both organization and listing, and allows null", () => {
    expect(
      CommerceMarketOwnerRootDetailSchema.safeParse({
        organizationId: ORG_ID,
        listingId: LISTING_ID,
        item: ownerRoot(LISTING_ID, ORG_ID, "1"),
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketOwnerRootDetailSchema.safeParse({
        organizationId: ORG_ID,
        listingId: LISTING_ID,
        item: null,
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketOwnerRootDetailSchema.safeParse({
        organizationId: ORG_ID,
        listingId: LISTING_ID,
        item: ownerRoot(LISTING_ID_B, ORG_ID),
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketOwnerRootDetailSchema.safeParse({
        organizationId: ORG_ID,
        listingId: LISTING_ID,
        item: ownerRoot(LISTING_ID, ORG_ID_B),
      }).success,
    ).toBe(false);
  });

  it("rejects public-provider shaped and other non-root items", () => {
    expect(
      CommerceMarketOwnerRootDetailSchema.safeParse({
        organizationId: ORG_ID,
        listingId: LISTING_ID,
        item: {
          schemaVersion: "openarc.provider-public.v1",
          providerId: PROVIDER_ID,
          displayName: "Acme",
          status: "active",
        },
      }).success,
    ).toBe(false);
  });

  it("wraps the detail in a strict v2 success envelope", () => {
    const data = {
      organizationId: ORG_ID,
      listingId: LISTING_ID,
      item: ownerRoot(LISTING_ID, ORG_ID, "1"),
    };
    expect(
      CommerceMarketOwnerRootDetailResponseSchema.safeParse({
        ok: true,
        data,
        meta: { ...META },
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketOwnerRootDetailResponseSchema.safeParse({
        ok: false,
        data,
        meta: { ...META },
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketOwnerRootDetailResponseSchema.safeParse({
        ok: true,
        data: { ...data, rawMetadata: CANARY },
        meta: { ...META },
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketOwnerRootDetailResponseSchema.shape.data,
    ).toBe(CommerceMarketOwnerRootDetailSchema);
  });
});

describe("market lifecycle provider options", () => {
  it("accepts the exact projection and rejects extra provider leaves", () => {
    const parsed = CommerceMarketProviderOptionSchema.parse(providerOption());
    expect(Object.keys(parsed).sort()).toEqual(
      ["displayName", "providerId", "status"].sort(),
    );
    for (const key of [
      "organizationId",
      "accountId",
      "credential",
      "walletAddress",
      "contact",
      "updatedAt",
      "createdAt",
      "schemaVersion",
      "reputation",
    ]) {
      expect(
        CommerceMarketProviderOptionSchema.safeParse(
          providerOption(PROVIDER_ID, { [key]: CANARY }),
        ).success,
        `expected rejection of option leaf ${key}`,
      ).toBe(false);
    }
    for (const status of ["active", "suspended", "retired"]) {
      expect(
        CommerceMarketProviderOptionSchema.safeParse(
          providerOption(PROVIDER_ID, { status }),
        ).success,
      ).toBe(true);
    }
    expect(
      CommerceMarketProviderOptionSchema.safeParse(
        providerOption(PROVIDER_ID, { status: "pending" }),
      ).success,
    ).toBe(false);
  });

  it("accepts bounded request options without defaults or undefined values", () => {
    expect(
      CommerceMarketProviderOptionsRequestSchema.safeParse({
        organizationId: ORG_ID,
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketProviderOptionsRequestSchema.safeParse({
        organizationId: ORG_ID,
        afterProviderId: PROVIDER_ID,
        limit: 50,
      }).success,
    ).toBe(true);
    const parsed = CommerceMarketProviderOptionsRequestSchema.parse({
      organizationId: ORG_ID,
    });
    expect("limit" in parsed).toBe(false);
    expect("afterProviderId" in parsed).toBe(false);
    for (const key of ["afterProviderId", "limit"] as const) {
      expect(
        CommerceMarketProviderOptionsRequestSchema.safeParse({
          organizationId: ORG_ID,
          [key]: undefined,
        }).success,
        `expected rejection of explicit undefined ${key}`,
      ).toBe(false);
    }
  });

  it("enforces integer limits 1..50 and no coercion", () => {
    for (const limit of [0, 51, 1.5, -1, Number.NaN, "1", null]) {
      expect(
        CommerceMarketProviderOptionsRequestSchema.safeParse({
          organizationId: ORG_ID,
          limit,
        }).success,
        `expected rejection of limit ${String(limit)}`,
      ).toBe(false);
    }
    for (const limit of [1, 25, 50]) {
      expect(
        CommerceMarketProviderOptionsRequestSchema.safeParse({
          organizationId: ORG_ID,
          limit,
        }).success,
      ).toBe(true);
    }
    expect(
      CommerceMarketProviderOptionsRequestSchema.safeParse({
        organizationId: ORG_ID,
        afterProviderId: PROVIDER_ID,
        extra: CANARY,
      }).success,
    ).toBe(false);
  });

  it("accepts ascending unique pages, final null cursor and empty page", () => {
    expect(
      CommerceMarketProviderOptionsPageSchema.safeParse({
        organizationId: ORG_ID,
        items: [providerOption(PROVIDER_ID), providerOption(PROVIDER_ID_B)],
        nextCursor: PROVIDER_ID_B,
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketProviderOptionsPageSchema.safeParse({
        organizationId: ORG_ID,
        items: [providerOption(PROVIDER_ID)],
        nextCursor: null,
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketProviderOptionsPageSchema.safeParse({
        organizationId: ORG_ID,
        items: [],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });

  it("rejects duplicates, out-of-order items and invalid cursors", () => {
    expect(
      CommerceMarketProviderOptionsPageSchema.safeParse({
        organizationId: ORG_ID,
        items: [providerOption(PROVIDER_ID), providerOption(PROVIDER_ID)],
        nextCursor: PROVIDER_ID,
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketProviderOptionsPageSchema.safeParse({
        organizationId: ORG_ID,
        items: [providerOption(PROVIDER_ID_B), providerOption(PROVIDER_ID)],
        nextCursor: PROVIDER_ID,
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketProviderOptionsPageSchema.safeParse({
        organizationId: ORG_ID,
        items: [providerOption(PROVIDER_ID)],
        nextCursor: PROVIDER_ID_B,
      }).success,
    ).toBe(false);
    expect(
      CommerceMarketProviderOptionsPageSchema.safeParse({
        organizationId: ORG_ID,
        items: [],
        nextCursor: PROVIDER_ID,
      }).success,
    ).toBe(false);
    const fifty = Array.from({ length: 50 }, (_value, index) =>
      providerOption(
        `openarc:provider:00000000-0000-4000-8000-${(index + 1)
          .toString(16)
          .padStart(12, "0")}`,
      ),
    );
    expect(
      CommerceMarketProviderOptionsPageSchema.safeParse({
        organizationId: ORG_ID,
        items: fifty,
        nextCursor: null,
      }).success,
    ).toBe(true);
    const fiftyOne = [
      ...fifty,
      providerOption("openarc:provider:ffffffff-ffff-4fff-8fff-ffffffffffff"),
    ];
    expect(
      CommerceMarketProviderOptionsPageSchema.safeParse({
        organizationId: ORG_ID,
        items: fiftyOne,
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it("wraps the page in a strict v2 success envelope", () => {
    const data = {
      organizationId: ORG_ID,
      items: [providerOption(PROVIDER_ID)],
      nextCursor: null,
    };
    expect(
      CommerceMarketProviderOptionsResponseSchema.safeParse({
        ok: true,
        data,
        meta: { ...META },
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketProviderOptionsResponseSchema.shape.data,
    ).toBe(CommerceMarketProviderOptionsPageSchema);
  });
});

describe("market lifecycle resource id", () => {
  it("accepts canonical listing@version with version at least 1 including max", () => {
    for (const version of ["1", "2", "10", "999999999"]) {
      expect(
        CommerceMarketLifecycleResourceIdSchema.safeParse(
          `${LISTING_ID}@${version}`,
        ).success,
        `expected acceptance of version ${version}`,
      ).toBe(true);
    }
  });

  it("rejects wrong namespace, UUID, suffix, version zero, leading zero and extras", () => {
    const rejected = [
      `${LISTING_ID}@0`,
      `${LISTING_ID}@00`,
      `${LISTING_ID}@01`,
      `${LISTING_ID}@1000000000`,
      LISTING_ID,
      `${LISTING_ID}@`,
      "@1",
      `${LISTING_ID}@1@2`,
      `openarc:org:${V4}@1`,
      "openarc:listing:not-a-uuid@1",
      `openarc:provider:${V4}@1`,
      ` ${LISTING_ID}@1`,
      `${LISTING_ID}@1 `,
      `${LISTING_ID}@1\n`,
      42,
      null,
    ];
    for (const value of rejected) {
      expect(
        CommerceMarketLifecycleResourceIdSchema.safeParse(value).success,
        `expected rejection of ${String(value)}`,
      ).toBe(false);
    }
  });

  it("caps length before splitting and never throws", () => {
    const oversized = `${LISTING_ID}@${"1".repeat(80)}`;
    expect(oversized.length).toBeGreaterThan(128);
    const result = CommerceMarketLifecycleResourceIdSchema.safeParse(oversized);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1);
      expect(result.error.issues[0]?.message).toBe(
        "lifecycle resourceId must be at most 128 characters",
      );
    }
    const oversizedNoAt = "openarc:listing:".padEnd(129, "x");
    const noAtResult =
      CommerceMarketLifecycleResourceIdSchema.safeParse(oversizedNoAt);
    expect(noAtResult.success).toBe(false);
    if (!noAtResult.success) {
      expect(noAtResult.error.issues).toHaveLength(1);
      expect(noAtResult.error.issues[0]?.message).toBe(
        "lifecycle resourceId must be at most 128 characters",
      );
    }
  });

  it("safe-parses malformed input without mutating the input", () => {
    const input = { value: `${LISTING_ID}@0` };
    const snapshot = JSON.stringify(input);
    expect(() =>
      CommerceMarketLifecycleResourceIdSchema.safeParse(input.value),
    ).not.toThrow();
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("does not weaken the creation-only version-resource id rule", () => {
    // Version 1 is valid for the lifecycle correlation only; the accepted
    // creation schema remains version >= 2. This is asserted indirectly by
    // published receipts below using @1 while old create receipts still
    // require the version-create resource id (tested in the market suite).
    expect(
      CommerceMarketLifecycleResourceIdSchema.safeParse(`${LISTING_ID}@1`)
        .success,
    ).toBe(true);
  });
});

describe("market lifecycle mutation receipts", () => {
  it("accepts all four exact operation/resourceType pairs", () => {
    for (const operation of LIFECYCLE_OPERATIONS) {
      expect(
        CommerceMarketLifecycleMutationReceiptSchema.safeParse(
          lifecycleReceipt(operation),
        ).success,
        `expected acceptance of ${operation}`,
      ).toBe(true);
    }
  });

  it("keeps the closed union to listing_version with no extra leaves", () => {
    for (const operation of LIFECYCLE_OPERATIONS) {
      expect(
        CommerceMarketLifecycleMutationReceiptSchema.safeParse(
          lifecycleReceipt(operation, `${LISTING_ID}@1`),
        ).success,
      ).toBe(true);
      for (const key of [
        "request",
        "endpoint",
        "reviewerId",
        "accountId",
        "reasonDigest",
        "idempotencyKey",
        "notes",
        "resource",
        "status",
      ]) {
        expect(
          CommerceMarketLifecycleMutationReceiptSchema.safeParse({
            ...lifecycleReceipt(operation),
            [key]: CANARY,
          }).success,
          `expected rejection of receipt extra leaf ${key}`,
        ).toBe(false);
      }
    }
    for (const operation of [
      "market.listing.publish",
      "market.listing.version.unpublish",
      "market.listing.version.delete",
      "",
    ]) {
      expect(
        CommerceMarketLifecycleMutationReceiptSchema.safeParse(
          lifecycleReceipt(operation),
        ).success,
      ).toBe(false);
    }
  });

  it("rejects wrong resourceType pairings and non-lifecycle resource ids", () => {
    for (const operation of LIFECYCLE_OPERATIONS) {
      expect(
        CommerceMarketLifecycleMutationReceiptSchema.safeParse({
          ...lifecycleReceipt(operation),
          resourceType: "listing",
        }).success,
      ).toBe(false);
      expect(
        CommerceMarketLifecycleMutationReceiptSchema.safeParse({
          ...lifecycleReceipt(operation),
          resourceType: "provider",
        }).success,
      ).toBe(false);
      expect(
        CommerceMarketLifecycleMutationReceiptSchema.safeParse(
          lifecycleReceipt(operation, LISTING_ID),
        ).success,
      ).toBe(false);
      expect(
        CommerceMarketLifecycleMutationReceiptSchema.safeParse(
          lifecycleReceipt(operation, `${LISTING_ID}@1@2`),
        ).success,
      ).toBe(false);
    }
  });

  it("requires valid mutation ids and timestamps on every branch", () => {
    for (const operation of LIFECYCLE_OPERATIONS) {
      expect(
        CommerceMarketLifecycleMutationReceiptSchema.safeParse(
          lifecycleReceipt(operation, `${LISTING_ID}@1`, "not-a-uuid"),
        ).success,
      ).toBe(false);
      expect(
        CommerceMarketLifecycleMutationReceiptSchema.safeParse({
          ...lifecycleReceipt(operation),
          committedAt: "2025-13-01T00:00:00.000Z",
        }).success,
      ).toBe(false);
    }
  });
});

describe("expanded market mutation receipt union", () => {
  it("preserves both old branches exactly", () => {
    expect(
      CommerceMarketMutationReceiptSchema.safeParse({
        mutationId: MUTATION,
        operation: "market.listing.create",
        resourceType: "listing",
        resourceId: LISTING_ID,
        committedAt: CREATED_AT,
      }).success,
    ).toBe(true);
    expect(
      CommerceMarketMutationReceiptSchema.safeParse({
        mutationId: MUTATION_B,
        operation: "market.listing.version.create",
        resourceType: "listing_version",
        resourceId: `${LISTING_ID}@2`,
        committedAt: CREATED_AT,
      }).success,
    ).toBe(true);
    // Old draft derived-id binding stays intact.
    expect(
      CommerceMarketMutationReceiptSchema.safeParse({
        mutationId: MUTATION,
        operation: "market.listing.create",
        resourceType: "listing",
        resourceId: LISTING_ID_B,
        committedAt: CREATED_AT,
      }).success,
    ).toBe(false);
  });

  it("keeps old version-create at @1 invalid while lifecycle accepts @1", () => {
    for (const operation of LIFECYCLE_OPERATIONS) {
      expect(
        CommerceMarketMutationReceiptSchema.safeParse(
          lifecycleReceipt(operation, `${LISTING_ID}@1`),
        ).success,
        `expected expanded union acceptance of ${operation}`,
      ).toBe(true);
    }
    expect(
      CommerceMarketMutationReceiptSchema.safeParse({
        mutationId: MUTATION,
        operation: "market.listing.version.create",
        resourceType: "listing_version",
        resourceId: `${LISTING_ID}@1`,
        committedAt: CREATED_AT,
      }).success,
    ).toBe(false);
  });

  it("accepts new branches in result, status and v2 envelope wrappers", () => {
    for (const operation of LIFECYCLE_OPERATIONS) {
      const receipt = lifecycleReceipt(operation);
      expect(
        CommerceMarketMutationResultSchema.safeParse({
          replayed: false,
          receipt,
        }).success,
      ).toBe(true);
      expect(
        CommerceMarketMutationStatusSchema.safeParse({
          status: "committed",
          receipt,
        }).success,
      ).toBe(true);
      expect(
        CommerceMarketMutationResultResponseSchema.safeParse({
          ok: true,
          data: { replayed: true, receipt },
          meta: { ...META },
        }).success,
      ).toBe(true);
      expect(
        CommerceMarketMutationStatusResponseSchema.safeParse({
          ok: true,
          data: { status: "committed", receipt },
          meta: { ...META },
        }).success,
      ).toBe(true);
    }
  });

  it("binds the expanded union result/status field types", () => {
    expectTypeOf<CommerceMarketMutationResult["receipt"]>().toEqualTypeOf<
      CommerceMarketMutationReceipt
    >();
    expectTypeOf<CommerceMarketMutationStatus["status"]>().toEqualTypeOf<
      "committed" | "not_found"
    >();
  });
});

describe("market lifecycle exports and inference", () => {
  it("re-exports the same schema instances from the package root", () => {
    expect(CommerceMarketLifecycleMutationReceiptSchema).toBe(
      DirectLifecycleReceiptSchema,
    );
    expect(CommerceMarketOriginReviewBodySchema).toBe(
      DirectOriginReviewBodySchema,
    );
  });

  it("infers exact body, receipt and resource types", () => {
    expectTypeOf<
      CommerceMarketOriginReviewBody["reasonDigest"]
    >().toEqualTypeOf<string | null>();
    expectTypeOf<
      CommerceMarketOriginReviewBody["reviewedEndpointDigest"]
    >().toEqualTypeOf<string>();
    expectTypeOf<CommerceMarketPublishBody["expectedActiveVersion"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<CommerceMarketPauseBody["mutationId"]>().toEqualTypeOf<string>();
    expectTypeOf<CommerceMarketRetireBody["expectedUpdatedAt"]>().toEqualTypeOf<
      string
    >();
    expectTypeOf<CommerceMarketOwnerRootDetail["item"]>().toEqualTypeOf<
      CommerceListingOwner | null
    >();
    expectTypeOf<CommerceMarketProviderOption["status"]>().toEqualTypeOf<
      "active" | "suspended" | "retired"
    >();
    expectTypeOf<CommerceMarketProviderOptionsPage["nextCursor"]>().toEqualTypeOf<
      string | null
    >();
    expectTypeOf<CommerceMarketProviderOptionsRequest["limit"]>().toEqualTypeOf<
      number | undefined
    >();
    expectTypeOf<CommerceMarketLifecycleResourceId>().toEqualTypeOf<string>();
    expectTypeOf<
      CommerceMarketLifecycleMutationReceipt["operation"]
    >().toEqualTypeOf<
      | "market.listing.origin_review.record"
      | "market.listing.version.publish"
      | "market.listing.version.pause"
      | "market.listing.version.retire"
    >();
    expectTypeOf<CommerceMarketMutationReceipt["operation"]>().toEqualTypeOf<
      | "market.listing.create"
      | "market.listing.version.create"
      | "market.listing.origin_review.record"
      | "market.listing.version.publish"
      | "market.listing.version.pause"
      | "market.listing.version.retire"
    >();
  });
});

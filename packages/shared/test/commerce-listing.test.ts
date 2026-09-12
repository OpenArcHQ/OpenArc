import { describe, expect, expectTypeOf, it } from "vitest";

import {
  CommerceEndpointContractSchema,
  CommerceEndpointOriginSchema,
  CommerceEndpointPathSchema,
  CommerceListingAvailabilitySchema,
  CommerceListingIdSchema,
  CommerceListingKindSchema,
  CommerceListingManifestSchema,
  CommerceListingOwnerSchema,
  CommerceListingOwnerVersionSchema,
  CommerceListingPriceSchema,
  CommerceListingPublicVersionSchema,
  CommerceListingStatusSchema,
  CommerceListingVersionSchema,
  CommerceOriginReviewStateSchema,
  CommerceReceiptContractSchema,
  projectCommerceListingPublicVersion,
  type CommerceEndpointContract,
  type CommerceListingOwner,
  type CommerceListingOwnerVersion,
  type CommerceListingPrice,
  type CommerceListingPublicVersion,
} from "../src/commerce/listing.js";
import { CommerceUsdcAmountSchema } from "../src/commerce/money.js";
import {
  CommerceListingOwnerVersionSchema as IndexOwnerVersionSchema,
  CommerceListingPublicVersionSchema as IndexPublicVersionSchema,
} from "../src/index.js";

const V4 = "12345678-1234-4234-8123-123456789abc";
const V5 = "87654321-4321-4321-b321-cba987654321";
const LISTING_ID = `openarc:listing:${V4}`;
const ORG_ID = `openarc:org:${V4}`;
const PROVIDER_ID = `openarc:provider:${V5}`;
const CREATED_AT = "2025-01-01T00:00:00.000Z";
const UPDATED_AT = "2025-01-02T00:00:00.000Z";
const PUBLISHED_AT = "2025-01-01T12:00:00.000Z";
const DIGEST_A = `sha256:${"a".repeat(64)}`;
const DIGEST_B = `sha256:${"b".repeat(64)}`;
const DIGEST_C = `sha256:${"c".repeat(64)}`;
const MAX_UINT256 =
  "115792089237316195423570985008687907853269984665640564039457584007913129639935";
const OVER_UINT256 =
  "115792089237316195423570985008687907853269984665640564039457584007913129639936";

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

function makeOwner(): Record<string, unknown> {
  return {
    schemaVersion: "openarc.listing-owner-version.v1",
    listingId: LISTING_ID,
    organizationId: ORG_ID,
    providerId: PROVIDER_ID,
    version: "1",
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
    originReviewState: "approved",
    termsRevision: "2025-01",
    privacySummary: "Request metadata is retained for 30 days.",
    paymentLane: "unavailable",
    availability: { status: "available", rateLimitPerMinute: "60" },
    status: "active",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    publishedAt: PUBLISHED_AT,
  };
}

function makeOwnerRecord(): CommerceListingOwnerVersion {
  return CommerceListingOwnerVersionSchema.parse(makeOwner());
}

function makeOwnerPointer(): Record<string, unknown> {
  return {
    schemaVersion: "openarc.listing.v1",
    listingId: LISTING_ID,
    organizationId: ORG_ID,
    providerId: PROVIDER_ID,
    activeVersion: "1",
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
  };
}

describe("CommerceListingIdSchema", () => {
  it("accepts canonical listing ids and rejects every other prefix/casing", () => {
    expect(CommerceListingIdSchema.safeParse(LISTING_ID).success).toBe(true);
    const badVersion = "12345678-1234-9234-8123-123456789abc";
    const badVariant = "12345678-1234-4234-7123-123456789abc";
    const rejected: unknown[] = [
      `openarc:org:${V4}`,
      `openarc:provider:${V4}`,
      `openarc:listing:${V4}`.toUpperCase(),
      `openarc:listing:${V4.slice(0, -1)}`,
      `openarc:listing:${V4}0`,
      `openarc:listing:${V4}x`,
      `openarc:listing:${V4}\n`,
      `openarc:listing:${V4} `,
      ` openarc:listing:${V4}`,
      `openarc:listing:${badVersion}`,
      `openarc:listing:${badVariant}`,
      "openarc:listing:not-a-uuid",
      "",
      null,
      42,
    ];
    for (const value of rejected) {
      expect(
        CommerceListingIdSchema.safeParse(value).success,
        `expected rejection for ${String(value)}`,
      ).toBe(false);
    }
  });
});

describe("CommerceListingVersionSchema", () => {
  it("accepts only canonical decimals in 1..999999999", () => {
    for (const value of ["1", "2", "10", "999999998", "999999999"]) {
      expect(CommerceListingVersionSchema.safeParse(value).success).toBe(true);
    }
    const rejected: unknown[] = [
      "0",
      "00",
      "01",
      "007",
      "1000000000",
      "+1",
      "-1",
      " 1",
      "1 ",
      "1.0",
      "1.2.3",
      "v1",
      "1e2",
      "1E2",
      "0x1",
      "١",
      1,
      null,
    ];
    for (const value of rejected) {
      expect(CommerceListingVersionSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("listing enums", () => {
  it("exposes exactly the frozen members", () => {
    expect(CommerceListingKindSchema.options).toStrictEqual([
      "api",
      "mcp_tool",
      "data",
      "model",
      "workflow",
      "agent",
    ]);
    expect(CommerceListingStatusSchema.options).toStrictEqual([
      "draft",
      "active",
      "paused",
      "retired",
    ]);
    expect(CommerceOriginReviewStateSchema.options).toStrictEqual([
      "unreviewed",
      "approved",
      "rejected",
    ]);
    for (const value of CommerceListingKindSchema.options) {
      expect(CommerceListingKindSchema.safeParse(value).success).toBe(true);
    }
    for (const value of CommerceListingStatusSchema.options) {
      expect(CommerceListingStatusSchema.safeParse(value).success).toBe(true);
    }
    for (const value of CommerceOriginReviewStateSchema.options) {
      expect(CommerceOriginReviewStateSchema.safeParse(value).success).toBe(
        true,
      );
    }
    for (const value of ["other", "API", "", null, 3]) {
      expect(CommerceListingKindSchema.safeParse(value).success).toBe(false);
      expect(CommerceListingStatusSchema.safeParse(value).success).toBe(false);
      expect(CommerceOriginReviewStateSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });
});

describe("CommerceListingPriceSchema", () => {
  it("accepts positive erc20/decimals6 USDC amounts only", () => {
    for (const atomicAmount of ["1", "1000000", MAX_UINT256]) {
      expect(
        CommerceListingPriceSchema.safeParse({
          amount: usdc(atomicAmount),
          pricingModel: "fixed",
        }).success,
      ).toBe(true);
    }
  });

  it("rejects wrong representation/network/asset/decimals/model and zero/negative", () => {
    const base = { amount: usdc("1"), pricingModel: "fixed" };
    const native = {
      ...usdc("1"),
      representation: "native",
      decimals: 18,
    };
    const invalid: unknown[] = [
      { ...base, amount: native },
      { ...base, amount: { ...usdc("1"), networkId: "eip155:1" } },
      { ...base, amount: { ...usdc("1"), asset: "USDT" } },
      { ...base, amount: { ...usdc("1"), decimals: 18 } },
      { ...base, amount: { ...usdc("1"), representation: "erc20", decimals: 6, atomicAmount: "0" } },
      { amount: usdc("0"), pricingModel: "fixed" },
      { amount: usdc("-1"), pricingModel: "fixed" },
      { amount: usdc("01"), pricingModel: "fixed" },
      { amount: usdc("1.0"), pricingModel: "fixed" },
      { amount: usdc("1e2"), pricingModel: "fixed" },
      { amount: usdc(OVER_UINT256), pricingModel: "fixed" },
      { amount: usdc("1"), pricingModel: "metered" },
      { amount: usdc("1") },
      { pricingModel: "fixed" },
      { ...base, extra: true },
      { ...base, amount: { ...usdc("1"), extra: true } },
    ];
    for (const value of invalid) {
      expect(CommerceListingPriceSchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects oversized digit strings without invoking BigInt", () => {
    const originalBigInt = globalThis.BigInt;
    let listingBigIntCalls = 0;
    // A bounded canonical guard must reject an oversized/non-canonical amount
    // before the LISTING price narrowing performs any numeric conversion. The
    // accepted upstream USDC/uint256 schema is not modified here, so this spy
    // counts only conversions of the oversized/non-canonical value itself.
    globalThis.BigInt = ((value: string | number | bigint | boolean) => {
      if (typeof value === "string" && value.length > 78) listingBigIntCalls += 1;
      return originalBigInt(value as never);
    }) as typeof BigInt;
    try {
      const oversized = "1".repeat(500);
      expect(
        CommerceListingPriceSchema.safeParse({
          amount: usdc(oversized),
          pricingModel: "fixed",
        }).success,
      ).toBe(false);
      expect(
        CommerceListingPriceSchema.safeParse({
          amount: usdc("0"),
          pricingModel: "fixed",
        }).success,
      ).toBe(false);
      expect(
        CommerceListingPriceSchema.safeParse({
          amount: usdc("01"),
          pricingModel: "fixed",
        }).success,
      ).toBe(false);
      expect(listingBigIntCalls).toBe(0);
    } finally {
      globalThis.BigInt = originalBigInt;
    }
  });

  it("narrows the inferred price amount type to erc20/decimals6", () => {
    // Guard the selected money branch against an upstream option reorder.
    const selectedBranch = CommerceUsdcAmountSchema.options[1];
    expect(
      selectedBranch.safeParse(usdc("1")).success,
      "money schema options[1] must be the strict erc20/decimals6 branch",
    ).toBe(true);
    expect(selectedBranch.safeParse({ ...usdc("1"), representation: "native", decimals: 18 }).success).toBe(false);

    expectTypeOf<CommerceListingPrice["amount"]["representation"]>().toEqualTypeOf<"erc20">();
    expectTypeOf<CommerceListingPrice["amount"]["decimals"]>().toEqualTypeOf<6>();

    const amount: CommerceListingPrice["amount"] = {
      schemaVersion: "openarc.usdc-amount.v1",
      networkId: "eip155:5042002",
      asset: "USDC",
      representation: "erc20",
      decimals: 6,
      atomicAmount: "1000000",
    };
    expectTypeOf(amount.representation).toEqualTypeOf<"erc20">();
    expectTypeOf(amount.decimals).toEqualTypeOf<6>();

    // Compile-time proof that native/18 cannot satisfy the inferred amount type.
    const acceptInferredAmount = (value: CommerceListingPrice["amount"]): void => {
      void value;
    };
    const assertNativeRejected = (): void => {
      const native = {
        schemaVersion: "openarc.usdc-amount.v1",
        networkId: "eip155:5042002",
        asset: "USDC",
        representation: "native",
        decimals: 18,
        atomicAmount: "1",
      } as const;
      // @ts-expect-error native/18 is not the inferred listing price amount
      acceptInferredAmount(native);
    };
    void assertNativeRejected;
  });
});

describe("CommerceReceiptContractSchema", () => {
  it("accepts bounded unique identifier fields and rejects malformed ones", () => {
    expect(
      CommerceReceiptContractSchema.safeParse(evidenceContract()).success,
    ).toBe(true);
    expect(
      CommerceReceiptContractSchema.safeParse({
        ...evidenceContract(),
        deliveryFields: ["a", "b.c", "d-e_f", "x0"],
      }).success,
    ).toBe(true);
    expect(
      CommerceReceiptContractSchema.safeParse({
        ...evidenceContract(),
        deliveryFields: Array.from({ length: 32 }, (_, i) => `f${i}`),
      }).success,
    ).toBe(true);

    const invalid: unknown[] = [
      { ...evidenceContract(), deliveryFields: [] },
      { ...evidenceContract(), deliveryFields: ["a", "a"] },
      {
        ...evidenceContract(),
        deliveryFields: Array.from({ length: 33 }, (_, i) => `f${i}`),
      },
      { ...evidenceContract(), deliveryFields: ["1abc"] },
      { ...evidenceContract(), deliveryFields: ["Abc"] },
      { ...evidenceContract(), deliveryFields: [`a${"a".repeat(64)}`] },
      { ...evidenceContract(), receiptType: "Api" },
      { ...evidenceContract(), receiptType: "" },
      { ...evidenceContract(), receiptSchemaDigest: DIGEST_A.toUpperCase() },
      { ...evidenceContract(), receiptSchemaDigest: "sha256:short" },
      { ...evidenceContract(), schemaVersion: "openarc.receipt-contract.v2" },
      { ...evidenceContract(), extra: "x" },
      { ...evidenceContract(), deliveryFields: "requestId" },
    ];
    for (const value of invalid) {
      expect(CommerceReceiptContractSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });
});

describe("CommerceListingManifestSchema", () => {
  it("accepts exactly two canonical public digests", () => {
    expect(CommerceListingManifestSchema.safeParse(manifest()).success).toBe(
      true,
    );
    const invalid: unknown[] = [
      { ...manifest(), inputSchemaDigest: DIGEST_A.toUpperCase() },
      { ...manifest(), outputSchemaDigest: "md5:abc" },
      { ...manifest(), schemaVersion: "openarc.listing-manifest.v2" },
      { ...manifest(), extra: "private" },
      { ...manifest(), inputSchemaDigest: DIGEST_A, outputSchemaDigest: DIGEST_B, notes: "x" },
      { inputSchemaDigest: DIGEST_A },
      { ...manifest(), inputSchemaDigest: undefined },
    ];
    for (const value of invalid) {
      expect(CommerceListingManifestSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });
});

describe("CommerceEndpointOriginSchema", () => {
  it("accepts canonical lowercase HTTPS origins including reserved test names", () => {
    for (const origin of [
      "https://api.example.com",
      "https://example.com",
      "https://a.b.example.test",
      "https://service.example.invalid",
      "https://x-y.z.example.org",
    ]) {
      expect(CommerceEndpointOriginSchema.safeParse(origin).success).toBe(true);
    }
  });

  it("rejects credentials/path/query/fragment/case/normalization tricks", () => {
    const invalid: unknown[] = [
      "http://api.example.com",
      "ftp://api.example.com",
      "https://user:pass@api.example.com",
      "https://user@api.example.com",
      "https://api.example.com/",
      "https://api.example.com/v1",
      "https://api.example.com?x=1",
      "https://api.example.com#frag",
      "https://API.example.com",
      "https://api.example.com:443",
      "https://api.example.com.",
      "https://api.example.com\\@evil.example.com",
      "https://api%2eexample.com",
      "https://localhost",
      "https://api.localhost",
      "https://api.local",
      "https://api.internal",
      "https://127.0.0.1",
      "https://93.184.216.34",
      "https://[::1]",
      "https://0x7f000001",
      "https://api.example.com ",
      " https://api.example.com",
      "https://api.example.com\n",
      "https://api\u0000.example.com",
      `https://${"a".repeat(250)}.example.com`,
      "api.example.com",
      "",
      null,
      42,
    ];
    for (const value of invalid) {
      expect(
        CommerceEndpointOriginSchema.safeParse(value).success,
        `expected rejection for ${String(value)}`,
      ).toBe(false);
    }
  });
});

describe("CommerceEndpointPathSchema", () => {
  it("accepts rooted unreserved paths", () => {
    for (const path of ["/", "/v1", "/v1/messages", "/a.b_c~d-e/f0"]) {
      expect(CommerceEndpointPathSchema.safeParse(path).success).toBe(true);
    }
  });

  it("rejects traversal, escapes, queries, fragments and duplicate slashes", () => {
    const invalid: unknown[] = [
      "",
      "v1/messages",
      "//v1",
      "/v1//messages",
      "/v1/./messages",
      "/v1/../messages",
      "/..",
      "/.",
      "/v1\\messages",
      "/v1%2fmessages",
      "/v1?x=1",
      "/v1#frag",
      "/v1 messages",
      "/v1\tmessages",
      "/v1\nmessages",
      "/v1+plus",
      `/${"a".repeat(512)}`,
      null,
      42,
    ];
    for (const value of invalid) {
      expect(CommerceEndpointPathSchema.safeParse(value).success).toBe(false);
    }
    expect(
      CommerceEndpointPathSchema.safeParse(`/${"a".repeat(511)}`).success,
    ).toBe(true);
  });

  it("keeps the endpoint contract strict with an owner-only path", () => {
    const contract = {
      origin: "https://api.example.com",
      path: "/v1/messages",
    };
    expect(CommerceEndpointContractSchema.safeParse(contract).success).toBe(
      true,
    );
    expect(
      CommerceEndpointContractSchema.safeParse({ ...contract, extra: 1 }).success,
    ).toBe(false);
    expect(
      CommerceEndpointContractSchema.safeParse({ origin: contract.origin })
        .success,
    ).toBe(false);
    expect(
      CommerceEndpointContractSchema.safeParse({ path: contract.path }).success,
    ).toBe(false);
  });
});

describe("bounded text fields", () => {
  it("accepts ordinary Unicode within each bound", () => {
    const owner = makeOwner();
    const parsed = CommerceListingOwnerVersionSchema.safeParse({
      ...owner,
      title: "天気 API — café",
      description: "d".repeat(2000),
      termsRevision: "t".repeat(128),
      privacySummary: "p".repeat(1500),
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.description.length).toBe(2000);
      expect(parsed.data.privacySummary.length).toBe(1500);
    }
  });

  it("rejects empty, oversized, untrimmed and control-character text", () => {
    const owner = makeOwner();
    const invalid: unknown[] = [
      { ...owner, title: "" },
      { ...owner, title: "t".repeat(101) },
      { ...owner, title: " padded" },
      { ...owner, title: "padded " },
      { ...owner, title: "two\nlines" },
      { ...owner, title: "tab\there" },
      { ...owner, title: "del\u007f" },
      { ...owner, description: "" },
      { ...owner, description: "d".repeat(2001) },
      { ...owner, description: " leading" },
      { ...owner, termsRevision: "" },
      { ...owner, termsRevision: "t".repeat(129) },
      { ...owner, termsRevision: "trailing " },
      { ...owner, privacySummary: "" },
      { ...owner, privacySummary: "p".repeat(1501) },
      { ...owner, privacySummary: "ctl\u0001here" },
    ];
    for (const value of invalid) {
      expect(CommerceListingOwnerVersionSchema.safeParse(value).success).toBe(
        false,
      );
    }
  });
});

describe("CommerceListingAvailabilitySchema", () => {
  it("accepts null or canonical bounded rate limits", () => {
    for (const rateLimitPerMinute of [null, "1", "1000000"]) {
      expect(
        CommerceListingAvailabilitySchema.safeParse({
          status: "available",
          rateLimitPerMinute,
        }).success,
      ).toBe(true);
    }
    expect(
      CommerceListingAvailabilitySchema.safeParse({
        status: "unavailable",
        rateLimitPerMinute: null,
      }).success,
    ).toBe(true);
  });

  it("rejects zero, non-canonical, out-of-range and unknown fields", () => {
    const invalid: unknown[] = [
      { status: "available", rateLimitPerMinute: "0" },
      { status: "available", rateLimitPerMinute: "00" },
      { status: "available", rateLimitPerMinute: "01" },
      { status: "available", rateLimitPerMinute: "1000001" },
      { status: "available", rateLimitPerMinute: "1e3" },
      { status: "available", rateLimitPerMinute: 60 },
      { status: "available" },
      { status: "healthy", rateLimitPerMinute: null },
      { status: "available", rateLimitPerMinute: null, extra: true },
      null,
    ];
    for (const value of invalid) {
      expect(CommerceListingAvailabilitySchema.safeParse(value).success).toBe(
        false,
      );
    }
  });
});

describe("CommerceListingOwnerVersionSchema timestamps and eligibility", () => {
  it("accepts eligible active publication and retains history for other states", () => {
    expect(CommerceListingOwnerVersionSchema.safeParse(makeOwner()).success).toBe(
      true,
    );
    for (const status of ["draft", "paused", "retired"]) {
      expect(
        CommerceListingOwnerVersionSchema.safeParse({
          ...makeOwner(),
          status,
          originReviewState: "unreviewed",
          publishedAt: null,
        }).success,
      ).toBe(true);
      expect(
        CommerceListingOwnerVersionSchema.safeParse({
          ...makeOwner(),
          status,
          publishedAt: PUBLISHED_AT,
        }).success,
      ).toBe(true);
    }
  });

  it("requires approved review and publishedAt for active versions", () => {
    const invalid: unknown[] = [
      { ...makeOwner(), originReviewState: "unreviewed" },
      { ...makeOwner(), originReviewState: "rejected" },
      { ...makeOwner(), publishedAt: null },
    ];
    for (const value of invalid) {
      expect(
        CommerceListingOwnerVersionSchema.safeParse(value).success,
      ).toBe(false);
    }
  });

  it("orders createdAt/updatedAt and the publication window exactly", () => {
    const invalid: unknown[] = [
      { ...makeOwner(), createdAt: UPDATED_AT, updatedAt: CREATED_AT },
      {
        ...makeOwner(),
        createdAt: "2025-01-01T00:00:00.000000002Z",
        updatedAt: "2025-01-01T00:00:00.000000001Z",
      },
      {
        ...makeOwner(),
        createdAt: "2025-01-01T00:00:01Z",
        publishedAt: "2025-01-01T00:00:00Z",
      },
      {
        ...makeOwner(),
        updatedAt: "2025-01-01T00:00:01Z",
        publishedAt: "2025-01-01T00:00:02Z",
      },
      { ...makeOwner(), createdAt: "not-a-timestamp" },
      { ...makeOwner(), publishedAt: "not-a-timestamp" },
    ];
    for (const value of invalid) {
      expect(
        CommerceListingOwnerVersionSchema.safeParse(value).success,
      ).toBe(false);
    }

    const subMillisecond = {
      ...makeOwner(),
      createdAt: "2025-01-01T00:00:00.000000001Z",
      updatedAt: "2025-01-01T00:00:00.000000002Z",
      publishedAt: "2025-01-01T00:00:00.000000001Z",
    };
    expect(
      CommerceListingOwnerVersionSchema.safeParse(subMillisecond).success,
    ).toBe(true);
  });

  it("rejects injected keys and foreign nested objects", () => {
    const invalid: unknown[] = [
      { ...makeOwner(), organizationId: ORG_ID, extra: "x" },
      { ...makeOwner(), privatePrompt: "secret" },
      { ...makeOwner(), moderationNotes: "nope" },
      { ...makeOwner(), paymentLane: "usdc" },
      { ...makeOwner(), manifest: { ...manifest(), extra: "x" } },
      {
        ...makeOwner(),
        endpointContract: {
          origin: "https://api.example.com",
          path: "/v1/messages",
          extra: "x",
        },
      },
      {
        ...makeOwner(),
        price: { amount: usdc("1"), pricingModel: "fixed", extra: "x" },
      },
    ];
    for (const value of invalid) {
      expect(
        CommerceListingOwnerVersionSchema.safeParse(value).success,
      ).toBe(false);
    }
  });
});

describe("CommerceListingPublicVersionSchema", () => {
  it("accepts a projected public shape and rejects owner-only keys", () => {
    const publicVersion = projectCommerceListingPublicVersion(makeOwner());
    expect(publicVersion).not.toBeNull();
    if (publicVersion === null) throw new Error("expected a projection");
    expect(CommerceListingPublicVersionSchema.safeParse(publicVersion).success).toBe(
      true,
    );

    const invalid: unknown[] = [
      { ...publicVersion, organizationId: ORG_ID },
      { ...publicVersion, endpointContract: { origin: "https://api.example.com", path: "/" } },
      { ...publicVersion, originReviewState: "approved" },
      { ...publicVersion, createdAt: CREATED_AT },
      { ...publicVersion, updatedAt: UPDATED_AT },
      { ...publicVersion, endpointPath: "/v1" },
      { ...publicVersion, extra: "x" },
      { ...publicVersion, status: "draft" },
      { ...publicVersion, publishedAt: undefined },
    ];
    for (const value of invalid) {
      expect(
        CommerceListingPublicVersionSchema.safeParse(value).success,
      ).toBe(false);
    }
  });

  it("is not interchangeable with the owner version schema", () => {
    const owner = makeOwner();
    const publicVersion = projectCommerceListingPublicVersion(owner);
    expect(CommerceListingPublicVersionSchema.safeParse(owner).success).toBe(
      false,
    );
    expect(
      CommerceListingOwnerVersionSchema.safeParse(publicVersion).success,
    ).toBe(false);
  });
});

describe("projectCommerceListingPublicVersion", () => {
  it("returns an explicit allowlist with no private fields or aliases", () => {
    const owner = makeOwner();
    const projected = projectCommerceListingPublicVersion(owner);
    expect(projected).not.toBeNull();
    if (projected === null) return;

    expect(projected).not.toBe(owner);
    expect(projected.manifest).not.toBe(owner.manifest);
    expect(projected.price).not.toBe(owner.price);
    expect(projected.evidenceContract).not.toBe(owner.evidenceContract);
    expect(projected.availability).not.toBe(owner.availability);

    expect(Object.keys(projected).sort()).toStrictEqual(
      [
        "schemaVersion",
        "listingId",
        "providerId",
        "version",
        "kind",
        "title",
        "description",
        "manifest",
        "price",
        "evidenceContract",
        "endpointOrigin",
        "termsRevision",
        "privacySummary",
        "paymentLane",
        "availability",
        "status",
        "publishedAt",
      ].sort(),
    );
    expect(projected.endpointOrigin).toBe("https://api.example.com");
    expect(projected.schemaVersion).toBe("openarc.listing-public-version.v1");
    expect(projected.paymentLane).toBe("unavailable");
    expect(projected.status).toBe("active");

    for (const forbidden of [
      "organizationId",
      "endpointContract",
      "originReviewState",
      "createdAt",
      "updatedAt",
      "privatePrompt",
      "moderationNotes",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(projected, forbidden)).toBe(
        false,
      );
    }

    // Mutating the projection must not mutate the owner input via aliasing.
    projected.title = "mutated";
    expect(owner.title).toBe("Weather API");
  });

  it("returns null for well-formed but ineligible owner states", () => {
    const ineligible: unknown[] = [
      { ...makeOwner(), status: "draft", originReviewState: "unreviewed", publishedAt: null },
      { ...makeOwner(), status: "paused", publishedAt: null },
      { ...makeOwner(), status: "retired", originReviewState: "rejected", publishedAt: null },
      { ...makeOwner(), status: "paused", originReviewState: "unreviewed" },
      { ...makeOwner(), status: "retired", originReviewState: "rejected" },
    ];
    for (const value of ineligible) {
      expect(projectCommerceListingPublicVersion(value)).toBeNull();
    }
  });

  it("rejects malformed owner input instead of returning null", () => {
    const malformed: unknown[] = [
      { ...makeOwner(), title: "" },
      { ...makeOwner(), version: "0" },
      { ...makeOwner(), listingId: ORG_ID },
      { ...makeOwner(), price: { amount: usdc("0"), pricingModel: "fixed" } },
      { ...makeOwner(), endpointContract: { origin: "http://api.example.com", path: "/" } },
      { ...makeOwner(), publishedAt: null },
      { ...makeOwner(), originReviewState: "rejected" },
      {},
      null,
      "owner",
    ];
    for (const value of malformed) {
      expect(() => projectCommerceListingPublicVersion(value)).toThrow();
    }
  });
});

describe("CommerceListingOwnerSchema", () => {
  it("is a strict pointer DTO, not a version content container", () => {
    expect(CommerceListingOwnerSchema.safeParse(makeOwnerPointer()).success).toBe(
      true,
    );
    expect(
      CommerceListingOwnerSchema.safeParse({
        ...makeOwnerPointer(),
        activeVersion: null,
      }).success,
    ).toBe(true);
    expect(
      CommerceListingOwnerSchema.safeParse({
        ...makeOwnerPointer(),
        activeVersion: "999999999",
      }).success,
    ).toBe(true);
  });

  it("rejects embedded version content, extra keys and bad timestamps/ids", () => {
    const invalid: unknown[] = [
      { ...makeOwnerPointer(), activeVersion: makeOwner() },
      { ...makeOwnerPointer(), title: "Weather API" },
      { ...makeOwnerPointer(), extra: "x" },
      { ...makeOwnerPointer(), activeVersion: "0" },
      { ...makeOwnerPointer(), activeVersion: 1 },
      { ...makeOwnerPointer(), createdAt: UPDATED_AT, updatedAt: CREATED_AT },
      {
        ...makeOwnerPointer(),
        createdAt: "2025-01-01T00:00:00.000000002Z",
        updatedAt: "2025-01-01T00:00:00.000000001Z",
      },
      { ...makeOwnerPointer(), listingId: PROVIDER_ID },
      { ...makeOwnerPointer(), providerId: ORG_ID },
      {},
    ];
    for (const value of invalid) {
      expect(CommerceListingOwnerSchema.safeParse(value).success).toBe(false);
    }
  });
});

describe("shared root re-export identity", () => {
  it("re-exports the exact listing validators from the source index", () => {
    expect(IndexOwnerVersionSchema).toBe(CommerceListingOwnerVersionSchema);
    expect(IndexPublicVersionSchema).toBe(CommerceListingPublicVersionSchema);
  });

  it("keeps the root schemas directly usable and strict", () => {
    expect(IndexOwnerVersionSchema.safeParse(makeOwner()).success).toBe(true);
    const projected = projectCommerceListingPublicVersion(makeOwner());
    expect(IndexPublicVersionSchema.safeParse(projected).success).toBe(true);
    expect(
      IndexPublicVersionSchema.safeParse({ ...makeOwnerPointer(), extra: 1 })
        .success,
    ).toBe(false);
  });
});

describe("listing type surface", () => {
  it("preserves literal unions and public/owner distinctions", () => {
    const owner = makeOwnerRecord();
    expectTypeOf(owner.schemaVersion).toEqualTypeOf<"openarc.listing-owner-version.v1">();
    expectTypeOf(owner.paymentLane).toEqualTypeOf<"unavailable">();
    expectTypeOf(owner.kind).toEqualTypeOf<
      "api" | "mcp_tool" | "data" | "model" | "workflow" | "agent"
    >();
    expectTypeOf(owner.status).toEqualTypeOf<
      "draft" | "active" | "paused" | "retired"
    >();
    expectTypeOf(owner.originReviewState).toEqualTypeOf<
      "unreviewed" | "approved" | "rejected"
    >();
    expectTypeOf(owner.publishedAt).toEqualTypeOf<string | null>();

    const projected = projectCommerceListingPublicVersion(owner);
    if (projected !== null) {
      expectTypeOf<CommerceListingPublicVersion>(projected).toEqualTypeOf<CommerceListingPublicVersion>();
      expectTypeOf(projected.status).toEqualTypeOf<"active">();
      expectTypeOf(projected.publishedAt).toEqualTypeOf<string>();
    }

    const pointer: CommerceListingOwner = makeOwnerPointer() as unknown as CommerceListingOwner;
    expectTypeOf(pointer.activeVersion).toEqualTypeOf<string | null>();
    expectTypeOf<CommerceEndpointContract["path"]>().toEqualTypeOf<string>();
  });
});

describe("bounded deterministic inventory checks", () => {
  it("round-trips eligible owners through the public allowlist", () => {
    for (let version = 1; version <= 25; version += 1) {
      const owner = makeOwner();
      owner.version = String(version);
      const projected = projectCommerceListingPublicVersion(owner);
      expect(projected).not.toBeNull();
      if (projected === null) continue;
      expect(projected.version).toBe(String(version));
      expect(projected.listingId).toBe(LISTING_ID);
      expect(CommerceListingPublicVersionSchema.safeParse(projected).success).toBe(
        true,
      );
      expect(
        Object.prototype.hasOwnProperty.call(projected, "organizationId"),
      ).toBe(false);
    }
  });
});

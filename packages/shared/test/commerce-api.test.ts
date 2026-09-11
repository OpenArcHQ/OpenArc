import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  COMMERCE_API_ERRORS,
  COMMERCE_API_FIELD_CLASSES,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceApiErrorCodeSchema,
  CommerceApiErrorEnvelopeSchema,
  CommerceApiMetaSchema,
  createCommerceErrorEnvelope,
  createCommerceSuccessEnvelopeSchema,
  type CommerceApiErrorCode,
  type CommerceApiMeta,
} from "../src/commerce/api.js";
import {
  API_SCHEMA_VERSION,
  ApiErrorEnvelopeSchema,
  ApiMetaSchema,
} from "../src/api.js";

const EXPECTED_CODES = [
  "FEATURE_DISABLED",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "TENANT_MISMATCH",
  "INVALID_ORIGIN",
  "CSRF_REJECTED",
  "INVALID_REQUEST",
  "UNSUPPORTED_MEDIA_TYPE",
  "REQUEST_TOO_LARGE",
  "RATE_LIMITED",
  "IDEMPOTENCY_CONFLICT",
  "LISTING_NOT_ACTIVE",
  "LISTING_VERSION_MISMATCH",
  "POLICY_DENIED",
  "APPROVAL_REQUIRED",
  "BUDGET_LIMIT_EXCEEDED",
  "BUDGET_RESERVATION_CONFLICT",
  "GRANT_EXPIRED",
  "GRANT_REVOKED",
  "GRANT_ALREADY_USED",
  "PAYMENT_REQUIRED",
  "PAYMENT_INVALID",
  "PAYMENT_UNVERIFIED",
  "SETTLEMENT_PENDING",
  "SOURCE_UNAVAILABLE",
  "SOURCE_WRONG_NETWORK",
  "SOURCE_CONFLICT",
  "RECEIPT_MALFORMED",
  "DELIVERY_UNVERIFIED",
  "JOB_STATE_CONFLICT",
  "INTERNAL_ERROR",
] as const satisfies readonly CommerceApiErrorCode[];

const CANARY = "PRIVATE_CANARY_DO_NOT_ECHO";
const SAMPLE_UUID = "9f1c2d34-5e6a-4b7c-8d9e-0f1a2b3c4d5e";
const SAMPLE_SHA = "0123456789abcdef0123456789abcdef01234567";

const VALID_META: CommerceApiMeta = CommerceApiMetaSchema.parse({
  schemaVersion: COMMERCE_API_SCHEMA_VERSION,
  requestId: SAMPLE_UUID,
  buildSha: SAMPLE_SHA,
});

const CANONICAL_ERROR = {
  code: "INTERNAL_ERROR" as const,
  message: COMMERCE_API_ERRORS.INTERNAL_ERROR.message,
  retryable: false as const,
};

function validErrorRoot() {
  return {
    ok: false as const,
    error: { ...CANONICAL_ERROR },
    meta: { ...VALID_META },
  };
}

describe("commerce api v2 error codes and catalog", () => {
  it("publishes exactly the 31 supplied unique error codes", () => {
    expect(COMMERCE_API_SCHEMA_VERSION).toBe("openarc.api.v2");
    expect([...CommerceApiErrorCodeSchema.options]).toEqual([...EXPECTED_CODES]);
    expect(new Set(CommerceApiErrorCodeSchema.options).size).toBe(31);
    expect(EXPECTED_CODES.length).toBe(31);
  });

  it("publishes an exhaustive frozen fixed-message catalog", () => {
    expect(Object.isFrozen(COMMERCE_API_ERRORS)).toBe(true);
    expect(Object.keys(COMMERCE_API_ERRORS).sort()).toEqual(
      [...EXPECTED_CODES].sort(),
    );

    const messages = EXPECTED_CODES.map(
      (code) => COMMERCE_API_ERRORS[code].message,
    );
    expect(new Set(messages).size).toBe(31);

    for (const code of EXPECTED_CODES) {
      const entry = COMMERCE_API_ERRORS[code];
      expect(Object.isFrozen(entry)).toBe(true);
      expect(entry.retryable).toBe(false);
      expect(entry.message.length).toBeGreaterThan(0);
      expect(entry.message.length).toBeLessThanOrEqual(160);
    }
  });

  it("marks unverified payment and pending settlement as unconfirmed", () => {
    const payment = COMMERCE_API_ERRORS.PAYMENT_UNVERIFIED.message.toLowerCase();
    expect(payment).toContain("not confirmed");
    expect(payment).not.toContain("failed");
    expect(payment).not.toContain("unpaid");

    const settlement =
      COMMERCE_API_ERRORS.SETTLEMENT_PENDING.message.toLowerCase();
    expect(settlement).toContain("pending");
    expect(settlement).not.toContain("failed");
    expect(settlement).not.toContain("unpaid");
  });
});

describe("commerce api v2 error envelopes", () => {
  it("builds a canonical envelope for each code with constructor parity", () => {
    for (const code of EXPECTED_CODES) {
      const built = createCommerceErrorEnvelope(code, VALID_META);
      expect(built.ok).toBe(false);
      expect(built.error.code).toBe(code);
      expect(built.error.message).toBe(COMMERCE_API_ERRORS[code].message);
      expect(built.error.retryable).toBe(false);
      expect(built.meta).toEqual(VALID_META);

      const reparsed = CommerceApiErrorEnvelopeSchema.parse(built);
      expect(reparsed).toEqual(built);
    }
  });

  it("rejects forged, inconsistent, or retryable error fields", () => {
    const forged = {
      ...validErrorRoot(),
      error: { ...CANONICAL_ERROR, message: CANARY },
    };
    expect(CommerceApiErrorEnvelopeSchema.safeParse(forged).success).toBe(false);

    const inconsistent = {
      ...validErrorRoot(),
      error: {
        ...CANONICAL_ERROR,
        message: COMMERCE_API_ERRORS.PAYMENT_INVALID.message,
      },
    };
    expect(CommerceApiErrorEnvelopeSchema.safeParse(inconsistent).success).toBe(
      false,
    );

    const retryable = {
      ...validErrorRoot(),
      error: { ...CANONICAL_ERROR, retryable: true },
    };
    expect(CommerceApiErrorEnvelopeSchema.safeParse(retryable).success).toBe(
      false,
    );
  });

  it("rejects extra private fields at every envelope level", () => {
    const privateKeys = [
      "privatePrompt",
      "rawOutput",
      "signature",
      "cookie",
      "stack",
      "details",
    ] as const;

    for (const key of privateKeys) {
      expect(
        CommerceApiErrorEnvelopeSchema.safeParse({
          ...validErrorRoot(),
          [key]: CANARY,
        }).success,
      ).toBe(false);

      expect(
        CommerceApiErrorEnvelopeSchema.safeParse({
          ...validErrorRoot(),
          error: { ...CANONICAL_ERROR, [key]: CANARY },
        }).success,
      ).toBe(false);

      expect(
        CommerceApiErrorEnvelopeSchema.safeParse({
          ...validErrorRoot(),
          meta: { ...VALID_META, [key]: CANARY },
        }).success,
      ).toBe(false);
    }
  });

  it("rejects success mixtures on the error envelope root", () => {
    expect(
      CommerceApiErrorEnvelopeSchema.safeParse({
        ok: false,
        error: { ...CANONICAL_ERROR },
        data: { sampleCount: 1 },
        meta: { ...VALID_META },
      }).success,
    ).toBe(false);

    expect(
      CommerceApiErrorEnvelopeSchema.safeParse({
        ok: true,
        error: { ...CANONICAL_ERROR },
        meta: { ...VALID_META },
      }).success,
    ).toBe(false);
  });

  it("never echoes malformed input in canonical serialized errors", () => {
    const rejected = CommerceApiErrorEnvelopeSchema.safeParse({
      ...validErrorRoot(),
      error: { ...CANONICAL_ERROR, message: CANARY },
    });
    expect(rejected.success).toBe(false);

    const canonical = createCommerceErrorEnvelope(
      "PAYMENT_UNVERIFIED",
      VALID_META,
    );
    const serialized = JSON.stringify(canonical);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain("privatePrompt");
    expect(serialized).not.toContain("rawOutput");
    expect(serialized).not.toContain("signature");
    expect(serialized).not.toContain("cookie");
    expect(serialized).not.toContain("stack");
    expect(serialized).not.toContain("details");
  });
});

describe("commerce api v2 versioned wire metadata", () => {
  it("rejects wrong versions, malformed ids, and bad SHA forms", () => {
    expect(
      CommerceApiMetaSchema.safeParse({
        ...VALID_META,
        schemaVersion: "openarc.api.v1",
      }).success,
    ).toBe(false);

    expect(
      CommerceApiMetaSchema.safeParse({
        ...VALID_META,
        requestId: "not-a-uuid",
      }).success,
    ).toBe(false);

    expect(
      CommerceApiMetaSchema.safeParse({ ...VALID_META, buildSha: "deadbeef" })
        .success,
    ).toBe(false);

    expect(
      CommerceApiMetaSchema.safeParse({
        ...VALID_META,
        buildSha: "0123456789ABCDEF0123456789ABCDEF01234567",
      }).success,
    ).toBe(false);

    expect(
      CommerceApiMetaSchema.safeParse({
        ...VALID_META,
        buildSha: "build-label-v1".padEnd(40, "0"),
      }).success,
    ).toBe(false);
  });

  it("rejects unknown and missing metadata keys", () => {
    expect(
      CommerceApiMetaSchema.safeParse({ ...VALID_META, buildLabel: "x" })
        .success,
    ).toBe(false);

    expect(
      CommerceApiMetaSchema.safeParse({
        schemaVersion: VALID_META.schemaVersion,
        buildSha: VALID_META.buildSha,
      }).success,
    ).toBe(false);
  });

  it("passes a valid lowercase 40-char SHA and UUID unchanged", () => {
    const parsed = CommerceApiMetaSchema.parse({ ...VALID_META });
    expect(parsed.requestId).toBe(SAMPLE_UUID);
    expect(parsed.buildSha).toBe(SAMPLE_SHA);
    expect(parsed.schemaVersion).toBe("openarc.api.v2");
  });
});

describe("commerce api v2 success factory", () => {
  const SampleDtoSchema = z.strictObject({
    sampleCount: z.number().int().min(0).max(3),
  });
  const sampleSuccessSchema =
    createCommerceSuccessEnvelopeSchema(SampleDtoSchema);

  it("validates a strict reviewed success DTO", () => {
    const parsed = sampleSuccessSchema.parse({
      ok: true,
      data: { sampleCount: 2 },
      meta: VALID_META,
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.data.sampleCount).toBe(2);
  });

  it("rejects wrong-typed, missing, extra, and discriminator payloads", () => {
    const bad: readonly unknown[] = [
      { ok: true, data: { sampleCount: "2" }, meta: VALID_META },
      { ok: true, data: {}, meta: VALID_META },
      {
        ok: true,
        data: { sampleCount: 1, privatePrompt: CANARY },
        meta: VALID_META,
      },
      { ok: true, data: { sampleCount: 9 }, meta: VALID_META },
      { ok: false, data: { sampleCount: 1 }, meta: VALID_META },
      { ok: true, data: null, meta: VALID_META },
      { ok: true, data: [], meta: VALID_META },
      {
        ok: true,
        data: { sampleCount: 1 },
        error: { ...CANONICAL_ERROR },
        meta: VALID_META,
      },
    ];

    for (const payload of bad) {
      expect(sampleSuccessSchema.safeParse(payload).success).toBe(false);
    }
  });

  it("preserves the synthetic DTO inferred shape", () => {
    const typed = sampleSuccessSchema.parse({
      ok: true,
      data: { sampleCount: 1 },
      meta: VALID_META,
    });
    expectTypeOf(typed.data).toEqualTypeOf<{ sampleCount: number }>();
    const count: number = typed.data.sampleCount;
    expect(count).toBe(1);
  });
});

describe("commerce api v2 field classes", () => {
  it("maps exactly the fixed control-envelope metadata leaves", () => {
    const fixedPaths = [
      "ok",
      "meta.schemaVersion",
      "meta.requestId",
      "meta.buildSha",
      "error.code",
      "error.message",
      "error.retryable",
    ] as const;

    expect(Object.isFrozen(COMMERCE_API_FIELD_CLASSES)).toBe(true);
    expect(Object.keys(COMMERCE_API_FIELD_CLASSES).sort()).toEqual(
      [...fixedPaths].sort(),
    );

    for (const path of fixedPaths) {
      expect(COMMERCE_API_FIELD_CLASSES[path]).toBe("organization_protected");
    }
  });
});

describe("commerce api v2 legacy boundary", () => {
  it("keeps legacy v1 exports intact and rejects cross-version metadata", () => {
    expect(API_SCHEMA_VERSION).toBe("openarc.api.v1");
    expect(ApiMetaSchema).toBeDefined();
    expect(ApiErrorEnvelopeSchema).toBeDefined();

    expect(
      CommerceApiMetaSchema.safeParse({
        ...VALID_META,
        schemaVersion: "openarc.api.v1",
      }).success,
    ).toBe(false);

    expect(ApiMetaSchema.safeParse({ ...VALID_META }).success).toBe(false);
  });
});

import { z } from "zod";

/**
 * Strict commerce API v2 wire contracts.
 *
 * This module is intentionally additive to the legacy v1 api surface. It does
 * not import, wrap, or reinterpret legacy schemas. All objects are strict: no
 * unknown keys, defaults, `any`, records, or raw payload slots are permitted.
 */

export const COMMERCE_API_SCHEMA_VERSION = "openarc.api.v2" as const;

export const CommerceApiErrorCodeSchema = z.enum([
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
]);

export type CommerceApiErrorCode = z.infer<typeof CommerceApiErrorCodeSchema>;

type CommerceApiErrorCatalogEntry = Readonly<{
  message: string;
  retryable: false;
}>;

/**
 * Fixed, non-interpolated English catalog for every commerce error code.
 * Messages never echo caller input. Automatic write retry is not supported by
 * this foundation, so every retryable flag is `false`. HTTP status mapping is
 * deliberately absent until audience routes are frozen.
 */
export const COMMERCE_API_ERRORS: Readonly<
  Record<CommerceApiErrorCode, CommerceApiErrorCatalogEntry>
> = Object.freeze({
  FEATURE_DISABLED: Object.freeze({
    message: "This feature is disabled for the current deployment.",
    retryable: false,
  }),
  UNAUTHENTICATED: Object.freeze({
    message: "Authentication is required to perform this request.",
    retryable: false,
  }),
  FORBIDDEN: Object.freeze({
    message: "The caller is not permitted to perform this request.",
    retryable: false,
  }),
  TENANT_MISMATCH: Object.freeze({
    message: "The request targets a tenant that does not match the caller.",
    retryable: false,
  }),
  INVALID_ORIGIN: Object.freeze({
    message: "The request origin is not permitted for this endpoint.",
    retryable: false,
  }),
  CSRF_REJECTED: Object.freeze({
    message: "The anti-forgery token was missing or rejected.",
    retryable: false,
  }),
  INVALID_REQUEST: Object.freeze({
    message: "The request failed validation against the published contract.",
    retryable: false,
  }),
  UNSUPPORTED_MEDIA_TYPE: Object.freeze({
    message: "The request media type is not supported by this endpoint.",
    retryable: false,
  }),
  REQUEST_TOO_LARGE: Object.freeze({
    message: "The request payload exceeds the allowed size limit.",
    retryable: false,
  }),
  RATE_LIMITED: Object.freeze({
    message: "The request rate limit has been exceeded for this caller.",
    retryable: false,
  }),
  IDEMPOTENCY_CONFLICT: Object.freeze({
    message: "The idempotency key was reused with a different request.",
    retryable: false,
  }),
  LISTING_NOT_ACTIVE: Object.freeze({
    message: "The referenced listing is not currently active.",
    retryable: false,
  }),
  LISTING_VERSION_MISMATCH: Object.freeze({
    message: "The listing version does not match the expected version.",
    retryable: false,
  }),
  POLICY_DENIED: Object.freeze({
    message: "The applicable policy denied this request.",
    retryable: false,
  }),
  APPROVAL_REQUIRED: Object.freeze({
    message: "Human approval is required before this request can proceed.",
    retryable: false,
  }),
  BUDGET_LIMIT_EXCEEDED: Object.freeze({
    message: "The request exceeds the applicable budget limit.",
    retryable: false,
  }),
  BUDGET_RESERVATION_CONFLICT: Object.freeze({
    message: "The budget reservation conflicts with an existing reservation.",
    retryable: false,
  }),
  GRANT_EXPIRED: Object.freeze({
    message: "The referenced grant has expired.",
    retryable: false,
  }),
  GRANT_REVOKED: Object.freeze({
    message: "The referenced grant has been revoked.",
    retryable: false,
  }),
  GRANT_ALREADY_USED: Object.freeze({
    message: "The referenced grant has already been used.",
    retryable: false,
  }),
  PAYMENT_REQUIRED: Object.freeze({
    message: "Payment is required before this request can proceed.",
    retryable: false,
  }),
  PAYMENT_INVALID: Object.freeze({
    message: "The supplied payment is invalid.",
    retryable: false,
  }),
  PAYMENT_UNVERIFIED: Object.freeze({
    message: "Payment is not confirmed and remains unverified.",
    retryable: false,
  }),
  SETTLEMENT_PENDING: Object.freeze({
    message: "Settlement is pending and not yet confirmed.",
    retryable: false,
  }),
  SOURCE_UNAVAILABLE: Object.freeze({
    message: "The external source is currently unavailable.",
    retryable: false,
  }),
  SOURCE_WRONG_NETWORK: Object.freeze({
    message: "The external source responded on the wrong network.",
    retryable: false,
  }),
  SOURCE_CONFLICT: Object.freeze({
    message: "The external source returned conflicting results.",
    retryable: false,
  }),
  RECEIPT_MALFORMED: Object.freeze({
    message: "The supplied receipt is malformed.",
    retryable: false,
  }),
  DELIVERY_UNVERIFIED: Object.freeze({
    message: "Delivery could not be verified.",
    retryable: false,
  }),
  JOB_STATE_CONFLICT: Object.freeze({
    message: "The job is not in a state that allows this operation.",
    retryable: false,
  }),
  INTERNAL_ERROR: Object.freeze({
    message: "An internal error prevented the request from completing.",
    retryable: false,
  }),
});

export const CommerceApiMetaSchema = z.strictObject({
  schemaVersion: z.literal(COMMERCE_API_SCHEMA_VERSION),
  requestId: z.uuid(),
  buildSha: z.string().regex(/^[0-9a-f]{40}$/u),
});

export type CommerceApiMeta = z.infer<typeof CommerceApiMetaSchema>;

export const CommerceApiErrorSchema = z
  .strictObject({
    code: CommerceApiErrorCodeSchema,
    message: z.string().min(1).max(160),
    retryable: z.literal(false),
  })
  .superRefine((value, ctx) => {
    const expected = COMMERCE_API_ERRORS[value.code].message;
    if (value.message !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["message"],
        message:
          "Error message must match the canonical sentence for the error code.",
      });
    }
  });

export type CommerceApiError = z.infer<typeof CommerceApiErrorSchema>;

export const CommerceApiErrorEnvelopeSchema = z.strictObject({
  ok: z.literal(false),
  error: CommerceApiErrorSchema,
  meta: CommerceApiMetaSchema,
});

export type CommerceApiErrorEnvelope = z.infer<
  typeof CommerceApiErrorEnvelopeSchema
>;

/**
 * Builds a strict success envelope over a caller-supplied DTO schema.
 *
 * The generic factory does NOT itself sanitize arbitrary data, redact fields,
 * or authorize public disclosure. Callers must supply a reviewed, strict,
 * field-allowlisted DTO schema. `T` retains its inferred data shape; the data
 * subtree's field classes belong to that concrete DTO, not to this envelope
 * metadata registry.
 */
export function createCommerceSuccessEnvelopeSchema<T extends z.ZodType>(
  dataSchema: T,
) {
  return z.strictObject({
    ok: z.literal(true),
    data: dataSchema,
    meta: CommerceApiMetaSchema,
  });
}

/**
 * Constructs and parses a canonical error envelope using only fixed catalog
 * metadata. It never accepts a raw Error, provider response, message override,
 * payload, credential, or any caller-controlled text.
 */
export function createCommerceErrorEnvelope(
  code: CommerceApiErrorCode,
  meta: CommerceApiMeta,
): CommerceApiErrorEnvelope {
  const entry = COMMERCE_API_ERRORS[code];
  return CommerceApiErrorEnvelopeSchema.parse({
    ok: false,
    error: {
      code,
      message: entry.message,
      retryable: entry.retryable,
    },
    meta,
  });
}

/**
 * Conservative control-route envelope metadata classification. This is not the
 * whole field-level registry, nor an enforcement or authorization mechanism;
 * it covers only the fixed metadata/error envelope leaves listed here. The
 * generic success `data` subtree is out of scope and belongs to each DTO.
 */
export const COMMERCE_API_FIELD_CLASSES = Object.freeze({
  ok: "organization_protected",
  "meta.schemaVersion": "organization_protected",
  "meta.requestId": "organization_protected",
  "meta.buildSha": "organization_protected",
  "error.code": "organization_protected",
  "error.message": "organization_protected",
  "error.retryable": "organization_protected",
} as const);

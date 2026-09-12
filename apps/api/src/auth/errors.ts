import {
  COMMERCE_API_ERRORS,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceApiErrorEnvelopeSchema,
  type CommerceApiErrorCode,
} from "@openarc/shared";

import type { ApiErrorCode } from "@openarc/shared";

/**
 * Fixed auth route error. Never carries parser, driver, proof or cookie detail.
 * The HTTP status and the v1 metrics code are explicit so the v2 envelope is
 * never derived from raw causes.
 */
export class AuthApiError extends Error {
  readonly code: CommerceApiErrorCode;
  readonly status: number;
  readonly metricsCode: ApiErrorCode;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: CommerceApiErrorCode,
    status: number,
    metricsCode: ApiErrorCode,
    retryAfterSeconds?: number,
  ) {
    super(COMMERCE_API_ERRORS[code].message);
    this.name = "AuthApiError";
    this.code = code;
    this.status = status;
    this.metricsCode = metricsCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function authErrorEnvelope(
  error: AuthApiError,
  requestId: string,
  buildSha: string,
) {
  const entry = COMMERCE_API_ERRORS[error.code];
  return CommerceApiErrorEnvelopeSchema.parse({
    ok: false,
    error: {
      code: error.code,
      message: entry.message,
      retryable: entry.retryable,
    },
    meta: {
      schemaVersion: COMMERCE_API_SCHEMA_VERSION,
      requestId,
      buildSha,
    },
  });
}

export const AUTH_ERRORS = Object.freeze({
  invalidRequest: () =>
    new AuthApiError("INVALID_REQUEST", 400, "INVALID_REQUEST"),
  originRejected: () =>
    new AuthApiError("INVALID_ORIGIN", 403, "INVALID_ORIGIN"),
  csrfRejected: () =>
    new AuthApiError("CSRF_REJECTED", 403, "INVALID_ORIGIN"),
  unauthenticated: () =>
    new AuthApiError("UNAUTHENTICATED", 401, "INVALID_REQUEST"),
  forbidden: () => new AuthApiError("FORBIDDEN", 403, "INVALID_REQUEST"),
  unsupportedMedia: () =>
    new AuthApiError("UNSUPPORTED_MEDIA_TYPE", 415, "UNSUPPORTED_MEDIA_TYPE"),
  tooLarge: () =>
    new AuthApiError("REQUEST_TOO_LARGE", 413, "REQUEST_TOO_LARGE"),
  rateLimited: () => new AuthApiError("RATE_LIMITED", 429, "RATE_LIMITED"),
  unavailable: () =>
    new AuthApiError("INTERNAL_ERROR", 503, "INTERNAL_ERROR"),
  internal: () => new AuthApiError("INTERNAL_ERROR", 500, "INTERNAL_ERROR"),
  featureDisabled: () =>
    new AuthApiError("FEATURE_DISABLED", 503, "FEATURE_DISABLED"),
});

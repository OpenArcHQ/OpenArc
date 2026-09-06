import { API_ERRORS, API_SCHEMA_VERSION, ApiErrorEnvelopeSchema, type ApiErrorCode } from "@openarc/shared";

export class ApiBoundaryError extends Error {
  constructor(readonly code: ApiErrorCode, readonly retryAfterSeconds?: number) {
    super(API_ERRORS[code].message);
    this.name = "ApiBoundaryError";
  }
}

export function apiErrorEnvelope(error: ApiBoundaryError, requestId: string, buildSha: string) {
  return ApiErrorEnvelopeSchema.parse({
    ok: false,
    error: { code: error.code, message: API_ERRORS[error.code].message,
      retryable: API_ERRORS[error.code].retryable,
      ...(error.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: error.retryAfterSeconds }) },
    meta: { schemaVersion: API_SCHEMA_VERSION, requestId, buildSha },
  });
}

export function normalizeApiError(cause: unknown): ApiBoundaryError {
  if (cause instanceof ApiBoundaryError) return cause;
  const code = typeof cause === "object" && cause !== null && "code" in cause ? cause.code : null;
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") return new ApiBoundaryError("REQUEST_TOO_LARGE");
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" || code === "FST_ERR_CTP_INVALID_CONTENT_LENGTH") {
    return new ApiBoundaryError(code === "FST_ERR_CTP_INVALID_MEDIA_TYPE" ? "UNSUPPORTED_MEDIA_TYPE" : "INVALID_REQUEST");
  }
  if (code === "FST_ERR_CTP_EMPTY_JSON_BODY" || code === "FST_ERR_CTP_INVALID_JSON_BODY" ||
    code === "FST_ERR_VALIDATION" || cause instanceof SyntaxError) return new ApiBoundaryError("INVALID_REQUEST");
  return new ApiBoundaryError("INTERNAL_ERROR");
}

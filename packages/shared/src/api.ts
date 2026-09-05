import { z } from "zod";

import { ARC_ERC8004, ARC_TESTNET } from "./network.js";
import { BuildMarkerSchema } from "./primitives.js";

export const API_SCHEMA_VERSION = "openarc.api.v1" as const;
export const CAPABILITIES_PATH = "/v1/private/capabilities" as const;
export const API_CLIENT_HEADER = "browser-v1" as const;
export const API_MAX_RESPONSE_BYTES = 64 * 1024;
export const API_MAX_REQUEST_BYTES = 16 * 1024;

export const ApiErrorCodeSchema = z.enum([
  "FEATURE_DISABLED", "INVALID_ORIGIN", "CREDENTIALS_NOT_ALLOWED",
  "UNSUPPORTED_MEDIA_TYPE", "REQUEST_TOO_LARGE", "INVALID_REQUEST",
  "RATE_LIMITED", "GLOBAL_BUDGET_EXHAUSTED", "BUDGET_STORE_UNAVAILABLE",
  "SOURCE_UNAVAILABLE", "SOURCE_RATE_LIMITED", "SOURCE_RESPONSE_TOO_LARGE",
  "SOURCE_MALFORMED", "SOURCE_WRONG_NETWORK", "SOURCE_CONFLICT",
  "SOURCE_NOT_FOUND", "UNSUPPORTED_EVIDENCE", "INTERNAL_ERROR", "NOT_FOUND",
  "METHOD_NOT_ALLOWED", "METRICS_UNAUTHORIZED",
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

const error = (status: number, message: string, retryable = false) =>
  Object.freeze({ status, message, retryable });
export const API_ERRORS = Object.freeze({
  FEATURE_DISABLED: error(503, "This capability is disabled."),
  INVALID_ORIGIN: error(403, "This request did not pass the browser-origin boundary."),
  CREDENTIALS_NOT_ALLOWED: error(400, "This route does not accept cookies or credentials."),
  UNSUPPORTED_MEDIA_TYPE: error(415, "Use a supported JSON content type."),
  REQUEST_TOO_LARGE: error(413, "The request exceeds this route's size limit."),
  INVALID_REQUEST: error(400, "The request does not match the supported contract."),
  RATE_LIMITED: error(429, "The request limit has been reached.", true),
  GLOBAL_BUDGET_EXHAUSTED: error(503, "The source's daily request budget has been reached.", true),
  BUDGET_STORE_UNAVAILABLE: error(503, "The request-budget store is unavailable.", true),
  SOURCE_UNAVAILABLE: error(503, "The approved source is temporarily unavailable.", true),
  SOURCE_RATE_LIMITED: error(503, "The approved source is rate limiting requests.", true),
  SOURCE_RESPONSE_TOO_LARGE: error(503, "The approved source exceeded its response limit."),
  SOURCE_MALFORMED: error(502, "The source response did not match its supported contract."),
  SOURCE_WRONG_NETWORK: error(502, "The source did not confirm the required network."),
  SOURCE_CONFLICT: error(502, "The source returned inconsistent facts."),
  SOURCE_NOT_FOUND: error(404, "The requested source evidence was not found."),
  UNSUPPORTED_EVIDENCE: error(422, "This evidence is not supported."),
  INTERNAL_ERROR: error(500, "OpenArc could not complete this request."),
  NOT_FOUND: error(404, "Route not found."),
  METHOD_NOT_ALLOWED: error(405, "This route does not support that method."),
  METRICS_UNAUTHORIZED: error(401, "Metrics authorization is required."),
} satisfies Record<ApiErrorCode, { status: number; message: string; retryable: boolean }>);

export const ApiMetaSchema = z.strictObject({
  schemaVersion: z.literal(API_SCHEMA_VERSION),
  requestId: z.uuid(),
  buildSha: BuildMarkerSchema,
});

export const ApiErrorEnvelopeSchema = z.strictObject({
  ok: z.literal(false),
  error: z.strictObject({
    code: ApiErrorCodeSchema,
    message: z.string().min(1).max(160),
    retryable: z.boolean(),
    retryAfterSeconds: z.number().int().min(1).max(86_460).optional(),
  }).superRefine((value, context) => {
    const definition = API_ERRORS[value.code];
    if (value.message !== definition.message || value.retryable !== definition.retryable) {
      context.addIssue({ code: "custom", message: "Error metadata must match the fixed code" });
    }
    if (value.retryAfterSeconds !== undefined && !definition.retryable) {
      context.addIssue({ code: "custom", message: "A permanent error cannot advertise a retry" });
    }
  }),
  meta: ApiMetaSchema,
});

export const ApiLimitsSchema = z.strictObject({
  requestBytes: z.literal(API_MAX_REQUEST_BYTES),
  responseBytes: z.literal(API_MAX_RESPONSE_BYTES),
  sourceResponseBytes: z.number().int().min(1024).max(256 * 1024),
  sourceTimeoutMs: z.number().int().min(100).max(10_000),
  sourceMaxSubcalls: z.number().int().min(1).max(16),
  requestsPerPeerHour: z.number().int().min(1).max(10_000),
  globalSourceUnitsPerDay: z.number().int().min(1).max(1_000_000),
});

export const M04CapabilitiesSchema = z.strictObject({
  capabilityVersion: z.literal("openarc.capabilities.m04.v1"),
  environment: z.literal("testnet"),
  network: z.literal(ARC_TESTNET.caip2),
  sourceRevision: z.literal(ARC_TESTNET.sourceRevision),
  reviewedAt: z.literal(ARC_TESTNET.reviewedAt),
  writes: z.literal(false),
  enabledConnectors: z.union([z.tuple([]), z.tuple([z.literal("arc_primary_rpc")])]),
  features: z.strictObject({
    arcObservation: z.boolean(),
    agentRegistry: z.literal(false),
    agentJobs: z.literal(false),
    gatewayEvidence: z.literal(false),
  }),
  limits: ApiLimitsSchema,
}).superRefine((value, context) => {
  const expected = value.features.arcObservation ? ["arc_primary_rpc"] : [];
  if (JSON.stringify(value.enabledConnectors) !== JSON.stringify(expected)) {
    context.addIssue({ code: "custom", message: "Connector truth must match enabled source features" });
  }
});

export const M05CapabilitiesSchema = z.strictObject({
  capabilityVersion: z.literal("openarc.capabilities.m05.v1"),
  environment: z.literal("testnet"),
  network: z.literal(ARC_TESTNET.caip2),
  sourceRevision: z.literal(ARC_ERC8004.sourceRevision),
  reviewedAt: z.literal(ARC_ERC8004.reviewedAt),
  writes: z.literal(false),
  enabledConnectors: z.tuple([z.literal("arc_primary_rpc"), z.literal("erc8004_registries")]),
  features: z.strictObject({
    arcObservation: z.literal(true),
    agentRegistry: z.literal(true),
    agentJobs: z.literal(false),
    gatewayEvidence: z.literal(false),
  }),
  limits: ApiLimitsSchema,
});

// M06 uses the reviewed job source while retaining the cumulative M05 connectors.
export const M06CapabilitiesSchema = M05CapabilitiesSchema.extend({
  capabilityVersion: z.literal("openarc.capabilities.m06.v1"),
  sourceRevision: z.literal("arc-erc8183-reference-2026-09-04"),
  enabledConnectors: z.tuple([z.literal("arc_primary_rpc"), z.literal("erc8004_registries"), z.literal("erc8183_reference")]),
  features: z.strictObject({ arcObservation: z.literal(true), agentRegistry: z.literal(true),
    agentJobs: z.literal(true), gatewayEvidence: z.literal(false) }),
});

export const M07CapabilitiesSchema = M06CapabilitiesSchema.extend({
  capabilityVersion: z.literal("openarc.capabilities.m07.v1"),
  sourceRevision: z.literal("circle-gateway-x402-2026-09-05"),
  reviewedAt: z.literal("2026-09-05"),
  enabledConnectors: z.tuple([z.literal("arc_primary_rpc"), z.literal("erc8004_registries"),
    z.literal("erc8183_reference"), z.literal("circle_gateway_testnet")]),
  features: z.strictObject({ arcObservation: z.literal(true), agentRegistry: z.literal(true),
    agentJobs: z.literal(true), gatewayEvidence: z.literal(true) }),
});

export const CapabilitiesSchema = z.union([M04CapabilitiesSchema, M05CapabilitiesSchema, M06CapabilitiesSchema, M07CapabilitiesSchema]);

export const CapabilitiesEnvelopeSchema = z.strictObject({
  ok: z.literal(true),
  data: CapabilitiesSchema,
  meta: ApiMetaSchema,
});

/** Origins are historical receipt data, never a source of future fetch URLs. */
export const WorkspaceOriginSchema = z.string().min(1).max(255).refine((value) => {
  const allowed = /^https:\/\/[^/@?#]+$/u.test(value) ||
    /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/u.test(value);
  if (!allowed) return false;
  const normalized = z.url({ normalize: true }).safeParse(value);
  return normalized.success && normalized.data === `${value}/`;
}, { message: "Expected an exact HTTPS origin or a local development origin" });

export type ApiMeta = z.infer<typeof ApiMetaSchema>;
export type ApiLimits = z.infer<typeof ApiLimitsSchema>;
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export type CapabilitiesEnvelope = z.infer<typeof CapabilitiesEnvelopeSchema>;
export type ApiErrorEnvelope = z.infer<typeof ApiErrorEnvelopeSchema>;

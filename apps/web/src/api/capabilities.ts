import {
  CAPABILITIES_PATH,
  CapabilitiesEnvelopeSchema,
  type ApiErrorCode,
  type CapabilitiesEnvelope,
} from "@openarc/shared";

import { OpenArcRequestError, requestOpenArc, type OpenArcFetch } from "./client.js";

export type CapabilityFailureCode = ApiErrorCode | "REQUEST_UNAVAILABLE" | "INVALID_RESPONSE" | "RESPONSE_TOO_LARGE";

export class CapabilityRequestError extends Error {
  constructor(readonly code: CapabilityFailureCode, readonly phase: "pre-send" | "post-send") {
    super(code);
    this.name = "CapabilityRequestError";
  }
}

export type CapabilityFetch = OpenArcFetch;

export async function requestCapabilities(signal: AbortSignal, fetcher: CapabilityFetch = fetch): Promise<CapabilitiesEnvelope> {
  try {
    return await requestOpenArc({ path: CAPABILITIES_PATH, method: "GET",
      responseSchema: CapabilitiesEnvelopeSchema, signal, fetcher });
  } catch (cause) {
    if (cause instanceof OpenArcRequestError) throw new CapabilityRequestError(cause.code, cause.phase);
    throw new CapabilityRequestError("REQUEST_UNAVAILABLE", "post-send");
  }
}

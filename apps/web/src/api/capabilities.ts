import {
  API_CLIENT_HEADER, API_MAX_RESPONSE_BYTES, API_SCHEMA_VERSION, CAPABILITIES_PATH,
  ApiErrorEnvelopeSchema, CapabilitiesEnvelopeSchema, type ApiErrorCode,
  type CapabilitiesEnvelope,
} from "@openarc/shared";

export type CapabilityFailureCode = ApiErrorCode | "REQUEST_UNAVAILABLE" | "INVALID_RESPONSE" | "RESPONSE_TOO_LARGE";

export class CapabilityRequestError extends Error {
  constructor(readonly code: CapabilityFailureCode, readonly phase: "pre-send" | "post-send") {
    super(code);
    this.name = "CapabilityRequestError";
  }
}

export type CapabilityFetch = typeof fetch;
const CAPABILITY_TIMEOUT_MS = 10_000;

/** The only browser network client in M03: a fixed same-origin metadata GET. */
export async function requestCapabilities(signal: AbortSignal, fetcher: CapabilityFetch = fetch): Promise<CapabilitiesEnvelope> {
  if (signal.aborted) throw new CapabilityRequestError("REQUEST_UNAVAILABLE", "pre-send");
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), CAPABILITY_TIMEOUT_MS);
  const requestSignal = AbortSignal.any([signal, timeout.signal]);
  let response: Response;
  let pending: Promise<Response>;
  try {
    pending = fetcher(CAPABILITIES_PATH, { method: "GET", headers: { "X-OpenArc-Client": API_CLIENT_HEADER },
      credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: requestSignal });
  } catch { clearTimeout(timer); throw new CapabilityRequestError("REQUEST_UNAVAILABLE", "pre-send"); }
  void pending.then((late) => { if (requestSignal.aborted) void late.body?.cancel(); }, () => undefined);
  try {
    try { response = await raceSignal(pending, requestSignal); }
    catch { throw new CapabilityRequestError("REQUEST_UNAVAILABLE", "post-send"); }
    let body: Uint8Array;
    try { body = await readBounded(response, requestSignal); }
    catch (cause) {
      if (cause instanceof CapabilityRequestError) throw cause;
      throw new CapabilityRequestError("INVALID_RESPONSE", "post-send");
    }
    let decoded: unknown;
    try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
    catch { throw new CapabilityRequestError("INVALID_RESPONSE", "post-send"); }
    if (!response.ok) {
      const parsed = ApiErrorEnvelopeSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.meta.schemaVersion !== API_SCHEMA_VERSION) {
        throw new CapabilityRequestError("INVALID_RESPONSE", "post-send");
      }
      throw new CapabilityRequestError(parsed.data.error.code, "post-send");
    }
    const parsed = CapabilitiesEnvelopeSchema.safeParse(decoded);
    if (!parsed.success) throw new CapabilityRequestError("INVALID_RESPONSE", "post-send");
    return parsed.data;
  } finally {
    clearTimeout(timer);
    timeout.abort();
  }
}

async function readBounded(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const type = response.headers.get("content-type");
  if (!type || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(type)) {
    throw new CapabilityRequestError("INVALID_RESPONSE", "post-send");
  }
  const length = response.headers.get("content-length");
  if (length && (!/^(?:0|[1-9]\d{0,9})$/u.test(length) || Number(length) > API_MAX_RESPONSE_BYTES)) {
    throw new CapabilityRequestError("RESPONSE_TOO_LARGE", "post-send");
  }
  if (!response.body) throw new CapabilityRequestError("INVALID_RESPONSE", "post-send");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new CapabilityRequestError("REQUEST_UNAVAILABLE", "post-send");
      const next = await raceSignal(reader.read(), signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > API_MAX_RESPONSE_BYTES) throw new CapabilityRequestError("RESPONSE_TOO_LARGE", "post-send");
      chunks.push(next.value);
    }
  } finally { void reader.cancel().catch(() => undefined); }
  if (length && total !== Number(length)) throw new CapabilityRequestError("INVALID_RESPONSE", "post-send");
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
  return combined;
}

function raceSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new CapabilityRequestError("REQUEST_UNAVAILABLE", "post-send"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new CapabilityRequestError("REQUEST_UNAVAILABLE", "post-send"));
    signal.addEventListener("abort", abort, { once: true });
    void work.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (cause: unknown) => { signal.removeEventListener("abort", abort); reject(cause); });
  });
}

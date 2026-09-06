import {
  API_CLIENT_HEADER,
  API_MAX_RESPONSE_BYTES,
  API_SCHEMA_VERSION,
  ApiErrorEnvelopeSchema,
  type ApiErrorCode,
  type ARC_ACCOUNT_SNAPSHOT_PATH,
  type ARC_TRANSACTION_EVIDENCE_PATH,
  type AGENT_REGISTRY_EVIDENCE_PATH,
  type JOB_EVIDENCE_PATH,
  type GATEWAY_TRANSFER_PATH,
  type CAPABILITIES_PATH,
} from "@openarc/shared";

export type OpenArcFailureCode = ApiErrorCode | "REQUEST_UNAVAILABLE" | "INVALID_RESPONSE" | "RESPONSE_TOO_LARGE";
export type OpenArcFailurePhase = "pre-send" | "post-send";

export class OpenArcRequestError extends Error {
  constructor(readonly code: OpenArcFailureCode, readonly phase: OpenArcFailurePhase) {
    super(code);
    this.name = "OpenArcRequestError";
  }
}

export type OpenArcFetch = typeof fetch;
type AllowedPath = typeof CAPABILITIES_PATH | typeof ARC_ACCOUNT_SNAPSHOT_PATH |
  typeof ARC_TRANSACTION_EVIDENCE_PATH | typeof AGENT_REGISTRY_EVIDENCE_PATH | typeof JOB_EVIDENCE_PATH | typeof GATEWAY_TRANSFER_PATH;
type RuntimeSchema<T> = {
  parse(value: unknown): T;
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

export async function requestOpenArc<TReq, TRes>(input: {
  path: AllowedPath;
  method: "GET" | "POST";
  requestSchema?: RuntimeSchema<TReq>;
  responseSchema: RuntimeSchema<TRes>;
  body?: TReq;
  signal: AbortSignal;
  fetcher?: OpenArcFetch;
}): Promise<TRes> {
  if (input.signal.aborted) throw new OpenArcRequestError("REQUEST_UNAVAILABLE", "pre-send");
  if ((input.method === "GET") !== (input.body === undefined) ||
    (input.body !== undefined && (!input.requestSchema || !input.requestSchema.safeParse(input.body).success))) {
    throw new OpenArcRequestError("INVALID_REQUEST", "pre-send");
  }
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 10_000);
  const requestSignal = AbortSignal.any([input.signal, timeout.signal]);
  const headers: Record<string, string> = { "X-OpenArc-Client": API_CLIENT_HEADER };
  let body: string | undefined;
  if (input.body !== undefined) {
    headers["Content-Type"] = "application/json";
    try { body = JSON.stringify(input.requestSchema!.parse(input.body)); }
    catch { clearTimeout(timer); throw new OpenArcRequestError("INVALID_REQUEST", "pre-send"); }
  }
  let pending: Promise<Response>;
  try {
    pending = (input.fetcher ?? fetch)(input.path, { method: input.method, headers,
      ...(body === undefined ? {} : { body }), credentials: "omit", redirect: "error", cache: "no-store",
      referrerPolicy: "no-referrer", signal: requestSignal });
  } catch {
    clearTimeout(timer);
    throw new OpenArcRequestError("REQUEST_UNAVAILABLE", "pre-send");
  }
  void pending.then((late) => { if (requestSignal.aborted) void late.body?.cancel(); }, () => undefined);
  try {
    let response: Response;
    try { response = await raceSignal(pending, requestSignal); }
    catch { throw new OpenArcRequestError("REQUEST_UNAVAILABLE", "post-send"); }
    const decoded = await decodeResponse(response, requestSignal);
    if (!response.ok) {
      const parsed = ApiErrorEnvelopeSchema.safeParse(decoded);
      if (!parsed.success || parsed.data.meta.schemaVersion !== API_SCHEMA_VERSION) {
        throw new OpenArcRequestError("INVALID_RESPONSE", "post-send");
      }
      throw new OpenArcRequestError(parsed.data.error.code, "post-send");
    }
    const parsed = input.responseSchema.safeParse(decoded);
    if (!parsed.success) throw new OpenArcRequestError("INVALID_RESPONSE", "post-send");
    return parsed.data;
  } finally {
    clearTimeout(timer);
    timeout.abort();
  }
}

async function decodeResponse(response: Response, signal: AbortSignal): Promise<unknown> {
  const type = response.headers.get("content-type");
  if (!type || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(type)) {
    throw new OpenArcRequestError("INVALID_RESPONSE", "post-send");
  }
  const length = response.headers.get("content-length");
  if (length && (!/^(?:0|[1-9]\d{0,9})$/u.test(length) || Number(length) > API_MAX_RESPONSE_BYTES)) {
    throw new OpenArcRequestError("RESPONSE_TOO_LARGE", "post-send");
  }
  if (!response.body) throw new OpenArcRequestError("INVALID_RESPONSE", "post-send");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new OpenArcRequestError("REQUEST_UNAVAILABLE", "post-send");
      const next = await raceSignal(reader.read(), signal);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > API_MAX_RESPONSE_BYTES) throw new OpenArcRequestError("RESPONSE_TOO_LARGE", "post-send");
      chunks.push(next.value);
    }
  } finally { void reader.cancel().catch(() => undefined); }
  if (length && total !== Number(length)) throw new OpenArcRequestError("INVALID_RESPONSE", "post-send");
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined)); }
  catch { throw new OpenArcRequestError("INVALID_RESPONSE", "post-send"); }
}

function raceSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new OpenArcRequestError("REQUEST_UNAVAILABLE", "post-send"));
  return new Promise((resolve, reject) => {
    const abort = () => reject(new OpenArcRequestError("REQUEST_UNAVAILABLE", "post-send"));
    signal.addEventListener("abort", abort, { once: true });
    void work.then((value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (cause: unknown) => { signal.removeEventListener("abort", abort); reject(cause); });
  });
}

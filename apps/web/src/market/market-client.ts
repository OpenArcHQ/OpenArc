import {
  API_CLIENT_HEADER,
  API_MAX_RESPONSE_BYTES,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceApiErrorEnvelopeSchema,
  CommerceApiMetaSchema,
  CommerceMarketPublicDetailRequestSchema,
  CommerceMarketPublicDetailResponseSchema,
  CommerceMarketPublicListRequestSchema,
  CommerceMarketPublicPageResponseSchema,
  CommerceMarketPublicProviderDetailResponseSchema,
  CommerceMarketPublicProviderRequestSchema,
  MARKETPLACE_CAPABILITIES_PATH,
  MarketplaceCapabilitiesSuccessEnvelopeSchema,
  type CommerceListingKind,
  type CommerceMarketPublicDetail,
  type CommerceMarketPublicPage,
  type CommerceMarketPublicProviderDetail,
  type MarketplaceCapabilityManifest,
} from "@openarc/shared";

/**
 * Own public marketplace transport for the four accepted read-only GET routes.
 *
 * This module is deliberately independent of the legacy v1 client and of the
 * protected account/tenant/machine clients. It is a GET-only, cookie-free,
 * no-retry surface: every path is a fixed same-origin template plus at most one
 * validated canonical id encoded exactly once, and every query string is built
 * from validated allowlisted fields. There is no caller-supplied URL, origin,
 * header, credential, body, redirect, cookie or CORS. The marketplace
 * capability manifest is read first by the caller; this client only decodes it.
 */

export const MARKET_API_PATHS = Object.freeze({
  capabilities: MARKETPLACE_CAPABILITIES_PATH,
  listings: "/v2/public/market/listings",
  listing: "/v2/public/market/listings",
  provider: "/v2/public/market/providers",
} as const);

/** One bounded page; the API's own 1..50 cap stays authoritative. */
export const MARKET_PAGE_LIMIT = 50;

/** The total wall-clock budget for one request, including body streaming. */
export const MARKET_REQUEST_DEADLINE_MS = 10_000;

/**
 * Bounded, non-echoing local failure taxonomy. `not-found` is a truthful
 * `null`-item 200 (a missing/inactive listing or provider), never an
 * authorization failure. `feature-disabled` is the API's own bounded
 * FEATURE_DISABLED signal, not a local flag decision.
 */
export type MarketApiFailure =
  | { kind: "aborted" }
  | { kind: "unavailable" }
  | { kind: "not-found" }
  | { kind: "feature-disabled" }
  | { kind: "invalid-response" };

export class MarketApiError extends Error {
  readonly failure: MarketApiFailure;

  constructor(failure: MarketApiFailure) {
    super(failure.kind);
    this.name = "MarketApiError";
    this.failure = failure;
  }
}

export type MarketFetch = typeof fetch;

type RuntimeSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

export interface MarketClientOptions {
  readonly fetcher?: MarketFetch;
}

export interface MarketListRead {
  readonly afterListingId?: string | null;
  readonly limit?: number;
  readonly kind?: CommerceListingKind;
  readonly providerId?: string;
  readonly q?: string;
}

export class MarketClient {
  readonly #fetcher: MarketFetch;

  constructor(options: MarketClientOptions = {}) {
    this.#fetcher = options.fetcher ?? fetch;
  }

  /** GET /v2/public/marketplace-capabilities -> the frozen manifest. */
  async readCapabilities(signal: AbortSignal): Promise<MarketplaceCapabilityManifest> {
    const decoded = await this.#request({ path: MARKET_API_PATHS.capabilities, signal });
    return parseEnvelope(decoded, MarketplaceCapabilitiesSuccessEnvelopeSchema);
  }

  /** GET /v2/public/market/listings -> one bounded page. */
  async listListings(
    read: MarketListRead,
    signal: AbortSignal,
  ): Promise<CommerceMarketPublicPage> {
    const candidate: {
      afterListingId?: string;
      limit?: number;
      kind?: CommerceListingKind;
      providerId?: string;
      q?: string;
    } = {};
    if (read.afterListingId !== undefined && read.afterListingId !== null) {
      candidate.afterListingId = read.afterListingId;
    }
    if (read.limit !== undefined) candidate.limit = read.limit;
    if (read.kind !== undefined) candidate.kind = read.kind;
    if (read.providerId !== undefined) candidate.providerId = read.providerId;
    if (read.q !== undefined) candidate.q = read.q;
    const request = parseRequest(CommerceMarketPublicListRequestSchema, candidate);
    const query = buildListQuery(request);
    const path =
      query.length === 0 ? MARKET_API_PATHS.listings : `${MARKET_API_PATHS.listings}?${query}`;
    const decoded = await this.#request({ path, signal });
    return parseEnvelope(decoded, CommerceMarketPublicPageResponseSchema);
  }

  /**
   * GET /v2/public/market/listings/:listingId. A `200` with a `null` item is a
   * truthful `not-found` outcome, never an authorization failure.
   */
  async readListing(
    listingId: string,
    signal: AbortSignal,
  ): Promise<CommerceMarketPublicDetail> {
    const request = parseRequest(CommerceMarketPublicDetailRequestSchema, { listingId });
    const path = `${MARKET_API_PATHS.listing}/${encodeURIComponent(request.listingId)}`;
    const decoded = await this.#request({ path, signal });
    const detail = parseEnvelope(decoded, CommerceMarketPublicDetailResponseSchema);
    // The response must be bound to the exact requested listing id; a
    // same-shape response for another id is never published.
    if (detail.listingId !== request.listingId) {
      throw new MarketApiError({ kind: "invalid-response" });
    }
    if (detail.item !== null && detail.item.listingId !== request.listingId) {
      throw new MarketApiError({ kind: "invalid-response" });
    }
    return detail;
  }

  /**
   * GET /v2/public/market/providers/:providerId. A `200` with a `null` item is
   * a truthful `not-found` outcome, never an authorization failure.
   */
  async readProvider(
    providerId: string,
    signal: AbortSignal,
  ): Promise<CommerceMarketPublicProviderDetail> {
    const request = parseRequest(CommerceMarketPublicProviderRequestSchema, { providerId });
    const path = `${MARKET_API_PATHS.provider}/${encodeURIComponent(request.providerId)}`;
    const decoded = await this.#request({ path, signal });
    const detail = parseEnvelope(decoded, CommerceMarketPublicProviderDetailResponseSchema);
    // The response must be bound to the exact requested provider id.
    if (detail.providerId !== request.providerId) {
      throw new MarketApiError({ kind: "invalid-response" });
    }
    if (detail.item !== null && detail.item.providerId !== request.providerId) {
      throw new MarketApiError({ kind: "invalid-response" });
    }
    return detail;
  }

  async #request(wire: { path: string; signal: AbortSignal }): Promise<unknown> {
    if (wire.signal.aborted) throw new MarketApiError({ kind: "aborted" });

    // A single total deadline combining the caller's signal with a bounded
    // local timeout. `AbortSignal.any` keeps every abort reason: whichever
    // fires first cancels the reader and the underlying request.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), MARKET_REQUEST_DEADLINE_MS);
    const combined = combineSignals(wire.signal, timeout.signal);
    const fetcher = this.#fetcher;
    let response: Response;
    try {
      response = await fetcher(wire.path, {
        method: "GET",
        headers: {
          "X-OpenArc-Client": API_CLIENT_HEADER,
          Accept: "application/json",
        },
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: combined,
      });
    } catch {
      if (wire.signal.aborted) throw new MarketApiError({ kind: "aborted" });
      // A local deadline abort or a transport failure is never a not-found.
      throw new MarketApiError({ kind: "unavailable" });
    }

    let decoded: unknown;
    try {
      decoded = await decodeJson(response, combined);
    } catch (error) {
      // A caller/superseded abort stays an abort so the controller never
      // publishes it as a stale error. The local 10s deadline (or a transport
      // abort while the body is still streaming) is instead a bounded,
      // retryable GET failure — never a silent no-op that leaves loading on.
      if (wire.signal.aborted) throw new MarketApiError({ kind: "aborted" });
      // A non-2xx response is mapped by HTTP status even when its body is not a
      // strict JSON envelope.
      if (!response.ok) throw new MarketApiError(mapHttpFailure(response.status, null));
      if (error instanceof MarketApiError && error.failure.kind !== "aborted") throw error;
      throw new MarketApiError({ kind: "unavailable" });
    } finally {
      clearTimeout(timer);
    }

    if (wire.signal.aborted) throw new MarketApiError({ kind: "aborted" });

    if (!response.ok) {
      throw new MarketApiError(mapHttpFailure(response.status, decoded));
    }
    return decoded;
  }
}

/** Combines the caller signal and the local deadline into one abort signal. */
function combineSignals(caller: AbortSignal, deadline: AbortSignal): AbortSignal {
  const anySignal = (
    AbortSignal as unknown as {
      any?: (signals: AbortSignal[]) => AbortSignal;
    }
  ).any;
  if (typeof anySignal === "function") return anySignal([caller, deadline]);
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (caller.aborted || deadline.aborted) {
    controller.abort();
    return controller.signal;
  }
  caller.addEventListener("abort", onAbort, { once: true });
  deadline.addEventListener("abort", onAbort, { once: true });
  return controller.signal;
}

function parseRequest<T>(schema: RuntimeSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MarketApiError({ kind: "invalid-response" });
  return parsed.data;
}

/**
 * Builds the listing query from an already-validated request. The request
 * schema is authoritative for `limit` (1..50), `kind` (closed enum) and `q`
 * (trimmed 1..80); the path/id portions were validated before encoding.
 */
function buildListQuery(request: {
  afterListingId?: string | undefined;
  limit?: number | undefined;
  kind?: CommerceListingKind | undefined;
  providerId?: string | undefined;
  q?: string | undefined;
}): string {
  const params = new URLSearchParams();
  if (request.afterListingId !== undefined) params.set("afterListingId", request.afterListingId);
  if (request.limit !== undefined) params.set("limit", String(request.limit));
  if (request.kind !== undefined) params.set("kind", request.kind);
  if (request.providerId !== undefined) params.set("providerId", request.providerId);
  if (request.q !== undefined) params.set("q", request.q);
  return params.toString();
}

/**
 * Decodes a strict v2 success envelope. The top-level key set is exactly
 * `{data, meta, ok}`, the meta is the accepted v2 meta, and the payload is the
 * full caller-supplied DTO schema (never a loose partial).
 */
function parseEnvelope<T>(
  decoded: unknown,
  schema: {
    safeParse(value: unknown):
      | { success: true; data: { ok: true; data: T; meta: unknown } }
      | { success: false };
  },
): T {
  if (typeof decoded !== "object" || decoded === null) {
    throw new MarketApiError({ kind: "invalid-response" });
  }
  const record = decoded as { ok?: unknown; data?: unknown; meta?: unknown };
  if (record.ok !== true) throw new MarketApiError({ kind: "invalid-response" });
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "data" || keys[1] !== "meta" || keys[2] !== "ok") {
    throw new MarketApiError({ kind: "invalid-response" });
  }
  const meta = CommerceApiMetaSchema.safeParse(record.meta);
  if (!meta.success || meta.data.schemaVersion !== COMMERCE_API_SCHEMA_VERSION) {
    throw new MarketApiError({ kind: "invalid-response" });
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) throw new MarketApiError({ kind: "invalid-response" });
  return parsed.data.data;
}

function mapHttpFailure(status: number, decoded: unknown): MarketApiFailure {
  const envelope = CommerceApiErrorEnvelopeSchema.safeParse(decoded);
  if (envelope.success) {
    return envelope.data.error.code === "FEATURE_DISABLED"
      ? { kind: "feature-disabled" }
      : mapErrorCode(envelope.data.error.code);
  }
  if (status === 404) return { kind: "not-found" };
  if (status >= 500) return { kind: "unavailable" };
  // A structured but unrecognized 4xx is never a claimed empty success.
  return { kind: "invalid-response" };
}

function mapErrorCode(code: string): MarketApiFailure {
  if (code === "SOURCE_UNAVAILABLE" || code === "INTERNAL_ERROR" || code === "RATE_LIMITED") {
    return { kind: "unavailable" };
  }
  // The public catalog has no caller authorization surface; any other closed
  // code is a bounded rejection rather than a locally-inferred state.
  return { kind: "invalid-response" };
}

async function decodeJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const type = response.headers.get("content-type");
  if (!type || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(type)) {
    throw new MarketApiError({ kind: "invalid-response" });
  }
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^(?:0|[1-9]\d{0,9})$/u.test(length) || Number(length) > API_MAX_RESPONSE_BYTES)
  ) {
    throw new MarketApiError({ kind: "invalid-response" });
  }
  if (response.body === null) throw new MarketApiError({ kind: "invalid-response" });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await readOrAbort(reader, signal);
      if (next.done) break;
      if (signal.aborted) throw new MarketApiError({ kind: "aborted" });
      total += next.value.byteLength;
      if (total > API_MAX_RESPONSE_BYTES) {
        throw new MarketApiError({ kind: "invalid-response" });
      }
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof MarketApiError) throw error;
    if (signal.aborted) throw new MarketApiError({ kind: "aborted" });
    throw new MarketApiError({ kind: "invalid-response" });
  } finally {
    // Always cancel the reader so a late/short body cannot keep the stream open.
    void reader.cancel().catch(() => undefined);
  }
  if (signal.aborted) throw new MarketApiError({ kind: "aborted" });
  if (length !== null && total !== Number(length)) {
    throw new MarketApiError({ kind: "invalid-response" });
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined));
  } catch {
    throw new MarketApiError({ kind: "invalid-response" });
  }
}

/**
 * Reads one chunk with the combined signal raced against `reader.read()` so a
 * stalled body stream cannot hold the request open past the deadline. On abort
 * the reader is cancelled and a bounded `aborted` failure is raised.
 */
function readOrAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  if (signal.aborted) {
    return Promise.reject(new MarketApiError({ kind: "aborted" }));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
      reject(new MarketApiError({ kind: "aborted" }));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

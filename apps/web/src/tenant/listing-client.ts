import {
  API_CLIENT_HEADER,
  API_MAX_RESPONSE_BYTES,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceApiErrorEnvelopeSchema,
  CommerceApiMetaSchema,
  CommerceListingIdSchema,
  CommerceListingVersionSchema,
  CommerceMarketDraftCreateBodySchema,
  CommerceMarketLifecycleMutationReceiptSchema,
  CommerceMarketMutationReceiptSchema,
  CommerceMarketMutationResultResponseSchema,
  CommerceMarketMutationStatusResponseSchema,
  CommerceMarketOwnerPageResponseSchema,
  CommerceMarketOwnerRootDetailResponseSchema,
  CommerceMarketOwnerVersionDetailResponseSchema,
  CommerceMarketOwnerVersionPageResponseSchema,
  CommerceMarketProviderOptionsResponseSchema,
  CommerceMarketPublishBodySchema,
  CommerceMarketVersionCreateBodySchema,
  CommerceOrganizationIdSchema,
  CommerceProviderIdSchema,
  CommerceTenantIdempotencyKeySchema,
  CommerceTenantMutationIdSchema,
  MARKETPLACE_CAPABILITIES_PATH,
  MARKETPLACE_ROUTES,
  MarketplaceCapabilitiesSuccessEnvelopeSchema,
  type CommerceApiErrorCode,
  type CommerceListingId,
  type CommerceMarketMutationResult,
  type CommerceMarketMutationStatus,
  type CommerceMarketOwnerPage,
  type CommerceMarketOwnerRootDetail,
  type CommerceMarketOwnerVersionDetail,
  type CommerceMarketOwnerVersionPage,
  type CommerceMarketProviderOptionsPage,
  type MarketplaceCapabilityState,
} from "@openarc/shared";

/**
 * Own listing-management transport for the twelve frozen `listing_management`
 * marketplace routes. It is deliberately independent of the account, tenant
 * read/write and machine-credential transports.
 *
 * Every path is built here from the frozen registry template plus ONE validated
 * canonical id per segment, encoded exactly once. There is no caller-supplied
 * URL, no bearer credential and no redirect following. Reads send only the
 * same-origin browser marker (`X-OpenArc-Client`); writes additionally send the
 * transient CSRF token and an idempotency key as HTTP headers only. The
 * capability probe is a SEPARATE narrow transport that omits credentials.
 *
 * Every request is bounded to 10 seconds total and 64 KiB of streamed JSON,
 * with no automatic retry. Error mapping is fixed and never echoes server text,
 * raw ids or raw payloads.
 */

export const LISTING_ROUTE_IDS = Object.freeze([
  "listing_roots",
  "listing_create",
  "listing_root",
  "listing_versions",
  "listing_version_create",
  "listing_version",
  "listing_draft_mutation_status",
  "listing_provider_options",
  "listing_publish",
  "listing_pause",
  "listing_retire",
  "listing_lifecycle_mutation_status",
] as const);

export type ListingRouteId = (typeof LISTING_ROUTE_IDS)[number];

/** The exact logical operation a write performs (internal discriminator). */
export type ListingMutationOperation =
  | "market.listing.create"
  | "market.listing.version.create"
  | "market.listing.version.publish"
  | "market.listing.version.pause"
  | "market.listing.version.retire";

export type ListingApiFailure =
  | { kind: "aborted" }
  | { kind: "pre-send" }
  | { kind: "outcome-unknown" }
  | { kind: "validation" }
  | { kind: "policy" }
  | { kind: "conflict" }
  | { kind: "not-found" }
  | { kind: "unauthenticated" }
  | { kind: "csrf" }
  | { kind: "forbidden" }
  | { kind: "feature-disabled" }
  | { kind: "unavailable" }
  | { kind: "invalid-response" };

export class ListingApiError extends Error {
  readonly failure: ListingApiFailure;

  constructor(failure: ListingApiFailure) {
    super(failure.kind);
    this.name = "ListingApiError";
    this.failure = failure;
  }
}

export type ListingFetch = typeof fetch;

type RuntimeSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

export const LISTING_PAGE_LIMIT = 50;
export const LISTING_MAX_BODY_BYTES = 16 * 1024;
export const LISTING_REQUEST_TIMEOUT_MS = 10_000;

const ROUTE_BY_ID = Object.freeze(
  Object.fromEntries(MARKETPLACE_ROUTES.map((route) => [route.id, route])),
) as Readonly<Record<string, (typeof MARKETPLACE_ROUTES)[number]>>;

function routeTemplate(id: ListingRouteId): string {
  const route = ROUTE_BY_ID[id];
  if (route === undefined || route.family !== "listing_management" || route.audience !== "browser") {
    throw new ListingApiError({ kind: "pre-send" });
  }
  return route.path;
}

function fillPath(id: ListingRouteId, params: Readonly<Record<string, string>>): string {
  let path = routeTemplate(id);
  for (const [key, value] of Object.entries(params)) {
    path = path.replace(`:${key}`, encodeURIComponent(value));
  }
  if (path.includes(":")) throw new ListingApiError({ kind: "pre-send" });
  return path;
}

function scopedOrganization(id: string): string {
  const parsed = CommerceOrganizationIdSchema.safeParse(id);
  if (!parsed.success) throw new ListingApiError({ kind: "pre-send" });
  return parsed.data;
}

function scopedListing(id: string): CommerceListingId {
  const parsed = CommerceListingIdSchema.safeParse(id);
  if (!parsed.success) throw new ListingApiError({ kind: "pre-send" });
  return parsed.data;
}

function scopedProvider(id: string): string {
  const parsed = CommerceProviderIdSchema.safeParse(id);
  if (!parsed.success) throw new ListingApiError({ kind: "pre-send" });
  return parsed.data;
}

function boundedLimit(limit: number | undefined): number {
  const value = limit ?? 25;
  if (!Number.isInteger(value) || value < 1 || value > LISTING_PAGE_LIMIT) {
    throw new ListingApiError({ kind: "pre-send" });
  }
  return value;
}

/** Validates a version leaf BEFORE any path interpolation or fetch. */
function scopedVersion(version: string): string {
  const parsed = CommerceListingVersionSchema.safeParse(version);
  if (!parsed.success) throw new ListingApiError({ kind: "pre-send" });
  return parsed.data;
}

/** Validates a mutation id leaf BEFORE any path interpolation or fetch. */
function scopedMutationId(mutationId: string): string {
  const parsed = CommerceTenantMutationIdSchema.safeParse(mutationId);
  if (!parsed.success) throw new ListingApiError({ kind: "pre-send" });
  return parsed.data;
}

/**
 * Canonical ordering for accepted listing/provider ids: bytewise ascending,
 * matching the shared page schemas' `compareCanonicalId`.
 */
function compareCanonicalId(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Numeric ordering for accepted canonical versions 1..999999999. */
function compareCanonicalVersion(left: string, right: string): number {
  const a = BigInt(left);
  const b = BigInt(right);
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * A bounded page must not exceed the exact requested limit, and when a
 * continuation cursor was requested its first row must strictly follow that
 * cursor. This is a client-local binding on TOP of the shared page schema (the
 * schema bounds at 50 but cannot know the requested limit or cursor).
 */
function assertPageBounds<Row>(
  items: readonly Row[],
  limit: number,
  cursor: string | null,
  keyOf: (row: Row) => string,
  compare: (left: string, right: string) => number,
): void {
  if (items.length > limit) throw new ListingApiError({ kind: "invalid-response" });
  if (cursor === null) return;
  const first = items[0];
  if (first === undefined) return;
  if (compare(keyOf(first), cursor) <= 0) throw new ListingApiError({ kind: "invalid-response" });
}

interface WriteCommon {
  readonly csrfToken: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export interface ListingCreateDraftRequest extends WriteCommon {
  readonly organizationId: string;
  readonly body: unknown;
}

export interface ListingCreateVersionRequest extends WriteCommon {
  readonly organizationId: string;
  readonly listingId: string;
  readonly body: unknown;
}

export interface ListingLifecycleRequest extends WriteCommon {
  readonly organizationId: string;
  readonly listingId: string;
  readonly version: string;
  readonly body: unknown;
}

export interface ListingClientOptions {
  readonly fetcher?: ListingFetch;
}

interface RequestInput {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal: AbortSignal;
  readonly write: boolean;
}

export class ListingClient {
  readonly #fetcher: ListingFetch;

  constructor(options: ListingClientOptions = {}) {
    this.#fetcher = options.fetcher ?? fetch;
  }

  async listRoots(
    read: { organizationId: string; afterListingId?: string | null; limit?: number },
    signal: AbortSignal,
  ): Promise<CommerceMarketOwnerPage> {
    const params: Record<string, string> = { organizationId: scopedOrganization(read.organizationId) };
    const query = new URLSearchParams();
    const afterListingId =
      read.afterListingId === undefined || read.afterListingId === null
        ? null
        : scopedListing(read.afterListingId);
    if (afterListingId !== null) query.set("afterListingId", afterListingId);
    const limit = boundedLimit(read.limit);
    query.set("limit", String(limit));
    const decoded = await this.#request({ method: "GET", path: `${fillPath("listing_roots", params)}?${query.toString()}`, signal, write: false });
    const page = parseSuccessEnvelope(decoded, CommerceMarketOwnerPageResponseSchema);
    if (page.organizationId !== params.organizationId) throw new ListingApiError({ kind: "invalid-response" });
    assertPageBounds(page.items, limit, afterListingId, (item) => item.listingId, compareCanonicalId);
    return page;
  }

  async readRoot(
    read: { organizationId: string; listingId: string },
    signal: AbortSignal,
  ): Promise<CommerceMarketOwnerRootDetail> {
    const params = { organizationId: scopedOrganization(read.organizationId), listingId: scopedListing(read.listingId) };
    const decoded = await this.#request({ method: "GET", path: fillPath("listing_root", params), signal, write: false });
    const detail = parseSuccessEnvelope(decoded, CommerceMarketOwnerRootDetailResponseSchema);
    if (detail.organizationId !== params.organizationId || detail.listingId !== params.listingId) {
      throw new ListingApiError({ kind: "invalid-response" });
    }
    return detail;
  }

  async listVersions(
    read: { organizationId: string; listingId: string; afterVersion?: string | null; limit?: number },
    signal: AbortSignal,
  ): Promise<CommerceMarketOwnerVersionPage> {
    const params = { organizationId: scopedOrganization(read.organizationId), listingId: scopedListing(read.listingId) };
    const query = new URLSearchParams();
    const afterVersion =
      read.afterVersion === undefined || read.afterVersion === null
        ? null
        : scopedVersion(read.afterVersion);
    if (afterVersion !== null) query.set("afterVersion", afterVersion);
    const limit = boundedLimit(read.limit);
    query.set("limit", String(limit));
    const decoded = await this.#request({ method: "GET", path: `${fillPath("listing_versions", params)}?${query.toString()}`, signal, write: false });
    const page = parseSuccessEnvelope(decoded, CommerceMarketOwnerVersionPageResponseSchema);
    if (page.organizationId !== params.organizationId || page.listingId !== params.listingId) {
      throw new ListingApiError({ kind: "invalid-response" });
    }
    assertPageBounds(page.items, limit, afterVersion, (item) => item.version, compareCanonicalVersion);
    return page;
  }

  async readVersion(
    read: { organizationId: string; listingId: string; version: string },
    signal: AbortSignal,
  ): Promise<CommerceMarketOwnerVersionDetail> {
    const params = {
      organizationId: scopedOrganization(read.organizationId),
      listingId: scopedListing(read.listingId),
      version: scopedVersion(read.version),
    };
    const decoded = await this.#request({ method: "GET", path: fillPath("listing_version", params), signal, write: false });
    const detail = parseSuccessEnvelope(decoded, CommerceMarketOwnerVersionDetailResponseSchema);
    if (detail.organizationId !== params.organizationId || detail.listingId !== params.listingId || detail.version !== params.version) {
      throw new ListingApiError({ kind: "invalid-response" });
    }
    return detail;
  }

  async listProviderOptions(
    read: { organizationId: string; afterProviderId?: string | null; limit?: number },
    signal: AbortSignal,
  ): Promise<CommerceMarketProviderOptionsPage> {
    const params = { organizationId: scopedOrganization(read.organizationId) };
    const query = new URLSearchParams();
    const afterProviderId =
      read.afterProviderId === undefined || read.afterProviderId === null
        ? null
        : scopedProvider(read.afterProviderId);
    if (afterProviderId !== null) query.set("afterProviderId", afterProviderId);
    const limit = boundedLimit(read.limit);
    query.set("limit", String(limit));
    const decoded = await this.#request({ method: "GET", path: `${fillPath("listing_provider_options", params)}?${query.toString()}`, signal, write: false });
    const page = parseSuccessEnvelope(decoded, CommerceMarketProviderOptionsResponseSchema);
    if (page.organizationId !== params.organizationId) throw new ListingApiError({ kind: "invalid-response" });
    assertPageBounds(page.items, limit, afterProviderId, (item) => item.providerId, compareCanonicalId);
    return page;
  }

  async createDraft(input: ListingCreateDraftRequest): Promise<CommerceMarketMutationResult> {
    const organizationId = scopedOrganization(input.organizationId);
    const body = parseBody(CommerceMarketDraftCreateBodySchema, input.body);
    return this.#write(fillPath("listing_create", { organizationId }), body, input, {
      operation: "market.listing.create",
      mutationId: body.mutationId,
      resourceId: `openarc:listing:${body.mutationId}`,
    });
  }

  async createVersion(input: ListingCreateVersionRequest): Promise<CommerceMarketMutationResult> {
    const organizationId = scopedOrganization(input.organizationId);
    const listingId = scopedListing(input.listingId);
    const body = parseBody(CommerceMarketVersionCreateBodySchema, input.body);
    return this.#write(fillPath("listing_version_create", { organizationId, listingId }), body, input, {
      operation: "market.listing.version.create",
      mutationId: body.mutationId,
      resourceId: `${listingId}@${incrementVersion(body.expectedLatestVersion)}`,
    });
  }

  async publish(input: ListingLifecycleRequest): Promise<CommerceMarketMutationResult> {
    return this.#lifecycle("listing_publish", "market.listing.version.publish", input);
  }

  async pause(input: ListingLifecycleRequest): Promise<CommerceMarketMutationResult> {
    return this.#lifecycle("listing_pause", "market.listing.version.pause", input);
  }

  async retire(input: ListingLifecycleRequest): Promise<CommerceMarketMutationResult> {
    return this.#lifecycle("listing_retire", "market.listing.version.retire", input);
  }

  async #lifecycle(
    routeId: "listing_publish" | "listing_pause" | "listing_retire",
    operation: ListingMutationOperation,
    input: ListingLifecycleRequest,
  ): Promise<CommerceMarketMutationResult> {
    const organizationId = scopedOrganization(input.organizationId);
    const listingId = scopedListing(input.listingId);
    const version = scopedVersion(input.version);
    const body = parseBody(CommerceMarketLifecycleBodySchemas, input.body);
    return this.#write(
      fillPath(routeId, { organizationId, listingId, version }),
      body,
      input,
      { operation, mutationId: body.mutationId, resourceId: `${listingId}@${version}` },
    );
  }

  async readDraftMutationStatus(
    read: {
      organizationId: string;
      mutationId: string;
      operation: "market.listing.create" | "market.listing.version.create";
      resourceId: string;
      signal: AbortSignal;
    },
  ): Promise<CommerceMarketMutationStatus> {
    return this.#readStatus(
      "listing_draft_mutation_status",
      undefined,
      read,
      { operations: DRAFT_OPERATIONS, operation: read.operation, resourceId: read.resourceId },
    );
  }

  async readLifecycleMutationStatus(
    read: {
      organizationId: string;
      listingId: string;
      version: string;
      mutationId: string;
      operation: string;
      signal: AbortSignal;
    },
  ): Promise<CommerceMarketMutationStatus> {
    const listingId = scopedListing(read.listingId);
    const version = scopedVersion(read.version);
    if (!LIFECYCLE_OPERATIONS.has(read.operation)) throw new ListingApiError({ kind: "pre-send" });
    return this.#readStatus(
      "listing_lifecycle_mutation_status",
      { listingId, version },
      read,
      { operations: LIFECYCLE_OPERATIONS, operation: read.operation, resourceId: `${listingId}@${version}` },
    );
  }

  async #readStatus(
    routeId: "listing_draft_mutation_status" | "listing_lifecycle_mutation_status",
    extra: { listingId: string; version: string } | undefined,
    read: { organizationId: string; mutationId: string; signal: AbortSignal },
    expected: { operations: ReadonlySet<string>; operation: string; resourceId: string },
  ): Promise<CommerceMarketMutationStatus> {
    const organizationId = scopedOrganization(read.organizationId);
    const mutationId = scopedMutationId(read.mutationId);
    const params: Record<string, string> = { organizationId, mutationId };
    if (extra !== undefined) params.version = extra.version;
    const decoded = await this.#request({ method: "GET", path: fillPath(routeId, params), signal: read.signal, write: false });
    const status = parseSuccessEnvelope(decoded, CommerceMarketMutationStatusResponseSchema);
    if (status.status === "committed") {
      const receipt = status.receipt;
      // A committed status is accepted ONLY for the exact family, operation and
      // resource the original frozen action targeted: a same-mutation receipt
      // from another family/action/resource can never be committed.
      if (!expected.operations.has(receipt.operation)) {
        throw new ListingApiError({ kind: "invalid-response" });
      }
      if (receipt.operation !== expected.operation) {
        throw new ListingApiError({ kind: "invalid-response" });
      }
      if (receipt.mutationId !== mutationId) {
        throw new ListingApiError({ kind: "invalid-response" });
      }
      if (receipt.resourceId !== expected.resourceId) {
        throw new ListingApiError({ kind: "invalid-response" });
      }
    }
    return status;
  }

  async #write(
    path: string,
    body: { mutationId: string },
    common: WriteCommon,
    expected: { operation: ListingMutationOperation; mutationId: string; resourceId: string },
  ): Promise<CommerceMarketMutationResult> {
    if (common.csrfToken.length === 0) throw new ListingApiError({ kind: "pre-send" });
    if (!CommerceTenantIdempotencyKeySchema.safeParse(common.idempotencyKey).success) {
      throw new ListingApiError({ kind: "pre-send" });
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(body);
    } catch {
      throw new ListingApiError({ kind: "pre-send" });
    }
    if (new TextEncoder().encode(serialized).byteLength > LISTING_MAX_BODY_BYTES) {
      throw new ListingApiError({ kind: "pre-send" });
    }
    const headers: Record<string, string> = {
      "X-OpenArc-Client": API_CLIENT_HEADER,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-OpenArc-CSRF": common.csrfToken,
      "Idempotency-Key": common.idempotencyKey,
    };
    const decoded = await this.#request({ method: "POST", path, headers, body: serialized, signal: common.signal, write: true });
    const result = parseSuccessEnvelope(decoded, CommerceMarketMutationResultResponseSchema);
    assertMutationBinding(result, expected);
    return result;
  }

  async #request(input: RequestInput): Promise<unknown> {
    if (input.signal.aborted) throw new ListingApiError({ kind: "aborted" });
    const fetcher = this.#fetcher;
    // ONE total deadline covers response headers AND the streamed body. The
    // caller signal and the local deadline are combined, so whichever fires
    // first cancels the request, the reader and every pending read.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), LISTING_REQUEST_TIMEOUT_MS);
    const combined = combineSignals(input.signal, deadline.signal);
    try {
      let response: Response;
      try {
        response = await fetcher(input.path, {
          method: input.method,
          headers: input.headers ?? { "X-OpenArc-Client": API_CLIENT_HEADER, Accept: "application/json" },
          ...(input.body === undefined ? {} : { body: input.body }),
          credentials: "same-origin",
          cache: "no-store",
          redirect: "error",
          referrerPolicy: "no-referrer",
          signal: combined,
        });
      } catch {
        // Caller supersession/hidden stays silent; a write that may have
        // reached the server is outcome-unknown; a GET deadline is unavailable.
        if (input.signal.aborted) throw new ListingApiError({ kind: "aborted" });
        if (input.write) throw new ListingApiError({ kind: "outcome-unknown" });
        throw new ListingApiError({ kind: "unavailable" });
      }
      let decoded: unknown;
      try {
        decoded = await decodeJson(response, combined);
      } catch (error) {
        if (input.signal.aborted) throw new ListingApiError({ kind: "aborted" });
        // A non-OK response is classified by its status alone, without ever
        // reflecting a body.
        if (!response.ok) throw new ListingApiError(mapHttpFailure(response.status, undefined, input.write));
        // A body that hit the local deadline (or a read abort) is unavailable
        // for a GET and outcome-unknown for an already-sent write.
        if (error instanceof ListingApiError && error.failure.kind === "aborted") {
          throw new ListingApiError(input.write ? { kind: "outcome-unknown" } : { kind: "unavailable" });
        }
        throw new ListingApiError(input.write ? { kind: "outcome-unknown" } : { kind: "invalid-response" });
      }
      if (!response.ok) {
        throw new ListingApiError(mapHttpFailure(response.status, decoded, input.write));
      }
      return decoded;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * The publish/pause/retire bodies are three distinct accepted schemas with an
 * identical shape. Validating against the accepted publish schema keeps this
 * client from declaring a second (drifting) lifecycle body contract.
 */
const CommerceMarketLifecycleBodySchemas: RuntimeSchema<
  { mutationId: string; expectedUpdatedAt: string; expectedActiveVersion: string | null }
> = {
  safeParse(value: unknown) {
    const parsed = CommerceMarketPublishBodySchema.safeParse(value);
    if (!parsed.success) return { success: false as const };
    return { success: true as const, data: parsed.data };
  },
};

function parseBody<T>(schema: RuntimeSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ListingApiError({ kind: "pre-send" });
  return parsed.data;
}

/** Exact expected next version: accepted expectedLatestVersion + 1, BigInt only. */
function incrementVersion(expectedLatestVersion: string): string {
  const parsed = CommerceListingVersionSchema.safeParse(expectedLatestVersion);
  if (!parsed.success) throw new ListingApiError({ kind: "pre-send" });
  const next = (BigInt(parsed.data) + 1n).toString();
  if (!CommerceListingVersionSchema.safeParse(next).success) {
    throw new ListingApiError({ kind: "pre-send" });
  }
  return next;
}

function parseSuccessEnvelope<T>(
  decoded: unknown,
  schema: {
    safeParse(value: unknown):
      | { success: true; data: { ok: true; data: T; meta: unknown } }
      | { success: false };
  },
): T {
  if (typeof decoded !== "object" || decoded === null) throw new ListingApiError({ kind: "invalid-response" });
  const record = decoded as { ok?: unknown; meta?: unknown };
  if (record.ok !== true) throw new ListingApiError({ kind: "invalid-response" });
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "data" || keys[1] !== "meta" || keys[2] !== "ok") {
    throw new ListingApiError({ kind: "invalid-response" });
  }
  const meta = CommerceApiMetaSchema.safeParse(record.meta);
  if (!meta.success || meta.data.schemaVersion !== COMMERCE_API_SCHEMA_VERSION) {
    throw new ListingApiError({ kind: "invalid-response" });
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) throw new ListingApiError({ kind: "invalid-response" });
  return parsed.data.data;
}

/** The exact frozen correlation a receipt/status must bind, and nothing more. */
export interface MutationBindingExpectation {
  readonly operation: ListingMutationOperation;
  readonly mutationId: string;
  readonly resourceId: string;
}

function assertMutationBinding(
  result: CommerceMarketMutationResult,
  expected: MutationBindingExpectation,
): void {
  if (!CommerceMarketMutationReceiptSchema.safeParse(result.receipt).success) {
    throw new ListingApiError({ kind: "invalid-response" });
  }
  const receipt = result.receipt;
  if (receipt.mutationId !== expected.mutationId) throw new ListingApiError({ kind: "invalid-response" });
  if (receipt.operation !== expected.operation) throw new ListingApiError({ kind: "invalid-response" });
  if (receipt.resourceId !== expected.resourceId) throw new ListingApiError({ kind: "invalid-response" });
}

function mapHttpFailure(status: number, decoded: unknown, write: boolean): ListingApiFailure {
  const envelope = CommerceApiErrorEnvelopeSchema.safeParse(decoded);
  if (envelope.success) return mapErrorCode(envelope.data.error.code, write);
  switch (status) {
    case 400:
      return { kind: "validation" };
    case 401:
      return { kind: "unauthenticated" };
    case 403:
      return { kind: "forbidden" };
    case 404:
      return { kind: "not-found" };
    case 409:
      return { kind: "conflict" };
    case 503:
      return write ? { kind: "outcome-unknown" } : { kind: "unavailable" };
    default:
      if (status >= 500) return write ? { kind: "outcome-unknown" } : { kind: "unavailable" };
      return write ? { kind: "outcome-unknown" } : { kind: "invalid-response" };
  }
}

function mapErrorCode(code: CommerceApiErrorCode, write: boolean): ListingApiFailure {
  switch (code) {
    case "INVALID_REQUEST":
    case "UNSUPPORTED_MEDIA_TYPE":
    case "REQUEST_TOO_LARGE":
      return { kind: "validation" };
    case "POLICY_DENIED":
    case "APPROVAL_REQUIRED":
    case "LISTING_NOT_ACTIVE":
    case "LISTING_VERSION_MISMATCH":
      return { kind: "policy" };
    case "IDEMPOTENCY_CONFLICT":
    case "BUDGET_RESERVATION_CONFLICT":
    case "JOB_STATE_CONFLICT":
      return { kind: "conflict" };
    case "UNAUTHENTICATED":
      return { kind: "unauthenticated" };
    case "CSRF_REJECTED":
    case "INVALID_ORIGIN":
      return { kind: "csrf" };
    case "FORBIDDEN":
    case "TENANT_MISMATCH":
      return { kind: "forbidden" };
    case "FEATURE_DISABLED":
      return { kind: "feature-disabled" };
    case "SOURCE_UNAVAILABLE":
    case "INTERNAL_ERROR":
    case "RATE_LIMITED":
    default:
      return write ? { kind: "outcome-unknown" } : { kind: "unavailable" };
  }
}

async function decodeJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const type = response.headers.get("content-type");
  if (!type || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(type)) {
    throw new ListingApiError({ kind: "invalid-response" });
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^(?:0|[1-9]\d{0,9})$/u.test(length) || Number(length) > API_MAX_RESPONSE_BYTES)) {
    throw new ListingApiError({ kind: "invalid-response" });
  }
  if (response.body === null) throw new ListingApiError({ kind: "invalid-response" });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await readOrAbort(reader, signal);
      if (next.done) break;
      if (signal.aborted) throw new ListingApiError({ kind: "aborted" });
      total += next.value.byteLength;
      if (total > API_MAX_RESPONSE_BYTES) throw new ListingApiError({ kind: "invalid-response" });
      chunks.push(next.value);
    }
  } catch (error) {
    if (error instanceof ListingApiError) throw error;
    if (signal.aborted) throw new ListingApiError({ kind: "aborted" });
    throw new ListingApiError({ kind: "invalid-response" });
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  if (signal.aborted) throw new ListingApiError({ kind: "aborted" });
  if (length !== null && total !== Number(length)) throw new ListingApiError({ kind: "invalid-response" });
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(combined));
  } catch {
    throw new ListingApiError({ kind: "invalid-response" });
  }
}

/**
 * Combines the caller signal and the local deadline into one signal without
 * dropping either abort reason. `AbortSignal.any` is used when available; the
 * manual fallback keeps the same semantics.
 */
function combineSignals(caller: AbortSignal, deadline: AbortSignal): AbortSignal {
  const anySignal = (
    AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }
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

/**
 * Reads one chunk with the combined signal raced against `reader.read()` so a
 * stalled body cannot hold the request open past the deadline. On abort the
 * reader is cancelled and a bounded `aborted` failure is raised.
 */
function readOrAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
  if (signal.aborted) return Promise.reject(new ListingApiError({ kind: "aborted" }));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel().catch(() => undefined);
      reject(new ListingApiError({ kind: "aborted" }));
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

/**
 * Independent credentialless capability transport. It sends NO cookies, NO
 * client marker, NO CSRF token and NO bearer credential: the marketplace
 * capability manifest is public and is used only to decide whether the listing
 * surface is enabled, never as a grant of role authority.
 */
export async function readListingManagementCapability(
  signal: AbortSignal,
  fetcher: ListingFetch = fetch,
): Promise<MarketplaceCapabilityState> {
  if (signal.aborted) throw new ListingApiError({ kind: "aborted" });
  // ONE total deadline covers headers AND the streamed body, exactly like the
  // listing request transport.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), LISTING_REQUEST_TIMEOUT_MS);
  const combined = combineSignals(signal, deadline.signal);
  try {
    let response: Response;
    try {
      response = await fetcher(MARKETPLACE_CAPABILITIES_PATH, {
        method: "GET",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: combined,
      });
    } catch {
      if (signal.aborted) throw new ListingApiError({ kind: "aborted" });
      throw new ListingApiError({ kind: "unavailable" });
    }
    let decoded: unknown;
    try {
      decoded = await decodeJson(response, combined);
    } catch (error) {
      if (signal.aborted) throw new ListingApiError({ kind: "aborted" });
      if (!response.ok) throw new ListingApiError(mapHttpFailure(response.status, undefined, false));
      if (error instanceof ListingApiError && error.failure.kind === "invalid-response") throw error;
      // A stalled/deadline body is an unavailable capability probe, never a
      // silent no-op that leaves the capability gate checking forever.
      throw new ListingApiError({ kind: "unavailable" });
    }
    if (!response.ok) throw new ListingApiError(mapHttpFailure(response.status, decoded, false));
    const parsed = MarketplaceCapabilitiesSuccessEnvelopeSchema.safeParse(decoded);
    if (!parsed.success) throw new ListingApiError({ kind: "invalid-response" });
    const entry = parsed.data.data.capabilities.find((capability) => capability.family === "listing_management");
    if (entry === undefined) throw new ListingApiError({ kind: "invalid-response" });
    return entry.state;
  } finally {
    clearTimeout(timer);
  }
}

const LIFECYCLE_OPERATIONS: ReadonlySet<string> = new Set([
  "market.listing.origin_review.record",
  "market.listing.version.publish",
  "market.listing.version.pause",
  "market.listing.version.retire",
]);

/** The two closed draft-family operations accepted by the draft status route. */
const DRAFT_OPERATIONS: ReadonlySet<string> = new Set([
  "market.listing.create",
  "market.listing.version.create",
]);

/** True for the four closed lifecycle operation literals. */
export function isLifecycleOperation(operation: string): boolean {
  return LIFECYCLE_OPERATIONS.has(operation);
}

export { CommerceMarketPublishBodySchema, CommerceMarketLifecycleMutationReceiptSchema };

const IDEMPOTENCY_KEY_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function canonicalBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const b0 = bytes[index] as number;
    const b1 = index + 1 < bytes.length ? (bytes[index + 1] as number) : 0;
    const b2 = index + 2 < bytes.length ? (bytes[index + 2] as number) : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    out += IDEMPOTENCY_KEY_ALPHABET[(triplet >> 18) & 0x3f];
    out += IDEMPOTENCY_KEY_ALPHABET[(triplet >> 12) & 0x3f];
    if (index + 1 < bytes.length) out += IDEMPOTENCY_KEY_ALPHABET[(triplet >> 6) & 0x3f];
    if (index + 2 < bytes.length) out += IDEMPOTENCY_KEY_ALPHABET[triplet & 0x3f];
  }
  return out;
}

function randomBytes(length: number, cryptoSource?: Crypto): Uint8Array {
  const source =
    cryptoSource ??
    (typeof globalThis.crypto === "undefined" ? undefined : globalThis.crypto);
  if (source === undefined) throw new ListingApiError({ kind: "pre-send" });
  const bytes = new Uint8Array(length);
  source.getRandomValues(bytes);
  return bytes;
}

/** One canonical RFC 4122 v4 UUID mutation id per logical write. */
export function createListingMutationId(cryptoSource?: Crypto): string {
  const bytes = randomBytes(16, cryptoSource);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex: string[] = [];
  for (const byte of bytes) hex.push(byte.toString(16).padStart(2, "0"));
  const raw = hex.join("");
  const candidate = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  const parsed = CommerceTenantMutationIdSchema.safeParse(candidate);
  if (!parsed.success) throw new ListingApiError({ kind: "pre-send" });
  return parsed.data;
}

/** One canonical 43-character 32-byte base64url idempotency key per write. */
export function createListingIdempotencyKey(cryptoSource?: Crypto): string {
  const bytes = randomBytes(32, cryptoSource);
  bytes[31] = (bytes[31] as number) & 0b11;
  const candidate = canonicalBase64Url(bytes);
  const parsed = CommerceTenantIdempotencyKeySchema.safeParse(candidate);
  if (!parsed.success) throw new ListingApiError({ kind: "pre-send" });
  return parsed.data;
}

export interface ListingCorrelation {
  readonly mutationId: string;
  readonly idempotencyKey: string;
}

export function createListingCorrelation(cryptoSource?: Crypto): ListingCorrelation {
  return {
    mutationId: createListingMutationId(cryptoSource),
    idempotencyKey: createListingIdempotencyKey(cryptoSource),
  };
}

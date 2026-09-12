import {
  API_CLIENT_HEADER,
  API_MAX_RESPONSE_BYTES,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceAccountIdSchema,
  CommerceAgentCreateBodySchema,
  CommerceAgentIdSchema,
  CommerceAgentUpdateBodySchema,
  CommerceApiErrorEnvelopeSchema,
  CommerceApiMetaSchema,
  CommerceMembershipSetBodySchema,
  CommerceOrganizationCreateBodySchema,
  CommerceOrganizationIdSchema,
  CommerceProviderCreateBodySchema,
  CommerceProviderIdSchema,
  CommerceProviderUpdateBodySchema,
  CommerceTenantIdempotencyKeySchema,
  CommerceTenantMutationIdSchema,
  CommerceTenantMutationResponseSchema,
  CommerceTenantMutationResultSchema,
  CommerceTenantMutationStatusResponseSchema,
  CommerceTenantMutationStatusSchema,
  type CommerceApiErrorCode,
  type CommerceTenantMutationResult,
  type CommerceTenantMutationStatus,
  type CommerceTenantMutationReceipt,
} from "@openarc/shared";

/**
 * Own write/status transport for the eight accepted tenant mutation routes.
 *
 * This module is deliberately independent of the frozen read client. Every
 * request path is built here from a fixed template plus ONE validated
 * canonical id per segment, encoded exactly once. There is no query string,
 * no bearer credential, no redirect following, no automatic retry and no
 * caller-supplied URL. The idempotency key is an HTTP header only: it is
 * never placed in a body, a URL or a log, and the CSRF token is passed
 * transiently into a single request and never retained.
 */

export const TENANT_WRITE_API_PATHS = Object.freeze({
  organizations: "/v1/operator/organizations",
} as const);

/**
 * The exact logical operation a request performs. It is an internal
 * correlation discriminator, never a server-supplied route or authority.
 */
export type TenantMutationOperation =
  | "tenant.organization.create"
  | "tenant.agent.create"
  | "tenant.agent.update"
  | "tenant.provider.create"
  | "tenant.provider.update"
  | "tenant.membership.set";

/**
 * Bounded, non-echoing local failure taxonomy.
 *
 * `outcome-unknown` is distinct from a confirmed rejection: a transport error
 * after send, a timeout, an abort after send or a malformed write response may
 * still have committed, so it is never reported as a rollback. `validation`,
 * `policy` and `conflict` are only produced from a definite structured 4xx
 * response that proves the write was rejected.
 */
export type TenantWriteFailure =
  | { kind: "aborted" }
  | { kind: "pre-send" }
  | { kind: "outcome-unknown" }
  | { kind: "validation" }
  | { kind: "policy" }
  | { kind: "conflict" }
  | { kind: "unauthenticated" }
  | { kind: "csrf" }
  | { kind: "forbidden" }
  | { kind: "feature-disabled" }
  | { kind: "unavailable" }
  | { kind: "invalid-response" };

export class TenantWriteApiError extends Error {
  readonly failure: TenantWriteFailure;

  constructor(failure: TenantWriteFailure) {
    super(failure.kind);
    this.name = "TenantWriteApiError";
    this.failure = failure;
  }
}

export type TenantWriteFetch = typeof fetch;

type RuntimeSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

/** The local pre-serialization bound; the API's own cap stays authoritative. */
export const TENANT_WRITE_MAX_BODY_BYTES = 8 * 1024;

export interface TenantWriteClientOptions {
  readonly fetcher?: TenantWriteFetch;
}

export interface CreateOrganizationRequest {
  readonly operation: "tenant.organization.create";
  readonly body: unknown;
  readonly csrfToken: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export interface CreateAgentRequest {
  readonly operation: "tenant.agent.create";
  readonly organizationId: string;
  readonly body: unknown;
  readonly csrfToken: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export interface UpdateAgentRequest {
  readonly operation: "tenant.agent.update";
  readonly organizationId: string;
  readonly agentId: string;
  readonly body: unknown;
  readonly csrfToken: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export interface CreateProviderRequest {
  readonly operation: "tenant.provider.create";
  readonly organizationId: string;
  readonly body: unknown;
  readonly csrfToken: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export interface UpdateProviderRequest {
  readonly operation: "tenant.provider.update";
  readonly organizationId: string;
  readonly providerId: string;
  readonly body: unknown;
  readonly csrfToken: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export interface SetMembershipRequest {
  readonly operation: "tenant.membership.set";
  readonly organizationId: string;
  readonly accountId: string;
  readonly body: unknown;
  readonly csrfToken: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export type TenantMutationRequest =
  | CreateOrganizationRequest
  | CreateAgentRequest
  | UpdateAgentRequest
  | CreateProviderRequest
  | UpdateProviderRequest
  | SetMembershipRequest;

export interface TenantMutationStatusRead {
  readonly organizationId?: string;
  readonly mutationId: string;
  readonly signal: AbortSignal;
}

/** The exact expected resource binding for a status/response projection. */
export interface MutationExpectation {
  readonly operation: TenantMutationOperation;
  readonly mutationId: string;
  readonly organizationId: string | null;
  readonly resourceId: string | null;
}

export class TenantWriteClient {
  readonly #fetcher: TenantWriteFetch;

  constructor(options: TenantWriteClientOptions = {}) {
    this.#fetcher = options.fetcher ?? fetch;
  }

  async createOrganization(input: CreateOrganizationRequest): Promise<CommerceTenantMutationResult> {
    const body = parseBody(CommerceOrganizationCreateBodySchema, input.body);
    return this.#send(
      {
        method: "POST",
        path: TENANT_WRITE_API_PATHS.organizations,
        body,
        csrfToken: input.csrfToken,
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
      },
      expectation(input.operation, body.mutationId, null, null),
    );
  }

  async createAgent(input: CreateAgentRequest): Promise<CommerceTenantMutationResult> {
    const organizationId = parseId(CommerceOrganizationIdSchema, input.organizationId);
    const body = parseBody(CommerceAgentCreateBodySchema, input.body);
    return this.#send(
      {
        method: "POST",
        path: `${scopedPath(organizationId)}/agents`,
        body,
        csrfToken: input.csrfToken,
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
      },
      expectation(input.operation, body.mutationId, organizationId, null),
    );
  }

  async updateAgent(input: UpdateAgentRequest): Promise<CommerceTenantMutationResult> {
    const organizationId = parseId(CommerceOrganizationIdSchema, input.organizationId);
    const agentId = parseId(CommerceAgentIdSchema, input.agentId);
    const body = parseBody(CommerceAgentUpdateBodySchema, input.body);
    return this.#send(
      {
        method: "PATCH",
        path: `${scopedPath(organizationId)}/agents/${encodeURIComponent(agentId)}`,
        body,
        csrfToken: input.csrfToken,
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
      },
      expectation(input.operation, body.mutationId, organizationId, agentId),
    );
  }

  async createProvider(input: CreateProviderRequest): Promise<CommerceTenantMutationResult> {
    const organizationId = parseId(CommerceOrganizationIdSchema, input.organizationId);
    const body = parseBody(CommerceProviderCreateBodySchema, input.body);
    return this.#send(
      {
        method: "POST",
        path: `${scopedPath(organizationId)}/providers`,
        body,
        csrfToken: input.csrfToken,
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
      },
      expectation(input.operation, body.mutationId, organizationId, null),
    );
  }

  async updateProvider(input: UpdateProviderRequest): Promise<CommerceTenantMutationResult> {
    const organizationId = parseId(CommerceOrganizationIdSchema, input.organizationId);
    const providerId = parseId(CommerceProviderIdSchema, input.providerId);
    const body = parseBody(CommerceProviderUpdateBodySchema, input.body);
    return this.#send(
      {
        method: "PATCH",
        path: `${scopedPath(organizationId)}/providers/${encodeURIComponent(providerId)}`,
        body,
        csrfToken: input.csrfToken,
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
      },
      expectation(input.operation, body.mutationId, organizationId, providerId),
    );
  }

  async setMembership(input: SetMembershipRequest): Promise<CommerceTenantMutationResult> {
    const organizationId = parseId(CommerceOrganizationIdSchema, input.organizationId);
    const accountId = parseId(CommerceAccountIdSchema, input.accountId);
    const body = parseBody(CommerceMembershipSetBodySchema, input.body);
    return this.#send(
      {
        method: "PUT",
        path: `${scopedPath(organizationId)}/memberships/${encodeURIComponent(accountId)}`,
        body,
        csrfToken: input.csrfToken,
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
      },
      expectation(input.operation, body.mutationId, organizationId, accountId),
    );
  }

  async readMutationStatus(
    read: TenantMutationStatusRead,
  ): Promise<CommerceTenantMutationStatus> {
    const mutationId = parseId(CommerceTenantMutationIdSchema, read.mutationId);
    const organizationId =
      read.organizationId === undefined
        ? null
        : parseId(CommerceOrganizationIdSchema, read.organizationId);
    const path =
      organizationId === null
        ? `${TENANT_WRITE_API_PATHS.organizations}/bootstrap-mutations/${encodeURIComponent(mutationId)}`
        : `${scopedPath(organizationId)}/mutations/${encodeURIComponent(mutationId)}`;
    const decoded = await this.#request({
      method: "GET",
      path,
      signal: read.signal,
    });
    const data = parseSuccessEnvelope(decoded, CommerceTenantMutationStatusResponseSchema);
    assertStatusBinding(data, organizationId, mutationId);
    return data;
  }

  async #send(
    wire: {
      method: "POST" | "PATCH" | "PUT";
      path: string;
      body: unknown;
      csrfToken: string;
      idempotencyKey: string;
      signal: AbortSignal;
    },
    expected: MutationExpectation,
  ): Promise<CommerceTenantMutationResult> {
    if (wire.signal.aborted) throw new TenantWriteApiError({ kind: "aborted" });
    if (wire.csrfToken.length === 0) throw new TenantWriteApiError({ kind: "pre-send" });
    if (!CommerceTenantIdempotencyKeySchema.safeParse(wire.idempotencyKey).success) {
      throw new TenantWriteApiError({ kind: "pre-send" });
    }
    let body: string;
    try {
      body = JSON.stringify(wire.body);
    } catch {
      throw new TenantWriteApiError({ kind: "pre-send" });
    }
    if (new TextEncoder().encode(body).byteLength > TENANT_WRITE_MAX_BODY_BYTES) {
      throw new TenantWriteApiError({ kind: "pre-send" });
    }
    const headers: Record<string, string> = {
      "X-OpenArc-Client": API_CLIENT_HEADER,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-OpenArc-CSRF": wire.csrfToken,
      "Idempotency-Key": wire.idempotencyKey,
    };
    const decoded = await this.#request(
      { method: wire.method, path: wire.path, headers, body, signal: wire.signal },
      true,
    );
    const data = parseSuccessEnvelope(decoded, CommerceTenantMutationResponseSchema);
    assertResultBinding(data, expected);
    return data;
  }

  async #request(
    wire: {
      method: "GET" | "POST" | "PATCH" | "PUT";
      path: string;
      headers?: Record<string, string>;
      body?: string;
      signal: AbortSignal;
    },
    write = false,
  ): Promise<unknown> {
    if (wire.signal.aborted) throw new TenantWriteApiError({ kind: "aborted" });
    // The transport is invoked as a bare function: a native fetch called as a
    // method (this bound to this instance) throws an Illegal invocation.
    const fetcher = this.#fetcher;
    let response: Response;
    try {
      response = await fetcher(wire.path, {
        method: wire.method,
        headers: wire.headers ?? {
          "X-OpenArc-Client": API_CLIENT_HEADER,
          Accept: "application/json",
        },
        ...(wire.body === undefined ? {} : { body: wire.body }),
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: wire.signal,
      });
    } catch {
      if (wire.signal.aborted) throw new TenantWriteApiError({ kind: "aborted" });
      // A write that failed after send is an explicitly unknown outcome; a
      // GET that failed is simply an unavailable read.
      throw new TenantWriteApiError(write ? { kind: "outcome-unknown" } : { kind: "unavailable" });
    }

    let decoded: unknown;
    try {
      decoded = await decodeJson(response);
    } catch {
      throw new TenantWriteApiError(write ? { kind: "outcome-unknown" } : { kind: "invalid-response" });
    }

    if (!response.ok) {
      throw new TenantWriteApiError(mapHttpFailure(response.status, decoded, write));
    }
    return decoded;
  }
}

function expectation(
  operation: TenantMutationOperation,
  mutationId: string,
  organizationId: string | null,
  resourceId: string | null,
): MutationExpectation {
  return { operation, mutationId, organizationId, resourceId };
}

function scopedPath(organizationId: string): string {
  return `${TENANT_WRITE_API_PATHS.organizations}/${encodeURIComponent(organizationId)}`;
}

function parseId<T>(schema: RuntimeSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TenantWriteApiError({ kind: "pre-send" });
  return parsed.data;
}

function parseBody<T>(schema: RuntimeSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TenantWriteApiError({ kind: "pre-send" });
  return parsed.data;
}

function parseSuccessEnvelope<T>(decoded: unknown, schema: { safeParse(value: unknown): { success: true; data: { ok: true; data: T; meta: unknown } } | { success: false } }): T {
  if (typeof decoded !== "object" || decoded === null) {
    throw new TenantWriteApiError({ kind: "invalid-response" });
  }
  const record = decoded as { ok?: unknown; data?: unknown; meta?: unknown };
  if (record.ok !== true) throw new TenantWriteApiError({ kind: "invalid-response" });
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "data" || keys[1] !== "meta" || keys[2] !== "ok") {
    throw new TenantWriteApiError({ kind: "invalid-response" });
  }
  const meta = CommerceApiMetaSchema.safeParse(record.meta);
  if (!meta.success || meta.data.schemaVersion !== COMMERCE_API_SCHEMA_VERSION) {
    throw new TenantWriteApiError({ kind: "invalid-response" });
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) throw new TenantWriteApiError({ kind: "invalid-response" });
  return parsed.data.data;
}

function assertResultBinding(
  result: CommerceTenantMutationResult,
  expected: MutationExpectation,
): void {
  if (!CommerceTenantMutationResultSchema.safeParse(result).success) {
    throw new TenantWriteApiError({ kind: "invalid-response" });
  }
  const receipt = result.receipt;
  if (receipt.mutationId !== expected.mutationId) {
    throw new TenantWriteApiError({ kind: "invalid-response" });
  }
  if (receipt.operation !== expected.operation) {
    throw new TenantWriteApiError({ kind: "invalid-response" });
  }
  if (
    expected.organizationId !== null &&
    result.organizationId !== expected.organizationId
  ) {
    throw new TenantWriteApiError({ kind: "invalid-response" });
  }
  if (expected.resourceId !== null && receipt.resourceId !== expected.resourceId) {
    throw new TenantWriteApiError({ kind: "invalid-response" });
  }
}

/**
 * A committed status must belong to the exact mutation and organization the
 * caller asked about before any receipt is displayed.
 */
function assertStatusBinding(
  status: CommerceTenantMutationStatus,
  organizationId: string | null,
  mutationId: string,
): void {
  if (!CommerceTenantMutationStatusSchema.safeParse(status).success) {
    throw new TenantWriteApiError({ kind: "invalid-response" });
  }
  if (organizationId !== null && status.organizationId !== organizationId) {
    throw new TenantWriteApiError({ kind: "invalid-response" });
  }
  if (status.status === "committed" && status.receipt.mutationId !== mutationId) {
    throw new TenantWriteApiError({ kind: "invalid-response" });
  }
}

function mapHttpFailure(
  status: number,
  decoded: unknown,
  write: boolean,
): TenantWriteFailure {
  const envelope = CommerceApiErrorEnvelopeSchema.safeParse(decoded);
  if (envelope.success) {
    return mapErrorCode(envelope.data.error.code, write);
  }
  if (status === 401) return { kind: "unauthenticated" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "feature-disabled" };
  if (status >= 500) return write ? { kind: "outcome-unknown" } : { kind: "unavailable" };
  // A structured but unrecognized 4xx on a write cannot prove rejection.
  return write ? { kind: "outcome-unknown" } : { kind: "invalid-response" };
}

function mapErrorCode(code: CommerceApiErrorCode, write: boolean): TenantWriteFailure {
  switch (code) {
    case "INVALID_REQUEST":
    case "UNSUPPORTED_MEDIA_TYPE":
    case "REQUEST_TOO_LARGE":
      return { kind: "validation" };
    case "POLICY_DENIED":
    case "APPROVAL_REQUIRED":
    case "BUDGET_LIMIT_EXCEEDED":
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
      // A definite 5xx/unknown structured code from a sent write cannot prove
      // the write did not commit.
      return write ? { kind: "outcome-unknown" } : { kind: "unavailable" };
  }
}

async function decodeJson(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type");
  if (!type || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(type)) {
    throw new TenantWriteApiError({ kind: "invalid-response" });
  }
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^(?:0|[1-9]\d{0,9})$/u.test(length) || Number(length) > API_MAX_RESPONSE_BYTES)
  ) {
    throw new TenantWriteApiError({ kind: "invalid-response" });
  }
  if (response.body === null) throw new TenantWriteApiError({ kind: "invalid-response" });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > API_MAX_RESPONSE_BYTES) {
        throw new TenantWriteApiError({ kind: "invalid-response" });
      }
      chunks.push(next.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  if (length !== null && total !== Number(length)) {
    throw new TenantWriteApiError({ kind: "invalid-response" });
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
    throw new TenantWriteApiError({ kind: "invalid-response" });
  }
}

export type { CommerceTenantMutationReceipt };

/**
 * Generates one canonical mutation id and one canonical 32-byte base64url
 * idempotency key for a single logical submit. Both are validated with the
 * frozen shared schemas before they are returned, so a malformed value can
 * never be sent. The key is an HTTP header only; it is never placed in a body,
 * a URL, storage or a log.
 */
export interface TenantMutationCorrelation {
  readonly mutationId: string;
  readonly idempotencyKey: string;
}

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
  if (source === undefined) {
    throw new TenantWriteApiError({ kind: "pre-send" });
  }
  const bytes = new Uint8Array(length);
  source.getRandomValues(bytes);
  return bytes;
}

/**
 * Creates a canonical RFC 4122 version-4 UUID from cryptographic randomness:
 * the version nibble is forced to 4 and the variant nibble to 8, 9, a or b.
 */
export function createMutationId(cryptoSource?: Crypto): string {
  const bytes = randomBytes(16, cryptoSource);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex: string[] = [];
  for (const byte of bytes) hex.push(byte.toString(16).padStart(2, "0"));
  const raw = hex.join("");
  const candidate = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  const parsed = CommerceTenantMutationIdSchema.safeParse(candidate);
  if (!parsed.success) throw new TenantWriteApiError({ kind: "pre-send" });
  return parsed.data;
}

/**
 * Creates one canonical 43-character unpadded base64url idempotency key that
 * encodes exactly 32 cryptographic bytes. The result is validated with the
 * frozen shared schema so noncanonical trailing bits can never be produced
 * (the last byte is masked to clear the final two padding bits).
 */
export function createIdempotencyKey(cryptoSource?: Crypto): string {
  const bytes = randomBytes(32, cryptoSource);
  bytes[31] = (bytes[31] as number) & 0b11;
  const candidate = canonicalBase64Url(bytes);
  const parsed = CommerceTenantIdempotencyKeySchema.safeParse(candidate);
  if (!parsed.success) throw new TenantWriteApiError({ kind: "pre-send" });
  return parsed.data;

}

/** Generates one valid correlation pair for a single logical submit. */
export function createMutationCorrelation(
  cryptoSource?: Crypto,
): TenantMutationCorrelation {
  return {
    mutationId: createMutationId(cryptoSource),
    idempotencyKey: createIdempotencyKey(cryptoSource),
  };
}

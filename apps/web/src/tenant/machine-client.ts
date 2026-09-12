import {
  API_CLIENT_HEADER,
  API_MAX_RESPONSE_BYTES,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceAgentIdSchema,
  CommerceApiErrorEnvelopeSchema,
  CommerceApiMetaSchema,
  CommerceMachineCredentialIdSchema,
  CommerceMachineCredentialIssueBodySchema,
  CommerceMachineCredentialIssueResponseSchema,
  CommerceMachineCredentialMetadataSchema,
  CommerceMachineCredentialPageResponseSchema,
  CommerceMachineCredentialPageSchema,
  CommerceMachineCredentialRevokeBodySchema,
  CommerceMachineCredentialRevokeResponseSchema,
  CommerceMachineCredentialRevokeResultSchema,
  CommerceMachineCredentialStatusResponseSchema,
  CommerceMachineCredentialStatusSchema,
  CommerceOrganizationIdSchema,
  CommerceProviderIdSchema,
  CommerceTenantIdempotencyKeySchema,
  type CommerceApiErrorCode,
  type CommerceMachineCredentialIssueResult,
  type CommerceMachineCredentialMetadata,
  type CommerceMachineCredentialPage,
  type CommerceMachineCredentialRevokeResult,
  type CommerceMachineCredentialStatus,
  type CommerceMachineKind,
} from "@openarc/shared";

/**
 * Own human credential-management transport for the six accepted operator
 * credential routes.
 *
 * This module is deliberately independent of the frozen read/write clients.
 * Every request path is built here from a fixed template plus exactly ONE
 * validated canonical id per segment, encoded exactly once. There is no
 * caller-supplied URL, no bearer credential, no redirect following, no
 * automatic retry, no response cookie and no CORS. The Idempotency-Key and
 * CSRF token are HTTP headers only: they are never placed in a body, a URL,
 * browser storage or a log, and the CSRF token is passed transiently into a
 * single request and never retained.
 *
 * This client NEVER targets a machine session endpoint. `/v1/agent` and
 * `/v1/provider` exchange/self/revoke are machine-only Bearer endpoints and
 * must never receive a browser proxy or CORS; they are intentionally absent
 * from every path template here.
 */

export const MACHINE_API_PATHS = Object.freeze({
  organizations: "/v1/operator/organizations",
} as const);

/**
 * The exact logical operation a request performs. It is an internal
 * correlation discriminator, never a server-supplied route or authority.
 */
export type MachineCredentialOperation =
  | "tenant.agent.credential.issue"
  | "tenant.provider.credential.issue"
  | "tenant.agent.credential.revoke"
  | "tenant.provider.credential.revoke";

/**
 * Bounded, non-echoing local failure taxonomy.
 *
 * `outcome-unknown` is distinct from a confirmed rejection: a transport error
 * after send, a timeout, an abort after send or a malformed success response
 * may still have committed, so it is never reported as a rollback. `validation`,
 * `policy` and `conflict` are only produced from a definite structured 4xx that
 * proves the request was rejected.
 */
export type MachineApiFailure =
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

export class MachineApiError extends Error {
  readonly failure: MachineApiFailure;

  constructor(failure: MachineApiFailure) {
    super(failure.kind);
    this.name = "MachineApiError";
    this.failure = failure;
  }
}

export type MachineFetch = typeof fetch;

type RuntimeSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

/** The list query default/limit is 50; the API's own cap stays authoritative. */
export const MACHINE_PAGE_LIMIT = 50;

/** The local pre-serialization bound; the API's own cap stays authoritative. */
export const MACHINE_MAX_BODY_BYTES = 8 * 1024;

export interface MachineClientOptions {
  readonly fetcher?: MachineFetch;
}

interface ScopedWrite {
  readonly organizationId: string;
  readonly csrfToken: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

export interface IssueAgentCredentialRequest extends ScopedWrite {
  readonly agentId: string;
  readonly body: unknown;
}

export interface IssueProviderCredentialRequest extends ScopedWrite {
  readonly providerId: string;
  readonly body: unknown;
}

export interface RevokeAgentCredentialRequest extends ScopedWrite {
  readonly credentialId: string;
  readonly body: unknown;
}

export interface RevokeProviderCredentialRequest extends ScopedWrite {
  readonly credentialId: string;
  readonly body: unknown;
}

export interface MachineCredentialListRead {
  readonly organizationId: string;
  /** The exact explicitly selected profile whose credentials are listed. */
  readonly agentId?: string;
  readonly providerId?: string;
  readonly afterCredentialId?: string | null;
  readonly limit?: number;
}

export interface MachineCredentialStatusRead {
  readonly organizationId: string;
  readonly kind: CommerceMachineKind;
  readonly mutationId: string;
  readonly signal: AbortSignal;
}

/** The exact expected binding for a status/issue/revoke projection. */
export interface MachineExpectation {
  readonly operation: MachineCredentialOperation;
  readonly organizationId: string;
  readonly kind: CommerceMachineKind;
  readonly profileId: string;
  readonly mutationId: string;
  readonly credentialId: string;
}

export class MachineClient {
  readonly #fetcher: MachineFetch;

  constructor(options: MachineClientOptions = {}) {
    this.#fetcher = options.fetcher ?? fetch;
  }

  async listAgentCredentials(
    read: MachineCredentialListRead,
    signal: AbortSignal,
  ): Promise<CommerceMachineCredentialPage> {
    return this.#list("agent", read, signal);
  }

  async listProviderCredentials(
    read: MachineCredentialListRead,
    signal: AbortSignal,
  ): Promise<CommerceMachineCredentialPage> {
    return this.#list("provider", read, signal);
  }

  async issueAgentCredential(
    input: IssueAgentCredentialRequest,
  ): Promise<CommerceMachineCredentialIssueResult> {
    const organizationId = parseId(CommerceOrganizationIdSchema, input.organizationId);
    const agentId = parseId(CommerceAgentIdSchema, input.agentId);
    const body = parseBody(CommerceMachineCredentialIssueBodySchema, input.body);
    return this.#send(
      {
        method: "POST",
        path: `${scopedPath(organizationId)}/agents/${encodeURIComponent(agentId)}/credentials`,
        body,
        csrfToken: input.csrfToken,
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
      },
      {
        operation: "tenant.agent.credential.issue",
        organizationId,
        kind: "agent",
        profileId: agentId,
        mutationId: body.mutationId,
        credentialId: body.mutationId,
      },
    );
  }

  async issueProviderCredential(
    input: IssueProviderCredentialRequest,
  ): Promise<CommerceMachineCredentialIssueResult> {
    const organizationId = parseId(CommerceOrganizationIdSchema, input.organizationId);
    const providerId = parseId(CommerceProviderIdSchema, input.providerId);
    const body = parseBody(CommerceMachineCredentialIssueBodySchema, input.body);
    return this.#send(
      {
        method: "POST",
        path: `${scopedPath(organizationId)}/providers/${encodeURIComponent(providerId)}/credentials`,
        body,
        csrfToken: input.csrfToken,
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
      },
      {
        operation: "tenant.provider.credential.issue",
        organizationId,
        kind: "provider",
        profileId: providerId,
        mutationId: body.mutationId,
        credentialId: body.mutationId,
      },
    );
  }

  async revokeAgentCredential(
    input: RevokeAgentCredentialRequest,
  ): Promise<CommerceMachineCredentialRevokeResult> {
    return this.#revoke("agent", input);
  }

  async revokeProviderCredential(
    input: RevokeProviderCredentialRequest,
  ): Promise<CommerceMachineCredentialRevokeResult> {
    return this.#revoke("provider", input);
  }

  async readCredentialStatus(
    read: MachineCredentialStatusRead,
  ): Promise<CommerceMachineCredentialStatus> {
    const organizationId = parseId(CommerceOrganizationIdSchema, read.organizationId);
    const mutationId = parseId(CommerceMachineCredentialIdSchema, read.mutationId);
    const family =
      read.kind === "agent"
        ? "agent-credential-mutations"
        : "provider-credential-mutations";
    const path = `${scopedPath(organizationId)}/${family}/${encodeURIComponent(mutationId)}`;
    const decoded = await this.#request({ method: "GET", path, signal: read.signal });
    const status = parseSuccessEnvelope(decoded, CommerceMachineCredentialStatusResponseSchema);
    assertStatusBinding(status, organizationId, read.kind, mutationId);
    return status;
  }

  async #list(
    kind: CommerceMachineKind,
    read: MachineCredentialListRead,
    signal: AbortSignal,
  ): Promise<CommerceMachineCredentialPage> {
    if (signal.aborted) throw new MachineApiError({ kind: "aborted" });
    const organizationId = parseId(CommerceOrganizationIdSchema, read.organizationId);
    const after =
      read.afterCredentialId === undefined || read.afterCredentialId === null
        ? null
        : parseId(CommerceMachineCredentialIdSchema, read.afterCredentialId);
    const limit = read.limit ?? MACHINE_PAGE_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MACHINE_PAGE_LIMIT) {
      throw new MachineApiError({ kind: "pre-send" });
    }
    // The list reads ONLY the selected profile's credential collection. The
    // profile is a caller-supplied selection; it is not inferred. The route
    // family is the explicit profile credential route, not a broad operator
    // proxy or the bare profile collection.
    const folder = kind === "agent" ? "agents" : "providers";
    const profileId = parseId(
      kind === "agent" ? CommerceAgentIdSchema : CommerceProviderIdSchema,
      kind === "agent" ? (read as { agentId?: string }).agentId : (read as { providerId?: string }).providerId,
    );
    const params = new URLSearchParams();
    if (after !== null) params.set("afterCredentialId", after);
    params.set("limit", String(limit));
    const path = `${scopedPath(organizationId)}/${folder}/${encodeURIComponent(profileId)}/credentials?${params.toString()}`;
    const decoded = await this.#request({ method: "GET", path, signal });
    const page = parseSuccessEnvelope(decoded, CommerceMachineCredentialPageResponseSchema);
    assertPageBinding(page, organizationId, kind, profileId);
    return page;
  }

  async #revoke(
    kind: CommerceMachineKind,
    input: RevokeAgentCredentialRequest | RevokeProviderCredentialRequest,
  ): Promise<CommerceMachineCredentialRevokeResult> {
    const organizationId = parseId(CommerceOrganizationIdSchema, input.organizationId);
    const credentialId = parseId(CommerceMachineCredentialIdSchema, input.credentialId);
    const body = parseBody(CommerceMachineCredentialRevokeBodySchema, input.body);
    const family =
      kind === "agent" ? "agent-credentials" : "provider-credentials";
    return this.#sendRevoke(
      {
        method: "POST",
        path: `${scopedPath(organizationId)}/${family}/${encodeURIComponent(credentialId)}/revoke`,
        body,
        csrfToken: input.csrfToken,
        idempotencyKey: input.idempotencyKey,
        signal: input.signal,
      },
      {
        operation: kind === "agent" ? "tenant.agent.credential.revoke" : "tenant.provider.credential.revoke",
        organizationId,
        kind,
        profileId: "",
        mutationId: body.mutationId,
        credentialId,
      },
    );
  }

  async #send(
    wire: SendWire,
    expected: MachineExpectation,
  ): Promise<CommerceMachineCredentialIssueResult> {
    const decoded = await this.#write(wire);
    const data = parseSuccessEnvelope(decoded, CommerceMachineCredentialIssueResponseSchema);
    assertIssueBinding(data, expected);
    return data;
  }

  async #sendRevoke(
    wire: SendWire,
    expected: MachineExpectation,
  ): Promise<CommerceMachineCredentialRevokeResult> {
    const decoded = await this.#write(wire);
    const data = parseSuccessEnvelope(decoded, CommerceMachineCredentialRevokeResponseSchema);
    assertRevokeBinding(data, expected);
    return data;
  }

  async #write(wire: SendWire): Promise<unknown> {
    if (wire.signal.aborted) throw new MachineApiError({ kind: "aborted" });
    if (wire.csrfToken.length === 0) throw new MachineApiError({ kind: "pre-send" });
    if (!CommerceTenantIdempotencyKeySchema.safeParse(wire.idempotencyKey).success) {
      throw new MachineApiError({ kind: "pre-send" });
    }
    let body: string;
    try {
      body = JSON.stringify(wire.body);
    } catch {
      throw new MachineApiError({ kind: "pre-send" });
    }
    if (new TextEncoder().encode(body).byteLength > MACHINE_MAX_BODY_BYTES) {
      throw new MachineApiError({ kind: "pre-send" });
    }
    const headers: Record<string, string> = {
      "X-OpenArc-Client": API_CLIENT_HEADER,
      "Content-Type": "application/json",
      Accept: "application/json",
      "X-OpenArc-CSRF": wire.csrfToken,
      "Idempotency-Key": wire.idempotencyKey,
    };
    return this.#request({ method: wire.method, path: wire.path, headers, body, signal: wire.signal }, true);
  }

  async #request(
    wire: {
      method: "GET" | "POST";
      path: string;
      headers?: Record<string, string>;
      body?: string;
      signal: AbortSignal;
    },
    write = false,
  ): Promise<unknown> {
    if (wire.signal.aborted) throw new MachineApiError({ kind: "aborted" });
    const fetcher = this.#fetcher;
    let response: Response;
    try {
      response = await fetcher(wire.path, {
        method: wire.method,
        headers:
          wire.headers ?? {
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
      // A write whose fetch was already invoked may have reached the server.
      // An abort or transport failure observed AFTER invocation is therefore
      // never proof of rollback: report it as an unknown outcome so the caller
      // keeps the original mutation id and offers only an explicit status GET.
      if (write) throw new MachineApiError({ kind: "outcome-unknown" });
      if (wire.signal.aborted) throw new MachineApiError({ kind: "aborted" });
      throw new MachineApiError({ kind: "unavailable" });
    }

    let decoded: unknown;
    try {
      decoded = await decodeJson(response);
    } catch {
      throw new MachineApiError(write ? { kind: "outcome-unknown" } : { kind: "invalid-response" });
    }

    if (!response.ok) {
      throw new MachineApiError(mapHttpFailure(response.status, decoded, write));
    }
    return decoded;
  }
}

interface SendWire {
  readonly method: "POST";
  readonly path: string;
  readonly body: unknown;
  readonly csrfToken: string;
  readonly idempotencyKey: string;
  readonly signal: AbortSignal;
}

function scopedPath(organizationId: string): string {
  return `${MACHINE_API_PATHS.organizations}/${encodeURIComponent(organizationId)}`;
}

function parseId<T>(schema: RuntimeSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MachineApiError({ kind: "pre-send" });
  return parsed.data;
}

function parseBody<T>(schema: RuntimeSchema<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new MachineApiError({ kind: "pre-send" });
  return parsed.data;
}

function parseSuccessEnvelope<T>(
  decoded: unknown,
  schema: {
    safeParse(value: unknown):
      | { success: true; data: { ok: true; data: T; meta: unknown } }
      | { success: false };
  },
): T {
  if (typeof decoded !== "object" || decoded === null) {
    throw new MachineApiError({ kind: "invalid-response" });
  }
  const record = decoded as { ok?: unknown; data?: unknown; meta?: unknown };
  if (record.ok !== true) throw new MachineApiError({ kind: "invalid-response" });
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "data" || keys[1] !== "meta" || keys[2] !== "ok") {
    throw new MachineApiError({ kind: "invalid-response" });
  }
  const meta = CommerceApiMetaSchema.safeParse(record.meta);
  if (!meta.success || meta.data.schemaVersion !== COMMERCE_API_SCHEMA_VERSION) {
    throw new MachineApiError({ kind: "invalid-response" });
  }
  const parsed = schema.safeParse(decoded);
  if (!parsed.success) throw new MachineApiError({ kind: "invalid-response" });
  return parsed.data.data;
}

/**
 * A credential page must correlate to the exact organization, kind and
 * profile the caller requested, not merely satisfy the schema shape.
 */
function assertPageBinding(
  page: CommerceMachineCredentialPage,
  organizationId: string,
  kind: CommerceMachineKind,
  profileId: string,
): void {
  if (page.organizationId !== organizationId) throw new MachineApiError({ kind: "invalid-response" });
  if (page.kind !== kind) throw new MachineApiError({ kind: "invalid-response" });
  // The page must belong to the EXACT profile that was requested. A same-kind
  // response for a different profile is never accepted, not even when the item
  // list is empty: an empty page cannot prove which profile it belongs to.
  if (page.profileId !== profileId) throw new MachineApiError({ kind: "invalid-response" });
  if (!CommerceMachineCredentialPageSchema.safeParse(page).success) {
    throw new MachineApiError({ kind: "invalid-response" });
  }
}

function receiptKind(operation: string): CommerceMachineKind {
  return operation.includes(".provider.") ? "provider" : "agent";
}

function assertIssueBinding(
  result: CommerceMachineCredentialIssueResult,
  expected: MachineExpectation,
): void {
  const receipt = result.receipt;
  if (result.organizationId !== expected.organizationId) {
    throw new MachineApiError({ kind: "invalid-response" });
  }
  if (receipt.mutationId !== expected.mutationId) {
    throw new MachineApiError({ kind: "invalid-response" });
  }
  if (receipt.operation !== expected.operation) {
    throw new MachineApiError({ kind: "invalid-response" });
  }
  if (receiptKind(receipt.operation) !== expected.kind) {
    throw new MachineApiError({ kind: "invalid-response" });
  }
  // An issue receipt's credentialId equals its mutationId (shared invariant).
  if (receipt.credentialId !== expected.mutationId) {
    throw new MachineApiError({ kind: "invalid-response" });
  }
}

function assertRevokeBinding(
  result: CommerceMachineCredentialRevokeResult,
  expected: MachineExpectation,
): void {
  if (!CommerceMachineCredentialRevokeResultSchema.safeParse(result).success) {
    throw new MachineApiError({ kind: "invalid-response" });
  }
  const receipt = result.receipt;
  if (result.organizationId !== expected.organizationId) {
    throw new MachineApiError({ kind: "invalid-response" });
  }
  if (receipt.operation !== expected.operation) {
    throw new MachineApiError({ kind: "invalid-response" });
  }
  if (receiptKind(receipt.operation) !== expected.kind) {
    throw new MachineApiError({ kind: "invalid-response" });
  }
  // The revoke receipt targets the exact credential id requested.
  if (receipt.credentialId !== expected.credentialId) {
    throw new MachineApiError({ kind: "invalid-response" });
  }
}

/**
 * A committed status must belong to the exact mutation, organization and kind
 * the caller asked about before any receipt is displayed.
 */
function assertStatusBinding(
  status: CommerceMachineCredentialStatus,
  organizationId: string,
  kind: CommerceMachineKind,
  mutationId: string,
): void {
  if (!CommerceMachineCredentialStatusSchema.safeParse(status).success) {
    throw new MachineApiError({ kind: "invalid-response" });
  }
  if (status.organizationId !== organizationId) {
    throw new MachineApiError({ kind: "invalid-response" });
  }
  if (status.status === "committed") {
    if (status.receipt.mutationId !== mutationId) {
      throw new MachineApiError({ kind: "invalid-response" });
    }
    if (receiptKind(status.receipt.operation) !== kind) {
      throw new MachineApiError({ kind: "invalid-response" });
    }
  }
}

function mapHttpFailure(status: number, decoded: unknown, write: boolean): MachineApiFailure {
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

function mapErrorCode(code: CommerceApiErrorCode, write: boolean): MachineApiFailure {
  switch (code) {
    case "INVALID_REQUEST":
    case "UNSUPPORTED_MEDIA_TYPE":
    case "REQUEST_TOO_LARGE":
      return { kind: "validation" };
    case "POLICY_DENIED":
    case "APPROVAL_REQUIRED":
    case "GRANT_EXPIRED":
    case "GRANT_REVOKED":
      return { kind: "policy" };
    case "IDEMPOTENCY_CONFLICT":
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
      // the request did not commit.
      return write ? { kind: "outcome-unknown" } : { kind: "unavailable" };
  }
}

async function decodeJson(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type");
  if (!type || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(type)) {
    throw new MachineApiError({ kind: "invalid-response" });
  }
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^(?:0|[1-9]\d{0,9})$/u.test(length) || Number(length) > API_MAX_RESPONSE_BYTES)
  ) {
    throw new MachineApiError({ kind: "invalid-response" });
  }
  if (response.body === null) throw new MachineApiError({ kind: "invalid-response" });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > API_MAX_RESPONSE_BYTES) {
        throw new MachineApiError({ kind: "invalid-response" });
      }
      chunks.push(next.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  if (length !== null && total !== Number(length)) {
    throw new MachineApiError({ kind: "invalid-response" });
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
    throw new MachineApiError({ kind: "invalid-response" });
  }
}

/**
 * Generates one canonical mutation id and one canonical 43-character
 * idempotency key for a single logical submit. Both are validated with the
 * frozen shared schemas before they are returned. The key is an HTTP header
 * only; it is never placed in a body, a URL, storage or a log.
 */
export interface MachineCredentialCorrelation {
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
  if (source === undefined) throw new MachineApiError({ kind: "pre-send" });
  const bytes = new Uint8Array(length);
  source.getRandomValues(bytes);
  return bytes;
}

export function createMachineMutationId(cryptoSource?: Crypto): string {
  const bytes = randomBytes(16, cryptoSource);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex: string[] = [];
  for (const byte of bytes) hex.push(byte.toString(16).padStart(2, "0"));
  const raw = hex.join("");
  const candidate = `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
  const parsed = CommerceMachineCredentialIdSchema.safeParse(candidate);
  if (!parsed.success) throw new MachineApiError({ kind: "pre-send" });
  return parsed.data;
}

export function createMachineIdempotencyKey(cryptoSource?: Crypto): string {
  const bytes = randomBytes(32, cryptoSource);
  bytes[31] = (bytes[31] as number) & 0b11;
  const candidate = canonicalBase64Url(bytes);
  const parsed = CommerceTenantIdempotencyKeySchema.safeParse(candidate);
  if (!parsed.success) throw new MachineApiError({ kind: "pre-send" });
  return parsed.data;
}

export function createMachineCorrelation(cryptoSource?: Crypto): MachineCredentialCorrelation {
  return {
    mutationId: createMachineMutationId(cryptoSource),
    idempotencyKey: createMachineIdempotencyKey(cryptoSource),
  };
}

/**
 * Validates one credential metadata record against the exact requested kind and
 * profile. Used by the controller before any list item becomes visible state.
 */
export function matchesCredentialProfile(
  item: CommerceMachineCredentialMetadata,
  kind: CommerceMachineKind,
  profileId: string,
): boolean {
  if (!CommerceMachineCredentialMetadataSchema.safeParse(item).success) return false;
  return item.kind === kind && item.profileId === profileId;
}

export type { CommerceMachineCredentialMetadata, CommerceMachineCredentialPage };

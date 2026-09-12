import {
  API_CLIENT_HEADER,
  API_MAX_RESPONSE_BYTES,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceAgentPageResponseSchema,
  CommerceApiErrorEnvelopeSchema,
  CommerceApiMetaSchema,
  CommerceOrganizationContextResponseSchema,
  CommerceOrganizationIdSchema,
  CommerceOrganizationPageResponseSchema,
  CommerceProviderPageResponseSchema,
  type CommerceAccountId,
  type CommerceAgentPage,
  type CommerceOrganizationContext,
  type CommerceOrganizationPage,
  type CommerceOrganizationId,
  type CommerceProviderPage,
} from "@openarc/shared";
import type { CommerceApiErrorCode } from "@openarc/shared";

/**
 * Frozen organization-read transport for the four `GET /v1/operator/organizations...`
 * endpoints.
 *
 * This module is deliberately independent of the legacy v1 client and of the
 * account `/v2/auth/*` transport: it is a GET-only surface that sends no CSRF
 * token, no bearer credential, no proxy secret and no custom cookie. Every
 * request path is constructed here from a fixed template and a single
 * validated canonical organization id, and every query string is built from
 * known keys with canonical integer strings. There is no automatic retry.
 */

export const TENANT_API_PATHS = Object.freeze({
  organizations: "/v1/operator/organizations",
  organization: "/v1/operator/organizations",
} as const);

/**
 * Bounded, non-echoing local failure taxonomy. `unauthenticated` and
 * `forbidden` are the only authorization-shaped outcomes; a lost connection
 * or malformed body is `unavailable`, never a claimed empty success.
 */
export type TenantApiFailure =
  | { kind: "aborted" }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | { kind: "feature-disabled" }
  | { kind: "unavailable" }
  | { kind: "invalid-response" };

export class TenantApiError extends Error {
  readonly failure: TenantApiFailure;

  constructor(failure: TenantApiFailure) {
    super(failure.kind);
    this.name = "TenantApiError";
    this.failure = failure;
  }
}

export type TenantFetch = typeof fetch;

type RuntimeSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

/** The list-level read request. `afterOrganizationId` is the last id seen. */
export interface OrganizationListRead {
  readonly afterOrganizationId?: CommerceOrganizationId;
  readonly limit?: number;
}

/** The organization-scoped read request for context/agents/providers. */
export interface OrganizationScopedRead {
  readonly organizationId: CommerceOrganizationId;
  readonly afterAgentId?: CommerceAgentPage["nextCursor"];
  readonly afterProviderId?: CommerceProviderPage["nextCursor"];
  readonly limit?: number;
}

export interface TenantClientOptions {
  readonly fetcher?: TenantFetch;
}

/**
 * A read scope binds one explicit request to the account and organization the
 * caller believes is current. The client enforces organization equality for
 * page/context and account equality only where the DTO exposes an account id,
 * so a mismatched response can never be published as this request's success.
 */
export interface TenantReadScope {
  readonly expectedOrganizationId?: CommerceOrganizationId;
}

export class TenantClient {
  readonly #fetcher: TenantFetch;

  constructor(options: TenantClientOptions = {}) {
    this.#fetcher = options.fetcher ?? fetch;
  }

  async listOrganizations(
    read: OrganizationListRead,
    signal: AbortSignal,
  ): Promise<CommerceOrganizationPage> {
    return this.#read({
      path: TENANT_API_PATHS.organizations,
      query: buildListQuery(read, "afterOrganizationId"),
      responseSchema: commerceEnvelopeData(CommerceOrganizationPageResponseSchema),
      signal,
      pagination: pageGuard(read.limit, read.afterOrganizationId, "organizationId"),
    });
  }

  async readOrganizationContext(
    read: Pick<OrganizationScopedRead, "organizationId">,
    signal: AbortSignal,
  ): Promise<CommerceOrganizationContext> {
    return this.#read({
      path: scopedPath(read.organizationId),
      query: "",
      responseSchema: commerceEnvelopeData(CommerceOrganizationContextResponseSchema),
      signal,
      contextOrganization: read.organizationId,
    });
  }

  async listAgents(
    read: OrganizationScopedRead,
    signal: AbortSignal,
  ): Promise<CommerceAgentPage> {
    return this.#read({
      path: `${scopedPath(read.organizationId)}/agents`,
      query: buildListQuery(read, "afterAgentId"),
      responseSchema: commerceEnvelopeData(CommerceAgentPageResponseSchema),
      signal,
      expectedOrganizationId: read.organizationId,
      pagination: pageGuard(read.limit, read.afterAgentId, "agentId"),
    });
  }

  async listProviders(
    read: OrganizationScopedRead,
    signal: AbortSignal,
  ): Promise<CommerceProviderPage> {
    return this.#read({
      path: `${scopedPath(read.organizationId)}/providers`,
      query: buildListQuery(read, "afterProviderId"),
      responseSchema: commerceEnvelopeData(CommerceProviderPageResponseSchema),
      signal,
      expectedOrganizationId: read.organizationId,
      pagination: pageGuard(read.limit, read.afterProviderId, "providerId"),
    });
  }

  async #read<T>(input: {
    path: string;
    query: string;
    responseSchema: RuntimeSchema<T>;
    signal: AbortSignal;
    expectedOrganizationId?: CommerceOrganizationId;
    contextOrganization?: CommerceOrganizationId;
    pagination?: PageGuard;
  }): Promise<T> {
    if (input.signal.aborted) throw new TenantApiError({ kind: "aborted" });
    if (input.query.startsWith("?")) {
      throw new TenantApiError({ kind: "invalid-response" });
    }
    const url = input.query.length === 0 ? input.path : `${input.path}?${input.query}`;
    // Invoke the transport as a bare function: a native `fetch` called as a
    // method (with `this` bound to this instance) throws an Illegal invocation.
    const fetcher = this.#fetcher;
    let response: Response;
    try {
      response = await fetcher(url, {
        method: "GET",
        headers: { "X-OpenArc-Client": API_CLIENT_HEADER },
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal: input.signal,
      });
    } catch {
      throw new TenantApiError(
        input.signal.aborted ? { kind: "aborted" } : { kind: "unavailable" },
      );
    }

    let decoded: unknown;
    try {
      decoded = await decodeJson(response);
    } catch (error) {
      if (input.signal.aborted || (error instanceof TenantApiError && error.failure.kind === "aborted")) {
        throw new TenantApiError({ kind: "aborted" });
      }
      throw new TenantApiError({ kind: "invalid-response" });
    }

    if (!response.ok) {
      throw new TenantApiError(mapHttpFailure(response.status, decoded));
    }

    const data = parseSuccessEnvelope(decoded, input.responseSchema);
    assertScopedResponse(data, input);
    if (input.pagination !== undefined) assertPagination(data, input.pagination);
    return data;
  }
}

export interface PageGuard {
  readonly limit: number | undefined;
  readonly after: string | null | undefined;
  readonly idKey: string;
}

function pageGuard(
  limit: number | undefined,
  after: string | null | undefined,
  idKey: string,
): PageGuard {
  return { limit, after, idKey };
}

function scopedPath(organizationId: CommerceOrganizationId): string {
  const parsed = CommerceOrganizationIdSchema.safeParse(organizationId);
  if (!parsed.success) throw new TenantApiError({ kind: "invalid-response" });
  return `${TENANT_API_PATHS.organization}/${encodeURIComponent(parsed.data)}`;
}

function buildListQuery(
  read: {
    afterOrganizationId?: string;
    afterAgentId?: string | null;
    afterProviderId?: string | null;
    limit?: number;
  },
  afterKey: "afterOrganizationId" | "afterAgentId" | "afterProviderId",
): string {
  const params = new URLSearchParams();
  const after = read[afterKey];
  if (after !== undefined && after !== null) params.set(afterKey, after);
  if (read.limit !== undefined) {
    if (!Number.isInteger(read.limit) || read.limit < 1 || read.limit > 100) {
      throw new TenantApiError({ kind: "invalid-response" });
    }
    params.set("limit", String(read.limit));
  }
  return params.toString();
}

/** Adapts a zod success-envelope schema into a data-only runtime schema. */
function commerceEnvelopeData<T>(schema: RuntimeSchema<{ data: T }>): RuntimeSchema<T> {
  return {
    safeParse(value: unknown) {
      const parsed = schema.safeParse(value);
      if (!parsed.success) return { success: false };
      return { success: true, data: parsed.data.data };
    },
  };
}

function parseSuccessEnvelope<T>(decoded: unknown, responseSchema: RuntimeSchema<T>): T {
  if (typeof decoded !== "object" || decoded === null) {
    throw new TenantApiError({ kind: "invalid-response" });
  }
  const record = decoded as { ok?: unknown; data?: unknown; meta?: unknown };
  if (record.ok !== true) throw new TenantApiError({ kind: "invalid-response" });
  const keys = Object.keys(record).sort();
  if (keys.length !== 3 || keys[0] !== "data" || keys[1] !== "meta" || keys[2] !== "ok") {
    throw new TenantApiError({ kind: "invalid-response" });
  }
  const meta = CommerceApiMetaSchema.safeParse(record.meta);
  if (!meta.success || meta.data.schemaVersion !== COMMERCE_API_SCHEMA_VERSION) {
    throw new TenantApiError({ kind: "invalid-response" });
  }
  const parsed = responseSchema.safeParse(decoded);
  if (!parsed.success) throw new TenantApiError({ kind: "invalid-response" });
  return parsed.data;
}

function assertScopedResponse<T>(
  data: T,
  input: {
    expectedOrganizationId?: CommerceOrganizationId;
    contextOrganization?: CommerceOrganizationId;
  },
): void {
  const record = data as {
    organizationId?: unknown;
    organization?: { organizationId?: unknown };
  };
  if (
    input.expectedOrganizationId !== undefined &&
    record.organizationId !== input.expectedOrganizationId
  ) {
    throw new TenantApiError({ kind: "invalid-response" });
  }
  if (
    input.contextOrganization !== undefined &&
    record.organization?.organizationId !== input.contextOrganization
  ) {
    throw new TenantApiError({ kind: "invalid-response" });
  }
}

/**
 * A broken server must not be able to replay pagination forever: a page may
 * never exceed the requested limit, and every returned id must sort strictly
 * after the requested cursor (which itself was the previous page's last id).
 */
function assertPagination<T>(data: T, pagination: PageGuard): void {
  const items = (data as { items?: unknown }).items;
  if (!Array.isArray(items)) throw new TenantApiError({ kind: "invalid-response" });
  if (pagination.limit !== undefined && items.length > pagination.limit) {
    throw new TenantApiError({ kind: "invalid-response" });
  }
  if (pagination.after !== undefined && pagination.after !== null) {
    for (const item of items) {
      const id = (item as Record<string, unknown>)[pagination.idKey];
      if (typeof id !== "string" || !(id > pagination.after)) {
        throw new TenantApiError({ kind: "invalid-response" });
      }
    }
  }
}

function mapHttpFailure(status: number, decoded: unknown): TenantApiFailure {
  const envelope = CommerceApiErrorEnvelopeSchema.safeParse(decoded);
  if (envelope.success) {
    return mapErrorCode(envelope.data.error.code);
  }
  if (status === 401) return { kind: "unauthenticated" };
  if (status === 403) return { kind: "forbidden" };
  if (status === 404) return { kind: "feature-disabled" };
  if (status >= 500) return { kind: "unavailable" };
  return { kind: "invalid-response" };
}

function mapErrorCode(code: CommerceApiErrorCode): TenantApiFailure {
  if (code === "UNAUTHENTICATED") return { kind: "unauthenticated" };
  if (code === "FORBIDDEN" || code === "TENANT_MISMATCH") return { kind: "forbidden" };
  if (code === "FEATURE_DISABLED") return { kind: "feature-disabled" };
  if (code === "SOURCE_UNAVAILABLE" || code === "INTERNAL_ERROR" || code === "RATE_LIMITED") {
    return { kind: "unavailable" };
  }
  return { kind: "invalid-response" };
}

async function decodeJson(response: Response): Promise<unknown> {
  const type = response.headers.get("content-type");
  if (!type || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(type)) {
    throw new TenantApiError({ kind: "invalid-response" });
  }
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^(?:0|[1-9]\d{0,9})$/u.test(length) || Number(length) > API_MAX_RESPONSE_BYTES)
  ) {
    throw new TenantApiError({ kind: "invalid-response" });
  }
  if (response.body === null) throw new TenantApiError({ kind: "invalid-response" });
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > API_MAX_RESPONSE_BYTES) {
        throw new TenantApiError({ kind: "invalid-response" });
      }
      chunks.push(next.value);
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  if (length !== null && total !== Number(length)) {
    throw new TenantApiError({ kind: "invalid-response" });
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
    throw new TenantApiError({ kind: "invalid-response" });
  }
}

/** Exposed for the controller's context-account comparison without re-parsing. */
export function contextAccountId(
  context: CommerceOrganizationContext,
): CommerceAccountId {
  return context.access.accountId;
}

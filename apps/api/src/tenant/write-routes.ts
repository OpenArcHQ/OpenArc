import {
  API_CLIENT_HEADER,
  API_MAX_RESPONSE_BYTES,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceApiMetaSchema,
  CommerceTenantIdempotencyKeySchema,
  CommerceTenantMutationResponseSchema,
  CommerceTenantMutationStatusResponseSchema,
  type CommerceApiMeta,
} from "@openarc/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";

import { AUTH_ERRORS, AuthApiError } from "../auth/errors.js";
import { parseAuthCookies, type AuthCookieNames } from "../auth/cookies.js";
import type { AuthRequestContext } from "../auth/service.js";
import { decodePathSegment, TENANT_ROUTE_PREFIX } from "./routes.js";
import type { TenantWriteService } from "./write-service.js";

/**
 * Exact tenant write/status surface.
 *
 * Transport is strict: the exact APP_ORIGIN is required for every write (an
 * originless POST/PATCH/PUT is denied), `X-OpenArc-Client: browser-v1`, the
 * accepted same-origin/CORS Fetch metadata, cookie auth only (any Authorization
 * header is rejected, including a duplicate), exact `application/json` media,
 * no query string at all (including a bare `?`), and exactly ONE canonical
 * 43-character 32-byte base64url `Idempotency-Key` header per business write.
 * Every route parameter is decoded exactly once from the bounded raw URL;
 * residual percent-encoding, controls, separators and unknown parameters fail
 * closed. Bad input, URLs, headers and bodies are never reflected.
 *
 * No response on this surface can set a cookie. A committed receipt returns
 * 200 whether it is new or replayed. There is no broad catch-all POST and no
 * arbitrary operation dispatcher: each route maps to exactly one service call.
 */

const MAX_REQUEST_URL_BYTES = 2048;
const MAX_PATH_PARAM_BYTES = 512;

/**
 * Critical security headers whose wire occurrence count must be at most one.
 * Node's HTTP parser discards duplicates of some headers (most notably
 * `Content-Type`) from the normalized `request.headers` object, so the
 * normalized `strictHeader` checks below alone cannot see a request that sent
 * both `application/json` and `text/plain`. The raw header list is authoritative
 * and is counted case-insensitively before any parsing or authorization.
 */
const CRITICAL_HEADER_NAMES: ReadonlySet<string> = new Set([
  "origin",
  "x-openarc-client",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "authorization",
  "content-type",
  "content-length",
  "transfer-encoding",
  "idempotency-key",
  "x-openarc-csrf",
]);

export const TENANT_WRITE_ROUTES = Object.freeze({
  organizations: TENANT_ROUTE_PREFIX,
  agents: `${TENANT_ROUTE_PREFIX}/:organizationId/agents`,
  agent: `${TENANT_ROUTE_PREFIX}/:organizationId/agents/:agentId`,
  providers: `${TENANT_ROUTE_PREFIX}/:organizationId/providers`,
  provider: `${TENANT_ROUTE_PREFIX}/:organizationId/providers/:providerId`,
  membership: `${TENANT_ROUTE_PREFIX}/:organizationId/memberships/:accountId`,
  mutation: `${TENANT_ROUTE_PREFIX}/:organizationId/mutations/:mutationId`,
  bootstrapMutation: `${TENANT_ROUTE_PREFIX}/bootstrap-mutations/:mutationId`,
} as const);

/** The new write-only/status paths that are registered disabled by default. */
const WRITE_ONLY_PATHS: readonly string[] = [
  TENANT_WRITE_ROUTES.agent,
  TENANT_WRITE_ROUTES.provider,
  TENANT_WRITE_ROUTES.membership,
  TENANT_WRITE_ROUTES.mutation,
  TENANT_WRITE_ROUTES.bootstrapMutation,
];

export interface TenantWriteRoutesOptions {
  appOrigin: string;
  cookieNames: AuthCookieNames;
  service: TenantWriteService;
  buildSha: string;
  enabled: boolean;
  maxResponseBytes?: number;
}

type ParsedWritePath =
  | { readonly kind: "organizationCreate" }
  | { readonly kind: "agentCreate"; readonly organizationId: string }
  | {
      readonly kind: "agentUpdate";
      readonly organizationId: string;
      readonly agentId: string;
    }
  | { readonly kind: "providerCreate"; readonly organizationId: string }
  | {
      readonly kind: "providerUpdate";
      readonly organizationId: string;
      readonly providerId: string;
    }
  | {
      readonly kind: "membershipSet";
      readonly organizationId: string;
      readonly accountId: string;
    }
  | {
      readonly kind: "mutationStatus";
      readonly organizationId: string;
      readonly mutationId: string;
    }
  | { readonly kind: "bootstrapMutationStatus"; readonly mutationId: string };

function invalidRequest(): AuthApiError {
  return AUTH_ERRORS.invalidRequest();
}

function methodNotAllowed(): AuthApiError {
  return new AuthApiError("INVALID_REQUEST", 405, "METHOD_NOT_ALLOWED");
}

function originRejected(): AuthApiError {
  return AUTH_ERRORS.originRejected();
}

function strictHeader(headers: Record<string, unknown>, key: string): unknown {
  const value = headers[key];
  if (Array.isArray(value)) throw invalidRequest();
  return value;
}

/**
 * Reject a request that presents more than one wire instance of any critical
 * security header. `request.raw.rawHeaders` is the flat, case-preserving
 * `[name, value, ...]` list exactly as received, so a duplicate `Content-Type`
 * (which Node may collapse in `request.headers`) is still observed here. This
 * runs before body parsing and before any auth/repository work.
 */
function enforceNoDuplicateCriticalHeaders(request: FastifyRequest): void {
  const raw = request.raw.rawHeaders;
  if (!Array.isArray(raw)) return;
  const seen = new Set<string>();
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index];
    if (typeof name !== "string") continue;
    const lower = name.toLowerCase();
    if (!CRITICAL_HEADER_NAMES.has(lower)) continue;
    if (seen.has(lower)) throw invalidRequest();
    seen.add(lower);
  }
}

/**
 * The exact request target as received on the wire. `request.raw.url` preserves
 * a bare trailing `?` that framework URL normalization may otherwise drop, so
 * an empty query is still rejected. The normalized `request.url` is only a
 * fallback and is never trusted for authority.
 */
function rawRequestUrl(request: FastifyRequest): string {
  const raw = request.raw.url;
  return typeof raw === "string" && raw.length > 0 ? raw : request.url;
}

/**
 * True when an exact request target is unacceptable for this surface: over the
 * URL byte bound or carrying ANY query, including a bare empty `?`. Exported so
 * the bare-`?` rule can be tested directly (some HTTP injectors normalize an
 * empty query away on the wire, while a real request target preserves it).
 */
export function isForbiddenRequestTarget(url: string): boolean {
  return (
    Buffer.byteLength(url, "utf8") > MAX_REQUEST_URL_BYTES || url.includes("?")
  );
}

function meta(request: FastifyRequest, buildSha: string): CommerceApiMeta {
  return CommerceApiMetaSchema.parse({
    schemaVersion: COMMERCE_API_SCHEMA_VERSION,
    requestId: request.id,
    buildSha,
  });
}

function sendEnvelope<T>(
  request: FastifyRequest,
  reply: FastifyReply,
  options: TenantWriteRoutesOptions,
  schema: ZodType<{ ok: true; data: T; meta: CommerceApiMeta }>,
  data: T,
): FastifyReply {
  const envelope = schema.parse({ ok: true, data, meta: meta(request, options.buildSha) });
  const serialized = JSON.stringify(envelope);
  const limit = options.maxResponseBytes ?? API_MAX_RESPONSE_BYTES;
  if (Buffer.byteLength(serialized, "utf8") > limit) throw AUTH_ERRORS.internal();
  return reply.type("application/json; charset=utf-8").send(serialized);
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

/**
 * Exact decode-once matcher for the eight write/status shapes. Every segment is
 * bound-checked, control-checked and decoded once; unknown keywords, extra
 * segments, separators and residual encoding all fail closed.
 */
function parseWritePath(rawUrl: string): ParsedWritePath {
  if (Buffer.byteLength(rawUrl, "utf8") > MAX_REQUEST_URL_BYTES) throw invalidRequest();
  if (rawUrl.includes("?")) throw invalidRequest();
  if (hasControlCharacter(rawUrl)) throw invalidRequest();
  const prefix = `${TENANT_ROUTE_PREFIX}/`;
  if (rawUrl === TENANT_ROUTE_PREFIX) return { kind: "organizationCreate" };
  if (!rawUrl.startsWith(prefix)) throw invalidRequest();
  const segments = rawUrl.slice(prefix.length).split("/");
  for (const segment of segments) {
    if (segment.length === 0) throw invalidRequest();
  }
  const head = decodePathSegment(segments[0] as string, MAX_PATH_PARAM_BYTES);
  if (segments.length === 1) throw invalidRequest();
  const second = segments[1] as string;
  if (head === "bootstrap-mutations") {
    if (segments.length !== 2) throw invalidRequest();
    return {
      kind: "bootstrapMutationStatus",
      mutationId: decodePathSegment(second, MAX_PATH_PARAM_BYTES),
    };
  }
  const organizationId = head;
  if (second === "agents") {
    if (segments.length === 2) return { kind: "agentCreate", organizationId };
    if (segments.length === 3) {
      return {
        kind: "agentUpdate",
        organizationId,
        agentId: decodePathSegment(segments[2] as string, MAX_PATH_PARAM_BYTES),
      };
    }
    throw invalidRequest();
  }
  if (second === "providers") {
    if (segments.length === 2) return { kind: "providerCreate", organizationId };
    if (segments.length === 3) {
      return {
        kind: "providerUpdate",
        organizationId,
        providerId: decodePathSegment(segments[2] as string, MAX_PATH_PARAM_BYTES),
      };
    }
    throw invalidRequest();
  }
  if (second === "memberships") {
    if (segments.length !== 3) throw invalidRequest();
    return {
      kind: "membershipSet",
      organizationId,
      accountId: decodePathSegment(segments[2] as string, MAX_PATH_PARAM_BYTES),
    };
  }
  if (second === "mutations") {
    if (segments.length !== 3) throw invalidRequest();
    return {
      kind: "mutationStatus",
      organizationId,
      mutationId: decodePathSegment(segments[2] as string, MAX_PATH_PARAM_BYTES),
    };
  }
  throw invalidRequest();
}

function requestContext(
  request: FastifyRequest,
  names: AuthCookieNames,
): AuthRequestContext {
  let cookies;
  try {
    cookies = parseAuthCookies(request.headers.cookie, names);
  } catch {
    throw invalidRequest();
  }
  return { peerIp: request.ip, cookies };
}

function enforceFetchMetadata(
  request: FastifyRequest,
  options: TenantWriteRoutesOptions,
  allowOriginless: boolean,
): void {
  const origin = strictHeader(request.headers, "origin");
  const site = strictHeader(request.headers, "sec-fetch-site");
  const mode = strictHeader(request.headers, "sec-fetch-mode");
  const destination = strictHeader(request.headers, "sec-fetch-dest");
  if (origin === options.appOrigin) {
    // exact same-origin request
  } else if (allowOriginless && origin === undefined && site === "same-origin") {
    // originless GET is allowed ONLY with an explicit same-origin fetch site
  } else {
    throw originRejected();
  }
  if (site !== undefined && site !== "same-origin") throw originRejected();
  if (mode !== undefined && mode !== "cors" && mode !== "same-origin") {
    throw originRejected();
  }
  if (destination !== undefined && destination !== "empty") throw originRejected();
}

function enforceNoBodyOrWriteAuthority(
  request: FastifyRequest,
  methodNotAllowedFor: string,
): void {
  if (request.method !== methodNotAllowedFor) throw methodNotAllowed();
  if (strictHeader(request.headers, "authorization") !== undefined) {
    throw invalidRequest();
  }
  const contentLength = strictHeader(request.headers, "content-length");
  if (contentLength !== undefined && contentLength !== "0") throw invalidRequest();
  if (strictHeader(request.headers, "transfer-encoding") !== undefined) {
    throw invalidRequest();
  }
  // An unexpected write-authority header on a status GET is ambiguous and fails
  // closed rather than being silently ignored.
  if (strictHeader(request.headers, "idempotency-key") !== undefined) {
    throw invalidRequest();
  }
  if (strictHeader(request.headers, "x-openarc-csrf") !== undefined) {
    throw invalidRequest();
  }
}

function enforceWriteTransport(
  request: FastifyRequest,
  options: TenantWriteRoutesOptions,
  expectedMethod: "POST" | "PATCH" | "PUT",
): void {
  enforceNoDuplicateCriticalHeaders(request);
  const url = rawRequestUrl(request);
  if (isForbiddenRequestTarget(url)) throw invalidRequest();
  if (request.method !== expectedMethod) throw methodNotAllowed();
  if (strictHeader(request.headers, "authorization") !== undefined) {
    throw invalidRequest();
  }
  if (strictHeader(request.headers, "x-openarc-client") !== API_CLIENT_HEADER) {
    throw originRejected();
  }
  enforceFetchMetadata(request, options, false);
  const contentType = strictHeader(request.headers, "content-type");
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:; *charset=utf-8)?$/iu.test(contentType)
  ) {
    throw AUTH_ERRORS.unsupportedMedia();
  }
  if (strictHeader(request.headers, "transfer-encoding") !== undefined) {
    throw invalidRequest();
  }
  const contentLength = strictHeader(request.headers, "content-length");
  if (
    contentLength !== undefined &&
    (typeof contentLength !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/u.test(contentLength))
  ) {
    throw invalidRequest();
  }
  const idempotency = strictHeader(request.headers, "idempotency-key");
  if (
    typeof idempotency !== "string" ||
    !CommerceTenantIdempotencyKeySchema.safeParse(idempotency).success
  ) {
    throw invalidRequest();
  }
}

function enforceStatusTransport(
  request: FastifyRequest,
  options: TenantWriteRoutesOptions,
): void {
  enforceNoDuplicateCriticalHeaders(request);
  const url = rawRequestUrl(request);
  if (isForbiddenRequestTarget(url)) throw invalidRequest();
  if (request.method !== "GET") throw methodNotAllowed();
  if (strictHeader(request.headers, "x-openarc-client") !== API_CLIENT_HEADER) {
    throw originRejected();
  }
  enforceFetchMetadata(request, options, true);
  enforceNoBodyOrWriteAuthority(request, "GET");
}

export function registerTenantWriteRoutes(
  app: FastifyInstance,
  options: TenantWriteRoutesOptions,
): void {
  if (!options.enabled) {
    // New write-only/status paths fail closed with the fixed v2
    // FEATURE_DISABLED envelope and perform no transport/authority check. The
    // three shared paths stay owned by the read plugin (POST keeps its existing
    // 405/FEATURE_DISABLED behavior).
    for (const path of WRITE_ONLY_PATHS) {
      app.all(
        path,
        { onRequest: async () => { throw AUTH_ERRORS.featureDisabled(); } },
        async () => undefined,
      );
    }
    return;
  }

  const envelope = (
    request: FastifyRequest,
    reply: FastifyReply,
    data: unknown,
  ): FastifyReply =>
    sendEnvelope(
      request,
      reply,
      options,
      CommerceTenantMutationResponseSchema,
      data,
    );

  const statusEnvelope = (
    request: FastifyRequest,
    reply: FastifyReply,
    data: unknown,
  ): FastifyReply =>
    sendEnvelope(
      request,
      reply,
      options,
      CommerceTenantMutationStatusResponseSchema,
      data,
    );

  app.route({
    method: "POST",
    url: TENANT_WRITE_ROUTES.organizations,
    onRequest: async (request) => {
      enforceWriteTransport(request, options, "POST");
      if (parseWritePath(request.url).kind !== "organizationCreate") {
        throw invalidRequest();
      }
    },
    handler: async (request, reply) => {
      const data = await options.service.createOrganization({
        ctx: requestContext(request, options.cookieNames),
        csrf: strictHeader(request.headers, "x-openarc-csrf"),
        idempotencyKey: strictHeader(request.headers, "idempotency-key"),
        body: request.body,
      });
      return envelope(request, reply, data);
    },
  });

  const registerExactWrite = (
    method: "POST" | "PATCH" | "PUT",
    path: string,
    expectedKind: ParsedWritePath["kind"],
    run: (
      parsed: ParsedWritePath,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<FastifyReply>,
    sharedWithRead = false,
  ): void => {
    const onRequest = async (request: FastifyRequest): Promise<void> => {
      enforceWriteTransport(request, options, method);
    };
    const handler = async (
      request: FastifyRequest,
      reply: FastifyReply,
    ): Promise<FastifyReply> => {
      const parsed = parseWritePath(request.url);
      if (parsed.kind !== expectedKind) throw invalidRequest();
      return run(parsed, request, reply);
    };
    if (sharedWithRead) {
      // The read plugin owns every verb except the exact POST on this path, so
      // only POST is registered here (a second `all` would be a duplicate).
      app.route({ method, url: path, onRequest, handler });
    } else {
      app.all(path, { onRequest }, handler);
    }
  };

  registerExactWrite("POST", TENANT_WRITE_ROUTES.agents, "agentCreate", async (parsed, request, reply) => {
    const scoped = parsed as Extract<ParsedWritePath, { kind: "agentCreate" }>;
    const data = await options.service.createAgent(scoped.organizationId, {
      ctx: requestContext(request, options.cookieNames),
      csrf: strictHeader(request.headers, "x-openarc-csrf"),
      idempotencyKey: strictHeader(request.headers, "idempotency-key"),
      body: request.body,
    });
    return envelope(request, reply, data);
  }, true);

  registerExactWrite("PATCH", TENANT_WRITE_ROUTES.agent, "agentUpdate", async (parsed, request, reply) => {
    const scoped = parsed as Extract<ParsedWritePath, { kind: "agentUpdate" }>;
    const data = await options.service.updateAgent(
      scoped.organizationId,
      scoped.agentId,
      {
        ctx: requestContext(request, options.cookieNames),
        csrf: strictHeader(request.headers, "x-openarc-csrf"),
        idempotencyKey: strictHeader(request.headers, "idempotency-key"),
        body: request.body,
      },
    );
    return envelope(request, reply, data);
  });

  registerExactWrite("POST", TENANT_WRITE_ROUTES.providers, "providerCreate", async (parsed, request, reply) => {
    const scoped = parsed as Extract<ParsedWritePath, { kind: "providerCreate" }>;
    const data = await options.service.createProvider(scoped.organizationId, {
      ctx: requestContext(request, options.cookieNames),
      csrf: strictHeader(request.headers, "x-openarc-csrf"),
      idempotencyKey: strictHeader(request.headers, "idempotency-key"),
      body: request.body,
    });
    return envelope(request, reply, data);
  }, true);

  registerExactWrite("PATCH", TENANT_WRITE_ROUTES.provider, "providerUpdate", async (parsed, request, reply) => {
    const scoped = parsed as Extract<ParsedWritePath, { kind: "providerUpdate" }>;
    const data = await options.service.updateProvider(
      scoped.organizationId,
      scoped.providerId,
      {
        ctx: requestContext(request, options.cookieNames),
        csrf: strictHeader(request.headers, "x-openarc-csrf"),
        idempotencyKey: strictHeader(request.headers, "idempotency-key"),
        body: request.body,
      },
    );
    return envelope(request, reply, data);
  });

  registerExactWrite("PUT", TENANT_WRITE_ROUTES.membership, "membershipSet", async (parsed, request, reply) => {
    const scoped = parsed as Extract<ParsedWritePath, { kind: "membershipSet" }>;
    const data = await options.service.setMembership(
      scoped.organizationId,
      scoped.accountId,
      {
        ctx: requestContext(request, options.cookieNames),
        csrf: strictHeader(request.headers, "x-openarc-csrf"),
        idempotencyKey: strictHeader(request.headers, "idempotency-key"),
        body: request.body,
      },
    );
    return envelope(request, reply, data);
  });

  const registerStatus = (
    path: string,
    expectedKind: ParsedWritePath["kind"],
    run: (
      parsed: ParsedWritePath,
      ctx: AuthRequestContext,
    ) => Promise<unknown>,
  ): void => {
    app.all(
      path,
      { onRequest: async (request) => { enforceStatusTransport(request, options); } },
      async (request, reply) => {
        const parsed = parseWritePath(request.url);
        if (parsed.kind !== expectedKind) throw invalidRequest();
        const data = await run(parsed, requestContext(request, options.cookieNames));
        return statusEnvelope(request, reply, data);
      },
    );
  };

  registerStatus(TENANT_WRITE_ROUTES.mutation, "mutationStatus", async (parsed, ctx) => {
    const scoped = parsed as Extract<ParsedWritePath, { kind: "mutationStatus" }>;
    return options.service.getTenantMutationStatus(
      scoped.organizationId,
      scoped.mutationId,
      ctx,
    );
  });

  registerStatus(
    TENANT_WRITE_ROUTES.bootstrapMutation,
    "bootstrapMutationStatus",
    async (parsed, ctx) => {
      const scoped = parsed as Extract<
        ParsedWritePath,
        { kind: "bootstrapMutationStatus" }
      >;
      return options.service.getOrganizationMutationStatus(scoped.mutationId, ctx);
    },
  );
}

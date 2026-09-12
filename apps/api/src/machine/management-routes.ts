import {
  API_CLIENT_HEADER,
  API_MAX_RESPONSE_BYTES,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceApiMetaSchema,
  CommerceMachineCredentialIdSchema,
  CommerceMachineCredentialIssueBodySchema,
  CommerceMachineCredentialIssueResponseSchema,
  CommerceMachineCredentialPageResponseSchema,
  CommerceMachineCredentialRevokeBodySchema,
  CommerceMachineCredentialRevokeResponseSchema,
  CommerceMachineCredentialStatusResponseSchema,
  CommerceOrganizationIdSchema,
  CommerceTenantIdempotencyKeySchema,
  type CommerceApiMeta,
} from "@openarc/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";

import { AUTH_ERRORS, AuthApiError } from "../auth/errors.js";
import { parseAuthCookies, type AuthCookieNames } from "../auth/cookies.js";
import type { AuthRequestContext } from "../auth/service.js";
import { ApiBoundaryError } from "../http/errors.js";
import { decodePathSegment, TENANT_ROUTE_PREFIX } from "../tenant/routes.js";
import type { MachineManagementService } from "./management-service.js";
import type { MachineCredentialKind } from "./credential-crypto.js";

/**
 * Exact human management surface for machine credentials.
 *
 * Strict browser transport: exact APP_ORIGIN plus `X-OpenArc-Client:
 * browser-v1`, cookie auth only (any Authorization header is rejected,
 * including a duplicate), exact `application/json` media on writes, exactly
 * ONE canonical 32-byte base64url `Idempotency-Key`, and a raw duplicate-header
 * guard before body parsing. Every path parameter is decoded exactly once from
 * the bounded raw URL; the list route is the ONLY route permitted a query
 * (`limit`/`after`, each exactly once, default 50, max 50, canonical UUIDv4
 * cursor) and status rejects even a bare `?`. No response here can set a
 * cookie and no cookie is ever echoed.
 */

const MAX_REQUEST_URL_BYTES = 2048;
const MAX_PATH_PARAM_BYTES = 512;
const MAX_LIST_LIMIT = 50;
const DEFAULT_LIST_LIMIT = 50;

const CRITICAL_HEADER_NAMES: ReadonlySet<string> = new Set([
  "origin",
  "x-openarc-client",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "cookie",
  "authorization",
  "content-type",
  "content-length",
  "transfer-encoding",
  "idempotency-key",
  "x-openarc-csrf",
]);

export const MACHINE_MANAGEMENT_ROUTES = Object.freeze({
  agentCredentials: `${TENANT_ROUTE_PREFIX}/:organizationId/agents/:agentId/credentials`,
  providerCredentials: `${TENANT_ROUTE_PREFIX}/:organizationId/providers/:providerId/credentials`,
  agentCredentialRevoke: `${TENANT_ROUTE_PREFIX}/:organizationId/agent-credentials/:credentialId/revoke`,
  providerCredentialRevoke: `${TENANT_ROUTE_PREFIX}/:organizationId/provider-credentials/:credentialId/revoke`,
  agentMutation: `${TENANT_ROUTE_PREFIX}/:organizationId/agent-credential-mutations/:mutationId`,
  providerMutation: `${TENANT_ROUTE_PREFIX}/:organizationId/provider-credential-mutations/:mutationId`,
} as const);

const MACHINE_MANAGEMENT_PATHS: readonly string[] = [
  MACHINE_MANAGEMENT_ROUTES.agentCredentials,
  MACHINE_MANAGEMENT_ROUTES.providerCredentials,
  MACHINE_MANAGEMENT_ROUTES.agentCredentialRevoke,
  MACHINE_MANAGEMENT_ROUTES.providerCredentialRevoke,
  MACHINE_MANAGEMENT_ROUTES.agentMutation,
  MACHINE_MANAGEMENT_ROUTES.providerMutation,
];

export interface MachineManagementRoutesOptions {
  appOrigin: string;
  cookieNames: AuthCookieNames;
  service: MachineManagementService;
  buildSha: string;
  enabled: boolean;
  maxResponseBytes?: number;
}

interface ListQuery {
  readonly limit?: number;
  readonly after?: string;
}

type ParsedManagementPath =
  | {
      readonly kind: "credentials";
      readonly credentialKind: MachineCredentialKind;
      readonly organizationId: string;
      readonly profileId: string;
    }
  | {
      readonly kind: "revoke";
      readonly credentialKind: MachineCredentialKind;
      readonly organizationId: string;
      readonly credentialId: string;
    }
  | {
      readonly kind: "mutation";
      readonly credentialKind: MachineCredentialKind;
      readonly organizationId: string;
      readonly mutationId: string;
    };

function invalidRequest(): AuthApiError {
  return AUTH_ERRORS.invalidRequest();
}

function methodNotAllowed(): AuthApiError {
  return new AuthApiError("INVALID_REQUEST", 405, "METHOD_NOT_ALLOWED");
}

function originRejected(): AuthApiError {
  return AUTH_ERRORS.originRejected();
}

function notFound(): ApiBoundaryError {
  return new ApiBoundaryError("NOT_FOUND");
}

function strictHeader(headers: Record<string, unknown>, key: string): unknown {
  const value = headers[key];
  if (Array.isArray(value)) throw invalidRequest();
  return value;
}

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

function rawRequestUrl(request: FastifyRequest): string {
  const raw = request.raw.url;
  return typeof raw === "string" && raw.length > 0 ? raw : request.url;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) return true;
  }
  return false;
}

function rawPath(url: string): string {
  const queryIndex = url.indexOf("?");
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

function parseManagementPath(rawUrl: string): ParsedManagementPath {
  if (Buffer.byteLength(rawUrl, "utf8") > MAX_REQUEST_URL_BYTES) throw invalidRequest();
  const path = rawPath(rawUrl);
  if (hasControlCharacter(path)) throw invalidRequest();
  const prefix = `${TENANT_ROUTE_PREFIX}/`;
  if (!path.startsWith(prefix)) throw invalidRequest();
  const rawSegments = path.slice(prefix.length).split("/");
  if (rawSegments.some((segment) => segment.length === 0)) throw invalidRequest();
  const segments = rawSegments.map((segment) =>
    decodePathSegment(segment, MAX_PATH_PARAM_BYTES),
  );
  if (segments.length === 3) {
    const [organizationId, keyword, id] = segments as [string, string, string];
    if (keyword === "agent-credential-mutations") {
      return {
        kind: "mutation",
        credentialKind: "agent",
        organizationId,
        mutationId: id,
      };
    }
    if (keyword === "provider-credential-mutations") {
      return {
        kind: "mutation",
        credentialKind: "provider",
        organizationId,
        mutationId: id,
      };
    }
    throw invalidRequest();
  }
  if (segments.length === 4) {
    const [organizationId, keyword, id, verb] = segments as [
      string,
      string,
      string,
      string,
    ];
    if (keyword === "agents" && verb === "credentials") {
      return {
        kind: "credentials",
        credentialKind: "agent",
        organizationId,
        profileId: id,
      };
    }
    if (keyword === "providers" && verb === "credentials") {
      return {
        kind: "credentials",
        credentialKind: "provider",
        organizationId,
        profileId: id,
      };
    }
    if (keyword === "agent-credentials" && verb === "revoke") {
      return {
        kind: "revoke",
        credentialKind: "agent",
        organizationId,
        credentialId: id,
      };
    }
    if (keyword === "provider-credentials" && verb === "revoke") {
      return {
        kind: "revoke",
        credentialKind: "provider",
        organizationId,
        credentialId: id,
      };
    }
    throw invalidRequest();
  }
  throw invalidRequest();
}

const ENCODED_CHARACTER = /^(?:[^%\s]|%[0-9A-Fa-f]{2})*$/u;
const CANONICAL_LIMIT = /^(?:[1-9]|[1-4][0-9]|50)$/u;

/**
 * Parse the list query. Each key may appear exactly once; any unknown key,
 * duplicate, empty value, control character, `#` fragment or malformed
 * percent-encoding fails closed. `limit` is 1..50 canonical; `after` is a
 * canonical UUIDv4.
 */
export function parseMachineListQuery(url: string): ListQuery {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return {};
  const raw = url.slice(queryIndex + 1);
  if (raw.length === 0 || raw.includes("#")) throw invalidRequest();
  for (const pair of raw.split("&")) {
    if (pair.length === 0) throw invalidRequest();
    const separator = pair.indexOf("=");
    if (separator <= 0) throw invalidRequest();
    const key = pair.slice(0, separator);
    const value = pair.slice(separator + 1);
    if (
      value.length === 0 ||
      !ENCODED_CHARACTER.test(key) ||
      !ENCODED_CHARACTER.test(value)
    ) {
      throw invalidRequest();
    }
  }
  const params = new URLSearchParams(raw);
  const result: { limit?: number; after?: string } = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    if (values.length !== 1) throw invalidRequest();
    const value = values[0];
    if (value === undefined || hasControlCharacter(value)) throw invalidRequest();
    if (key === "limit") {
      if (!CANONICAL_LIMIT.test(value)) throw invalidRequest();
      result.limit = Number(value);
    } else if (key === "after") {
      if (!CommerceMachineCredentialIdSchema.safeParse(value).success) {
        throw invalidRequest();
      }
      result.after = value;
    } else {
      throw invalidRequest();
    }
  }
  return result;
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
  options: MachineManagementRoutesOptions,
  allowOriginlessSameOrigin: boolean,
): void {
  const origin = strictHeader(request.headers, "origin");
  const site = strictHeader(request.headers, "sec-fetch-site");
  const mode = strictHeader(request.headers, "sec-fetch-mode");
  const destination = strictHeader(request.headers, "sec-fetch-dest");
  if (origin === options.appOrigin) {
    // exact same-origin request
  } else if (allowOriginlessSameOrigin && origin === undefined && site === "same-origin") {
    // Same-origin browser GET lists/status normally omit Origin; allow
    // originless reads ONLY with an explicit same-origin fetch site. This
    // mirrors the accepted tenant read transport and never applies to writes.
  } else {
    throw originRejected();
  }
  if (site !== undefined && site !== "same-origin") throw originRejected();
  if (mode !== undefined && mode !== "cors" && mode !== "same-origin") {
    throw originRejected();
  }
  if (destination !== undefined && destination !== "empty") {
    throw originRejected();
  }
}

function enforceBrowserOrigin(
  request: FastifyRequest,
  options: MachineManagementRoutesOptions,
  allowOriginlessSameOrigin: boolean,
): void {
  enforceNoDuplicateCriticalHeaders(request);
  if (Buffer.byteLength(rawRequestUrl(request), "utf8") > MAX_REQUEST_URL_BYTES) {
    throw invalidRequest();
  }
  if (strictHeader(request.headers, "authorization") !== undefined) {
    throw invalidRequest();
  }
  if (strictHeader(request.headers, "x-openarc-client") !== API_CLIENT_HEADER) {
    throw originRejected();
  }
  enforceFetchMetadata(request, options, allowOriginlessSameOrigin);
}

function enforceStatusTransport(
  request: FastifyRequest,
  options: MachineManagementRoutesOptions,
): void {
  // Status is a read; an originless same-origin GET is permitted.
  enforceBrowserOrigin(request, options, true);
  if (request.method !== "GET") throw methodNotAllowed();
  if (isForbiddenMachineRequestTarget(rawRequestUrl(request))) throw invalidRequest();
  const contentLength = strictHeader(request.headers, "content-length");
  if (contentLength !== undefined && contentLength !== "0") throw invalidRequest();
  if (strictHeader(request.headers, "transfer-encoding") !== undefined) {
    throw invalidRequest();
  }
  if (strictHeader(request.headers, "idempotency-key") !== undefined) {
    throw invalidRequest();
  }
  if (strictHeader(request.headers, "x-openarc-csrf") !== undefined) {
    throw invalidRequest();
  }
}

/**
 * True when an exact request target is unacceptable for a no-query machine
 * route: over the URL byte bound or carrying ANY query, including a bare empty
 * `?` that framework URL normalization may otherwise drop. Exported so the
 * bare-`?` rule is testable directly against a real request target.
 */
export function isForbiddenMachineRequestTarget(url: string): boolean {
  return Buffer.byteLength(url, "utf8") > MAX_REQUEST_URL_BYTES || url.includes("?");
}

function enforceWriteTransport(
  request: FastifyRequest,
  options: MachineManagementRoutesOptions,
): void {
  // Writes always require the exact Origin header; never apply the GET fallback.
  enforceBrowserOrigin(request, options, false);
  if (request.method !== "POST") throw methodNotAllowed();
  if (rawRequestUrl(request).includes("?")) throw invalidRequest();
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
    (typeof contentLength !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(contentLength))
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
  const csrf = strictHeader(request.headers, "x-openarc-csrf");
  if (typeof csrf !== "string" || csrf.length === 0) throw invalidRequest();
}

function enforceListTransport(
  request: FastifyRequest,
  options: MachineManagementRoutesOptions,
): void {
  if (request.method === "GET") {
    // List GET is a read; allow an originless same-origin browser request.
    enforceBrowserOrigin(request, options, true);
    const contentLength = strictHeader(request.headers, "content-length");
    if (contentLength !== undefined && contentLength !== "0") throw invalidRequest();
    if (strictHeader(request.headers, "transfer-encoding") !== undefined) {
      throw invalidRequest();
    }
    if (strictHeader(request.headers, "idempotency-key") !== undefined) {
      throw invalidRequest();
    }
    if (strictHeader(request.headers, "x-openarc-csrf") !== undefined) {
      throw invalidRequest();
    }
    return;
  }
  enforceWriteTransport(request, options);
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
  options: MachineManagementRoutesOptions,
  schema: ZodType<{ ok: true; data: T; meta: CommerceApiMeta }>,
  data: T,
): FastifyReply {
  const envelope = schema.parse({ ok: true, data, meta: meta(request, options.buildSha) });
  const serialized = JSON.stringify(envelope);
  const limit = options.maxResponseBytes ?? API_MAX_RESPONSE_BYTES;
  if (Buffer.byteLength(serialized, "utf8") > limit) throw AUTH_ERRORS.internal();
  return reply.type("application/json; charset=utf-8").send(serialized);
}

function requireOrganization(value: string): string {
  if (!CommerceOrganizationIdSchema.safeParse(value).success) throw invalidRequest();
  return value;
}

export function registerMachineManagementRoutes(
  app: FastifyInstance,
  options: MachineManagementRoutesOptions,
): void {
  if (!options.enabled) {
    for (const path of MACHINE_MANAGEMENT_PATHS) {
      app.all(
        path,
        { onRequest: async () => { throw notFound(); } },
        async () => undefined,
      );
    }
    return;
  }

  const registerAll = (
    path: string,
    expected: ParsedManagementPath["kind"][],
    transport: (request: FastifyRequest) => void,
    run: (
      parsed: ParsedManagementPath,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<FastifyReply>,
  ): void => {
    app.all(
      path,
      {
        onRequest: async (request) => {
          transport(request);
        },
      },
      async (request, reply) => {
        const parsed = parseManagementPath(rawRequestUrl(request));
        if (!expected.includes(parsed.kind)) throw invalidRequest();
        return run(parsed, request, reply);
      },
    );
  };

  registerAll(
    MACHINE_MANAGEMENT_ROUTES.agentCredentials,
    ["credentials"],
    (request) => enforceListTransport(request, options),
    async (parsed, request, reply) => {
      const scoped = parsed as Extract<ParsedManagementPath, { kind: "credentials" }>;
      if (scoped.credentialKind !== "agent") throw invalidRequest();
      const ctx = requestContext(request, options.cookieNames);
      if (request.method === "POST") {
        if (!CommerceMachineCredentialIssueBodySchema.safeParse(request.body).success) {
          throw invalidRequest();
        }
        const data = await options.service.issueCredential(
          "agent",
          requireOrganization(scoped.organizationId),
          scoped.profileId,
          {
            ctx,
            csrf: strictHeader(request.headers, "x-openarc-csrf"),
            idempotencyKey: strictHeader(request.headers, "idempotency-key"),
            body: request.body,
          },
        );
        return sendEnvelope(
          request,
          reply,
          options,
          CommerceMachineCredentialIssueResponseSchema,
          data,
        );
      }
      const query = parseMachineListQuery(rawRequestUrl(request));
      const data = await options.service.listCredentials(
        "agent",
        requireOrganization(scoped.organizationId),
        scoped.profileId,
        {
          ctx,
          ...(query.after !== undefined ? { after: query.after } : {}),
          limit: query.limit ?? DEFAULT_LIST_LIMIT,
        },
      );
      return sendEnvelope(
        request,
        reply,
        options,
        CommerceMachineCredentialPageResponseSchema,
        data,
      );
    },
  );

  registerAll(
    MACHINE_MANAGEMENT_ROUTES.providerCredentials,
    ["credentials"],
    (request) => enforceListTransport(request, options),
    async (parsed, request, reply) => {
      const scoped = parsed as Extract<ParsedManagementPath, { kind: "credentials" }>;
      if (scoped.credentialKind !== "provider") throw invalidRequest();
      const ctx = requestContext(request, options.cookieNames);
      if (request.method === "POST") {
        if (!CommerceMachineCredentialIssueBodySchema.safeParse(request.body).success) {
          throw invalidRequest();
        }
        const data = await options.service.issueCredential(
          "provider",
          requireOrganization(scoped.organizationId),
          scoped.profileId,
          {
            ctx,
            csrf: strictHeader(request.headers, "x-openarc-csrf"),
            idempotencyKey: strictHeader(request.headers, "idempotency-key"),
            body: request.body,
          },
        );
        return sendEnvelope(
          request,
          reply,
          options,
          CommerceMachineCredentialIssueResponseSchema,
          data,
        );
      }
      const query = parseMachineListQuery(rawRequestUrl(request));
      const data = await options.service.listCredentials(
        "provider",
        requireOrganization(scoped.organizationId),
        scoped.profileId,
        {
          ctx,
          ...(query.after !== undefined ? { after: query.after } : {}),
          limit: query.limit ?? DEFAULT_LIST_LIMIT,
        },
      );
      return sendEnvelope(
        request,
        reply,
        options,
        CommerceMachineCredentialPageResponseSchema,
        data,
      );
    },
  );

  const registerRevoke = (
    path: string,
    expectedKind: MachineCredentialKind,
  ): void => {
    registerAll(
      path,
      ["revoke"],
      (request) => enforceWriteTransport(request, options),
      async (parsed, request, reply) => {
        const scoped = parsed as Extract<ParsedManagementPath, { kind: "revoke" }>;
        if (scoped.credentialKind !== expectedKind) throw invalidRequest();
        if (!CommerceMachineCredentialRevokeBodySchema.safeParse(request.body).success) {
          throw invalidRequest();
        }
        const data = await options.service.revokeCredential(
          expectedKind,
          requireOrganization(scoped.organizationId),
          scoped.credentialId,
          {
            ctx: requestContext(request, options.cookieNames),
            csrf: strictHeader(request.headers, "x-openarc-csrf"),
            idempotencyKey: strictHeader(request.headers, "idempotency-key"),
            body: request.body,
          },
        );
        return sendEnvelope(
          request,
          reply,
          options,
          CommerceMachineCredentialRevokeResponseSchema,
          data,
        );
      },
    );
  };

  registerRevoke(MACHINE_MANAGEMENT_ROUTES.agentCredentialRevoke, "agent");
  registerRevoke(MACHINE_MANAGEMENT_ROUTES.providerCredentialRevoke, "provider");

  const registerMutation = (
    path: string,
    expectedKind: MachineCredentialKind,
  ): void => {
    registerAll(
      path,
      ["mutation"],
      (request) => enforceStatusTransport(request, options),
      async (parsed, request, reply) => {
        const scoped = parsed as Extract<ParsedManagementPath, { kind: "mutation" }>;
        if (scoped.credentialKind !== expectedKind) throw invalidRequest();
        const data = await options.service.getMutationStatus(
          expectedKind,
          requireOrganization(scoped.organizationId),
          scoped.mutationId,
          requestContext(request, options.cookieNames),
        );
        return sendEnvelope(
          request,
          reply,
          options,
          CommerceMachineCredentialStatusResponseSchema,
          data,
        );
      },
    );
  };

  registerMutation(MACHINE_MANAGEMENT_ROUTES.agentMutation, "agent");
  registerMutation(MACHINE_MANAGEMENT_ROUTES.providerMutation, "provider");
}

export { MAX_LIST_LIMIT, DEFAULT_LIST_LIMIT };

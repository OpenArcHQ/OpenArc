import {
  API_CLIENT_HEADER,
  API_MAX_RESPONSE_BYTES,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceAgentIdSchema,
  CommerceAgentListRequestSchema,
  CommerceAgentPageResponseSchema,
  CommerceApiMetaSchema,
  CommerceOrganizationContextResponseSchema,
  CommerceOrganizationIdSchema,
  CommerceOrganizationListRequestSchema,
  CommerceOrganizationPageResponseSchema,
  CommerceProviderIdSchema,
  CommerceProviderListRequestSchema,
  CommerceProviderPageResponseSchema,
  type CommerceApiMeta,
} from "@openarc/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";

import { AUTH_ERRORS, AuthApiError } from "../auth/errors.js";
import {
  parseAuthCookies,
  type AuthCookieNames,
} from "../auth/cookies.js";
import type { AuthRequestContext } from "../auth/service.js";
import type { TenantReadService } from "./service.js";

/**
 * Bounded, exact GET-only protected tenant read routes.
 *
 * The path is parsed from the RAW url with a fixed matcher (never a generic
 * dispatcher), the query is parsed with URLSearchParams plus explicit
 * percent-encoding, duplicate-key, unknown-key and character rejection, and
 * the framework's value coercion is never trusted. Every response is a strict
 * v2 success envelope whose serialized size is checked before it is sent. No
 * Set-Cookie, no CSRF and no cookie minting are possible on this surface.
 */

export const TENANT_ROUTE_PREFIX = "/v1/operator/organizations" as const;

export const TENANT_ROUTES = Object.freeze({
  organizations: TENANT_ROUTE_PREFIX,
  organization: `${TENANT_ROUTE_PREFIX}/:organizationId`,
  agents: `${TENANT_ROUTE_PREFIX}/:organizationId/agents`,
  providers: `${TENANT_ROUTE_PREFIX}/:organizationId/providers`,
} as const);

/**
 * The methods registered by the read family when the write family owns POST.
 * Fastify's `all()` would also claim POST, so the read plugin must register an
 * explicit method list minus POST to leave the single POST registration to the
 * write plugin. Every other verb keeps the existing read-handler 405.
 */
const READ_METHODS_WITHOUT_POST = [
  "GET",
  "HEAD",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
] as const;

const MAX_REQUEST_URL_BYTES = 2048;
const MAX_PATH_ORGANIZATION_BYTES = 512;

export interface TenantRoutesOptions {
  appOrigin: string;
  cookieNames: AuthCookieNames;
  service: TenantReadService;
  buildSha: string;
  enabled: boolean;
  maxResponseBytes?: number;
  /**
   * When the tenant write family is enabled, the three shared read paths must
   * not register POST so the write plugin can own the exact POST route.
   */
  excludePost?: boolean;
}

export interface TenantCompletionLogShape {
  readonly requestId: string;
  readonly buildSha: string;
}

function invalidRequest(): AuthApiError {
  return AUTH_ERRORS.invalidRequest();
}

function methodNotAllowed(): AuthApiError {
  return new AuthApiError("INVALID_REQUEST", 405, "METHOD_NOT_ALLOWED");
}

function originRejected(): AuthApiError {
  return AUTH_ERRORS.originRejected();
}

function strictHeader(
  headers: Record<string, unknown>,
  key: string,
): unknown {
  const value = headers[key];
  if (Array.isArray(value)) throw invalidRequest();
  return value;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function rawPath(url: string): string {
  const queryIndex = url.indexOf("?");
  return queryIndex === -1 ? url : url.slice(0, queryIndex);
}

/**
 * Why a segment is rejected: empty/oversize/control, a `/` separator, or a
 * malformed `%` escape. The `%` checks are done here rather than by trusting a
 * framework decoder.
 */
function hasMalformedPercentEncoding(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] !== "%") continue;
    const high = value[index + 1];
    const low = value[index + 2];
    if (
      high === undefined ||
      low === undefined ||
      !/[0-9A-Fa-f]/u.test(high) ||
      !/[0-9A-Fa-f]/u.test(low)
    ) {
      return true;
    }
    index += 2;
  }
  return false;
}

/**
 * Decode the organization segment EXACTLY once and validate the canonical
 * decoded id. The frontend sends `encodeURIComponent(orgId)`, so one decode of
 * a well-formed escape is accepted. Residual percent-encoding (double
 * encoding), separators, control characters and malformed escapes are
 * rejected; no second decode is ever attempted.
 */
export function decodePathSegment(
  raw: string,
  maxBytes = MAX_PATH_ORGANIZATION_BYTES,
): string {
  if (
    raw.length === 0 ||
    Buffer.byteLength(raw, "utf8") > maxBytes ||
    raw.includes("/") ||
    hasControlCharacter(raw) ||
    hasMalformedPercentEncoding(raw)
  ) {
    throw invalidRequest();
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw invalidRequest();
  }
  if (
    decoded.includes("%") ||
    decoded.includes("/") ||
    hasControlCharacter(decoded)
  ) {
    throw invalidRequest();
  }
  return decoded;
}

function decodeOrganizationSegment(raw: string): string {
  const decoded = decodePathSegment(raw);
  const parsed = CommerceOrganizationIdSchema.safeParse(decoded);
  if (!parsed.success) throw invalidRequest();
  return parsed.data;
}

/**
 * Reject anything other than a bounded canonical path with a decodable
 * organization segment. This is an exact matcher for the four frozen routes,
 * not an arbitrary URL dispatcher.
 */
function requireOrganizationPath(
  url: string,
  suffix: "" | "/agents" | "/providers",
): string {
  if (Buffer.byteLength(url, "utf8") > MAX_REQUEST_URL_BYTES) {
    throw invalidRequest();
  }
  const path = rawPath(url);
  if (hasControlCharacter(path)) throw invalidRequest();
  const prefix = `${TENANT_ROUTE_PREFIX}/`;
  if (!path.startsWith(prefix)) throw invalidRequest();
  let rest = path.slice(prefix.length);
  if (suffix !== "") {
    if (!rest.endsWith(suffix)) throw invalidRequest();
    rest = rest.slice(0, rest.length - suffix.length);
  }
  return decodeOrganizationSegment(rest);
}

function requireExactRoot(url: string): void {
  if (Buffer.byteLength(url, "utf8") > MAX_REQUEST_URL_BYTES) {
    throw invalidRequest();
  }
  const path = rawPath(url);
  if (hasControlCharacter(path) || path !== TENANT_ROUTE_PREFIX) {
    throw invalidRequest();
  }
}

const ENCODED_CHARACTER = /^(?:[^%\s]|%[0-9A-Fa-f]{2})*$/u;
const CANONICAL_LIMIT = /^(?:[1-9]|[1-9][0-9]|100)$/u;

/**
 * Parse a bounded raw query string.
 *
 * URLSearchParams performs the decoding, but the raw pairs are checked first
 * so invalid percent-encoding, empty keys/values, duplicate keys and
 * unknown keys fail closed instead of being coerced. A `+` is decoded as a
 * space by URLSearchParams and then rejected by the canonical validators.
 */
function parseQuery(
  url: string,
  allowedKeys: readonly string[],
  requireNoQuery: boolean,
): Map<string, string> {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return new Map();
  if (requireNoQuery) throw invalidRequest();
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
  const result = new Map<string, string>();
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    if (values.length !== 1) throw invalidRequest();
    if (!allowedKeys.includes(key)) throw invalidRequest();
    const value = values[0];
    if (value === undefined || hasControlCharacter(value)) {
      throw invalidRequest();
    }
    result.set(key, value);
  }
  return result;
}

function parseLimit(query: Map<string, string>): number | undefined {
  const raw = query.get("limit");
  if (raw === undefined) return undefined;
  if (!CANONICAL_LIMIT.test(raw)) throw invalidRequest();
  return Number(raw);
}

function parseOptionalId(
  query: Map<string, string>,
  key: string,
  pattern: { safeParse(value: unknown): { success: boolean } },
): string | undefined {
  const raw = query.get(key);
  if (raw === undefined) return undefined;
  if (!pattern.safeParse(raw).success) throw invalidRequest();
  return raw;
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
  options: TenantRoutesOptions,
  schema: ZodType<{ ok: true; data: T; meta: CommerceApiMeta }>,
  data: T,
): FastifyReply {
  const envelope = schema.parse({
    ok: true,
    data,
    meta: meta(request, options.buildSha),
  });
  const serialized = JSON.stringify(envelope);
  const limit = options.maxResponseBytes ?? API_MAX_RESPONSE_BYTES;
  if (Buffer.byteLength(serialized, "utf8") > limit) {
    throw AUTH_ERRORS.internal();
  }
  return reply.type("application/json; charset=utf-8").send(serialized);
}

function enforceTransport(
  request: FastifyRequest,
  options: TenantRoutesOptions,
): void {
  if (Buffer.byteLength(request.url, "utf8") > MAX_REQUEST_URL_BYTES) {
    throw invalidRequest();
  }
  if (request.method !== "GET") throw methodNotAllowed();
  const headers = request.headers;
  if (strictHeader(headers, "authorization") !== undefined) {
    throw invalidRequest();
  }
  if (strictHeader(headers, "x-openarc-client") !== API_CLIENT_HEADER) {
    throw originRejected();
  }
  const origin = strictHeader(headers, "origin");
  const site = strictHeader(headers, "sec-fetch-site");
  const mode = strictHeader(headers, "sec-fetch-mode");
  const destination = strictHeader(headers, "sec-fetch-dest");
  if (origin === options.appOrigin) {
    // exact same-origin request
  } else if (origin === undefined && site === "same-origin") {
    // originless GET is allowed ONLY with an explicit same-origin fetch site
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
  const contentLength = strictHeader(headers, "content-length");
  if (contentLength !== undefined && contentLength !== "0") {
    throw invalidRequest();
  }
  if (strictHeader(headers, "transfer-encoding") !== undefined) {
    throw invalidRequest();
  }
}

export function registerTenantRoutes(
  app: FastifyInstance,
  options: TenantRoutesOptions,
): void {
  const paths: readonly string[] = [
    TENANT_ROUTES.organizations,
    TENANT_ROUTES.organization,
    TENANT_ROUTES.agents,
    TENANT_ROUTES.providers,
  ];

  if (!options.enabled) {
    for (const path of paths) {
      app.all(
        path,
        { onRequest: async () => { throw AUTH_ERRORS.featureDisabled(); } },
        async () => undefined,
      );
    }
    return;
  }

  type ReadHandler = (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<unknown>;

  /**
   * Register one read route. When POST is owned by the write plugin, an exact
   * method list minus POST is used; every other verb keeps the read handler and
   * therefore the existing 405. The other read routes keep the full `all` set.
   */
  const registerRead = (
    path: string,
    excludePost: boolean,
    handler: ReadHandler,
  ): void => {
    const onRequest = async (request: FastifyRequest): Promise<void> => {
      enforceTransport(request, options);
    };
    if (excludePost) {
      app.route({
        url: path,
        method: [...READ_METHODS_WITHOUT_POST],
        onRequest,
        handler,
      });
    } else {
      app.all(path, { onRequest }, handler);
    }
  };

  registerRead(
    TENANT_ROUTES.organizations,
    options.excludePost === true,
    async (request, reply) => {
      requireExactRoot(request.url);
      const query = parseQuery(
        request.url,
        ["afterOrganizationId", "limit"],
        false,
      );
      const afterOrganizationId = parseOptionalId(
        query,
        "afterOrganizationId",
        CommerceOrganizationIdSchema,
      );
      const limit = parseLimit(query);
      const requestObject = {
        ...(afterOrganizationId !== undefined ? { afterOrganizationId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      };
      // Re-parse through the accepted strict request schema before the read.
      const strict = CommerceOrganizationListRequestSchema.safeParse(
        requestObject,
      );
      if (!strict.success) throw invalidRequest();
      const data = await options.service.listOrganizations(
        requestContext(request, options.cookieNames),
        strict.data,
      );
      return sendEnvelope(
        request,
        reply,
        options,
        CommerceOrganizationPageResponseSchema,
        data,
      );
    },
  );

  registerRead(
    TENANT_ROUTES.organization,
    false,
    async (request, reply) => {
      const organizationId = requireOrganizationPath(request.url, "");
      const query = parseQuery(request.url, [], true);
      void query;
      const data = await options.service.getOrganizationContext(
        requestContext(request, options.cookieNames),
        { organizationId },
      );
      return sendEnvelope(
        request,
        reply,
        options,
        CommerceOrganizationContextResponseSchema,
        data,
      );
    },
  );

  registerRead(
    TENANT_ROUTES.agents,
    options.excludePost === true,
    async (request, reply) => {
      const organizationId = requireOrganizationPath(request.url, "/agents");
      const query = parseQuery(request.url, ["afterAgentId", "limit"], false);
      const afterAgentId = parseOptionalId(
        query,
        "afterAgentId",
        CommerceAgentIdSchema,
      );
      const limit = parseLimit(query);
      const strict = CommerceAgentListRequestSchema.safeParse({
        organizationId,
        ...(afterAgentId !== undefined ? { afterAgentId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      if (!strict.success) throw invalidRequest();
      const data = await options.service.listAgents(
        requestContext(request, options.cookieNames),
        strict.data,
      );
      return sendEnvelope(
        request,
        reply,
        options,
        CommerceAgentPageResponseSchema,
        data,
      );
    },
  );

  registerRead(
    TENANT_ROUTES.providers,
    options.excludePost === true,
    async (request, reply) => {
      const organizationId = requireOrganizationPath(
        request.url,
        "/providers",
      );
      const query = parseQuery(
        request.url,
        ["afterProviderId", "limit"],
        false,
      );
      const afterProviderId = parseOptionalId(
        query,
        "afterProviderId",
        CommerceProviderIdSchema,
      );
      const limit = parseLimit(query);
      const strict = CommerceProviderListRequestSchema.safeParse({
        organizationId,
        ...(afterProviderId !== undefined ? { afterProviderId } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      if (!strict.success) throw invalidRequest();
      const data = await options.service.listProviders(
        requestContext(request, options.cookieNames),
        strict.data,
      );
      return sendEnvelope(
        request,
        reply,
        options,
        CommerceProviderPageResponseSchema,
        data,
      );
    },
  );

}

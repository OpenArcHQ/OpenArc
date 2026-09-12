import {
  API_CLIENT_HEADER,
  API_MAX_RESPONSE_BYTES,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceApiMetaSchema,
  CommerceListingIdSchema,
  CommerceListingVersionSchema,
  CommerceMarketMutationResultResponseSchema,
  CommerceMarketMutationStatusResponseSchema,
  CommerceMarketOwnerPageResponseSchema,
  CommerceMarketOwnerVersionDetailResponseSchema,
  CommerceMarketOwnerVersionPageResponseSchema,
  CommerceOrganizationIdSchema,
  CommerceTenantIdempotencyKeySchema,
  CommerceTenantMutationIdSchema,
  type CommerceApiMeta,
} from "@openarc/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";

import { AUTH_ERRORS, AuthApiError } from "../auth/errors.js";
import { parseAuthCookies, type AuthCookieNames } from "../auth/cookies.js";
import type { AuthRequestContext } from "../auth/service.js";
import { decodePathSegment } from "../tenant/routes.js";
import type { MarketService } from "./service.js";

/**
 * Exact protected market owner listing surface.
 *
 * Six routes only, under `/v2/provider/organizations/:organizationId`:
 *   GET  /listings
 *   POST /listings
 *   GET  /listings/:listingId/versions
 *   POST /listings/:listingId/versions
 *   GET  /listings/:listingId/versions/:version
 *   GET  /listing-mutations/:mutationId
 *
 * Transport is cookie-only human auth with the exact browser marker. A POST
 * requires the exact configured Origin; a GET may omit Origin ONLY when
 * `Sec-Fetch-Site: same-origin`, while any supplied foreign Origin is denied.
 * `Authorization` and `Proxy-Authorization` are rejected, unexpected credential
 * metadata fails closed, and a raw duplicate critical header scan runs before
 * framework normalization. The path is parsed exactly once from the bounded raw
 * URL; residual escapes, separators, controls and unknown keywords fail closed.
 * No response on this surface can set a cookie and there is no CORS grant.
 */

export const MARKET_ROUTE_PREFIX = "/v2/provider/organizations" as const;

export const MARKET_ROUTES = Object.freeze({
  listings: `${MARKET_ROUTE_PREFIX}/:organizationId/listings`,
  versions: `${MARKET_ROUTE_PREFIX}/:organizationId/listings/:listingId/versions`,
  version: `${MARKET_ROUTE_PREFIX}/:organizationId/listings/:listingId/versions/:version`,
  mutation: `${MARKET_ROUTE_PREFIX}/:organizationId/listing-mutations/:mutationId`,
} as const);

/**
 * True when an exact request target is unacceptable for a write/query-free
 * route: over the URL byte bound or carrying ANY query, including a bare `?`.
 * Exported so the bare-`?` rule can be tested directly (some HTTP injectors
 * normalize an empty query away on the wire, while a real request target
 * preserves it).
 */
export function isForbiddenRequestTarget(url: string): boolean {
  return (
    Buffer.byteLength(url, "utf8") > MAX_REQUEST_URL_BYTES || url.includes("?")
  );
}

const MAX_REQUEST_URL_BYTES = 2048;
const MAX_PATH_PARAM_BYTES = 512;
const CANONICAL_LIMIT = /^(?:[1-9]|[1-4][0-9]|50)$/u;
const ENCODED_CHARACTER = /^(?:[^%\s]|%[0-9A-Fa-f]{2})*$/u;

/**
 * Critical security headers whose wire occurrence count must be at most one.
 * `request.raw.rawHeaders` is authoritative because Node may collapse some
 * duplicates (notably Content-Type) in the normalized header map.
 */
const CRITICAL_HEADER_NAMES: ReadonlySet<string> = new Set([
  "origin",
  "x-openarc-client",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "authorization",
  "proxy-authorization",
  "cookie",
  "content-type",
  "content-length",
  "transfer-encoding",
  "idempotency-key",
  "x-openarc-csrf",
]);

export interface MarketRoutesOptions {
  appOrigin: string;
  cookieNames: AuthCookieNames;
  service: MarketService;
  buildSha: string;
  enabled: boolean;
  maxResponseBytes?: number;
}

type ParsedMarketPath =
  | { readonly kind: "listings"; readonly organizationId: string }
  | {
      readonly kind: "versions";
      readonly organizationId: string;
      readonly listingId: string;
    }
  | {
      readonly kind: "version";
      readonly organizationId: string;
      readonly listingId: string;
      readonly version: string;
    }
  | {
      readonly kind: "mutation";
      readonly organizationId: string;
      readonly mutationId: string;
    };

interface MarketQuery {
  readonly value: Map<string, string>;
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

function strictHeader(headers: Record<string, unknown>, key: string): unknown {
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

function rawRequestUrl(request: FastifyRequest): string {
  const raw = request.raw.url;
  return typeof raw === "string" && raw.length > 0 ? raw : request.url;
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

function requireCanonical<T>(
  schema: ZodType<T>,
  value: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidRequest();
  return parsed.data;
}

/**
 * Exact decode-once matcher for the four frozen market path shapes. Every
 * segment is bound/control/escape checked, decoded exactly once, and validated
 * against the accepted canonical id schema. Unknown keywords, extra segments
 * and separators fail closed.
 */
function parseMarketPath(rawUrl: string): ParsedMarketPath {
  if (Buffer.byteLength(rawUrl, "utf8") > MAX_REQUEST_URL_BYTES) {
    throw invalidRequest();
  }
  if (hasControlCharacter(rawUrl)) throw invalidRequest();
  const queryIndex = rawUrl.indexOf("?");
  const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const prefix = `${MARKET_ROUTE_PREFIX}/`;
  if (!path.startsWith(prefix)) throw invalidRequest();
  const segments = path.slice(prefix.length).split("/");
  for (const segment of segments) {
    if (segment.length === 0) throw invalidRequest();
  }
  const organizationId = requireCanonical(
    CommerceOrganizationIdSchema,
    decodePathSegment(segments[0] as string, MAX_PATH_PARAM_BYTES),
  );
  const second = segments[1];
  if (second === "listings") {
    if (segments.length === 2) return { kind: "listings", organizationId };
    if (segments[2] === undefined || segments[3] !== "versions") {
      throw invalidRequest();
    }
    const listingId = requireCanonical(
      CommerceListingIdSchema,
      decodePathSegment(segments[2], MAX_PATH_PARAM_BYTES),
    );
    if (segments.length === 4) {
      return { kind: "versions", organizationId, listingId };
    }
    if (segments.length === 5 && segments[4] !== undefined) {
      const version = requireCanonical(
        CommerceListingVersionSchema,
        decodePathSegment(segments[4], MAX_PATH_PARAM_BYTES),
      );
      return { kind: "version", organizationId, listingId, version };
    }
    throw invalidRequest();
  }
  if (second === "listing-mutations") {
    if (segments.length !== 3) throw invalidRequest();
    const mutationId = requireCanonical(
      CommerceTenantMutationIdSchema,
      decodePathSegment(segments[2] as string, MAX_PATH_PARAM_BYTES),
    );
    return { kind: "mutation", organizationId, mutationId };
  }
  throw invalidRequest();
}

/**
 * Parse a bounded raw query string. Invalid percent-encoding, empty
 * keys/values, duplicate keys, unknown keys and control characters fail closed;
 * an empty or absent value is never coerced into a default.
 */
function parseQuery(
  url: string,
  allowedKeys: readonly string[],
  requireNoQuery: boolean,
): MarketQuery {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return { value: new Map() };
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
  return { value: result };
}

function parseLimit(query: MarketQuery): number | undefined {
  const raw = query.value.get("limit");
  if (raw === undefined) return undefined;
  if (!CANONICAL_LIMIT.test(raw)) throw invalidRequest();
  return Number(raw);
}

function parseOptionalCursor(
  query: MarketQuery,
  key: string,
  schema: ZodType,
): string | undefined {
  const raw = query.value.get(key);
  if (raw === undefined) return undefined;
  if (!schema.safeParse(raw).success) throw invalidRequest();
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

function enforceFetchMetadata(
  request: FastifyRequest,
  options: MarketRoutesOptions,
  allowOriginless: boolean,
): void {
  const origin = strictHeader(request.headers, "origin");
  const site = strictHeader(request.headers, "sec-fetch-site");
  const mode = strictHeader(request.headers, "sec-fetch-mode");
  const destination = strictHeader(request.headers, "sec-fetch-dest");
  if (origin === options.appOrigin) {
    // exact same-origin request
  } else if (allowOriginless && origin === undefined && site === "same-origin") {
    // originless read ONLY with an explicit same-origin fetch site
  } else {
    throw originRejected();
  }
  if (site !== undefined && site !== "same-origin") throw originRejected();
  if (mode !== undefined && mode !== "cors" && mode !== "same-origin") {
    throw originRejected();
  }
  if (destination !== undefined && destination !== "empty") throw originRejected();
}

function enforceReadTransport(
  request: FastifyRequest,
  options: MarketRoutesOptions,
): void {
  enforceNoDuplicateCriticalHeaders(request);
  const url = rawRequestUrl(request);
  if (Buffer.byteLength(url, "utf8") > MAX_REQUEST_URL_BYTES) throw invalidRequest();
  if (request.method !== "GET") throw methodNotAllowed();
  if (strictHeader(request.headers, "authorization") !== undefined) {
    throw invalidRequest();
  }
  if (strictHeader(request.headers, "proxy-authorization") !== undefined) {
    throw invalidRequest();
  }
  if (strictHeader(request.headers, "x-openarc-client") !== API_CLIENT_HEADER) {
    throw originRejected();
  }
  enforceFetchMetadata(request, options, true);
  if (strictHeader(request.headers, "idempotency-key") !== undefined) {
    throw invalidRequest();
  }
  if (strictHeader(request.headers, "x-openarc-csrf") !== undefined) {
    throw invalidRequest();
  }
  const contentLength = strictHeader(request.headers, "content-length");
  if (contentLength !== undefined && contentLength !== "0") throw invalidRequest();
  if (strictHeader(request.headers, "transfer-encoding") !== undefined) {
    throw invalidRequest();
  }
}

function enforceWriteTransport(
  request: FastifyRequest,
  options: MarketRoutesOptions,
): void {
  enforceNoDuplicateCriticalHeaders(request);
  const url = rawRequestUrl(request);
  if (isForbiddenRequestTarget(url)) throw invalidRequest();
  if (request.method !== "POST") throw methodNotAllowed();
  if (strictHeader(request.headers, "authorization") !== undefined) {
    throw invalidRequest();
  }
  if (strictHeader(request.headers, "proxy-authorization") !== undefined) {
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
  options: MarketRoutesOptions,
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

export function registerMarketRoutes(
  app: FastifyInstance,
  options: MarketRoutesOptions,
): void {
  if (!options.enabled) {
    // Default-off: register NOTHING. A request yields the framework's ordinary
    // 404 rather than a simulated disabled-route response.
    return;
  }

  const methodFor = (request: FastifyRequest, allowed: "read" | "write"): void => {
    if (allowed === "read") {
      if (request.method !== "GET") throw methodNotAllowed();
      enforceReadTransport(request, options);
      return;
    }
    if (request.method !== "POST") throw methodNotAllowed();
    enforceWriteTransport(request, options);
  };

  const dispatch = (
    request: FastifyRequest,
    reply: FastifyReply,
    expected: ParsedMarketPath["kind"],
  ): Promise<FastifyReply> => {
    const path = parseMarketPath(rawRequestUrl(request));
    if (path.kind !== expected) throw invalidRequest();

    if (path.kind === "listings") {
      if (request.method === "GET") {
        const query = parseQuery(
          rawRequestUrl(request),
          ["afterListingId", "limit"],
          false,
        );
        const afterListingId = parseOptionalCursor(
          query,
          "afterListingId",
          CommerceListingIdSchema,
        );
        const limit = parseLimit(query);
        return options.service
          .listOwnerListings(requestContext(request, options.cookieNames), {
            organizationId: path.organizationId,
            ...(afterListingId !== undefined ? { afterListingId } : {}),
            ...(limit !== undefined ? { limit } : {}),
          })
          .then((data) =>
            sendEnvelope(
              request,
              reply,
              options,
              CommerceMarketOwnerPageResponseSchema,
              data,
            ),
          );
      }
      return options.service
        .createListingDraft(
          requestContext(request, options.cookieNames),
          path.organizationId,
          {
            ctx: requestContext(request, options.cookieNames),
            csrf: strictHeader(request.headers, "x-openarc-csrf"),
            idempotencyKey: strictHeader(request.headers, "idempotency-key"),
            body: request.body,
          },
        )
        .then((data) =>
          sendEnvelope(
            request,
            reply,
            options,
            CommerceMarketMutationResultResponseSchema,
            data,
          ),
        );
    }

    if (path.kind === "versions") {
      if (request.method === "GET") {
        const query = parseQuery(
          rawRequestUrl(request),
          ["afterVersion", "limit"],
          false,
        );
        const afterVersion = parseOptionalCursor(
          query,
          "afterVersion",
          CommerceListingVersionSchema,
        );
        const limit = parseLimit(query);
        return options.service
          .listOwnerListingVersions(
            requestContext(request, options.cookieNames),
            {
              organizationId: path.organizationId,
              listingId: path.listingId,
              ...(afterVersion !== undefined ? { afterVersion } : {}),
              ...(limit !== undefined ? { limit } : {}),
            },
          )
          .then((data) =>
            sendEnvelope(
              request,
              reply,
              options,
              CommerceMarketOwnerVersionPageResponseSchema,
              data,
            ),
          );
      }
      return options.service
        .createListingVersion(
          requestContext(request, options.cookieNames),
          path.organizationId,
          path.listingId,
          {
            ctx: requestContext(request, options.cookieNames),
            csrf: strictHeader(request.headers, "x-openarc-csrf"),
            idempotencyKey: strictHeader(request.headers, "idempotency-key"),
            body: request.body,
          },
        )
        .then((data) =>
          sendEnvelope(
            request,
            reply,
            options,
            CommerceMarketMutationResultResponseSchema,
            data,
          ),
        );
    }

    if (path.kind === "version") {
      if (isForbiddenRequestTarget(rawRequestUrl(request))) throw invalidRequest();
      return options.service
        .getOwnerListingVersion(requestContext(request, options.cookieNames), {
          organizationId: path.organizationId,
          listingId: path.listingId,
          version: path.version,
        })
        .then((data) =>
          sendEnvelope(
            request,
            reply,
            options,
            CommerceMarketOwnerVersionDetailResponseSchema,
            data,
          ),
        );
    }

    if (isForbiddenRequestTarget(rawRequestUrl(request))) throw invalidRequest();
    return options.service
      .getMarketMutationStatus(requestContext(request, options.cookieNames), {
        organizationId: path.organizationId,
        mutationId: path.mutationId,
      })
      .then((data) =>
        sendEnvelope(
          request,
          reply,
          options,
          CommerceMarketMutationStatusResponseSchema,
          data,
        ),
      );
  };

  const register = (
    template: string,
    allowed: "read" | "write" | "both",
    expected: ParsedMarketPath["kind"],
  ): void => {
    app.all(
      template,
      {
        onRequest: async (request) => {
          if (allowed === "both") {
            if (request.method === "GET") methodFor(request, "read");
            else if (request.method === "POST") methodFor(request, "write");
            else throw methodNotAllowed();
            return;
          }
          methodFor(request, allowed);
        },
      },
      async (request, reply) => dispatch(request, reply, expected),
    );
  };

  register(MARKET_ROUTES.listings, "both", "listings");
  register(MARKET_ROUTES.versions, "both", "versions");
  register(MARKET_ROUTES.version, "read", "version");
  register(MARKET_ROUTES.mutation, "read", "mutation");
}

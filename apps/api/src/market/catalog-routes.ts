import {
  API_CLIENT_HEADER,
  API_MAX_RESPONSE_BYTES,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceApiMetaSchema,
  CommerceListingIdSchema,
  CommerceListingKindSchema,
  CommerceMarketPublicDetailRequestSchema,
  CommerceMarketPublicDetailResponseSchema,
  CommerceMarketPublicPageResponseSchema,
  CommerceMarketPublicProviderDetailResponseSchema,
  CommerceMarketPublicProviderRequestSchema,
  CommerceProviderIdSchema,
  type CommerceApiMeta,
} from "@openarc/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";

import { AUTH_ERRORS, AuthApiError } from "../auth/errors.js";
import { decodePathSegment } from "../tenant/routes.js";
import type { MarketCatalogService } from "./catalog-service.js";

/**
 * Exact public, credentialless marketplace catalog surface: three GET routes.
 *
 * This transport is independent of the protected family. An absent Origin is
 * allowed (machine metadata reads); a supplied Origin must equal the exact
 * configured app origin. The optional `browser-v1` marker is the ONLY accepted
 * client metadata. ANY Cookie, Authorization, Proxy-Authorization, CSRF,
 * Idempotency-Key, body/length payload or unknown client metadata fails closed,
 * and duplicate critical headers are rejected from the raw wire list before
 * framework normalization. Only the exact eight informational Railway/proxy
 * metadata names reused from the public capability surface are ignored, never
 * trusted, and there is deliberately no wildcard header allowance. The list
 * route accepts exactly the shared catalog query; detail/provider are
 * query-free. Unsupported verbs are a fixed 405. No response can set an account
 * cookie, redirect, retry, contact a provider/RPC source or grant CORS.
 */

const PUBLIC_BASE = "/v2/public/market";

export const MARKET_CATALOG_ROUTES = Object.freeze({
  listings: `${PUBLIC_BASE}/listings`,
  listing: `${PUBLIC_BASE}/listings/:listingId`,
  provider: `${PUBLIC_BASE}/providers/:providerId`,
} as const);

const MAX_REQUEST_URL_BYTES = 2048;
const MAX_PATH_PARAM_BYTES = 512;
const CANONICAL_LIMIT = /^(?:[1-9]|[1-4][0-9]|50)$/u;
const ENCODED_CHARACTER = /^(?:[^%\s]|%[0-9A-Fa-f]{2})*$/u;

const PUBLIC_CRITICAL_HEADERS: ReadonlySet<string> = new Set([
  "origin",
  "cookie",
  "authorization",
  "proxy-authorization",
  "x-openarc-csrf",
  "idempotency-key",
  "x-openarc-client",
  "content-length",
  "transfer-encoding",
  "content-type",
]);

const ALLOWED_CLIENT_HEADER_NAMES: ReadonlySet<string> = new Set([
  "x-openarc-client",
]);

/**
 * The exact eight informational metadata names ignored on the public
 * capability surface: six documented Railway second-edge headers plus the two
 * standard opaque proxy names. Never trusted, echoed, logged or used as
 * authority. No wildcard.
 */
const IGNORED_TRANSPORT_HEADERS: ReadonlySet<string> = new Set([
  "x-real-ip",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-railway-edge",
  "x-request-start",
  "x-railway-request-id",
  "x-forwarded-for",
  "forwarded",
]);

export interface MarketCatalogRoutesOptions {
  enabled: boolean;
  appOrigin: string;
  service?: MarketCatalogService;
  buildSha: string;
  maxResponseBytes?: number;
}

type ParsedCatalogPath =
  | { readonly kind: "listings" }
  | { readonly kind: "listing"; readonly listingId: string }
  | { readonly kind: "provider"; readonly providerId: string };

interface CatalogQuery {
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

function missingService(): never {
  throw new Error("MARKET_CATALOG_SERVICE_REQUIRED");
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

export function isForbiddenCatalogRequestTarget(url: string): boolean {
  return (
    Buffer.byteLength(url, "utf8") > MAX_REQUEST_URL_BYTES || url.includes("?")
  );
}

function enforceNoDuplicateCriticalHeaders(request: FastifyRequest): void {
  const raw = request.raw.rawHeaders;
  if (!Array.isArray(raw)) return;
  const seen = new Set<string>();
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index];
    if (typeof name !== "string") continue;
    const lower = name.toLowerCase();
    if (!PUBLIC_CRITICAL_HEADERS.has(lower)) continue;
    if (seen.has(lower)) throw invalidRequest();
    seen.add(lower);
  }
}

/**
 * Reject any header that is neither a fixed transport/negotiation header nor
 * the single optional browser marker or one of the exact eight ignored
 * informational names. This is an allowlist, so arbitrary client metadata
 * fails closed.
 */
function enforceAllowedHeaders(request: FastifyRequest): void {
  for (const name of Object.keys(request.headers)) {
    if (ALLOWED_CLIENT_HEADER_NAMES.has(name)) continue;
    if (PUBLIC_CRITICAL_HEADERS.has(name)) continue;
    if (IGNORED_TRANSPORT_HEADERS.has(name)) continue;
    if (
      name === "host" ||
      name === "accept" ||
      name === "accept-encoding" ||
      name === "accept-language" ||
      name === "user-agent" ||
      name === "connection" ||
      name === "sec-fetch-site" ||
      name === "sec-fetch-mode" ||
      name === "sec-fetch-dest"
    ) {
      continue;
    }
    throw invalidRequest();
  }
}

function enforceCatalogTransport(
  request: FastifyRequest,
  options: MarketCatalogRoutesOptions,
  allowQuery: boolean,
): void {
  enforceNoDuplicateCriticalHeaders(request);
  const url = rawRequestUrl(request);
  if (Buffer.byteLength(url, "utf8") > MAX_REQUEST_URL_BYTES) throw invalidRequest();
  if (request.method !== "GET") throw methodNotAllowed();
  enforceAllowedHeaders(request);

  // Credential and anti-forgery headers are never accepted on this public,
  // credentialless surface.
  for (const name of [
    "cookie",
    "authorization",
    "proxy-authorization",
    "x-openarc-csrf",
    "idempotency-key",
    "content-type",
  ]) {
    if (strictHeader(request.headers, name) !== undefined) throw invalidRequest();
  }

  const client = strictHeader(request.headers, "x-openarc-client");
  if (client !== undefined && client !== API_CLIENT_HEADER) {
    throw invalidRequest();
  }
  const origin = strictHeader(request.headers, "origin");
  const site = strictHeader(request.headers, "sec-fetch-site");
  if (origin !== undefined && origin !== options.appOrigin) throw originRejected();
  if (site !== undefined && site !== "same-origin") throw originRejected();

  const contentLength = strictHeader(request.headers, "content-length");
  if (contentLength !== undefined && contentLength !== "0") throw invalidRequest();
  if (strictHeader(request.headers, "transfer-encoding") !== undefined) {
    throw invalidRequest();
  }
  if (!allowQuery && isForbiddenCatalogRequestTarget(url)) throw invalidRequest();
}

function requireCanonical<T>(schema: ZodType<T>, value: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidRequest();
  return parsed.data;
}

function parseCatalogPath(rawUrl: string): ParsedCatalogPath {
  if (Buffer.byteLength(rawUrl, "utf8") > MAX_REQUEST_URL_BYTES) {
    throw invalidRequest();
  }
  if (hasControlCharacter(rawUrl)) throw invalidRequest();
  const queryIndex = rawUrl.indexOf("?");
  const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const prefix = `${PUBLIC_BASE}/`;
  if (!path.startsWith(prefix)) throw invalidRequest();
  const segments = path.slice(prefix.length).split("/");
  for (const segment of segments) {
    if (segment.length === 0) throw invalidRequest();
  }
  if (segments.length === 1 && segments[0] === "listings") {
    return { kind: "listings" };
  }
  if (segments.length === 2 && segments[0] === "listings") {
    const listingId = requireCanonical(
      CommerceListingIdSchema,
      decodePathSegment(segments[1] as string, MAX_PATH_PARAM_BYTES),
    );
    return { kind: "listing", listingId };
  }
  if (segments.length === 2 && segments[0] === "providers") {
    const providerId = requireCanonical(
      CommerceProviderIdSchema,
      decodePathSegment(segments[1] as string, MAX_PATH_PARAM_BYTES),
    );
    return { kind: "provider", providerId };
  }
  throw invalidRequest();
}

/**
 * Parse and validate the exact catalog-list query. Unknown/duplicate keys,
 * empty values, a bare `?`, malformed escapes and control characters fail
 * closed. The accepted shared request schema is the final authority.
 */
function parseCatalogQuery(url: string): CatalogQuery {
  const queryIndex = url.indexOf("?");
  if (queryIndex === -1) return { value: new Map() };
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
  const allowed = ["afterListingId", "limit", "kind", "providerId", "q"];
  const result = new Map<string, string>();
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    if (values.length !== 1) throw invalidRequest();
    if (!allowed.includes(key)) throw invalidRequest();
    const value = values[0];
    if (value === undefined || hasControlCharacter(value)) throw invalidRequest();
    result.set(key, value);
  }
  return { value: result };
}

function catalogListRequest(query: CatalogQuery): Record<string, unknown> {
  const request: Record<string, unknown> = {};
  const afterListingId = query.value.get("afterListingId");
  if (afterListingId !== undefined) {
    request["afterListingId"] = requireCanonical(
      CommerceListingIdSchema,
      afterListingId,
    );
  }
  const limit = query.value.get("limit");
  if (limit !== undefined) {
    if (!CANONICAL_LIMIT.test(limit)) throw invalidRequest();
    request["limit"] = Number(limit);
  }
  const kind = query.value.get("kind");
  if (kind !== undefined) {
    request["kind"] = requireCanonical(CommerceListingKindSchema, kind);
  }
  const providerId = query.value.get("providerId");
  if (providerId !== undefined) {
    request["providerId"] = requireCanonical(CommerceProviderIdSchema, providerId);
  }
  const q = query.value.get("q");
  if (q !== undefined) request["q"] = q;
  return request;
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
  options: MarketCatalogRoutesOptions,
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
  return reply
    .type("application/json; charset=utf-8")
    .header("Cache-Control", "no-store")
    .header("X-Content-Type-Options", "nosniff")
    .header("Referrer-Policy", "no-referrer")
    .send(serialized);
}

export function registerMarketCatalogRoutes(
  app: FastifyInstance,
  options: MarketCatalogRoutesOptions,
): void {
  if (options.enabled !== true) {
    // Default-off: register NOTHING, so a request keeps the framework's
    // ordinary 404 rather than a simulated disabled-route response.
    return;
  }
  if (options.service === undefined || options.service === null) {
    missingService();
  }
  const service = options.service as MarketCatalogService;

  const register = (
    template: string,
    allowQuery: boolean,
    expectedKind: ParsedCatalogPath["kind"],
    run: (
      parsed: ParsedCatalogPath,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<FastifyReply>,
  ): void => {
    app.all(
      template,
      {
        onRequest: async (request) => {
          enforceCatalogTransport(request, options, allowQuery);
          const parsed = parseCatalogPath(rawRequestUrl(request));
          if (parsed.kind !== expectedKind) throw invalidRequest();
        },
      },
      async (request, reply) => {
        const parsed = parseCatalogPath(rawRequestUrl(request));
        if (parsed.kind !== expectedKind) throw invalidRequest();
        return run(parsed, request, reply);
      },
    );
  };

  register(
    MARKET_CATALOG_ROUTES.listings,
    true,
    "listings",
    async (parsed, request, reply) => {
      void parsed;
      const query = parseCatalogQuery(rawRequestUrl(request));
      const requestInput = catalogListRequest(query);
      // The shared request schema is the final authority over the query shape.
      const data = await service.listPublicListings(requestInput);
      return sendEnvelope(
        request,
        reply,
        options,
        CommerceMarketPublicPageResponseSchema,
        data,
      );
    },
  );

  register(
    MARKET_CATALOG_ROUTES.listing,
    false,
    "listing",
    async (parsed, request, reply) => {
      const scoped = parsed as Extract<ParsedCatalogPath, { kind: "listing" }>;
      const requestInput = { listingId: scoped.listingId };
      const data = await service.getPublicListing(
        parseRequestOrThrow(CommerceMarketPublicDetailRequestSchema, requestInput)
          .listingId,
      );
      return sendEnvelope(
        request,
        reply,
        options,
        CommerceMarketPublicDetailResponseSchema,
        data,
      );
    },
  );

  register(
    MARKET_CATALOG_ROUTES.provider,
    false,
    "provider",
    async (parsed, request, reply) => {
      const scoped = parsed as Extract<ParsedCatalogPath, { kind: "provider" }>;
      const requestInput = { providerId: scoped.providerId };
      const data = await service.getPublicProvider(
        parseRequestOrThrow(
          CommerceMarketPublicProviderRequestSchema,
          requestInput,
        ).providerId,
      );
      return sendEnvelope(
        request,
        reply,
        options,
        CommerceMarketPublicProviderDetailResponseSchema,
        data,
      );
    },
  );
}

function parseRequestOrThrow<T>(schema: ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw invalidRequest();
  return parsed.data;
}

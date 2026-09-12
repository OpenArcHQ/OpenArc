import {
  API_CLIENT_HEADER,
  API_MAX_RESPONSE_BYTES,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceApiMetaSchema,
  CommerceListingIdSchema,
  CommerceListingVersionSchema,
  CommerceMarketMutationResultResponseSchema,
  CommerceMarketMutationStatusResponseSchema,
  CommerceMarketOwnerRootDetailResponseSchema,
  CommerceMarketOwnerVersionDetailResponseSchema,
  CommerceMarketProviderOptionsResponseSchema,
  CommerceOrganizationIdSchema,
  CommerceProviderIdSchema,
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
import type { MarketLifecycleService } from "./lifecycle-service.js";

/**
 * Exact protected marketplace lifecycle surface: six listing-management routes
 * plus three moderation routes. The six accepted draft market routes owned by
 * `registerMarketRoutes` are deliberately NOT registered here, so the two
 * modules mount together without a wildcard or duplicate-template collision.
 *
 * Transport reuses the reviewed draft-API conventions without editing them:
 * cookie-only human auth with the exact `browser-v1` marker, exact configured
 * Origin (a GET may omit Origin ONLY with `Sec-Fetch-Site: same-origin`), CSRF
 * plus one canonical 43-character base64url Idempotency-Key on POST, exact
 * `application/json` bounded to 16 KiB, a raw duplicate critical-header scan
 * including Cookie before framework normalization, decode-once canonical path
 * parameters, and query rejection except the provider-options cursor/limit.
 * No response can set a cookie and no CORS grant exists.
 */

const PROVIDER_PREFIX = "/v2/provider/organizations";
const MODERATOR_PREFIX = "/v2/moderator/organizations";

export const MARKET_LIFECYCLE_ROUTES = Object.freeze({
  ownerListing: `${PROVIDER_PREFIX}/:organizationId/listings/:listingId`,
  providerOptions: `${PROVIDER_PREFIX}/:organizationId/listing-providers`,
  publish: `${PROVIDER_PREFIX}/:organizationId/listings/:listingId/versions/:version/publish`,
  pause: `${PROVIDER_PREFIX}/:organizationId/listings/:listingId/versions/:version/pause`,
  retire: `${PROVIDER_PREFIX}/:organizationId/listings/:listingId/versions/:version/retire`,
  providerMutation: `${PROVIDER_PREFIX}/:organizationId/listing-lifecycle-mutations/:mutationId`,
  moderatorVersion: `${MODERATOR_PREFIX}/:organizationId/listings/:listingId/versions/:version`,
  moderatorOriginReview: `${MODERATOR_PREFIX}/:organizationId/listings/:listingId/versions/:version/origin-review`,
  moderatorMutation: `${MODERATOR_PREFIX}/:organizationId/listing-lifecycle-mutations/:mutationId`,
} as const);

const MAX_REQUEST_URL_BYTES = 2048;
const MAX_PATH_PARAM_BYTES = 512;
const MAX_WRITE_BODY_BYTES = 16 * 1024;

/**
 * Critical security headers whose wire occurrence count must be at most one.
 * `request.raw.rawHeaders` is authoritative because Node may collapse some
 * duplicates (notably Cookie and Content-Type) in the normalized map.
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

export interface MarketLifecycleRoutesOptions {
  listingManagementEnabled: boolean;
  moderationEnabled: boolean;
  appOrigin: string;
  cookieNames: AuthCookieNames;
  service?: MarketLifecycleService;
  buildSha: string;
  maxResponseBytes?: number;
}

type Family = "provider" | "moderator";

type ParsedLifecyclePath =
  | { readonly kind: "ownerListing"; readonly organizationId: string; readonly listingId: string }
  | { readonly kind: "providerOptions"; readonly organizationId: string }
  | {
      readonly kind: "providerTransition";
      readonly organizationId: string;
      readonly listingId: string;
      readonly version: string;
      readonly operation: "publish" | "pause" | "retire";
    }
  | { readonly kind: "providerMutation"; readonly organizationId: string; readonly mutationId: string }
  | {
      readonly kind: "moderatorVersion";
      readonly organizationId: string;
      readonly listingId: string;
      readonly version: string;
    }
  | {
      readonly kind: "moderatorOriginReview";
      readonly organizationId: string;
      readonly listingId: string;
      readonly version: string;
    }
  | { readonly kind: "moderatorMutation"; readonly organizationId: string; readonly mutationId: string };

interface LifecycleQuery {
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
  // Fixed startup error: never interpolates flags, origins or caller data.
  throw new Error("MARKET_LIFECYCLE_SERVICE_REQUIRED");
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

/**
 * True when an exact request target is unacceptable for a query-free route:
 * over the URL byte bound or carrying ANY query, including a bare `?`.
 */
export function isForbiddenLifecycleRequestTarget(url: string): boolean {
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
    if (!CRITICAL_HEADER_NAMES.has(lower)) continue;
    if (seen.has(lower)) throw invalidRequest();
    seen.add(lower);
  }
}

function requireCanonical<T>(schema: ZodType<T>, value: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidRequest();
  return parsed.data;
}

/**
 * Exact decode-once matcher for the nine frozen lifecycle path shapes. Every
 * segment is bound/control/escape checked, decoded exactly once, and validated
 * against the accepted canonical id schema. Unknown keywords, extra segments
 * and separators fail closed.
 */
function parseLifecyclePath(rawUrl: string, family: Family): ParsedLifecyclePath {
  if (Buffer.byteLength(rawUrl, "utf8") > MAX_REQUEST_URL_BYTES) {
    throw invalidRequest();
  }
  if (hasControlCharacter(rawUrl)) throw invalidRequest();
  const queryIndex = rawUrl.indexOf("?");
  const path = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
  const prefix = family === "provider" ? PROVIDER_PREFIX : MODERATOR_PREFIX;
  if (!path.startsWith(`${prefix}/`)) throw invalidRequest();
  const segments = path.slice(prefix.length + 1).split("/");
  for (const segment of segments) {
    if (segment.length === 0) throw invalidRequest();
  }
  const organizationId = requireCanonical(
    CommerceOrganizationIdSchema,
    decodePathSegment(segments[0] as string, MAX_PATH_PARAM_BYTES),
  );
  const second = segments[1];
  if (family === "provider") {
    if (second === "listing-providers") {
      if (segments.length !== 2) throw invalidRequest();
      return { kind: "providerOptions", organizationId };
    }
    if (second === "listing-lifecycle-mutations") {
      if (segments.length !== 3) throw invalidRequest();
      const mutationId = requireCanonical(
        CommerceTenantMutationIdSchema,
        decodePathSegment(segments[2] as string, MAX_PATH_PARAM_BYTES),
      );
      return { kind: "providerMutation", organizationId, mutationId };
    }
    if (second === "listings") {
      if (segments.length === 3) {
        const listingId = requireCanonical(
          CommerceListingIdSchema,
          decodePathSegment(segments[2] as string, MAX_PATH_PARAM_BYTES),
        );
        return { kind: "ownerListing", organizationId, listingId };
      }
      if (segments.length === 6 && segments[3] === "versions") {
        const listingId = requireCanonical(
          CommerceListingIdSchema,
          decodePathSegment(segments[2] as string, MAX_PATH_PARAM_BYTES),
        );
        const version = requireCanonical(
          CommerceListingVersionSchema,
          decodePathSegment(segments[4] as string, MAX_PATH_PARAM_BYTES),
        );
        const operation = segments[5];
        if (operation !== "publish" && operation !== "pause" && operation !== "retire") {
          throw invalidRequest();
        }
        return { kind: "providerTransition", organizationId, listingId, version, operation };
      }
      throw invalidRequest();
    }
    throw invalidRequest();
  }
  if (second === "listing-lifecycle-mutations") {
    if (segments.length !== 3) throw invalidRequest();
    const mutationId = requireCanonical(
      CommerceTenantMutationIdSchema,
      decodePathSegment(segments[2] as string, MAX_PATH_PARAM_BYTES),
    );
    return { kind: "moderatorMutation", organizationId, mutationId };
  }
  if (second === "listings" && segments[3] === "versions") {
    const listingId = requireCanonical(
      CommerceListingIdSchema,
      decodePathSegment(segments[2] as string, MAX_PATH_PARAM_BYTES),
    );
    const version = requireCanonical(
      CommerceListingVersionSchema,
      decodePathSegment(segments[4] as string, MAX_PATH_PARAM_BYTES),
    );
    if (segments.length === 5) {
      return { kind: "moderatorVersion", organizationId, listingId, version };
    }
    if (segments.length === 6 && segments[5] === "origin-review") {
      return { kind: "moderatorOriginReview", organizationId, listingId, version };
    }
    throw invalidRequest();
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
  options: MarketLifecycleRoutesOptions,
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

function enforceLifecycleTransport(
  request: FastifyRequest,
  options: MarketLifecycleRoutesOptions,
  mode: "read" | "write",
  allowQuery: boolean,
): void {
  enforceNoDuplicateCriticalHeaders(request);
  const url = rawRequestUrl(request);
  if (Buffer.byteLength(url, "utf8") > MAX_REQUEST_URL_BYTES) throw invalidRequest();
  if (request.method !== (mode === "read" ? "GET" : "POST")) {
    throw methodNotAllowed();
  }
  if (strictHeader(request.headers, "authorization") !== undefined) {
    throw invalidRequest();
  }
  if (strictHeader(request.headers, "proxy-authorization") !== undefined) {
    throw invalidRequest();
  }
  if (strictHeader(request.headers, "x-openarc-client") !== API_CLIENT_HEADER) {
    throw originRejected();
  }
  if (mode === "read") {
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
    if (!allowQuery && isForbiddenLifecycleRequestTarget(url)) throw invalidRequest();
    return;
  }
  enforceFetchMetadata(request, options, false);
  if (isForbiddenLifecycleRequestTarget(url)) throw invalidRequest();
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
  if (contentLength !== undefined) {
    if (
      typeof contentLength !== "string" ||
      !/^(?:0|[1-9][0-9]*)$/u.test(contentLength)
    ) {
      throw invalidRequest();
    }
    if (Number.parseInt(contentLength, 10) > MAX_WRITE_BODY_BYTES) {
      throw AUTH_ERRORS.tooLarge();
    }
  }
  const idempotency = strictHeader(request.headers, "idempotency-key");
  if (
    typeof idempotency !== "string" ||
    !CommerceTenantIdempotencyKeySchema.safeParse(idempotency).success
  ) {
    throw invalidRequest();
  }
}

const CANONICAL_OPTIONS_LIMIT = /^(?:[1-9]|[1-4][0-9]|50)$/u;
const ENCODED_CHARACTER = /^(?:[^%\s]|%[0-9A-Fa-f]{2})*$/u;

/**
 * Parse a bounded raw query string for the provider-options route only.
 * Invalid percent-encoding, empty keys/values, duplicate keys, unknown keys,
 * a bare `?` and control characters all fail closed.
 */
function parseLifecycleQuery(url: string): LifecycleQuery {
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
  const result = new Map<string, string>();
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    if (values.length !== 1) throw invalidRequest();
    if (key !== "afterProviderId" && key !== "limit") throw invalidRequest();
    const value = values[0];
    if (value === undefined || hasControlCharacter(value)) throw invalidRequest();
    result.set(key, value);
  }
  return { value: result };
}

function parseOptionsLimit(query: LifecycleQuery): number | undefined {
  const raw = query.value.get("limit");
  if (raw === undefined) return undefined;
  if (!CANONICAL_OPTIONS_LIMIT.test(raw)) throw invalidRequest();
  return Number(raw);
}

function parseOptionsCursor(query: LifecycleQuery): string | undefined {
  const raw = query.value.get("afterProviderId");
  if (raw === undefined) return undefined;
  return requireCanonical(CommerceProviderIdSchema, raw);
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
  options: MarketLifecycleRoutesOptions,
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

export function registerMarketLifecycleRoutes(
  app: FastifyInstance,
  options: MarketLifecycleRoutesOptions,
): void {
  const providerEnabled = options.listingManagementEnabled === true;
  const moderatorEnabled = options.moderationEnabled === true;
  if (
    (providerEnabled || moderatorEnabled) &&
    (options.service === undefined || options.service === null)
  ) {
    missingService();
  }
  const service = options.service as MarketLifecycleService;

  const register = (
    family: Family,
    template: string,
    mode: "read" | "write",
    allowQuery: boolean,
    expectedKind: ParsedLifecyclePath["kind"],
    run: (
      parsed: ParsedLifecyclePath,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<FastifyReply>,
  ): void => {
    app.all(
      template,
      {
        onRequest: async (request) => {
          enforceLifecycleTransport(request, options, mode, allowQuery);
          const parsed = parseLifecyclePath(rawRequestUrl(request), family);
          if (parsed.kind !== expectedKind) throw invalidRequest();
        },
      },
      async (request, reply) => {
        const parsed = parseLifecyclePath(rawRequestUrl(request), family);
        if (parsed.kind !== expectedKind) throw invalidRequest();
        return run(parsed, request, reply);
      },
    );
  };

  const envelope = (
    request: FastifyRequest,
    reply: FastifyReply,
    schema: Parameters<typeof sendEnvelope>[3],
    data: unknown,
  ): FastifyReply => sendEnvelope(request, reply, options, schema, data);

  if (providerEnabled) {
    register(
      "provider",
      MARKET_LIFECYCLE_ROUTES.ownerListing,
      "read",
      false,
      "ownerListing",
      async (parsed, request, reply) => {
        const scoped = parsed as Extract<ParsedLifecyclePath, { kind: "ownerListing" }>;
        const data = await service.getOwnerListing(
          requestContext(request, options.cookieNames),
          { organizationId: scoped.organizationId, listingId: scoped.listingId },
        );
        return envelope(
          request,
          reply,
          CommerceMarketOwnerRootDetailResponseSchema,
          data,
        );
      },
    );

    register(
      "provider",
      MARKET_LIFECYCLE_ROUTES.providerOptions,
      "read",
      true,
      "providerOptions",
      async (parsed, request, reply) => {
        const scoped = parsed as Extract<ParsedLifecyclePath, { kind: "providerOptions" }>;
        const query = parseLifecycleQuery(rawRequestUrl(request));
        const afterProviderId = parseOptionsCursor(query);
        const limit = parseOptionsLimit(query);
        const data = await service.listMarketProviders(
          requestContext(request, options.cookieNames),
          {
            organizationId: scoped.organizationId,
            ...(afterProviderId !== undefined ? { afterProviderId } : {}),
            ...(limit !== undefined ? { limit } : {}),
          },
        );
        return envelope(
          request,
          reply,
          CommerceMarketProviderOptionsResponseSchema,
          data,
        );
      },
    );

    const registerTransition = (
      template: string,
      operation: "publish" | "pause" | "retire",
    ): void => {
      register(
        "provider",
        template,
        "write",
        false,
        "providerTransition",
        async (parsed, request, reply) => {
          const scoped = parsed as Extract<
            ParsedLifecyclePath,
            { kind: "providerTransition" }
          >;
          const write = {
            ctx: requestContext(request, options.cookieNames),
            csrf: strictHeader(request.headers, "x-openarc-csrf"),
            idempotencyKey: strictHeader(request.headers, "idempotency-key"),
            body: request.body,
          };
          const data =
            operation === "publish"
              ? await service.publishListingVersion(
                  write.ctx,
                  scoped.organizationId,
                  scoped.listingId,
                  scoped.version,
                  write,
                )
              : operation === "pause"
                ? await service.pauseListingVersion(
                    write.ctx,
                    scoped.organizationId,
                    scoped.listingId,
                    scoped.version,
                    write,
                  )
                : await service.retireListingVersion(
                    write.ctx,
                    scoped.organizationId,
                    scoped.listingId,
                    scoped.version,
                    write,
                  );
          return envelope(
            request,
            reply,
            CommerceMarketMutationResultResponseSchema,
            data,
          );
        },
      );
    };

    registerTransition(MARKET_LIFECYCLE_ROUTES.publish, "publish");
    registerTransition(MARKET_LIFECYCLE_ROUTES.pause, "pause");
    registerTransition(MARKET_LIFECYCLE_ROUTES.retire, "retire");

    register(
      "provider",
      MARKET_LIFECYCLE_ROUTES.providerMutation,
      "read",
      false,
      "providerMutation",
      async (parsed, request, reply) => {
        const scoped = parsed as Extract<
          ParsedLifecyclePath,
          { kind: "providerMutation" }
        >;
        const data = await service.getLifecycleMutationStatus(
          requestContext(request, options.cookieNames),
          { organizationId: scoped.organizationId, mutationId: scoped.mutationId },
        );
        return envelope(
          request,
          reply,
          CommerceMarketMutationStatusResponseSchema,
          data,
        );
      },
    );
  }

  if (moderatorEnabled) {
    register(
      "moderator",
      MARKET_LIFECYCLE_ROUTES.moderatorVersion,
      "read",
      false,
      "moderatorVersion",
      async (parsed, request, reply) => {
        const scoped = parsed as Extract<
          ParsedLifecyclePath,
          { kind: "moderatorVersion" }
        >;
        const data = await service.getModeratorListingVersion(
          requestContext(request, options.cookieNames),
          {
            organizationId: scoped.organizationId,
            listingId: scoped.listingId,
            version: scoped.version,
          },
        );
        return envelope(
          request,
          reply,
          CommerceMarketOwnerVersionDetailResponseSchema,
          data,
        );
      },
    );

    register(
      "moderator",
      MARKET_LIFECYCLE_ROUTES.moderatorOriginReview,
      "write",
      false,
      "moderatorOriginReview",
      async (parsed, request, reply) => {
        const scoped = parsed as Extract<
          ParsedLifecyclePath,
          { kind: "moderatorOriginReview" }
        >;
        const write = {
          ctx: requestContext(request, options.cookieNames),
          csrf: strictHeader(request.headers, "x-openarc-csrf"),
          idempotencyKey: strictHeader(request.headers, "idempotency-key"),
          body: request.body,
        };
        const data = await service.recordOriginReview(
          write.ctx,
          scoped.organizationId,
          scoped.listingId,
          scoped.version,
          write,
        );
        return envelope(
          request,
          reply,
          CommerceMarketMutationResultResponseSchema,
          data,
        );
      },
    );

    register(
      "moderator",
      MARKET_LIFECYCLE_ROUTES.moderatorMutation,
      "read",
      false,
      "moderatorMutation",
      async (parsed, request, reply) => {
        const scoped = parsed as Extract<
          ParsedLifecyclePath,
          { kind: "moderatorMutation" }
        >;
        const data = await service.getLifecycleMutationStatus(
          requestContext(request, options.cookieNames),
          { organizationId: scoped.organizationId, mutationId: scoped.mutationId },
        );
        return envelope(
          request,
          reply,
          CommerceMarketMutationStatusResponseSchema,
          data,
        );
      },
    );
  }
}

import {
  API_MAX_RESPONSE_BYTES,
  COMMERCE_API_SCHEMA_VERSION,
  CommerceApiMetaSchema,
  CommerceMachineEmptyBodySchema,
  CommerceMachineSessionExchangeResponseSchema,
  CommerceMachineSessionRevokeResponseSchema,
  CommerceMachineSessionSelfResponseSchema,
  type CommerceApiMeta,
} from "@openarc/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";

import { AUTH_ERRORS, AuthApiError } from "../auth/errors.js";
import type { MachineSessionService } from "./session-service.js";
import type { MachineCredentialKind } from "./credential-crypto.js";

/**
 * Strict machine-to-machine session surface.
 *
 * These routes are NOT browser endpoints: no Cookie, Origin, browser marker,
 * CSRF, idempotency or Fetch-metadata header is accepted, no CORS grant is
 * emitted, and exactly ONE `Authorization: Bearer <token>` is required.
 * Exchange sends the long-lived typed credential; self/revoke send the short
 * session token. Bodies are the exact empty JSON object `{}` and no route
 * accepts a query. Raw duplicate critical headers are rejected before body
 * parsing, and every failure is the fixed v2 envelope with no raw URL echo.
 */

export const MACHINE_SESSION_ROUTES = Object.freeze({
  agentExchange: "/v1/agent/sessions",
  providerExchange: "/v1/provider/sessions",
  agentSelf: "/v1/agent/self",
  providerSelf: "/v1/provider/self",
  agentRevoke: "/v1/agent/sessions/current/revoke",
  providerRevoke: "/v1/provider/sessions/current/revoke",
} as const);

const SESSION_ROUTES: readonly {
  readonly path: string;
  readonly kind: MachineCredentialKind;
  readonly action: "exchange" | "self" | "revoke";
}[] = [
  { path: MACHINE_SESSION_ROUTES.agentExchange, kind: "agent", action: "exchange" },
  { path: MACHINE_SESSION_ROUTES.providerExchange, kind: "provider", action: "exchange" },
  { path: MACHINE_SESSION_ROUTES.agentSelf, kind: "agent", action: "self" },
  { path: MACHINE_SESSION_ROUTES.providerSelf, kind: "provider", action: "self" },
  { path: MACHINE_SESSION_ROUTES.agentRevoke, kind: "agent", action: "revoke" },
  { path: MACHINE_SESSION_ROUTES.providerRevoke, kind: "provider", action: "revoke" },
];

const MAX_REQUEST_URL_BYTES = 2048;

/**
 * Session-critical headers whose wire occurrence count must be at most one.
 * Node collapses some duplicates in `request.headers`, so the flat raw header
 * list is authoritative and counted before parsing.
 */
const SESSION_FORBIDDEN_HEADERS: readonly string[] = [
  "cookie",
  "origin",
  "x-openarc-client",
  "x-openarc-csrf",
  "sec-fetch-site",
  "sec-fetch-mode",
  "sec-fetch-dest",
  "sec-fetch-user",
  "idempotency-key",
];

const SESSION_CRITICAL_HEADERS: ReadonlySet<string> = new Set([
  "authorization",
  "content-type",
  "content-length",
  "transfer-encoding",
  ...SESSION_FORBIDDEN_HEADERS,
]);

export interface MachineSessionRoutesOptions {
  service: MachineSessionService;
  buildSha: string;
  enabled: boolean;
  maxResponseBytes?: number;
}

function invalidRequest(): AuthApiError {
  return AUTH_ERRORS.invalidRequest();
}

function methodNotAllowed(): AuthApiError {
  return new AuthApiError("INVALID_REQUEST", 405, "METHOD_NOT_ALLOWED");
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
    if (!SESSION_CRITICAL_HEADERS.has(lower)) continue;
    if (seen.has(lower)) throw invalidRequest();
    seen.add(lower);
  }
}

function rawRequestUrl(request: FastifyRequest): string {
  const raw = request.raw.url;
  return typeof raw === "string" && raw.length > 0 ? raw : request.url;
}

export function isMachineSessionFamilyPath(path: string): boolean {
  return (
    path === "/v1/agent" ||
    path.startsWith("/v1/agent/") ||
    path === "/v1/provider" ||
    path.startsWith("/v1/provider/")
  );
}

/**
 * True when an exact machine-session request target is unacceptable: over the
 * URL byte bound or carrying ANY query, including a bare empty `?`. Exported so
 * the bare-`?` rule can be asserted on a real request target.
 */
export function isForbiddenSessionRequestTarget(url: string): boolean {
  return Buffer.byteLength(url, "utf8") > MAX_REQUEST_URL_BYTES || url.includes("?");
}

function bearerToken(request: FastifyRequest): string {
  const authorization = strictHeader(request.headers, "authorization");
  if (typeof authorization !== "string") throw invalidRequest();
  const match = /^Bearer ([A-Za-z0-9_-]{1,1024})$/u.exec(authorization);
  if (match === null) throw invalidRequest();
  return match[1] as string;
}

function enforceNoBrowserHeaders(request: FastifyRequest): void {
  for (const name of SESSION_FORBIDDEN_HEADERS) {
    if (strictHeader(request.headers, name) !== undefined) throw invalidRequest();
  }
}

function enforceMachineTransport(
  request: FastifyRequest,
  action: "exchange" | "self" | "revoke",
): string {
  enforceNoDuplicateCriticalHeaders(request);
  const url = rawRequestUrl(request);
  if (isForbiddenSessionRequestTarget(url)) throw invalidRequest();
  enforceNoBrowserHeaders(request);
  const token = bearerToken(request);
  if (request.method !== (action === "self" ? "GET" : "POST")) {
    throw methodNotAllowed();
  }
  if (strictHeader(request.headers, "transfer-encoding") !== undefined) {
    throw invalidRequest();
  }
  const contentLength = strictHeader(request.headers, "content-length");
  if (action === "self") {
    if (contentLength !== undefined && contentLength !== "0") throw invalidRequest();
    return token;
  }
  return token;
}

/**
 * Media and exact-empty-body checks run in the HANDLER, after Fastify has
 * parsed the body. An `onRequest` hook would observe `request.body` as
 * undefined and incorrectly reject every valid write.
 */
function enforceMachineBody(
  request: FastifyRequest,
  action: "exchange" | "self" | "revoke",
): void {
  if (action === "self") return;
  const contentLength = strictHeader(request.headers, "content-length");
  const contentType = strictHeader(request.headers, "content-type");
  if (
    typeof contentType !== "string" ||
    !/^application\/json(?:; *charset=utf-8)?$/iu.test(contentType)
  ) {
    throw AUTH_ERRORS.unsupportedMedia();
  }
  if (
    contentLength !== undefined &&
    (typeof contentLength !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(contentLength))
  ) {
    throw invalidRequest();
  }
  const body = CommerceMachineEmptyBodySchema.safeParse(request.body);
  if (!body.success) throw invalidRequest();
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
  options: MachineSessionRoutesOptions,
  schema: ZodType<{ ok: true; data: T; meta: CommerceApiMeta }>,
  data: T,
): FastifyReply {
  const envelope = schema.parse({ ok: true, data, meta: meta(request, options.buildSha) });
  const serialized = JSON.stringify(envelope);
  const limit = options.maxResponseBytes ?? API_MAX_RESPONSE_BYTES;
  if (Buffer.byteLength(serialized, "utf8") > limit) throw AUTH_ERRORS.internal();
  return reply.type("application/json; charset=utf-8").send(serialized);
}

export function registerMachineSessionRoutes(
  app: FastifyInstance,
  options: MachineSessionRoutesOptions,
): void {
  if (!options.enabled) {
    for (const route of SESSION_ROUTES) {
      app.all(
        route.path,
        { onRequest: async () => { throw AUTH_ERRORS.featureDisabled(); } },
        async () => undefined,
      );
    }
    return;
  }

  for (const route of SESSION_ROUTES) {
    app.all(
      route.path,
      {
        onRequest: async (request) => {
          enforceMachineTransport(request, route.action);
        },
      },
      async (request, reply) => {
        const token = bearerToken(request);
        enforceMachineBody(request, route.action);
        if (route.action === "exchange") {
          const data = await options.service.exchange(route.kind, {
            token,
            peerIp: request.ip,
          });
          return sendEnvelope(
            request,
            reply,
            options,
            CommerceMachineSessionExchangeResponseSchema,
            data,
          );
        }
        if (route.action === "self") {
          const data = await options.service.self(route.kind, {
            token,
            peerIp: request.ip,
          });
          return sendEnvelope(
            request,
            reply,
            options,
            CommerceMachineSessionSelfResponseSchema,
            data,
          );
        }
        const data = await options.service.revoke(route.kind, {
          token,
          peerIp: request.ip,
        });
        return sendEnvelope(
          request,
          reply,
          options,
          CommerceMachineSessionRevokeResponseSchema,
          data,
        );
      },
    );
  }
}

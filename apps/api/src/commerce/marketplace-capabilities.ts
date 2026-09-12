import {
  API_CLIENT_HEADER,
  API_MAX_RESPONSE_BYTES,
  COMMERCE_API_SCHEMA_VERSION,
  MARKETPLACE_CAPABILITIES_PATH,
  CommerceApiMetaSchema,
  MarketplaceCapabilitiesSuccessEnvelopeSchema,
  buildMarketplaceCapabilityManifest,
  type MarketplaceCapabilityBuilderInput,
  type MarketplaceCapabilityManifest,
} from "@openarc/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { AUTH_ERRORS, AuthApiError } from "../auth/errors.js";

/**
 * Public, credentialless marketplace capability metadata surface.
 *
 * `GET /v2/public/marketplace-capabilities` publishes the accepted shared
 * three-family marketplace manifest and the exact frozen 18-entry route
 * registry. It always registers: with every flag off it returns the accepted
 * manifest whose three families are all `built_disabled`, and it performs ZERO
 * database or readiness-callback calls. Availability is NOT authorization: the
 * manifest grants no role and exposes no live handler by itself.
 *
 * Only the three own family flags and the AUTH/TENANT_READS gating flags cross
 * this boundary, never a full config spread, secret, DB URL or identity. The
 * transport is metadata ONLY: no cookie, Authorization, CSRF, idempotency key,
 * body, query or CORS grant is accepted, and the route can never mint a cookie.
 * It performs no automatic network/provider/RPC request.
 *
 * Readiness is joined from at most ONE bounded, app-wide in-flight batch of the
 * read-only callback probes that the ENABLED families actually require.
 * Concurrent requests share that batch; when it settles the reference is
 * cleared so a later request re-checks. A response deadline (2s total,
 * parallel) fails closed for still-unresolved dependencies without demoting a
 * dependency that already settled to `true` independently, and without
 * starting a second overlapping batch. The response result is snapshotted at
 * the deadline so late settlement cannot mutate an already-returned response.
 * There is no success cache, no principal/auth cache and no background timer.
 */

export const MARKETPLACE_CAPABILITIES_ROUTE = MARKETPLACE_CAPABILITIES_PATH;

const MAX_REQUEST_URL_BYTES = 2048;
const READINESS_DEADLINE_MS = 2000;

/** Exactly the public transport-critical header names counted on the wire. */
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

/**
 * Optional single browser marker: absent or exactly `browser-v1`. Every other
 * client-metadata name is rejected; no other client metadata is inspected.
 */
const ALLOWED_CLIENT_HEADER_NAMES: ReadonlySet<string> = new Set([
  "x-openarc-client",
]);

/**
 * Untrusted, informational proxy metadata inserted by a SECOND edge (Railway)
 * after nginx has already stripped the incoming transport headers. These are
 * not authoritative for anything: they are ignored, never trusted, persisted,
 * echoed, logged, used as requestId/principal/client identity, involved in
 * routing/origin checks or readiness, and their contents are deliberately not
 * validated because they have no semantics on this route. Existing server
 * limits bound the total header count. The exact six documented Railway names
 * plus the two standard proxy metadata names are allowed; there is NO wildcard
 * `x-railway`/`x-forwarded` allowance and no debug-header special treatment.
 */
const IGNORED_TRANSPORT_HEADERS: ReadonlySet<string> = new Set([
  // Documented Railway second-edge request headers.
  "x-real-ip",
  "x-forwarded-proto",
  "x-forwarded-host",
  "x-railway-edge",
  "x-request-start",
  "x-railway-request-id",
  // Standard opaque proxy metadata, not authorization.
  "x-forwarded-for",
  "forwarded",
]);

/** The explicit flags app.ts may pass. Never the full config object. */
export interface MarketplaceCapabilityFlags {
  readonly authEnabled: boolean;
  readonly tenantReadsEnabled: boolean;
  readonly marketCatalogEnabled: boolean;
  readonly listingManagementEnabled: boolean;
  readonly marketModerationEnabled: boolean;
}

/** Existing readiness callbacks, unchanged. Each may be absent. */
export interface MarketplaceCapabilityReadiness {
  readonly authReady?: () => Promise<boolean>;
  readonly tenantReady?: () => Promise<boolean>;
  readonly marketReady?: () => Promise<boolean>;
}

export interface RegisterMarketplaceCapabilitiesOptions {
  readonly flags: MarketplaceCapabilityFlags;
  readonly readiness: MarketplaceCapabilityReadiness;
  readonly buildSha: string;
  readonly appOrigin: string;
  readonly maxResponseBytes?: number;
}

type ReadinessKey = "authReady" | "tenantReady" | "marketReady";

type DependencyKey = "authReady" | "tenantDatabaseReady" | "marketDatabaseReady";

interface ReadinessBatch {
  readonly promise: Promise<ReadinessResult>;
  /**
   * The in-progress result object. Only this batch's own callback settlement
   * mutates it, so the frozen deadline snapshot stays a stable copy even if
   * settlement lands later.
   */
  readonly result: MutableReadinessResult;
}

interface ReadinessResult {
  readonly authReady: boolean;
  readonly tenantDatabaseReady: boolean;
  readonly marketDatabaseReady: boolean;
}

type MutableReadinessResult = {
  -readonly [K in keyof ReadinessResult]: ReadinessResult[K];
};

function unready(): MutableReadinessResult {
  return {
    authReady: false,
    tenantDatabaseReady: false,
    marketDatabaseReady: false,
  };
}

/** Frozen copy so a deadline snapshot cannot be mutated by late settlement. */
function snapshot(result: ReadinessResult): ReadinessResult {
  return Object.freeze({
    authReady: result.authReady === true,
    tenantDatabaseReady: result.tenantDatabaseReady === true,
    marketDatabaseReady: result.marketDatabaseReady === true,
  });
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
    if (!PUBLIC_CRITICAL_HEADERS.has(lower)) continue;
    if (seen.has(lower)) throw invalidRequest();
    seen.add(lower);
  }
}

/**
 * Reject any header that is neither a fixed transport/negotiation header nor
 * the single optional browser marker. This is an allowlist, so arbitrary
 * client metadata (cookies, credentials, CSRF, idempotency, unknown client
 * headers) fails closed. Duplicate wire occurrences of critical names are
 * already rejected before this normalized check.
 *
 * `IGNORED_TRANSPORT_HEADERS` is the ONLY relaxation: it admits the untrusted
 * informational metadata that a second proxy edge may append. Authoritative
 * security inputs remain Origin, Fetch-Site and the credential/CSRF/
 * idempotency headers, which are still enforced below regardless of any proxy
 * metadata present.
 */
function enforceAllowedHeaders(request: FastifyRequest): void {
  for (const name of Object.keys(request.headers)) {
    if (ALLOWED_CLIENT_HEADER_NAMES.has(name)) continue;
    if (PUBLIC_CRITICAL_HEADERS.has(name)) continue;
    if (IGNORED_TRANSPORT_HEADERS.has(name)) continue;
    if (name === "host" || name === "accept" || name === "accept-encoding" ||
      name === "accept-language" || name === "user-agent" || name === "connection" ||
      name === "sec-fetch-site" ||
      name === "sec-fetch-mode" || name === "sec-fetch-dest") continue;
    throw invalidRequest();
  }
}

function enforceTransport(request: FastifyRequest, appOrigin: string): void {
  enforceNoDuplicateCriticalHeaders(request);
  const url = rawRequestUrl(request);
  if (Buffer.byteLength(url, "utf8") > MAX_REQUEST_URL_BYTES) throw invalidRequest();
  if (url.includes("?")) throw invalidRequest();
  if (request.method !== "GET") throw methodNotAllowed();
  enforceAllowedHeaders(request);

  // Credential and anti-forgery headers are never accepted on this public,
  // credentialless surface, even though Node may have collapsed a duplicate.
  for (const name of ["cookie", "authorization", "proxy-authorization",
    "x-openarc-csrf", "idempotency-key"]) {
    if (strictHeader(request.headers, name) !== undefined) throw invalidRequest();
  }

  const client = strictHeader(request.headers, "x-openarc-client");
  if (client !== undefined && client !== API_CLIENT_HEADER) throw invalidRequest();
  const origin = strictHeader(request.headers, "origin");
  const site = strictHeader(request.headers, "sec-fetch-site");
  if (origin !== undefined && origin !== appOrigin) throw originRejected();
  if (site !== undefined && site !== "same-origin") throw originRejected();

  const contentLength = strictHeader(request.headers, "content-length");
  if (contentLength !== undefined && contentLength !== "0") throw invalidRequest();
  if (strictHeader(request.headers, "transfer-encoding") !== undefined) {
    throw invalidRequest();
  }
}

function meta(request: FastifyRequest, buildSha: string) {
  return CommerceApiMetaSchema.parse({
    schemaVersion: COMMERCE_API_SCHEMA_VERSION,
    requestId: request.id,
    buildSha,
  });
}

function sendEnvelope(
  request: FastifyRequest,
  reply: FastifyReply,
  buildSha: string,
  manifest: MarketplaceCapabilityManifest,
  maxResponseBytes: number,
): FastifyReply {
  const envelope = MarketplaceCapabilitiesSuccessEnvelopeSchema.parse({
    ok: true,
    data: manifest,
    meta: meta(request, buildSha),
  });
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized, "utf8") > maxResponseBytes) {
    throw AUTH_ERRORS.internal();
  }
  return reply.type("application/json; charset=utf-8").send(serialized);
}

/**
 * Which readiness dependency each callback satisfies. Only readiness for a
 * dependency an ENABLED (and gate-satisfied) family actually requires is
 * invoked; at most once each per request. A missing callback contributes
 * `false` without invoking anything.
 */
function requiredDependencies(
  flags: MarketplaceCapabilityFlags,
): Record<DependencyKey, boolean> {
  const protectedFamily =
    flags.listingManagementEnabled || flags.marketModerationEnabled;
  return {
    authReady: flags.authEnabled && protectedFamily,
    tenantDatabaseReady:
      flags.tenantReadsEnabled && flags.listingManagementEnabled,
    marketDatabaseReady:
      flags.marketCatalogEnabled ||
      flags.listingManagementEnabled ||
      flags.marketModerationEnabled,
  };
}

const CALLBACK_DEPENDENCY: Readonly<Record<ReadinessKey, DependencyKey>> =
  Object.freeze({
    authReady: "authReady",
    tenantReady: "tenantDatabaseReady",
    marketReady: "marketDatabaseReady",
  });

/** Only the callbacks whose dependency is actually required are invoked. */
function readinessCallbacksNeeded(
  flags: MarketplaceCapabilityFlags,
): ReadinessKey[] {
  const required = requiredDependencies(flags);
  const keys: ReadinessKey[] = [];
  if (required.authReady) keys.push("authReady");
  if (required.tenantDatabaseReady) keys.push("tenantReady");
  if (required.marketDatabaseReady) keys.push("marketReady");
  return keys;
}

export function registerMarketplaceCapabilities(
  app: FastifyInstance,
  options: RegisterMarketplaceCapabilitiesOptions,
): void {
  const { flags, readiness, appOrigin } = options;
  const maxResponseBytes = options.maxResponseBytes ?? API_MAX_RESPONSE_BYTES;
  const callbacksNeeded = readinessCallbacksNeeded(flags);
  const required = requiredDependencies(flags);

  // App-wide single in-flight batch holder. Never accumulates, never queues.
  let inflight: ReadinessBatch | null = null;

  /**
   * One batch owns one mutable `result`. Each dependency writes its own
   * settled value as soon as it settles, so a deadline snapshot preserves
   * independently ready auth/tenant values while an unresolved market
   * dependency stays `false` and cannot demote them.
   */
  const startBatch = (): ReadinessBatch => {
    const result = unready();
    const work: Array<Promise<void>> = [];

    for (const key of callbacksNeeded) {
      const dependency = CALLBACK_DEPENDENCY[key];
      if (required[dependency] !== true) continue;
      const callback = readiness[key];
      if (callback === undefined) continue;
      work.push(
        Promise.resolve()
          .then(() => callback())
          .then((ready) => {
            result[dependency] = ready === true;
          })
          .catch(() => {
            result[dependency] = false;
          }),
      );
    }

    const promise: Promise<ReadinessResult> = Promise.all(work).then(() =>
      snapshot(result),
    );
    return { promise, result };
  };

  /**
   * Returns the single app-wide in-flight batch, creating one only when none
   * is active. Concurrent requests join the same batch; once it actually
   * settles its own reference is cleared so a later request re-checks.
   */
  const joinBatch = (): ReadinessBatch => {
    if (inflight !== null) return inflight;
    const batch = startBatch();
    inflight = batch;
    // Clear only this batch's own reference on settlement.
    void batch.promise.finally(() => {
      if (inflight === batch) {
        inflight = null;
      }
    });
    return batch;
  };

  const boundedReadiness = async (): Promise<ReadinessResult> => {
    if (callbacksNeeded.length === 0) return snapshot(unready());
    const batch = joinBatch();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<ReadinessResult>((resolve) => {
      timer = setTimeout(
        // Snapshot at the deadline: dependencies that settled independently
        // are preserved, while still-unresolved ones remain `false` and fail
        // closed. The copy is frozen so late settlement cannot mutate a
        // response already returned.
        () => resolve(snapshot(batch.result)),
        READINESS_DEADLINE_MS,
      );
      if (typeof timer === "object" && timer !== null && "unref" in timer &&
        typeof (timer as { unref?: unknown }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
    });
    try {
      // The underlying batch keeps running to its actual settlement (one
      // in-flight batch), but the response fails closed after the deadline.
      return await Promise.race([batch.promise, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const manifestInput = (
    readinessResult: ReadinessResult,
  ): MarketplaceCapabilityBuilderInput => ({
    auth: flags.authEnabled,
    tenantReads: flags.tenantReadsEnabled,
    marketCatalog: flags.marketCatalogEnabled,
    listingManagement: flags.listingManagementEnabled,
    marketModeration: flags.marketModerationEnabled,
    authReady: readinessResult.authReady,
    tenantDatabaseReady: readinessResult.tenantDatabaseReady,
    marketDatabaseReady: readinessResult.marketDatabaseReady,
  });

  app.all(
    MARKETPLACE_CAPABILITIES_PATH,
    {
      onRequest: async (request) => {
        enforceTransport(request, appOrigin);
      },
    },
    async (request, reply) => {
      const readinessResult = await boundedReadiness();
      const manifest = buildMarketplaceCapabilityManifest(
        manifestInput(readinessResult),
      );
      return sendEnvelope(
        request,
        reply,
        options.buildSha,
        manifest,
        maxResponseBytes,
      );
    },
  );
}

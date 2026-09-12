import {
  API_CLIENT_HEADER,
  API_MAX_RESPONSE_BYTES,
  COMMERCE_API_SCHEMA_VERSION,
  COMMERCE_CAPABILITIES_PATH,
  CommerceApiMetaSchema,
  CommerceCapabilitiesSuccessEnvelopeSchema,
  buildCommerceCapabilityManifest,
  type CommerceCapabilityBuilderInput,
  type CommerceCapabilityManifest,
} from "@openarc/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { AUTH_ERRORS, AuthApiError } from "../auth/errors.js";

/**
 * Public, credentialless capability metadata surface.
 *
 * `GET /v2/public/capabilities` publishes the accepted shared family manifest
 * and fixed principal-route registry. It is metadata ONLY: no account cookie,
 * Authorization header, CSRF, idempotency key, body, query or CORS grant is
 * accepted, and the route can never mint a cookie. It performs no automatic
 * network/provider/RPC request: the public registry is not a health poll of
 * external sources.
 *
 * Readiness is joined from at most one bounded, app-wide in-flight batch of
 * read-only callback probes. Concurrent requests share that batch; when it
 * settles the reference is cleared so a later request re-checks. A response
 * deadline (2s total, parallel) fails closed for still-unresolved
 * dependencies without demoting a dependency that already settled to `true`
 * independently, and without starting a second overlapping batch. The
 * response result is snapshotted at the deadline so late settlement cannot
 * mutate an already-returned response. There is no success cache, no
 * principal/auth cache and no background timer.
 */

export const COMMERCE_CAPABILITIES_ROUTE = COMMERCE_CAPABILITIES_PATH;

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

/** The five explicit flags app.ts may pass. Never the full config object. */
export interface CommerceCapabilityFlags {
  readonly authEnabled: boolean;
  readonly tenantReadsEnabled: boolean;
  readonly tenantWritesEnabled: boolean;
  readonly machineCredentialManagementEnabled: boolean;
  readonly machineSessionExchangeEnabled: boolean;
}

/** Existing readiness callbacks, unchanged. Each may be absent. */
export interface CommerceCapabilityReadiness {
  readonly authReady?: () => Promise<boolean>;
  readonly tenantReady?: () => Promise<boolean>;
  readonly machineReady?: () => Promise<boolean>;
}

export interface RegisterCommerceCapabilitiesOptions {
  readonly flags: CommerceCapabilityFlags;
  readonly readiness: CommerceCapabilityReadiness;
  readonly buildSha: string;
  readonly appOrigin: string;
  readonly maxResponseBytes?: number;
}

type ReadinessKey = "authReady" | "tenantReady" | "machineReady";

type DependencyKey = "authReady" | "tenantDatabaseReady" | "machineDatabaseReady";

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
  readonly machineDatabaseReady: boolean;
}

type MutableReadinessResult = {
  -readonly [K in keyof ReadinessResult]: ReadinessResult[K];
};

function unready(): MutableReadinessResult {
  return { authReady: false, tenantDatabaseReady: false, machineDatabaseReady: false };
}

/** Frozen copy so a deadline snapshot cannot be mutated by late settlement. */
function snapshot(result: ReadinessResult): ReadinessResult {
  return Object.freeze({
    authReady: result.authReady === true,
    tenantDatabaseReady: result.tenantDatabaseReady === true,
    machineDatabaseReady: result.machineDatabaseReady === true,
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

function strictHeader(
  headers: Record<string, unknown>,
  key: string,
): unknown {
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
 */
function enforceAllowedHeaders(request: FastifyRequest): void {
  for (const name of Object.keys(request.headers)) {
    if (ALLOWED_CLIENT_HEADER_NAMES.has(name)) continue;
    if (PUBLIC_CRITICAL_HEADERS.has(name)) continue;
    if (name === "host" || name === "accept" || name === "accept-encoding" ||
      name === "accept-language" || name === "user-agent" || name === "connection" ||
      name === "sec-fetch-site" ||
      name === "sec-fetch-mode" || name === "sec-fetch-dest") continue;
    throw invalidRequest();
  }
}

function enforceTransport(
  request: FastifyRequest,
  appOrigin: string,
): void {
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
  manifest: CommerceCapabilityManifest,
  maxResponseBytes: number,
): FastifyReply {
  const envelope = CommerceCapabilitiesSuccessEnvelopeSchema.parse({
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
 * True when the five explicit flags require no readiness callback at all:
 * every family is either built_disabled or purely flag-satisfied. Only reached
 * with all own flags false, so no batch is ever started.
 */
function readinessCallbacksNeeded(flags: CommerceCapabilityFlags): ReadinessKey[] {
  const keys: ReadinessKey[] = [];
  if (flags.authEnabled) keys.push("authReady");
  if (flags.tenantReadsEnabled || flags.tenantWritesEnabled) {
    keys.push("tenantReady");
  }
  if (flags.machineCredentialManagementEnabled || flags.machineSessionExchangeEnabled) {
    keys.push("machineReady");
  }
  return keys;
}

/**
 * Which readiness dependency each callback satisfies. Only readiness for an
 * enabled required dependency is invoked; at most once each per request. A
 * missing parent/callback contributes `false` without invoking anything.
 */
function requiredDependencies(
  flags: CommerceCapabilityFlags,
): Record<DependencyKey, boolean> {
  return {
    authReady: flags.authEnabled,
    tenantDatabaseReady: flags.tenantReadsEnabled || flags.tenantWritesEnabled ||
      flags.machineCredentialManagementEnabled || flags.machineSessionExchangeEnabled,
    machineDatabaseReady: flags.machineCredentialManagementEnabled ||
      flags.machineSessionExchangeEnabled,
  };
}

const CALLBACK_DEPENDENCY: Readonly<Record<ReadinessKey, DependencyKey>> =
  Object.freeze({
    authReady: "authReady",
    tenantReady: "tenantDatabaseReady",
    machineReady: "machineDatabaseReady",
  });

export function registerCommerceCapabilities(
  app: FastifyInstance,
  options: RegisterCommerceCapabilitiesOptions,
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
   * independently ready auth/tenant values while an unresolved machine
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
    // Clear only this batch's own reference on settlement. A response returned
    // before settlement is unaffected, and a later request starts a fresh
    // batch (re-check) instead of reusing stale readiness.
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

  const manifestInput = (readinessResult: ReadinessResult): CommerceCapabilityBuilderInput => ({
    auth: flags.authEnabled,
    tenantReads: flags.tenantReadsEnabled,
    tenantWrites: flags.tenantWritesEnabled,
    machineCredentials: flags.machineCredentialManagementEnabled,
    machineSessions: flags.machineSessionExchangeEnabled,
    authReady: readinessResult.authReady,
    tenantDatabaseReady: readinessResult.tenantDatabaseReady,
    machineDatabaseReady: readinessResult.machineDatabaseReady,
  });

  app.all(
    COMMERCE_CAPABILITIES_PATH,
    {
      onRequest: async (request) => {
        enforceTransport(request, appOrigin);
      },
    },
    async (request, reply) => {
      const readinessResult = await boundedReadiness();
      const manifest = buildCommerceCapabilityManifest(
        manifestInput(readinessResult),
      );
      return sendEnvelope(request, reply, options.buildSha, manifest, maxResponseBytes);
    },
  );
}

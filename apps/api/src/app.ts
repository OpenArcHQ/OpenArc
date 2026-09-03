import {
  API_ERRORS, API_MAX_REQUEST_BYTES, API_MAX_RESPONSE_BYTES, API_SCHEMA_VERSION,
  ARC_TESTNET, CAPABILITIES_PATH, CapabilitiesEnvelopeSchema, type ApiErrorCode,
} from "@openarc/shared";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import type { ApiConfig } from "./config.js";
import { ApiBoundaryError, apiErrorEnvelope, normalizeApiError } from "./http/errors.js";
import { verifyBrowserOrigin, verifyPreflight } from "./http/origin.js";
import { AggregateMetrics, durationBucket, metricsAuthorized, safeMethod,
  type DurationBucket, type RouteClass, type SafeMethod } from "./ops/metrics.js";

export interface CompletionLog {
  requestId: string;
  route: RouteClass;
  method: SafeMethod;
  status: number;
  duration: DurationBucket;
  failureCode: ApiErrorCode | null;
  buildSha: string;
}

export interface CreateAppOptions {
  config: ApiConfig;
  logger?: boolean;
  logSink?: (entry: Readonly<CompletionLog>) => void;
  metrics?: AggregateMetrics;
}

const disabledPaths = [
  "/v1/private/arc/account-snapshot", "/v1/private/arc/transaction-evidence",
  "/v1/private/arc/agent-registry-evidence", "/v1/private/arc/job-evidence",
  "/v1/private/gateway/transfer-evidence",
] as const;

function routeClass(url: string): RouteClass {
  const path = url.split("?", 1)[0];
  if (path === "/healthz") return "health";
  if (path === "/readyz") return "readiness";
  if (path === "/metrics") return "metrics";
  if (path === CAPABILITIES_PATH) return "capabilities";
  if (disabledPaths.some((candidate) => candidate === path)) return "disabled_source";
  return "not_found";
}

export function createApp({ config, logger = config.NODE_ENV !== "test", logSink, metrics = new AggregateMetrics() }: CreateAppOptions): FastifyInstance {
  // Framework request/error logging is disabled, including parser failures.
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: API_MAX_REQUEST_BYTES,
    requestIdHeader: false, genReqId: () => randomUUID(), exposeHeadRoutes: false,
    requestTimeout: 10_000, connectionTimeout: 10_000, keepAliveTimeout: 5_000 });
  const failures = new WeakMap<FastifyRequest, ApiErrorCode>();
  const started = new WeakMap<FastifyRequest, number>();
  const headers = (request: FastifyRequest, reply: FastifyReply) => {
    reply.headers({ "Cache-Control": "no-store", Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
      "X-OpenArc-Request-Id": request.id });
    if (config.NODE_ENV === "production") reply.header("Strict-Transport-Security", "max-age=31536000");
  };
  app.addHook("onRequest", async (request, reply) => { started.set(request, performance.now()); headers(request, reply); });
  app.addHook("onSend", async (request, reply, payload) => { headers(request, reply); return payload; });
  app.addHook("onResponse", async (request, reply) => {
    const duration = durationBucket(performance.now() - (started.get(request) ?? performance.now()));
    const route = routeClass(request.url);
    metrics.record(route, reply.statusCode, duration);
    const failure = failures.get(request);
    if (failure) metrics.recordFailure(route, failure);
    const entry: CompletionLog = { requestId: request.id, route, method: safeMethod(request.method),
      status: reply.statusCode, duration, failureCode: failures.get(request) ?? null, buildSha: config.COMMIT_SHA };
    if (logSink) logSink(Object.freeze(entry));
    else if (logger && config.LOG_LEVEL !== "silent" &&
      (config.LOG_LEVEL === "info" || (config.LOG_LEVEL === "warn" && reply.statusCode >= 400) || reply.statusCode >= 500)) {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
    }
  });

  const sendError = (request: FastifyRequest, reply: FastifyReply, error: ApiBoundaryError) => {
    failures.set(request, error.code);
    if (error.retryAfterSeconds !== undefined) reply.header("Retry-After", String(error.retryAfterSeconds));
    return reply.code(API_ERRORS[error.code].status).send(apiErrorEnvelope(error, request.id, config.COMMIT_SHA));
  };
  app.setErrorHandler((cause, request, reply) => sendError(request, reply, normalizeApiError(cause)));
  app.setNotFoundHandler((request, reply) => sendError(request, reply, new ApiBoundaryError("NOT_FOUND")));

  const build = { service: "openarc-api", version: "0.0.0", commitSha: config.COMMIT_SHA } as const;
  app.get("/healthz", async () => ({ status: "ok" as const, ...build }));
  app.get("/readyz", async () => ({ ok: true as const, status: "ready" as const,
    checks: { configuration: "up", sourceRoutes: "disabled", redis: "not_required" }, ...build }));

  app.all(CAPABILITIES_PATH, { onRequest: async (request, reply) => {
    if (!config.API_BOUNDARY_ENABLED) throw new ApiBoundaryError("FEATURE_DISABLED");
    if (request.url.includes("?") || (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0") || request.headers["transfer-encoding"] !== undefined) {
      throw new ApiBoundaryError("INVALID_REQUEST");
    }
    if (request.method === "OPTIONS") {
      verifyPreflight(request.headers, config.APP_ORIGIN, "GET");
      return reply.headers({ "Access-Control-Allow-Origin": config.APP_ORIGIN,
        "Access-Control-Allow-Methods": "GET", "Access-Control-Allow-Headers": "x-openarc-client, content-type",
        Vary: "Origin" }).code(204).send();
    }
    if (request.method !== "GET") throw new ApiBoundaryError("METHOD_NOT_ALLOWED");
    verifyBrowserOrigin(request.headers, config.APP_ORIGIN, true);
    if (request.headers.origin === config.APP_ORIGIN) reply.header("Access-Control-Allow-Origin", config.APP_ORIGIN);
    reply.header("Vary", "Origin");
  } }, async (request) => CapabilitiesEnvelopeSchema.parse({
    ok: true,
    data: { capabilityVersion: "openarc.capabilities.m03.v1", environment: "testnet", network: ARC_TESTNET.caip2,
      sourceRevision: ARC_TESTNET.sourceRevision, reviewedAt: ARC_TESTNET.reviewedAt,
      writes: false, enabledConnectors: [],
      features: { arcObservation: false, agentRegistry: false, agentJobs: false, gatewayEvidence: false },
      limits: { requestBytes: API_MAX_REQUEST_BYTES, responseBytes: API_MAX_RESPONSE_BYTES,
        sourceResponseBytes: config.SOURCE_MAX_RESPONSE_BYTES, sourceTimeoutMs: config.SOURCE_TIMEOUT_MS,
        sourceMaxSubcalls: config.SOURCE_MAX_SUBCALLS, requestsPerPeerHour: config.REQUESTS_PER_IP_HOUR,
        globalSourceUnitsPerDay: config.GLOBAL_SOURCE_UNITS_PER_DAY } },
    meta: { schemaVersion: API_SCHEMA_VERSION, requestId: request.id, buildSha: config.COMMIT_SHA },
  }));

  for (const path of disabledPaths) {
    app.all(path, { onRequest: async () => { throw new ApiBoundaryError("FEATURE_DISABLED"); } }, async () => undefined);
  }

  app.all("/metrics", { onRequest: async (request) => {
    if (request.method !== "GET") throw new ApiBoundaryError("METHOD_NOT_ALLOWED");
    if (request.url.includes("?") || !metricsAuthorized(request.headers.authorization, config.METRICS_TOKEN)) {
      throw new ApiBoundaryError("METRICS_UNAUTHORIZED");
    }
  } }, async (_request, reply) => reply.type("text/plain; version=0.0.4; charset=utf-8").send(metrics.render(config.COMMIT_SHA)));
  return app;
}

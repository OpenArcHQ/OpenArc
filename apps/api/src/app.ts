import {
  API_ERRORS, API_MAX_REQUEST_BYTES, API_MAX_RESPONSE_BYTES, API_SCHEMA_VERSION,
  AGENT_REGISTRY_EVIDENCE_PATH, ARC_ERC8004,
  ARC_ACCOUNT_SNAPSHOT_PATH, ARC_TESTNET, ARC_TRANSACTION_EVIDENCE_PATH,
  ArcAccountSnapshotEnvelopeSchema, ArcAccountSnapshotRequestSchema,
  ArcTransactionEvidenceEnvelopeSchema, ArcTransactionEvidenceRequestSchema,
  AgentRegistryEvidenceEnvelopeSchema, AgentRegistryEvidenceRequestSchema,
  CAPABILITIES_PATH, CapabilitiesEnvelopeSchema, type ApiErrorCode,
  type ArcAccountSnapshotEnvelope, type ArcAccountSnapshotRequest,
  type ArcTransactionEvidenceEnvelope, type ArcTransactionEvidenceRequest,
  type AgentRegistryEvidenceEnvelope, type AgentRegistryEvidenceRequest,
  ARC_ERC8183, JOB_EVIDENCE_PATH, JobEvidenceRequestSchema, JobEvidenceEnvelopeSchema,
  type JobEvidenceRequest,
  GATEWAY_TRANSFER_PATH, GatewayTransferRequestSchema, GatewayTransferEnvelopeSchema, type GatewayTransferRequest,
} from "@openarc/shared";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";

import type { ApiConfig } from "./config.js";
import type { ArcAccountService } from "./arc/account-service.js";
import type { AgentRegistryService } from "./arc/agent-registry-service.js";
import type { JobService } from "./arc/job-service.js";
import type { GatewayTransferService } from "./gateway/transfer-service.js";
import type { ArcTransactionService } from "./arc/transaction-service.js";
import { authCookieNames } from "./auth/cookies.js";
import { AUTH_ERRORS, AuthApiError, authErrorEnvelope } from "./auth/errors.js";
import { AUTH_ROUTE_PATHS, registerAuthRoutes } from "./auth/routes.js";
import type { AuthService } from "./auth/service.js";
import { ApiBoundaryError, apiErrorEnvelope, normalizeApiError } from "./http/errors.js";
import { verifyBrowserOrigin, verifyPreflight } from "./http/origin.js";
import { registerSourceRoute } from "./http/source-route.js";
import type { SourceBudget } from "./limits/budget.js";
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
  sourceBudget?: SourceBudget;
  arcAccountService?: ArcAccountService;
  arcTransactionService?: ArcTransactionService;
  agentRegistryService?: AgentRegistryService;
  jobService?: JobService;
  gatewayTransferService?: GatewayTransferService;
  authService?: AuthService;
  authReady?: () => Promise<boolean>;
}

const disabledPaths = [
  "/v1/private/gateway/transfer-evidence",
] as const;

function routeClass(url: string): RouteClass {
  const path = url.split("?", 1)[0] ?? url;
  if (path === "/healthz") return "health";
  if (path === "/readyz") return "readiness";
  if (path === "/metrics") return "metrics";
  if ((AUTH_ROUTE_PATHS as readonly string[]).includes(path)) return "auth";
  if (path === CAPABILITIES_PATH) return "capabilities";
  if (path === ARC_ACCOUNT_SNAPSHOT_PATH) return "arc_account";
  if (path === ARC_TRANSACTION_EVIDENCE_PATH) return "arc_transaction";
  if (path === AGENT_REGISTRY_EVIDENCE_PATH) return "agent_registry";
  if (path === JOB_EVIDENCE_PATH) return "agent_job";
  if (path === GATEWAY_TRANSFER_PATH) return "gateway_transfer";
  if (disabledPaths.some((candidate) => candidate === path)) return "disabled_source";
  return "not_found";
}

export function createApp({ config, logger = config.NODE_ENV !== "test", logSink, metrics = new AggregateMetrics(),
  sourceBudget, arcAccountService, arcTransactionService, agentRegistryService, jobService, gatewayTransferService,
  authService, authReady }: CreateAppOptions): FastifyInstance {
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

  const sendError = (request: FastifyRequest, reply: FastifyReply, cause: unknown) => {
    if (cause instanceof AuthApiError) {
      failures.set(request, cause.metricsCode);
      if (cause.retryAfterSeconds !== undefined) reply.header("Retry-After", String(cause.retryAfterSeconds));
      return reply.code(cause.status).send(authErrorEnvelope(cause, request.id, config.COMMIT_SHA));
    }
    const authPath = (request.url.split("?", 1)[0] ?? request.url).startsWith("/v2/auth/");
    if (authPath && !(cause instanceof ApiBoundaryError && cause.code === "NOT_FOUND")) {
      // Parser, body-limit, media, unexpected and response-schema failures on
      // the account surface must still return a strict v2 envelope with a
      // correct status and no raw cause or caller data.
      const normalized = normalizeApiError(cause);
      const mapped =
        normalized.code === "REQUEST_TOO_LARGE"
          ? AUTH_ERRORS.tooLarge()
          : normalized.code === "UNSUPPORTED_MEDIA_TYPE"
            ? AUTH_ERRORS.unsupportedMedia()
            : normalized.code === "INVALID_REQUEST"
              ? AUTH_ERRORS.invalidRequest()
              : AUTH_ERRORS.internal();
      failures.set(request, mapped.metricsCode);
      return reply
        .code(mapped.status)
        .send(authErrorEnvelope(mapped, request.id, config.COMMIT_SHA));
    }
    const error = normalizeApiError(cause);
    failures.set(request, error.code);
    if (error.retryAfterSeconds !== undefined) reply.header("Retry-After", String(error.retryAfterSeconds));
    return reply.code(API_ERRORS[error.code].status).send(apiErrorEnvelope(error, request.id, config.COMMIT_SHA));
  };
  app.setErrorHandler((cause, request, reply) => sendError(request, reply, cause));
  app.setNotFoundHandler((request, reply) => sendError(request, reply, new ApiBoundaryError("NOT_FOUND")));

  const build = { service: "openarc-api", version: "0.0.0", commitSha: config.COMMIT_SHA } as const;
  app.get("/healthz", async () => ({ status: "ok" as const, ...build }));
  app.get("/readyz", async (_request, reply) => {
    if (config.AUTH_ENABLED) {
      const authReadyResult = authReady ? await authReady().catch(() => false) : false;
      if (!authReadyResult) {
        return reply.code(503).send({ ok: false as const, status: "not_ready" as const,
          checks: { configuration: "up", sourceRoutes: config.ARC_OBSERVATION_ENABLED ? "enabled" : "disabled",
            redis: config.ARC_OBSERVATION_ENABLED ? "not_checked" : "not_required", authDatabase: "down" }, ...build });
      }
    }
    if (config.ARC_OBSERVATION_ENABLED) {
      const redisReady = sourceBudget ? await sourceBudget.ready(AbortSignal.timeout(750)) : false;
      if (!redisReady) return reply.code(503).send({ ok: false as const, status: "not_ready" as const,
        checks: { configuration: "up", sourceRoutes: "enabled", redis: "down" }, ...build });
      return { ok: true as const, status: "ready" as const,
        checks: { configuration: "up", sourceRoutes: "enabled", redis: "up" }, ...build };
    }
    return { ok: true as const, status: "ready" as const,
      checks: { configuration: "up", sourceRoutes: "disabled", redis: "not_required",
        ...(config.AUTH_ENABLED ? { authDatabase: "up" as const } : {}) }, ...build };
  });

  if (config.AUTH_ENABLED) {
    if (!authService) throw new Error("Auth dependencies are unavailable");
    const secureCookies = config.APP_ORIGIN.startsWith("https://");
    registerAuthRoutes(app, {
      appOrigin: config.APP_ORIGIN,
      cookieNames: authCookieNames(secureCookies),
      service: authService,
      buildSha: config.COMMIT_SHA,
      enabled: true,
    });
  } else {
    registerAuthRoutes(app, {
      appOrigin: config.APP_ORIGIN,
      cookieNames: authCookieNames(false),
      // A disabled registration never invokes the service.
      service: authService as AuthService,
      buildSha: config.COMMIT_SHA,
      enabled: false,
    });
  }

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
    data: { capabilityVersion: config.GATEWAY_EVIDENCE_ENABLED ? "openarc.capabilities.m07.v1" : config.AGENT_JOBS_ENABLED ? "openarc.capabilities.m06.v1" : config.AGENT_REGISTRY_ENABLED ? "openarc.capabilities.m05.v1" : "openarc.capabilities.m04.v1",
      environment: "testnet", network: ARC_TESTNET.caip2,
      sourceRevision: config.GATEWAY_EVIDENCE_ENABLED ? "circle-gateway-x402-2026-09-05" : config.AGENT_JOBS_ENABLED ? ARC_ERC8183.sourceRevision : config.AGENT_REGISTRY_ENABLED ? ARC_ERC8004.sourceRevision : ARC_TESTNET.sourceRevision,
      reviewedAt: config.GATEWAY_EVIDENCE_ENABLED ? "2026-09-05" : config.AGENT_REGISTRY_ENABLED ? ARC_ERC8004.reviewedAt : ARC_TESTNET.reviewedAt,
      writes: false, enabledConnectors: config.GATEWAY_EVIDENCE_ENABLED ? ["arc_primary_rpc", "erc8004_registries", "erc8183_reference", "circle_gateway_testnet"] : config.AGENT_JOBS_ENABLED ? ["arc_primary_rpc", "erc8004_registries", "erc8183_reference"] : config.AGENT_REGISTRY_ENABLED
        ? ["arc_primary_rpc", "erc8004_registries"] : config.ARC_OBSERVATION_ENABLED ? ["arc_primary_rpc"] : [],
      features: { arcObservation: config.ARC_OBSERVATION_ENABLED, agentRegistry: config.AGENT_REGISTRY_ENABLED,
        agentJobs: config.AGENT_JOBS_ENABLED, gatewayEvidence: config.GATEWAY_EVIDENCE_ENABLED },
      limits: { requestBytes: API_MAX_REQUEST_BYTES, responseBytes: API_MAX_RESPONSE_BYTES,
        sourceResponseBytes: config.SOURCE_MAX_RESPONSE_BYTES, sourceTimeoutMs: config.SOURCE_TIMEOUT_MS,
        sourceMaxSubcalls: config.SOURCE_MAX_SUBCALLS, requestsPerPeerHour: config.REQUESTS_PER_IP_HOUR,
        globalSourceUnitsPerDay: config.GLOBAL_SOURCE_UNITS_PER_DAY } },
    meta: { schemaVersion: API_SCHEMA_VERSION, requestId: request.id, buildSha: config.COMMIT_SHA },
  }));

  if (config.ARC_OBSERVATION_ENABLED) {
    if (!sourceBudget || !arcAccountService || !arcTransactionService) {
      throw new Error("Arc observation dependencies are unavailable");
    }
    registerSourceRoute<ArcAccountSnapshotRequest, ArcAccountSnapshotEnvelope>(app, {
      path: ARC_ACCOUNT_SNAPSHOT_PATH, source: "arc_rpc", route: "arc_account", enabled: true,
      appOrigin: config.APP_ORIGIN, proxySecret: config.SOURCE_PROXY_SECRET!,
      budget: sourceBudget, timeoutMs: config.SOURCE_TIMEOUT_MS,
      requestSchema: ArcAccountSnapshotRequestSchema, responseSchema: ArcAccountSnapshotEnvelopeSchema,
      execute: async (input, context) => ({ ok: true as const,
        data: await arcAccountService.observe(input, context.lease, context.signal),
        meta: { schemaVersion: API_SCHEMA_VERSION, requestId: context.requestId, buildSha: config.COMMIT_SHA } }),
    });
    registerSourceRoute<ArcTransactionEvidenceRequest, ArcTransactionEvidenceEnvelope>(app, {
      path: ARC_TRANSACTION_EVIDENCE_PATH, source: "arc_rpc", route: "arc_transaction", enabled: true,
      appOrigin: config.APP_ORIGIN, proxySecret: config.SOURCE_PROXY_SECRET!,
      budget: sourceBudget, timeoutMs: config.SOURCE_TIMEOUT_MS,
      requestSchema: ArcTransactionEvidenceRequestSchema, responseSchema: ArcTransactionEvidenceEnvelopeSchema,
      execute: async (input, context) => ({ ok: true as const,
        data: await arcTransactionService.observe(input, context.lease, context.signal),
        meta: { schemaVersion: API_SCHEMA_VERSION, requestId: context.requestId, buildSha: config.COMMIT_SHA } }),
    });
  } else {
    for (const path of [ARC_ACCOUNT_SNAPSHOT_PATH, ARC_TRANSACTION_EVIDENCE_PATH] as const) {
      app.all(path, { onRequest: async () => { throw new ApiBoundaryError("FEATURE_DISABLED"); } }, async () => undefined);
    }
  }

  if (config.AGENT_REGISTRY_ENABLED) {
    if (!sourceBudget || !agentRegistryService) throw new Error("Agent registry dependencies are unavailable");
    registerSourceRoute<AgentRegistryEvidenceRequest, AgentRegistryEvidenceEnvelope>(app, {
      path: AGENT_REGISTRY_EVIDENCE_PATH, source: "arc_rpc", route: "agent_registry", enabled: true,
      appOrigin: config.APP_ORIGIN, proxySecret: config.SOURCE_PROXY_SECRET!,
      budget: sourceBudget, timeoutMs: config.SOURCE_TIMEOUT_MS,
      requestSchema: AgentRegistryEvidenceRequestSchema, responseSchema: AgentRegistryEvidenceEnvelopeSchema,
      execute: async (input, context) => ({ ok: true as const,
        data: await agentRegistryService.observe(input, context.lease, context.signal),
        meta: { schemaVersion: API_SCHEMA_VERSION, requestId: context.requestId, buildSha: config.COMMIT_SHA } }),
    });
  } else {
    app.all(AGENT_REGISTRY_EVIDENCE_PATH,
      { onRequest: async () => { throw new ApiBoundaryError("FEATURE_DISABLED"); } }, async () => undefined);
  }

  if (config.AGENT_JOBS_ENABLED) {
    if (!sourceBudget || !jobService) throw new Error("Job evidence dependencies are unavailable");
    registerSourceRoute<JobEvidenceRequest, ReturnType<typeof JobEvidenceEnvelopeSchema.parse>>(app, {
      path: JOB_EVIDENCE_PATH, source: "arc_rpc", route: "agent_job", enabled: true,
      appOrigin: config.APP_ORIGIN, proxySecret: config.SOURCE_PROXY_SECRET!, budget: sourceBudget,
      timeoutMs: config.SOURCE_TIMEOUT_MS, requestSchema: JobEvidenceRequestSchema,
      responseSchema: JobEvidenceEnvelopeSchema,
      execute: async (input, context) => ({ ok: true as const,
        data: await jobService.observe(input, context.lease, context.signal),
        meta: { schemaVersion: API_SCHEMA_VERSION, requestId: context.requestId, buildSha: config.COMMIT_SHA } }),
    });
  } else {
    app.all(JOB_EVIDENCE_PATH, { onRequest: async () => { throw new ApiBoundaryError("FEATURE_DISABLED"); } }, async () => undefined);
  }

  if (config.GATEWAY_EVIDENCE_ENABLED) {
    if (!sourceBudget || !gatewayTransferService) throw new Error("Gateway evidence dependencies are unavailable");
    registerSourceRoute<GatewayTransferRequest, ReturnType<typeof GatewayTransferEnvelopeSchema.parse>>(app, {
      path: GATEWAY_TRANSFER_PATH, source: "gateway", route: "gateway_transfer", enabled: true,
      appOrigin: config.APP_ORIGIN, proxySecret: config.SOURCE_PROXY_SECRET!, budget: sourceBudget,
      timeoutMs: config.SOURCE_TIMEOUT_MS, requestSchema: GatewayTransferRequestSchema,
      responseSchema: GatewayTransferEnvelopeSchema,
      execute: async (input, context) => ({ ok: true as const,
        data: await gatewayTransferService.observe(input, context.lease, context.signal),
        meta: { schemaVersion: API_SCHEMA_VERSION, requestId: context.requestId, buildSha: config.COMMIT_SHA } }),
    });
  } else {
    app.all(GATEWAY_TRANSFER_PATH, { onRequest: async () => { throw new ApiBoundaryError("FEATURE_DISABLED"); } }, async () => undefined);
  }

  for (const path of disabledPaths) {
    app.all(path, { onRequest: async () => { throw new ApiBoundaryError("FEATURE_DISABLED"); } }, async () => undefined);
  }

  app.all("/metrics", { onRequest: async (request) => {
    if (request.method !== "GET") throw new ApiBoundaryError("METHOD_NOT_ALLOWED");
    if (request.url.includes("?") || !metricsAuthorized(request.headers.authorization, config.METRICS_TOKEN)) {
      throw new ApiBoundaryError("METRICS_UNAUTHORIZED");
    }
  } }, async (_request, reply) => reply.type("text/plain; version=0.0.4; charset=utf-8")
    .send(metrics.render(config.COMMIT_SHA, config.ARC_OBSERVATION_ENABLED)));
  return app;
}

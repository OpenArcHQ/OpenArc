import { API_MAX_REQUEST_BYTES, API_MAX_RESPONSE_BYTES } from "@openarc/shared";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import type { z } from "zod";

import { canonicalPeer, type SourceBudget, type SourceClass, type SourceLease, type SourceRoute } from "../limits/budget.js";
import { ApiBoundaryError } from "./errors.js";
import { verifyBrowserOrigin, verifyPreflight } from "./origin.js";

interface SourceContext {
  controller: AbortController;
  timer: ReturnType<typeof setTimeout>;
  peer: string | undefined;
  lease: SourceLease | undefined;
  cleanup: () => void;
}

export interface SourceRouteOptions<Input, Output> {
  path: string;
  source: SourceClass;
  route: SourceRoute;
  enabled: boolean;
  appOrigin: string;
  proxySecret: string;
  budget: SourceBudget | undefined;
  timeoutMs: number;
  requestSchema: z.ZodObject;
  responseSchema: z.ZodType<Output>;
  execute: (input: Input, context: { lease: SourceLease; signal: AbortSignal; requestId: string }) => Promise<Output>;
}

/** Reusable source boundary. Adapters remain route-owned and receive no raw request object. */
export function registerSourceRoute<Input, Output>(app: FastifyInstance, options: SourceRouteOptions<Input, Output>): void {
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 10_000) {
    throw new Error("Invalid source timeout configuration");
  }
  if (!/^[A-Za-z0-9_-]{32,128}$/u.test(options.proxySecret)) throw new Error("Invalid source proxy configuration");
  const contexts = new WeakMap<FastifyRequest, SourceContext>();
  const finish = (request: FastifyRequest) => {
    const context = contexts.get(request);
    if (!context) return;
    context.controller.abort();
    context.lease?.close();
    context.cleanup();
    contexts.delete(request);
  };
  const schema = options.requestSchema.strict();
  app.all(options.path, {
    bodyLimit: API_MAX_REQUEST_BYTES,
    onRequest: async (request, reply) => {
      if (!options.enabled) throw new ApiBoundaryError("FEATURE_DISABLED");
      if (!options.budget) throw new ApiBoundaryError("BUDGET_STORE_UNAVAILABLE");
      const controller = new AbortController();
      const abort = () => controller.abort();
      const close = () => { if (!reply.raw.writableEnded) abort(); };
      const timer = setTimeout(abort, options.timeoutMs);
      timer.unref();
      request.raw.once("aborted", abort);
      reply.raw.once("close", close);
      const context: SourceContext = { controller, timer, peer: undefined, lease: undefined, cleanup: () => {
        clearTimeout(timer);
        request.raw.off("aborted", abort);
        reply.raw.off("close", close);
      } };
      contexts.set(request, context);
      if (request.method === "OPTIONS") {
        verifyPreflight(request.headers, options.appOrigin, "POST");
        rejectQuery(request);
        if (request.headers["transfer-encoding"] !== undefined ||
          (request.headers["content-length"] !== undefined && request.headers["content-length"] !== "0")) {
          throw new ApiBoundaryError("INVALID_REQUEST");
        }
        return reply.headers({ "Access-Control-Allow-Origin": options.appOrigin,
          "Access-Control-Allow-Methods": "POST", "Access-Control-Allow-Headers": "content-type, x-openarc-client",
          Vary: "Origin" }).code(204).send();
      }
      verifyBrowserOrigin(request.headers, options.appOrigin, false);
      reply.header("Access-Control-Allow-Origin", options.appOrigin).header("Vary", "Origin");
      if (request.method !== "POST") throw new ApiBoundaryError("METHOD_NOT_ALLOWED");
      rejectQuery(request);
      const contentType = request.headers["content-type"];
      if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(contentType) ||
        (request.headers["content-encoding"] !== undefined && request.headers["content-encoding"] !== "identity")) {
        throw new ApiBoundaryError("UNSUPPORTED_MEDIA_TYPE");
      }
      const length = request.headers["content-length"];
      if (length !== undefined && !/^(?:0|[1-9]\d{0,9})$/u.test(length)) throw new ApiBoundaryError("INVALID_REQUEST");
      if (length !== undefined && Number(length) > API_MAX_REQUEST_BYTES) throw new ApiBoundaryError("REQUEST_TOO_LARGE");
      context.peer = trustedProxyPeer(request.headers["x-openarc-proxy-secret"],
        request.headers["x-openarc-proxy-client-ip"], options.proxySecret);
    },
    preValidation: async (request) => {
      const result = schema.safeParse(request.body);
      if (!result.success) throw new ApiBoundaryError("INVALID_REQUEST");
      request.body = result.data;
    },
    preHandler: async (request) => {
      const context = contexts.get(request);
      if (!context || !context.peer || context.controller.signal.aborted) throw new ApiBoundaryError("SOURCE_UNAVAILABLE");
      // Only a strict, authenticated, executable source request consumes a peer/global reservation.
      context.lease = await options.budget!.begin(options.source, options.route, context.peer, context.controller.signal);
    },
    onResponse: async (request) => finish(request),
    onTimeout: async (request) => finish(request),
    onError: async (request) => finish(request),
    onRequestAbort: async (request) => finish(request),
  }, async (request, reply: FastifyReply) => {
    const context = contexts.get(request);
    if (!context?.lease || context.controller.signal.aborted) throw new ApiBoundaryError("SOURCE_UNAVAILABLE");
    const work = options.execute(request.body as Input, {
      lease: context.lease, signal: context.controller.signal, requestId: request.id,
    });
    const output = await untilAborted(work, context.controller.signal);
    if (context.controller.signal.aborted) throw new ApiBoundaryError("SOURCE_UNAVAILABLE");
    const validated = options.responseSchema.safeParse(output);
    if (!validated.success) throw new ApiBoundaryError("SOURCE_MALFORMED");
    const serialized = JSON.stringify(validated.data);
    if (serialized === undefined || Buffer.byteLength(serialized) > API_MAX_RESPONSE_BYTES) {
      throw new ApiBoundaryError("SOURCE_RESPONSE_TOO_LARGE");
    }
    return reply.type("application/json; charset=utf-8").send(serialized);
  });
}

/** Accept only the identity asserted by the authenticated same-service web proxy. */
export function trustedProxyPeer(suppliedSecret: string | string[] | undefined,
  suppliedPeer: string | string[] | undefined, expectedSecret: string): string {
  if (typeof suppliedSecret !== "string" || typeof suppliedPeer !== "string") {
    throw new ApiBoundaryError("INVALID_ORIGIN");
  }
  const supplied = Buffer.from(suppliedSecret);
  const expected = Buffer.from(expectedSecret);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ApiBoundaryError("INVALID_ORIGIN");
  const peer = canonicalPeer(suppliedPeer);
  if (peer === "unknown") throw new ApiBoundaryError("INVALID_ORIGIN");
  return peer;
}

function rejectQuery(request: FastifyRequest): void {
  if (request.url.includes("?")) throw new ApiBoundaryError("INVALID_REQUEST");
}

/** Also bounds test/broken adapters that neglect the supplied AbortSignal. */
export async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void work.catch(() => undefined); throw new ApiBoundaryError("SOURCE_UNAVAILABLE"); }
  let rejectAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(new ApiBoundaryError("SOURCE_UNAVAILABLE"));
    signal.addEventListener("abort", rejectAbort, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener("abort", rejectAbort); }
}

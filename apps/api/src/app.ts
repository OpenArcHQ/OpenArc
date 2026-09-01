import { BuildInfoSchema } from "@openarc/shared";
import Fastify, { LogController, type FastifyInstance } from "fastify";

import type { ApiConfig } from "./config.js";

export interface CreateAppOptions {
  config: ApiConfig;
  logger?: boolean;
}

export function createApp({ config, logger = config.NODE_ENV !== "test" }: CreateAppOptions): FastifyInstance {
  const app = Fastify({
    logger,
    logController: new LogController({ disableRequestLogging: true }),
    bodyLimit: 16 * 1024,
  });

  const build = BuildInfoSchema.parse({
    service: "openarc-api",
    version: "0.0.0",
    commitSha: config.COMMIT_SHA,
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    reply.header("X-Content-Type-Options", "nosniff");
    return payload;
  });

  app.get("/healthz", { config: { rateLimit: false } }, async () => ({
    status: "ok" as const,
    ...build,
  }));

  app.get("/readyz", { config: { rateLimit: false } }, async () => ({
    ok: true as const,
    status: "ready" as const,
    checks: {
      configuration: "up" as const,
    },
    ...build,
  }));

  app.setNotFoundHandler(async (_request, reply) => {
    await reply.code(404).send({
      error: {
        code: "NOT_FOUND",
        message: "Route not found.",
      },
    });
  });

  return app;
}

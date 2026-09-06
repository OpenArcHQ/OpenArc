import { afterEach, describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function testApp(commitSha = "test-sha") {
  const app = createApp({
    config: loadConfig({
      NODE_ENV: "test",
      COMMIT_SHA: commitSha,
      APP_ORIGIN: "http://localhost:5173",
    }),
    logger: false,
  });
  apps.push(app);
  return app;
}

describe("M00 API shell", () => {
  it("rejects unsafe deployment markers", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "test",
        COMMIT_SHA: "bad marker",
        APP_ORIGIN: "http://localhost:5173",
      }),
    ).toThrow();
  });

  it("exposes a no-store liveness marker", async () => {
    const response = await testApp("abc123").inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      status: "ok",
      service: "openarc-api",
      version: "0.0.0",
      commitSha: "abc123",
    });
  });

  it("reports the configuration-only readiness shell honestly", async () => {
    const response = await testApp().inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      status: "ready",
      checks: { configuration: "up" },
    });
  });

  it("returns bounded no-store errors", async () => {
    const response = await testApp().inject({ method: "GET", url: "/unknown" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({ ok: false,
      error: { code: "NOT_FOUND", message: "Route not found.", retryable: false },
      meta: { schemaVersion: "openarc.api.v1", buildSha: "test-sha" },
    });
  });
});

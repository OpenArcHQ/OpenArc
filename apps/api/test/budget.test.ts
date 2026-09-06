import { createHmac } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createApp, type CompletionLog } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ApiBoundaryError } from "../src/http/errors.js";
import { registerSourceRoute } from "../src/http/source-route.js";
import { canonicalPeer, connectBudgetRedis, redisReconnectDelay, SourceBudget,
  type BudgetEvent, type BudgetOptions } from "../src/limits/budget.js";
import { disposableRedis } from "./redis-fixture.js";

const secret = "m03_synthetic_abuse_secret_not_a_real_credential";
const proxySecret = "synthetic_source_proxy_secret_for_boundary_tests";
const signal = () => new AbortController().signal;
let fixture: Awaited<ReturnType<typeof disposableRedis>>;
let clients: Awaited<ReturnType<typeof connectBudgetRedis>>[];
const options = (extra: Partial<BudgetOptions> = {}): BudgetOptions => ({ secret,
  requestsPerPeerHour: 60, globalUnitsPerDay: 100, maxSubcalls: 8, ...extra });
const abuseKey = (peer: string, route = "arc_account") => `oa:v1:abuse:${createHmac("sha256", secret).update(`${route}\0${canonicalPeer(peer)}`).digest("hex")}`;
const dailyKey = "oa:v1:budget:arc_rpc";

beforeAll(async () => {
  fixture = await disposableRedis();
  clients = await Promise.all([connectBudgetRedis(fixture.url), connectBudgetRedis(fixture.url)]);
  expect(await clients[0]!.info("server")).toMatch(/redis_version:8\./u);
});

describe("M03 reusable source boundary with real Redis (test-only route)", () => {
  const origin = "https://app.example.test";
  const headers = { origin, "x-openarc-client": "browser-v1", "content-type": "application/json",
    "x-openarc-proxy-secret": proxySecret, "x-openarc-proxy-client-ip": "192.0.2.10" };
  const changedHeaders = (mutation: Record<string, string | string[] | undefined>) => Object.fromEntries(
    Object.entries({ ...headers, ...mutation }).filter((entry): entry is [string, string | string[]] => entry[1] !== undefined));
  const metricsToken = "synthetic_metrics_token_for_m03_tests";

  function appFor(budget: SourceBudget | undefined, execute = vi.fn(async () => ({ result: "synthetic" })), enabled = true) {
    const logs: Readonly<CompletionLog>[] = [];
    const app = createApp({ config: loadConfig({ NODE_ENV: "test", APP_ORIGIN: origin, METRICS_TOKEN: metricsToken }),
      logger: false, logSink: (entry) => logs.push(entry) });
    registerSourceRoute(app, { path: "/test/source", source: "arc_rpc", route: "arc_account", enabled,
      appOrigin: origin, proxySecret, budget, timeoutMs: 100, requestSchema: z.strictObject({ fixture: z.literal(true) }),
      responseSchema: z.strictObject({ result: z.literal("synthetic") }), execute });
    return { app, logs, execute };
  }

  it("validates the full request boundary before reserving source capacity", async () => {
    const { app, execute, logs } = appFor(new SourceBudget(clients[0]!, options()));
    try {
      const requests = [
        { headers: { ...headers, origin: "null" }, payload: "{PRIVATE_CANARY" },
        { headers: { ...headers, cookie: "PRIVATE_CANARY" } },
        { headers: { ...headers, "content-type": "text/plain" }, payload: "PRIVATE_CANARY" },
        { headers, payload: "{PRIVATE_CANARY" },
        { headers, payload: JSON.stringify({ private: "PRIVATE_CANARY".repeat(2_000) }) },
        { headers, payload: "[]" }, { headers, payload: '{"fixture":true,"private":"PRIVATE_CANARY"}' },
        { headers, url: "/test/source?private=PRIVATE_CANARY" },
        { headers, method: "PUT" as const },
      ];
      for (const request of requests) {
        const response = await app.inject({ method: "POST", url: "/test/source", payload: '{"fixture":true}', ...request });
        expect(response.statusCode).toBeGreaterThanOrEqual(400);
        expect(response.headers["cache-control"]).toBe("no-store");
        expect(response.body).not.toContain("PRIVATE_CANARY");
      }
      expect(execute).not.toHaveBeenCalled();
      expect(await clients[0]!.exists(dailyKey)).toBe(0);
      expect(JSON.stringify(logs)).not.toContain("PRIVATE_CANARY");
      const good = await app.inject({ method: "POST", url: "/test/source", headers, payload: { fixture: true } });
      expect(good.statusCode).toBe(200);
      expect(execute).toHaveBeenCalledOnce();
      expect(await clients[0]!.hGetAll(dailyKey)).toMatchObject({ attempts: "1", subcalls: "0" });
    } finally { await app.close(); }
  });

  it("isolates authenticated peers and ignores attacker-supplied forwarding headers", async () => {
    const { app, execute } = appFor(new SourceBudget(clients[0]!, options({ requestsPerPeerHour: 2 })));
    try {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const result = await app.inject({ method: "POST", url: "/test/source", payload: { fixture: true },
          headers: { ...headers, "x-forwarded-for": `198.51.100.${attempt + 1}`,
            forwarded: `for=198.51.100.${attempt + 1}` } });
        expect(result.statusCode).toBe(attempt < 2 ? 200 : 429);
      }
      const independent = await app.inject({ method: "POST", url: "/test/source", payload: { fixture: true },
        headers: { ...headers, "x-openarc-proxy-client-ip": "192.0.2.11" } });
      expect(independent.statusCode).toBe(200);
      expect(execute).toHaveBeenCalledTimes(3);
      expect(await clients[0]!.hGetAll(dailyKey)).toMatchObject({ attempts: "3", subcalls: "0" });
    } finally { await app.close(); }
  });

  it("rejects missing, forged, duplicate, or malformed proxy identity before reserving", async () => {
    const { app, execute } = appFor(new SourceBudget(clients[0]!, options()));
    try {
      for (const mutation of [
        { "x-openarc-proxy-secret": undefined }, { "x-openarc-proxy-secret": "x".repeat(proxySecret.length) },
        { "x-openarc-proxy-secret": "é".repeat(proxySecret.length) },
        { "x-openarc-proxy-secret": [proxySecret, proxySecret] }, { "x-openarc-proxy-client-ip": undefined },
        { "x-openarc-proxy-client-ip": "192.0.2.1, 192.0.2.2" },
      ]) {
        const rejected = await app.inject({ method: "POST", url: "/test/source", payload: { fixture: true },
          headers: changedHeaders(mutation) });
        expect(rejected.statusCode).toBe(403);
      }
      expect(execute).not.toHaveBeenCalled();
      expect(await clients[0]!.exists(dailyKey)).toBe(0);
    } finally { await app.close(); }
  });

  it("keeps disabled routes and unavailable stores from parsing or executing", async () => {
    for (const enabled of [false, true]) {
      const { app, execute } = appFor(undefined, undefined, enabled);
      try {
        const result = await app.inject({ method: "POST", url: "/test/source", payload: "{PRIVATE_CANARY", headers });
        expect(result.statusCode).toBe(503);
        expect(result.json().error.code).toBe(enabled ? "BUDGET_STORE_UNAVAILABLE" : "FEATURE_DISABLED");
        expect(execute).not.toHaveBeenCalled();
      } finally { await app.close(); }
    }
    expect(await clients[0]!.exists(dailyKey)).toBe(0);
  });

  it("bounds slow adapters, suppresses late success, and never emits raw adapter failures", async () => {
    for (const execute of [vi.fn(async () => { await delay(160); return { result: "synthetic" }; }),
      vi.fn(async () => { throw new Error("PRIVATE_ADAPTER_CANARY"); }),
      vi.fn(async () => ({ result: "PRIVATE_ADAPTER_CANARY" }))]) {
      const { app, logs } = appFor(new SourceBudget(clients[0]!, options()), execute);
      try {
        const result = await app.inject({ method: "POST", url: "/test/source", payload: { fixture: true }, headers });
        expect(result.statusCode).toBeGreaterThanOrEqual(500);
        expect(result.body).not.toContain("PRIVATE_ADAPTER_CANARY");
        expect(JSON.stringify(logs)).not.toContain("PRIVATE_ADAPTER_CANARY");
        expect(execute).toHaveBeenCalledOnce();
      } finally { await app.close(); }
    }
  });

  it("serves strict preflight without spending source capacity", async () => {
    const { app, execute } = appFor(new SourceBudget(clients[0]!, options()));
    try {
      const result = await app.inject({ method: "OPTIONS", url: "/test/source",
        headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type, x-openarc-client" } });
      expect(result.statusCode).toBe(204);
      expect(result.headers["access-control-allow-origin"]).toBe(origin);
      expect(result.headers["access-control-allow-credentials"]).toBeUndefined();
      expect(result.headers["access-control-max-age"]).toBeUndefined();
      expect(execute).not.toHaveBeenCalled();
      expect(await clients[0]!.exists(dailyKey)).toBe(0);
    } finally { await app.close(); }
  });
});
beforeEach(async () => {
  // Fixture is explicitly disposable. Delete only this suite's versioned keys.
  const keys = await clients[0]!.keys("oa:v1:*");
  if (keys.length) await clients[0]!.del(keys);
});
afterAll(async () => {
  for (const client of clients ?? []) if (client.isOpen) client.destroy();
  await fixture?.stop();
});

describe("M03 real Redis atomic controls", () => {
  it("recovers a dropped budget connection without queueing or retrying commands", async () => {
    expect([0, 1, 2, 3, 4, 5, Number.NaN].map(redisReconnectDelay)).toEqual([100, 200, 400, 800, 1_000, 1_000, 1_000]);
    const reconnecting = await connectBudgetRedis(fixture.url);
    try {
      const originalId = await reconnecting.sendCommand<number>(["CLIENT", "ID"]);
      expect(await clients[0]!.sendCommand(["CLIENT", "KILL", "ID", String(originalId)])).toBe(1);
      let replacementId: number | null = null;
      for (let attempt = 0; attempt < 100 && replacementId === null; attempt += 1) {
        try {
          const candidate = await reconnecting.sendCommand<number>(["CLIENT", "ID"]);
          if (candidate !== originalId) replacementId = candidate;
        } catch { await delay(20); }
      }
      expect(replacementId).not.toBeNull();
      const budget = new SourceBudget(reconnecting, options());
      await expect(budget.begin("arc_rpc", "arc_account", "192.0.2.1", signal())).resolves.toBeDefined();
    } finally { reconnecting.destroy(); }
  });

  it("normalizes authenticated peers without accepting arbitrary or multi-address values", () => {
    expect(canonicalPeer("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(canonicalPeer("::ffff:c000:201")).toBe("192.0.2.1");
    expect(canonicalPeer("2001:0DB8:0:0:0:0:0:1")).toBe("2001:db8::1");
    for (const peer of [undefined, "", "PRIVATE_CANARY", "192.0.2.1,192.0.2.2"]) expect(canonicalPeer(peer)).toBe("unknown");
  });

  it("reserves once per attempt across independent concurrent clients and clamps exhaustion", async () => {
    const budgets = clients.map((client) => new SourceBudget(client, options({ requestsPerPeerHour: 12 })));
    const results = await Promise.allSettled(Array.from({ length: 80 }, (_, index) =>
      budgets[index % 2]!.begin("arc_rpc", "arc_account", "192.0.2.1", signal())));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(12);
    for (const result of results) if (result.status === "rejected") {
      expect(result.reason).toMatchObject({ code: "RATE_LIMITED" });
      expect(result.reason.retryAfterSeconds).toBeGreaterThan(0);
    }
    expect(await clients[0]!.hGetAll(abuseKey("192.0.2.1"))).toMatchObject({ count: "12" });
    expect(await clients[0]!.hGetAll(dailyKey)).toMatchObject({ attempts: "12", subcalls: "0" });
  });

  it("shares the daily source budget across peers and routes; keeps other sources separate", async () => {
    const budgets = clients.map((client) => new SourceBudget(client, options({ globalUnitsPerDay: 7 })));
    const results = await Promise.allSettled(Array.from({ length: 30 }, (_, index) => budgets[index % 2]!
      .begin("arc_rpc", index % 2 ? "arc_account" : "arc_transaction", `192.0.2.${index + 1}`, signal())));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(7);
    for (const result of results) if (result.status === "rejected") expect(result.reason.code).toBe("GLOBAL_BUDGET_EXHAUSTED");
    expect(await clients[0]!.hGetAll(dailyKey)).toMatchObject({ attempts: "7", subcalls: "0" });
    await expect(budgets[0]!.begin("gateway", "gateway_transfer", "192.0.2.1", signal())).resolves.toBeDefined();
  });

  it("caps concurrent lease subcalls and never refunds failed transport", async () => {
    const events: BudgetEvent[] = [];
    const budget = new SourceBudget(clients[0]!, options({ maxSubcalls: 3, observe: (_source, event) => events.push(event) }));
    const lease = await budget.begin("arc_rpc", "arc_account", "192.0.2.1", signal());
    const operation = vi.fn(async () => { throw new Error("PRIVATE_RESPONSE_CANARY"); });
    const results = await Promise.allSettled(Array.from({ length: 30 }, () => lease.dispatch(operation)));
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(operation).toHaveBeenCalledTimes(3);
    expect(await clients[0]!.hGetAll(dailyKey)).toMatchObject({ attempts: "1", subcalls: "3" });
    expect(events.filter((event) => event === "subcall_reserved")).toHaveLength(3);
    expect(events.filter((event) => event === "dispatched")).toHaveLength(3);
    lease.close();
    await expect(lease.dispatch(operation)).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it("enforces one global bound on both route and upstream units", async () => {
    const budget = new SourceBudget(clients[0]!, options({ globalUnitsPerDay: 3 }));
    const lease = await budget.begin("arc_rpc", "arc_account", "192.0.2.1", signal());
    const operation = vi.fn(async () => "ok");
    await lease.dispatch(operation);
    await lease.dispatch(operation);
    await expect(lease.dispatch(operation)).rejects.toMatchObject({ code: "GLOBAL_BUDGET_EXHAUSTED" });
    expect(operation).toHaveBeenCalledTimes(2);
    expect(await clients[0]!.hGetAll(dailyKey)).toMatchObject({ attempts: "1", subcalls: "2" });
  });

  it("uses Redis time, expires at UTC boundaries plus grace, and resets stale windows atomically", async () => {
    const redis = clients[0]!;
    const [seconds] = await redis.sendCommand<string[]>(["TIME"]);
    const now = Number(seconds);
    await redis.hSet(abuseKey("192.0.2.1"), { window: String(Math.floor(now / 3600) - 1), count: "60" });
    await redis.hSet(dailyKey, { window: String(Math.floor(now / 86400) - 1), attempts: "99", subcalls: "1" });
    const budget = new SourceBudget(redis, options());
    const lease = await budget.begin("arc_rpc", "arc_account", "192.0.2.1", signal());
    await lease.dispatch(async () => "ok");
    expect(await redis.hGetAll(abuseKey("192.0.2.1"))).toEqual({ window: String(Math.floor(now / 3600)), count: "1" });
    expect(await redis.hGetAll(dailyKey)).toEqual({ window: String(Math.floor(now / 86400)), attempts: "1", subcalls: "1" });
    const hourExpiry = await redis.sendCommand<number>(["EXPIRETIME", abuseKey("192.0.2.1")]);
    const dayExpiry = await redis.sendCommand<number>(["EXPIRETIME", dailyKey]);
    expect(hourExpiry).toBe((Math.floor(now / 3600) + 1) * 3600 + 60);
    expect(dayExpiry).toBe((Math.floor(now / 86400) + 1) * 86400 + 60);
  });

  it("stores only fixed classes, HMAC keys, time windows, and numeric counters", async () => {
    const budget = new SourceBudget(clients[0]!, options());
    await budget.begin("arc_rpc", "arc_account", "192.0.2.244", signal());
    await budget.begin("arc_rpc", "arc_account", "PRIVATE_PEER_CANARY", signal());
    const keys = await clients[0]!.keys("oa:v1:*");
    const rows = await Promise.all(keys.map(async (key) => [key, await clients[0]!.hGetAll(key)]));
    const serialized = JSON.stringify(rows);
    for (const canary of ["192.0.2.244", "PRIVATE_PEER_CANARY", secret]) expect(serialized).not.toContain(canary);
    for (const key of keys) expect(key).toMatch(/^oa:v1:(?:abuse:[0-9a-f]{64}|budget:arc_rpc)$/u);
    for (const [, row] of rows) for (const value of Object.values(row as Record<string, string>)) expect(value).toMatch(/^\d+$/u);
  });

  it("fails closed on corrupt state, command errors, and a disconnected store", async () => {
    const budget = new SourceBudget(clients[0]!, options());
    await clients[0]!.set(dailyKey, "PRIVATE_REDIS_CANARY");
    await expect(budget.begin("arc_rpc", "arc_account", "192.0.2.1", signal())).rejects
      .toMatchObject({ code: "BUDGET_STORE_UNAVAILABLE", message: "The request-budget store is unavailable." });
    expect(await clients[0]!.exists(abuseKey("192.0.2.1"))).toBe(0);
    await clients[0]!.del(dailyKey);
    await clients[0]!.hSet(dailyKey, { window: "9999999999", attempts: "0", subcalls: "0" });
    await expect(budget.begin("arc_rpc", "arc_account", "192.0.2.1", signal())).rejects.toBeInstanceOf(ApiBoundaryError);
    const offline = await connectBudgetRedis(fixture.url);
    offline.destroy();
    const offlineBudget = new SourceBudget(offline, options());
    expect(await offlineBudget.ready(signal())).toBe(false);
    await expect(offlineBudget.begin("arc_rpc", "arc_account", "192.0.2.1", signal())).rejects.toMatchObject({ code: "BUDGET_STORE_UNAVAILABLE" });
  });

  it("cancels before dispatch, including after a successful reservation", async () => {
    const controller = new AbortController();
    const operation = vi.fn(async () => "not sent");
    const budget = new SourceBudget(clients[0]!, options({ observe: (_source, event) => {
      if (event === "subcall_reserved") controller.abort();
    } }));
    const lease = await budget.begin("arc_rpc", "arc_account", "192.0.2.1", controller.signal);
    await expect(lease.dispatch(operation)).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(operation).not.toHaveBeenCalled();
    expect(await clients[0]!.hGetAll(dailyKey)).toMatchObject({ attempts: "1", subcalls: "1" });
    await expect(budget.begin("arc_rpc", "arc_account", "192.0.2.2", controller.signal)).rejects.toMatchObject({ code: "BUDGET_STORE_UNAVAILABLE" });
    expect(await clients[0]!.exists(abuseKey("192.0.2.2"))).toBe(0);
  });

  it("does not retry or dispatch when Redis stops replying within the command deadline", async () => {
    const budget = new SourceBudget(clients[1]!, options({ commandTimeoutMs: 25 }));
    const lease = await budget.begin("arc_rpc", "arc_account", "192.0.2.1", signal());
    // Hold the fault until dispatch has rejected. A short server-clock pause can
    // expire before its ACK reaches a contended test worker, testing no fault at all.
    // WRITE blocks every EVAL (the budget command) but allows CLIENT UNPAUSE.
    await clients[0]!.sendCommand(["CLIENT", "PAUSE", "10000", "WRITE"]);
    const operation = vi.fn(async () => "not sent");
    try {
      await expect(lease.dispatch(operation)).rejects.toMatchObject({ code: "BUDGET_STORE_UNAVAILABLE" });
      expect(operation).not.toHaveBeenCalled();
    } finally {
      await clients[0]!.sendCommand(["CLIENT", "UNPAUSE"]);
    }
    // Drain the dispatch connection: an already written reservation must finish
    // before inspecting counters, without relying on an arbitrary sleep.
    expect(await clients[1]!.ping()).toBe("PONG");
    expect(operation).not.toHaveBeenCalled();
    // An already written command may reserve once after timeout; no retry/refund.
    const state = await clients[0]!.hGetAll(dailyKey);
    expect(Number(state.subcalls)).toBeLessThanOrEqual(1);
    expect(Number(state.attempts)).toBe(1);
  });

  it.each(["resolve", "reject"] as const)("owns the in-flight command deadline and safely absorbs a late %s", async (outcome) => {
    let resolveReply!: (value: unknown) => void;
    let rejectReply!: (cause: Error) => void;
    const pending = new Promise<unknown>((resolve, reject) => { resolveReply = resolve; rejectReply = reject; });
    // Match a transport that removes its cancellation listener after writing.
    const sendCommand = vi.fn().mockResolvedValueOnce([0, 0]).mockReturnValueOnce(pending);
    const budget = new SourceBudget({ isReady: true, sendCommand }, options({ commandTimeoutMs: 25 }));
    const lease = await budget.begin("arc_rpc", "arc_account", "192.0.2.1", signal());
    const operation = vi.fn(async () => "not sent");
    await expect(lease.dispatch(operation)).rejects.toMatchObject({ code: "BUDGET_STORE_UNAVAILABLE" });
    expect(operation).not.toHaveBeenCalled();
    if (outcome === "resolve") resolveReply([0, 0]);
    else rejectReply(new Error("SYNTHETIC_LATE_TRANSPORT_ERROR"));
    await delay(0);
    expect(operation).not.toHaveBeenCalled();
    expect(sendCommand).toHaveBeenCalledTimes(2);
  });

  it("honors caller cancellation while a written reservation is still waiting for a reply", async () => {
    let resolveReply!: (value: unknown) => void;
    const pending = new Promise<unknown>((resolve) => { resolveReply = resolve; });
    const sendCommand = vi.fn().mockResolvedValueOnce([0, 0]).mockReturnValueOnce(pending);
    const controller = new AbortController();
    const budget = new SourceBudget({ isReady: true, sendCommand }, options({ commandTimeoutMs: 2000 }));
    const lease = await budget.begin("arc_rpc", "arc_account", "192.0.2.1", controller.signal);
    const operation = vi.fn(async () => "not sent");
    const dispatched = lease.dispatch(operation);
    controller.abort();
    await expect(dispatched).rejects.toMatchObject({ code: "BUDGET_STORE_UNAVAILABLE" });
    resolveReply([0, 0]); await delay(0);
    expect(operation).not.toHaveBeenCalled(); expect(sendCommand).toHaveBeenCalledTimes(2);
  });
});

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer as httpServer, type ServerResponse } from "node:http";
import { connect, createServer as tcpServer, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ARC_ACCOUNT_SNAPSHOT_PATH, ARC_TESTNET } from "@openarc/shared";
import { createApp, type CompletionLog } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { ArcAccountService } from "../src/arc/account-service.js";
import { ArcTransactionService } from "../src/arc/transaction-service.js";
import type { ArcRpcReader } from "../src/arc/rpc-client.js";
import { connectBudgetRedis, SourceBudget } from "../src/limits/budget.js";
import { disposableRedis } from "./redis-fixture.js";

const origin = "https://app.example.test";
const proxySecret = "synthetic_operations_proxy_secret_0001";
const metricsToken = "synthetic_operations_metrics_token_0001";
const abuseSecret = "synthetic_operations_abuse_secret_0001";
const canary = "PRIVATE_OPERATIONS_BODY_CANARY";
const build = "a".repeat(40);
const address = `0x${"1".repeat(40)}`;
const headers = { origin, "x-openarc-client": "browser-v1", "content-type": "application/json",
  "x-openarc-proxy-secret": proxySecret, "x-openarc-proxy-client-ip": "192.0.2.117" };
let redis: Awaited<ReturnType<typeof disposableRedis>>;
let administration: Awaited<ReturnType<typeof connectBudgetRedis>>;
const ownKeys = new Set<string>();
const cleanup: (() => Promise<unknown>)[] = [];
beforeAll(async () => { redis = await disposableRedis(); administration = await connectBudgetRedis(redis.url); });
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  if (ownKeys.size) await administration.del([...ownKeys]);
  ownKeys.clear();
});
afterAll(async () => { if (administration?.isOpen) administration.destroy(); await redis?.stop(); });

async function json(url: string, options?: RequestInit) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(2_000) });
  const body = await response.json(); return { status: response.status, body, headers: response.headers };
}
const observe = (base: string, body: unknown = { network: ARC_TESTNET.caip2, address }) =>
  json(`${base}${ARC_ACCOUNT_SNAPSHOT_PATH}`, { method: "POST", headers, body: JSON.stringify(body) });

/** Faults only this suite's sockets. Never pauses/kills/flushed the shared CI Redis. */
async function isolatedTransport() {
  const upstream = new URL(redis.url); const sockets = new Set<Socket>();
  let mode: "normal" | "drop" | "stall" = "normal";
  const server = tcpServer(client => {
    sockets.add(client); client.on("error", () => undefined); client.on("close", () => sockets.delete(client));
    if (mode === "drop") { client.destroy(); return; }
    const target = connect({ host: upstream.hostname, port: Number(upstream.port || 6379) });
    sockets.add(target); target.on("error", () => client.destroy()); target.on("close", () => { sockets.delete(target); client.destroy(); });
    client.on("close", () => target.destroy());
    client.on("data", data => { if (mode === "normal") target.write(data); });
    target.on("data", data => { if (mode === "normal") client.write(data); });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const bound = server.address(); if (!bound || typeof bound === "string") throw new Error("Missing loopback transport");
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { url: `redis://127.0.0.1:${bound.port}`, setMode(next: typeof mode) { mode = next; if (next !== "normal") for (const socket of sockets) {
    if (next === "drop") socket.destroy();
  } } };
}

async function fixtureProvider() {
  let calls = 0; let stall = false; const responses = new Set<ServerResponse>();
  const server = httpServer(async (request, response) => {
    calls += 1; responses.add(response); response.on("close", () => responses.delete(response));
    let bytes = ""; for await (const chunk of request) { bytes += String(chunk); if (bytes.length > 4096) { response.writeHead(413).end(); return; } }
    if (stall) return;
    const { method } = JSON.parse(bytes) as { method: string };
    const result = method === "eth_chainId" ? ARC_TESTNET.chainIdHex :
      method === "eth_getBlockByNumber" ? { number: "0x64", hash: `0x${"a".repeat(64)}`, timestamp: "0x66d70000" } :
      method === "eth_getBalance" ? "0x0" : method === "eth_call" ? `0x${"0".repeat(64)}` : null;
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const bound = server.address(); if (!bound || typeof bound === "string") throw new Error("Missing loopback fixture");
  cleanup.push(async () => { for (const response of responses) response.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const rpc: ArcRpcReader = { call: (method, params, lease, signal) => lease.dispatch(async () => {
    const response = await fetch(`http://127.0.0.1:${bound.port}`, { method: "POST", body: JSON.stringify({ method, params }), signal });
    return (await response.json() as { result: unknown }).result;
  }, signal) };
  return { rpc, calls: () => calls, stall: () => { stall = true; } };
}

async function api(transportUrl: string, namespace: string, rpc: ArcRpcReader, units = 100, enabled = true) {
  const client = await connectBudgetRedis(transportUrl);
  cleanup.push(async () => { if (client.isOpen) client.destroy(); });
  // Test-only namespace isolation: delegate unchanged production Lua and every
  // response to real Redis. Instances/restarts deliberately share this prefix.
  const executor = { get isReady() { return client.isReady; }, sendCommand(args: string[], options: { abortSignal: AbortSignal; timeout: number }) {
    const command = [...args];
    if (command[0] === "EVAL") for (let index = 3; index < 3 + Number(command[2]); index += 1) {
      command[index] = `${namespace}:${command[index]}`; ownKeys.add(command[index]);
    }
    return client.sendCommand(command, options);
  } };
  const budget = new SourceBudget(executor, { secret: abuseSecret, requestsPerPeerHour: 100, globalUnitsPerDay: units, maxSubcalls: 8, commandTimeoutMs: 100 });
  const logs: Readonly<CompletionLog>[] = [];
  const app = createApp({ config: loadConfig({ NODE_ENV: "test", APP_ORIGIN: origin, COMMIT_SHA: build, API_BOUNDARY_ENABLED: "true",
    ARC_OBSERVATION_ENABLED: String(enabled), REDIS_URL: transportUrl, ABUSE_LIMIT_SECRET: abuseSecret,
    SOURCE_PROXY_SECRET: proxySecret, METRICS_TOKEN: metricsToken, SOURCE_TIMEOUT_MS: "150" }),
    sourceBudget: budget, arcAccountService: new ArcAccountService(rpc), arcTransactionService: new ArcTransactionService(rpc),
    logger: false, logSink: entry => logs.push(entry) });
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanup.push(() => app.close());
  return { app, base, logs, client };
}

describe("M10 running HTTP API with real Redis and isolated loopback source fixtures", () => {
  it("keeps liveness up and readiness closed during transport outage, without replay after reconnect", async () => {
    const transport = await isolatedTransport(); const provider = await fixtureProvider();
    const running = await api(transport.url, `m10:${randomUUID()}`, provider.rpc);
    expect((await json(`${running.base}/readyz`)).status).toBe(200);
    transport.setMode("drop");
    await expect.poll(async () => (await json(`${running.base}/readyz`)).status, { timeout: 2000 }).toBe(503);
    expect((await json(`${running.base}/healthz`)).body).toMatchObject({ status: "ok", commitSha: build });
    const rejected = await observe(running.base); expect(rejected.status).toBe(503); expect(provider.calls()).toBe(0);
    transport.setMode("normal");
    await expect.poll(async () => (await json(`${running.base}/readyz`)).status, { timeout: 2500 }).toBe(200);
    expect(provider.calls()).toBe(0);
    expect((await observe(running.base)).status).toBe(200); expect(provider.calls()).toBe(5);
  });

  it("shares exact budgets across two HTTP instances and an instance restart", async () => {
    const transport = await isolatedTransport(); const provider = await fixtureProvider(); const namespace = `m10:${randomUUID()}`;
    const first = await api(transport.url, namespace, provider.rpc, 12); const second = await api(transport.url, namespace, provider.rpc, 12);
    expect((await observe(first.base)).status).toBe(200); expect((await observe(second.base)).status).toBe(200);
    expect(provider.calls()).toBe(10);
    await first.app.close(); first.client.destroy();
    const restarted = await api(transport.url, namespace, provider.rpc, 12);
    for (const instance of [restarted, second]) {
      const exhausted = await observe(instance.base);
      expect(exhausted.status).toBe(503); expect(exhausted.body.error.code).toBe("GLOBAL_BUDGET_EXHAUSTED");
      expect(Number(exhausted.headers.get("retry-after"))).toBeGreaterThan(0);
    }
    expect(provider.calls()).toBe(10);
  });

  it("a restarted disabled connector sends nothing and reports source checks not required", async () => {
    const transport = await isolatedTransport(); const provider = await fixtureProvider(); const namespace = `m10:${randomUUID()}`;
    const initial = await api(transport.url, namespace, provider.rpc);
    expect((await observe(initial.base)).status).toBe(200); await initial.app.close(); initial.client.destroy();
    const disabled = await api(transport.url, namespace, provider.rpc, 100, false);
    const killed = await observe(disabled.base, { private: canary });
    expect(killed.status).toBe(503); expect(killed.body.error.code).toBe("FEATURE_DISABLED");
    expect((await json(`${disabled.base}/readyz`)).body.checks).toMatchObject({ sourceRoutes: "disabled", redis: "not_required" });
    expect(provider.calls()).toBe(5);
  });

  it("bounds Redis and provider stalls over HTTP and keeps canaries out of errors, logs and metrics", async () => {
    const transport = await isolatedTransport(); const provider = await fixtureProvider(); const running = await api(transport.url, `m10:${randomUUID()}`, provider.rpc);
    const invalid = await observe(running.base, { private: canary }); expect(invalid.status).toBe(400);
    transport.setMode("stall");
    const start = performance.now(); const unavailable = await observe(running.base);
    expect(performance.now() - start).toBeLessThan(1000); expect(unavailable.status).toBe(503);
    expect(unavailable.body.error.code).toBe("BUDGET_STORE_UNAVAILABLE"); expect(provider.calls()).toBe(0);
    expect((await json(`${running.base}/readyz`)).status).toBe(503); expect((await json(`${running.base}/healthz`)).status).toBe(200);
    transport.setMode("drop"); transport.setMode("normal");
    await expect.poll(async () => (await json(`${running.base}/readyz`)).status, { timeout: 2500 }).toBe(200);
    provider.stall(); const sourceStart = performance.now(); const timeout = await observe(running.base);
    expect(performance.now() - sourceStart).toBeLessThan(1000); expect(timeout.status).toBe(503); expect(provider.calls()).toBe(1);
    expect(timeout.body.error.code).toBe("SOURCE_UNAVAILABLE");
    const metrics = await fetch(`${running.base}/metrics`, { headers: { authorization: `Bearer ${metricsToken}` }, signal: AbortSignal.timeout(2000) });
    expect(metrics.status).toBe(200);
    const metricsText = await metrics.text();
    for (const code of ["INVALID_REQUEST", "BUDGET_STORE_UNAVAILABLE", "SOURCE_UNAVAILABLE"]) {
      expect(metricsText).toContain(`openarc_api_failures_total{route="arc_account",code="${code}"} 1`);
      expect(running.logs.filter(entry => entry.failureCode === code)).toHaveLength(1);
    }
    const output = JSON.stringify([invalid.body, unavailable.body, timeout.body, running.logs, metricsText]);
    for (const value of [canary, address, proxySecret, abuseSecret, metricsToken]) expect(output).not.toContain(value);
    expect(provider.calls()).toBe(1);
  });
});

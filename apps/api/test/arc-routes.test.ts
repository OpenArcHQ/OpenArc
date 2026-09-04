import { ARC_TESTNET, ArcAccountSnapshotSchema, ArcTransactionEvidenceSchema } from "@openarc/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ArcAccountService } from "../src/arc/account-service.js";
import type { ArcTransactionService } from "../src/arc/transaction-service.js";
import { createApp } from "../src/app.js";
import type { CompletionLog } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { SourceLease, type SourceBudget } from "../src/limits/budget.js";

const origin = "https://app.example.test";
const address = "0x1111111111111111111111111111111111111111";
const transactionHash = `0x${"b".repeat(64)}`;
const blockHash = `0x${"a".repeat(64)}`;
const metricsToken = "synthetic_metrics_token_for_m04_tests";
const proxySecret = "synthetic_source_proxy_secret_for_m04_tests";
const headers = { origin, "x-openarc-client": "browser-v1", "content-type": "application/json",
  "x-openarc-proxy-secret": proxySecret, "x-openarc-proxy-client-ip": "192.0.2.10" };
const changedHeaders = (mutation: Record<string, string | undefined>) => Object.fromEntries(
  Object.entries({ ...headers, ...mutation }).filter((entry): entry is [string, string] => entry[1] !== undefined));
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const source = { sourceId: "arc_primary_rpc", origin: ARC_TESTNET.rpcHttp,
  explorerOrigin: ARC_TESTNET.explorerOrigin, network: ARC_TESTNET.caip2,
  sourceRevision: ARC_TESTNET.sourceRevision, observedAt: "2026-09-03T12:00:00Z",
  adapterVersion: "openarc.arc-observation.m04.v1" } as const;
const anchor = { blockNumber: "100", blockHash, blockTimestamp: "2026-09-03T11:59:59Z",
  finality: "deterministic", confirmations: "1" } as const;
const account = ArcAccountSnapshotSchema.parse({ schemaVersion: "openarc.arc-account-snapshot.v1",
  network: ARC_TESTNET.caip2, address, anchor,
  nativeUsdc: { asset: "USDC", interface: "native", amount: { baseUnits: "1", decimals: 18, decimal: "0.000000000000000001" } },
  erc20UsdcView: { asset: "USDC", interface: "erc20", contract: ARC_TESTNET.contracts.usdc,
    amount: { baseUnits: "0", decimals: 6, decimal: "0" }, relationship: "same_underlying_balance",
    truncatesSubMicroUsdc: true }, source,
  limitations: ["This is a read-only observation at one exact Arc Testnet block.",
    "The 6-decimal ERC-20 view truncates native precision below one micro-USDC.",
    "A public address is not proof that its owner or controller is an agent."] });
const transaction = ArcTransactionEvidenceSchema.parse({ schemaVersion: "openarc.arc-transaction-evidence.v1",
  network: ARC_TESTNET.caip2,
  transaction: { hash: transactionHash, blockNumber: "100", blockHash, transactionIndex: "0",
    from: address, to: null, nativeValue: { baseUnits: "0", decimals: 18, decimal: "0" } },
  receipt: { status: "success", gasUsed: "1",
    effectiveGasPrice: { baseUnits: "1", decimals: 18, decimal: "0.000000000000000001" },
    fee: { baseUnits: "1", decimals: 18, decimal: "0.000000000000000001" } },
  anchor, movements: [], coverage: { totalLogs: 0, canonicalMovements: 0,
    corroboratedMovements: 0, unsupportedLogs: 0, completeForUsdcTransfers: true }, source,
  limitations: ["This is a read-only observation of one Arc Testnet transaction and receipt.",
    "EIP-7708 system events are canonical; matching ERC-20 events are corroboration, not additional movements.",
    "Transaction inclusion does not prove intent, authorization, fulfillment, or service quality."] });

function setup(ready = true) {
  const logs: CompletionLog[] = [];
  const begin = vi.fn(async (sourceClass: "arc_rpc", _route: "arc_account" | "arc_transaction",
    _peer: string | undefined, signal: AbortSignal) => new SourceLease(sourceClass, 8, async () => undefined, signal));
  const budget = { begin, ready: vi.fn(async () => ready) } as unknown as SourceBudget;
  const accountObserve = vi.fn(async () => account);
  const transactionObserve = vi.fn(async () => transaction);
  const config = loadConfig({ NODE_ENV: "test", APP_ORIGIN: origin, COMMIT_SHA: "test-sha",
    API_BOUNDARY_ENABLED: "true", ARC_OBSERVATION_ENABLED: "true", REDIS_URL: "redis://127.0.0.1:6379",
    ABUSE_LIMIT_SECRET: "synthetic_abuse_secret_for_m04_tests", SOURCE_PROXY_SECRET: proxySecret,
    METRICS_TOKEN: metricsToken });
  const app = createApp({ config, sourceBudget: budget, logSink: (entry) => logs.push(entry),
    arcAccountService: { observe: accountObserve } as unknown as ArcAccountService,
    arcTransactionService: { observe: transactionObserve } as unknown as ArcTransactionService });
  apps.push(app);
  return { app, budget, begin, accountObserve, transactionObserve, logs };
}

describe("M04 source routes", () => {
  it("reports exact capability/readiness truth and serves both strict no-store envelopes", async () => {
    const { app, begin, accountObserve, transactionObserve, logs } = setup();
    const capabilities = await app.inject({ method: "GET", url: "/v1/private/capabilities",
      headers: { origin, "x-openarc-client": "browser-v1" } });
    expect(capabilities.json().data).toMatchObject({ capabilityVersion: "openarc.capabilities.m04.v1",
      enabledConnectors: ["arc_primary_rpc"], features: { arcObservation: true } });
    const readiness = await app.inject({ method: "GET", url: "/readyz" });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json().checks).toEqual({ configuration: "up", sourceRoutes: "enabled", redis: "up" });

    const accountResponse = await app.inject({ method: "POST", url: "/v1/private/arc/account-snapshot",
      headers, payload: { network: ARC_TESTNET.caip2, address } });
    expect(accountResponse.statusCode).toBe(200);
    expect(accountResponse.headers["cache-control"]).toBe("no-store");
    expect(accountResponse.json().data).toEqual(account);
    expect(accountObserve).toHaveBeenCalledOnce();

    const transactionResponse = await app.inject({ method: "POST", url: "/v1/private/arc/transaction-evidence",
      headers, payload: { network: ARC_TESTNET.caip2, transactionHash } });
    expect(transactionResponse.statusCode).toBe(200);
    expect(transactionResponse.json().data).toEqual(transaction);
    expect(transactionObserve).toHaveBeenCalledOnce();
    expect(begin).toHaveBeenNthCalledWith(1, "arc_rpc", "arc_account", "192.0.2.10", expect.any(AbortSignal));
    expect(begin).toHaveBeenNthCalledWith(2, "arc_rpc", "arc_transaction", "192.0.2.10", expect.any(AbortSignal));

    const metrics = await app.inject({ method: "GET", url: "/metrics",
      headers: { authorization: `Bearer ${metricsToken}` } });
    expect(metrics.body).toContain("openarc_source_routes_enabled 1");
    expect(metrics.body).toContain("openarc_redis_required 1");
    expect(JSON.stringify(logs)).not.toContain(address);
    expect(JSON.stringify(logs)).not.toContain(transactionHash);
    expect(JSON.stringify(logs)).not.toContain(ARC_TESTNET.rpcHttp);
  });

  it("rejects malformed identifiers before adapter execution or capacity reservation", async () => {
    const { app, begin, accountObserve, transactionObserve } = setup();
    for (const request of [
      { url: "/v1/private/arc/account-snapshot", payload: { network: ARC_TESTNET.caip2, address: "PRIVATE_CANARY" } },
      { url: "/v1/private/arc/transaction-evidence", payload: { network: ARC_TESTNET.caip2, transactionHash, rpcUrl: "https://evil.test" } },
    ]) {
      const response = await app.inject({ method: "POST", headers, ...request });
      expect(response.statusCode).toBe(400);
      expect(response.json().error.code).toBe("INVALID_REQUEST");
      expect(response.body).not.toContain("PRIVATE_CANARY");
    }
    expect(begin).not.toHaveBeenCalled();
    expect(accountObserve).not.toHaveBeenCalled();
    expect(transactionObserve).not.toHaveBeenCalled();
  });

  it("requires the authenticated web-proxy identity before capacity reservation", async () => {
    const { app, begin, accountObserve } = setup();
    for (const mutation of [
      { "x-openarc-proxy-secret": undefined }, { "x-openarc-proxy-secret": "x".repeat(proxySecret.length) },
      { "x-openarc-proxy-client-ip": "not-an-address" },
    ]) {
      const response = await app.inject({ method: "POST", url: "/v1/private/arc/account-snapshot",
        headers: changedHeaders(mutation), payload: { network: ARC_TESTNET.caip2, address } });
      expect(response.statusCode).toBe(403);
    }
    expect(begin).not.toHaveBeenCalled();
    expect(accountObserve).not.toHaveBeenCalled();
  });

  it("fails readiness closed when the required budget store is down", async () => {
    const { app } = setup(false);
    const response = await app.inject({ method: "GET", url: "/readyz" });
    expect(response.statusCode).toBe(503);
    expect(response.json().checks).toEqual({ configuration: "up", sourceRoutes: "enabled", redis: "down" });
  });
});

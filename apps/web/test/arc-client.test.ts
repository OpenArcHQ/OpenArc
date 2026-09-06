import {
  API_CLIENT_HEADER,
  API_SCHEMA_VERSION,
  ARC_ACCOUNT_SNAPSHOT_PATH,
  ARC_TESTNET,
  ARC_TRANSACTION_EVIDENCE_PATH,
} from "@openarc/shared";
import { describe, expect, it, vi } from "vitest";

import { requestArcAccountSnapshot, requestArcTransactionEvidence } from "../src/api/arc-observation.js";

const address = "0x1111111111111111111111111111111111111111";
const to = "0x2222222222222222222222222222222222222222";
const transactionHash = `0x${"b".repeat(64)}`;
const blockHash = `0x${"a".repeat(64)}`;
const meta = { schemaVersion: API_SCHEMA_VERSION,
  requestId: "11111111-1111-4111-8111-111111111111", buildSha: "test-sha" };
const anchor = { blockNumber: "100", blockHash, blockTimestamp: "2026-09-03T11:59:59Z",
  finality: "deterministic", confirmations: "1" };
const source = { sourceId: "arc_primary_rpc", origin: ARC_TESTNET.rpcHttp,
  explorerOrigin: ARC_TESTNET.explorerOrigin, network: ARC_TESTNET.caip2,
  sourceRevision: ARC_TESTNET.sourceRevision, observedAt: "2026-09-03T12:00:00Z",
  adapterVersion: "openarc.arc-observation.m04.v1" };
const native = { baseUnits: "0", decimals: 18, decimal: "0" };

const accountEnvelope = { ok: true, meta, data: { schemaVersion: "openarc.arc-account-snapshot.v1",
  network: ARC_TESTNET.caip2, address, anchor,
  nativeUsdc: { asset: "USDC", interface: "native", amount: native },
  erc20UsdcView: { asset: "USDC", interface: "erc20", contract: ARC_TESTNET.contracts.usdc,
    amount: { baseUnits: "0", decimals: 6, decimal: "0" }, relationship: "same_underlying_balance",
    truncatesSubMicroUsdc: true }, source,
  limitations: ["This is a read-only observation at one exact Arc Testnet block.",
    "The 6-decimal ERC-20 view truncates native precision below one micro-USDC.",
    "A public address is not proof that its owner or controller is an agent."] } };

const transactionEnvelope = { ok: true, meta, data: { schemaVersion: "openarc.arc-transaction-evidence.v1",
  network: ARC_TESTNET.caip2,
  transaction: { hash: transactionHash, blockNumber: "100", blockHash, transactionIndex: "0",
    from: address, to, nativeValue: native },
  receipt: { status: "success", gasUsed: "1", effectiveGasPrice: native, fee: native }, anchor,
  movements: [], coverage: { totalLogs: 0, canonicalMovements: 0, corroboratedMovements: 0,
    unsupportedLogs: 0, completeForUsdcTransfers: true }, source,
  limitations: ["This is a read-only observation of one Arc Testnet transaction and receipt.",
    "EIP-7708 system events are canonical; matching ERC-20 events are corroboration, not additional movements.",
    "Transaction inclusion does not prove intent, authorization, fulfillment, or service quality."] } };

function json(value: unknown) {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

describe("M04 browser observation client", () => {
  it("uses only fixed same-origin POST routes with one public identifier and no credentials", async () => {
    const accountFetch = vi.fn(async () => json(accountEnvelope));
    await requestArcAccountSnapshot({ network: ARC_TESTNET.caip2, address },
      new AbortController().signal, accountFetch);
    expect(accountFetch).toHaveBeenCalledWith(ARC_ACCOUNT_SNAPSHOT_PATH, {
      method: "POST", headers: { "X-OpenArc-Client": API_CLIENT_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ network: ARC_TESTNET.caip2, address }), credentials: "omit", redirect: "error",
      cache: "no-store", referrerPolicy: "no-referrer", signal: expect.any(AbortSignal),
    });

    const transactionFetch = vi.fn(async () => json(transactionEnvelope));
    await requestArcTransactionEvidence({ network: ARC_TESTNET.caip2, transactionHash },
      new AbortController().signal, transactionFetch);
    const [, options] = transactionFetch.mock.calls[0]!;
    expect(transactionFetch.mock.calls[0]![0]).toBe(ARC_TRANSACTION_EVIDENCE_PATH);
    expect(JSON.parse(String(options.body))).toEqual({ network: ARC_TESTNET.caip2, transactionHash });
    expect(options.credentials).toBe("omit");
  });

  it("fails before contact for unknown or malformed request fields", async () => {
    const fetcher = vi.fn(async () => json(accountEnvelope));
    await expect(requestArcAccountSnapshot({ network: ARC_TESTNET.caip2,
      address: "not-an-address" } as never, new AbortController().signal, fetcher))
      .rejects.toMatchObject({ code: "INVALID_REQUEST", phase: "pre-send" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects wrong-subject, widened, or cross-route source responses", async () => {
    for (const response of [
      { ...accountEnvelope, data: { ...accountEnvelope.data, address: to } },
      { ...accountEnvelope, data: { ...accountEnvelope.data, rawProvider: { canary: true } } },
      transactionEnvelope,
    ]) await expect(requestArcAccountSnapshot({ network: ARC_TESTNET.caip2, address },
      new AbortController().signal, async () => json(response)))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE", phase: "post-send" });
  });
});

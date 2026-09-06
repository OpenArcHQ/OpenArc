import { describe, expect, it } from "vitest";

import {
  API_SCHEMA_VERSION,
  ARC_TESTNET,
  ArcAccountSnapshotEnvelopeSchema,
  ArcAccountSnapshotRequestSchema,
  ArcTransactionEvidenceEnvelopeSchema,
  ArcTransactionEvidenceRequestSchema,
} from "../src/index.js";

const addressA = "0x1111111111111111111111111111111111111111";
const addressB = "0x2222222222222222222222222222222222222222";
const hash = `0x${"a".repeat(64)}`;
const txHash = `0x${"b".repeat(64)}`;
const meta = { schemaVersion: API_SCHEMA_VERSION,
  requestId: "11111111-1111-4111-8111-111111111111", buildSha: "test-sha" };
const source = { sourceId: "arc_primary_rpc", origin: ARC_TESTNET.rpcHttp,
  explorerOrigin: ARC_TESTNET.explorerOrigin, network: ARC_TESTNET.caip2,
  sourceRevision: ARC_TESTNET.sourceRevision, observedAt: "2026-09-03T12:00:00Z",
  adapterVersion: "openarc.arc-observation.m04.v1" };
const anchor = { blockNumber: "100", blockHash: hash, blockTimestamp: "2026-09-03T11:59:59Z",
  finality: "deterministic", confirmations: "1" };
const native = { baseUnits: "1000000000000000000", decimals: 18, decimal: "1" };
const erc20 = { baseUnits: "1000000", decimals: 6, decimal: "1" };

describe("M04 shared Arc observation contracts", () => {
  it("canonicalizes one public identifier and rejects unknown request fields", () => {
    expect(ArcAccountSnapshotRequestSchema.parse({ network: ARC_TESTNET.caip2,
      address: addressA.toUpperCase().replace("0X", "0x") })).toEqual({ network: ARC_TESTNET.caip2, address: addressA });
    expect(ArcTransactionEvidenceRequestSchema.parse({ network: ARC_TESTNET.caip2,
      transactionHash: txHash.toUpperCase().replace("0X", "0x") })).toEqual({ network: ARC_TESTNET.caip2, transactionHash: txHash });
    for (const input of [
      { network: "eip155:1", address: addressA },
      { network: ARC_TESTNET.caip2, address: addressA, private: true },
      { network: ARC_TESTNET.caip2, transactionHash: txHash, rpcUrl: "https://evil.test" },
    ]) {
      const schema = "address" in input ? ArcAccountSnapshotRequestSchema : ArcTransactionEvidenceRequestSchema;
      expect(schema.safeParse(input).success).toBe(false);
    }
  });

  it("accepts exact account and transaction envelopes and rejects raw provider additions", () => {
    const account = { ok: true, meta, data: { schemaVersion: "openarc.arc-account-snapshot.v1",
      network: ARC_TESTNET.caip2, address: addressA, anchor,
      nativeUsdc: { asset: "USDC", interface: "native", amount: native },
      erc20UsdcView: { asset: "USDC", interface: "erc20", contract: ARC_TESTNET.contracts.usdc,
        amount: erc20, relationship: "same_underlying_balance", truncatesSubMicroUsdc: true }, source,
      limitations: ["This is a read-only observation at one exact Arc Testnet block.",
        "The 6-decimal ERC-20 view truncates native precision below one micro-USDC.",
        "A public address is not proof that its owner or controller is an agent."] } };
    expect(ArcAccountSnapshotEnvelopeSchema.safeParse(account).success).toBe(true);
    expect(ArcAccountSnapshotEnvelopeSchema.safeParse({ ...account,
      data: { ...account.data, rawProvider: {} } }).success).toBe(false);

    const transaction = { ok: true, meta, data: { schemaVersion: "openarc.arc-transaction-evidence.v1",
      network: ARC_TESTNET.caip2,
      transaction: { hash: txHash, blockNumber: "100", blockHash: hash, transactionIndex: "2",
        from: addressA, to: addressB, nativeValue: { ...native, baseUnits: "0", decimal: "0" } },
      receipt: { status: "success", gasUsed: "21000",
        effectiveGasPrice: { ...native, baseUnits: "20000000000", decimal: "0.00000002" },
        fee: { ...native, baseUnits: "420000000000000", decimal: "0.00042" } }, anchor,
      movements: [{ classification: "canonical_eip7708_usdc", emitter: ARC_TESTNET.usdcSystemEmitter,
        logIndex: "0", from: addressA, to: addressB, amount: native,
        erc20Corroboration: { emitter: ARC_TESTNET.contracts.usdc, logIndex: "1", amount: erc20 } }],
      coverage: { totalLogs: 2, canonicalMovements: 1, corroboratedMovements: 1,
        unsupportedLogs: 0, completeForUsdcTransfers: true }, source,
      limitations: ["This is a read-only observation of one Arc Testnet transaction and receipt.",
        "EIP-7708 system events are canonical; matching ERC-20 events are corroboration, not additional movements.",
        "Transaction inclusion does not prove intent, authorization, fulfillment, or service quality."] } };
    expect(ArcTransactionEvidenceEnvelopeSchema.safeParse(transaction).success).toBe(true);
    for (const mutation of [
      { movements: [...transaction.data.movements, { ...transaction.data.movements[0], emitter: ARC_TESTNET.contracts.usdc }] },
      { coverage: { ...transaction.data.coverage, completeForUsdcTransfers: false } },
      { source: { ...source, origin: "https://evil.test" } },
      { rawReceipt: {} },
    ]) expect(ArcTransactionEvidenceEnvelopeSchema.safeParse({ ...transaction,
      data: { ...transaction.data, ...mutation } }).success).toBe(false);
  });
});

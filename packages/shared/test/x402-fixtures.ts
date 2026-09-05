import { ARC_TESTNET } from "../src/network.js";
import { ArcTransactionEvidenceSchema } from "../src/arc-observation.js";
import type { GatewayTransferObservation, X402ReceiptBundle } from "../src/x402-evidence.js";

export const x402Bundle = (): X402ReceiptBundle => ({
  schemaVersion: "openarc.x402-receipt-bundle.v1", bundleId: "11111111-1111-4111-8111-111111111111",
  capturedAt: "2026-09-05T12:00:01Z", provenance: "imported_metadata", authentication: "not_verified",
  resource: { originDigest: `sha256:${"a".repeat(64)}`, resourceDigest: `sha256:${"b".repeat(64)}` },
  requirement: { x402Version: 2, scheme: "exact", network: ARC_TESTNET.caip2, asset: ARC_TESTNET.contracts.usdc,
    domainName: "GatewayWalletBatched", domainVersion: "1", verifyingContract: ARC_TESTNET.contracts.gatewayWallet,
    payTo: `0x${"2".repeat(40)}`, amount: "9007199254740993123456789", maxTimeoutSeconds: "60" },
  authorizationMetadata: { network: ARC_TESTNET.caip2, asset: ARC_TESTNET.contracts.usdc,
    domainName: "GatewayWalletBatched", domainVersion: "1", verifyingContract: ARC_TESTNET.contracts.gatewayWallet,
    from: `0x${"1".repeat(40)}`, to: `0x${"2".repeat(40)}`, value: "9007199254740993123456789",
    nonce: `0x${"c".repeat(64)}`, validAfter: "1788609599", validBefore: "1788609601" },
  responseMetadata: { respondedAt: "2026-09-05T12:00:00Z", httpStatus: 200, reportedSuccess: true,
    responseDigest: `sha256:${"d".repeat(64)}`, transferId: "22222222-2222-4222-8222-222222222222" },
});
export const gatewayObservation = (): GatewayTransferObservation => ({
  schemaVersion: "openarc.gateway-transfer-observation.v1", network: ARC_TESTNET.caip2,
  transfer: { id: "22222222-2222-4222-8222-222222222222", status: "completed", token: "USDC",
    sendingNetwork: ARC_TESTNET.caip2, recipientNetwork: ARC_TESTNET.caip2,
    fromAddress: `0x${"1".repeat(40)}`, toAddress: `0x${"2".repeat(40)}`, amount: "9007199254740993123456789",
    nonce: `0x${"c".repeat(64)}`, txHash: `0x${"e".repeat(64)}`,
    createdAt: "2026-09-05T12:00:00Z", updatedAt: "2026-09-05T12:00:01Z" },
  source: { sourceId: "circle_gateway_testnet", origin: "https://gateway-api-testnet.circle.com",
    observedAt: "2026-09-05T12:00:02Z", adapterVersion: "openarc.gateway-transfer.m07.v1" },
});

export const batchObservation = () => {
  const amount = { baseUnits: "0", decimals: 18, decimal: "0" };
  return ArcTransactionEvidenceSchema.parse({ schemaVersion: "openarc.arc-transaction-evidence.v1", network: ARC_TESTNET.caip2,
    transaction: { hash: `0x${"e".repeat(64)}`, blockNumber: "100", blockHash: `0x${"f".repeat(64)}`,
      transactionIndex: "0", from: `0x${"3".repeat(40)}`, to: ARC_TESTNET.contracts.gatewayWallet, nativeValue: amount },
    receipt: { status: "success", gasUsed: "0", effectiveGasPrice: amount, fee: amount },
    anchor: { blockNumber: "100", blockHash: `0x${"f".repeat(64)}`, blockTimestamp: "2026-09-05T12:00:01Z", finality: "deterministic", confirmations: "1" },
    movements: [], coverage: { totalLogs: 0, canonicalMovements: 0, corroboratedMovements: 0, unsupportedLogs: 0, completeForUsdcTransfers: true },
    source: { sourceId: "arc_primary_rpc", origin: ARC_TESTNET.rpcHttp, explorerOrigin: ARC_TESTNET.explorerOrigin,
      network: ARC_TESTNET.caip2, sourceRevision: ARC_TESTNET.sourceRevision, observedAt: "2026-09-05T12:00:02Z", adapterVersion: "openarc.arc-observation.m04.v1" },
    limitations: ["This is a read-only observation of one Arc Testnet transaction and receipt.",
      "EIP-7708 system events are canonical; matching ERC-20 events are corroboration, not additional movements.",
      "Transaction inclusion does not prove intent, authorization, fulfillment, or service quality."],
  });
};

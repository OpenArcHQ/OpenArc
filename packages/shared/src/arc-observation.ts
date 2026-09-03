import { z } from "zod";

import { API_SCHEMA_VERSION, ApiMetaSchema } from "./api.js";
import { ARC_TESTNET } from "./network.js";
import {
  CanonicalDecimalSchema,
  CanonicalIntegerSchema,
  EvmAddressSchema,
  IsoTimestampSchema,
  TransactionHashSchema,
} from "./primitives.js";

export const ARC_ACCOUNT_SNAPSHOT_PATH = "/v1/private/arc/account-snapshot" as const;
export const ARC_TRANSACTION_EVIDENCE_PATH = "/v1/private/arc/transaction-evidence" as const;

const exactAmount = <D extends 6 | 18>(decimals: D) => z.strictObject({
  baseUnits: CanonicalIntegerSchema,
  decimals: z.literal(decimals),
  decimal: CanonicalDecimalSchema,
});

export const ArcNativeAmountSchema = exactAmount(18);
export const ArcErc20AmountSchema = exactAmount(6);

export const ArcAnchorSchema = z.strictObject({
  blockNumber: CanonicalIntegerSchema,
  blockHash: TransactionHashSchema,
  blockTimestamp: IsoTimestampSchema,
  finality: z.literal("deterministic"),
  confirmations: z.literal("1"),
});

export const ArcObservationSourceSchema = z.strictObject({
  sourceId: z.literal("arc_primary_rpc"),
  origin: z.literal(ARC_TESTNET.rpcHttp),
  explorerOrigin: z.literal(ARC_TESTNET.explorerOrigin),
  network: z.literal(ARC_TESTNET.caip2),
  sourceRevision: z.literal(ARC_TESTNET.sourceRevision),
  observedAt: IsoTimestampSchema,
  adapterVersion: z.literal("openarc.arc-observation.m04.v1"),
});

export const ArcAccountSnapshotRequestSchema = z.strictObject({
  network: z.literal(ARC_TESTNET.caip2),
  address: EvmAddressSchema,
});

export const ArcAccountSnapshotSchema = z.strictObject({
  schemaVersion: z.literal("openarc.arc-account-snapshot.v1"),
  network: z.literal(ARC_TESTNET.caip2),
  address: EvmAddressSchema,
  anchor: ArcAnchorSchema,
  nativeUsdc: z.strictObject({
    asset: z.literal("USDC"),
    interface: z.literal("native"),
    amount: ArcNativeAmountSchema,
  }),
  erc20UsdcView: z.strictObject({
    asset: z.literal("USDC"),
    interface: z.literal("erc20"),
    contract: z.literal(ARC_TESTNET.contracts.usdc.toLowerCase()),
    amount: ArcErc20AmountSchema,
    relationship: z.literal("same_underlying_balance"),
    truncatesSubMicroUsdc: z.literal(true),
  }),
  source: ArcObservationSourceSchema,
  limitations: z.tuple([
    z.literal("This is a read-only observation at one exact Arc Testnet block."),
    z.literal("The 6-decimal ERC-20 view truncates native precision below one micro-USDC."),
    z.literal("A public address is not proof that its owner or controller is an agent."),
  ]),
});

export const ArcAccountSnapshotEnvelopeSchema = z.strictObject({
  ok: z.literal(true),
  data: ArcAccountSnapshotSchema,
  meta: ApiMetaSchema.extend({ schemaVersion: z.literal(API_SCHEMA_VERSION) }),
});

export const ArcTransactionEvidenceRequestSchema = z.strictObject({
  network: z.literal(ARC_TESTNET.caip2),
  transactionHash: TransactionHashSchema,
});

export const ArcTransferCorroborationSchema = z.strictObject({
  emitter: z.literal(ARC_TESTNET.contracts.usdc.toLowerCase()),
  logIndex: CanonicalIntegerSchema,
  amount: ArcErc20AmountSchema,
});

export const ArcCanonicalMovementSchema = z.strictObject({
  classification: z.literal("canonical_eip7708_usdc"),
  emitter: z.literal(ARC_TESTNET.usdcSystemEmitter),
  logIndex: CanonicalIntegerSchema,
  from: EvmAddressSchema,
  to: EvmAddressSchema,
  amount: ArcNativeAmountSchema,
  erc20Corroboration: ArcTransferCorroborationSchema.nullable(),
});

export const ArcTransactionEvidenceSchema = z.strictObject({
  schemaVersion: z.literal("openarc.arc-transaction-evidence.v1"),
  network: z.literal(ARC_TESTNET.caip2),
  transaction: z.strictObject({
    hash: TransactionHashSchema,
    blockNumber: CanonicalIntegerSchema,
    blockHash: TransactionHashSchema,
    transactionIndex: CanonicalIntegerSchema,
    from: EvmAddressSchema,
    to: EvmAddressSchema.nullable(),
    nativeValue: ArcNativeAmountSchema,
  }),
  receipt: z.strictObject({
    status: z.enum(["success", "failed"]),
    gasUsed: CanonicalIntegerSchema,
    effectiveGasPrice: ArcNativeAmountSchema,
    fee: ArcNativeAmountSchema,
  }),
  anchor: ArcAnchorSchema,
  movements: z.array(ArcCanonicalMovementSchema).max(128),
  coverage: z.strictObject({
    totalLogs: z.number().int().min(0).max(256),
    canonicalMovements: z.number().int().min(0).max(128),
    corroboratedMovements: z.number().int().min(0).max(128),
    unsupportedLogs: z.number().int().min(0).max(256),
    completeForUsdcTransfers: z.literal(true),
  }),
  source: ArcObservationSourceSchema,
  limitations: z.tuple([
    z.literal("This is a read-only observation of one Arc Testnet transaction and receipt."),
    z.literal("EIP-7708 system events are canonical; matching ERC-20 events are corroboration, not additional movements."),
    z.literal("Transaction inclusion does not prove intent, authorization, fulfillment, or service quality."),
  ]),
});

export const ArcTransactionEvidenceEnvelopeSchema = z.strictObject({
  ok: z.literal(true),
  data: ArcTransactionEvidenceSchema,
  meta: ApiMetaSchema.extend({ schemaVersion: z.literal(API_SCHEMA_VERSION) }),
});

export type ArcAccountSnapshotRequest = z.infer<typeof ArcAccountSnapshotRequestSchema>;
export type ArcAccountSnapshot = z.infer<typeof ArcAccountSnapshotSchema>;
export type ArcAccountSnapshotEnvelope = z.infer<typeof ArcAccountSnapshotEnvelopeSchema>;
export type ArcTransactionEvidenceRequest = z.infer<typeof ArcTransactionEvidenceRequestSchema>;
export type ArcTransactionEvidence = z.infer<typeof ArcTransactionEvidenceSchema>;
export type ArcTransactionEvidenceEnvelope = z.infer<typeof ArcTransactionEvidenceEnvelopeSchema>;
export type ArcCanonicalMovement = z.infer<typeof ArcCanonicalMovementSchema>;

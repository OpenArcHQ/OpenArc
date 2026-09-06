import { z } from "zod";

import { ApiMetaSchema } from "./api.js";
import { ARC_TESTNET } from "./network.js";
import { EvmAddressSchema, IsoTimestampSchema, Sha256DigestSchema, TransactionHashSchema,
  Uint256DecimalSchema, Uint64DecimalSchema, compareIsoTimestamps } from "./primitives.js";

export const GATEWAY_TRANSFER_PATH = "/v1/private/gateway/transfer" as const;
export const GATEWAY_TESTNET_ORIGIN = "https://gateway-api-testnet.circle.com" as const;
export const CanonicalTransferIdSchema = z.string().uuid().regex(/^[0-9a-f-]{36}$/u);
const network = z.literal(ARC_TESTNET.caip2);
const asset = z.literal(ARC_TESTNET.contracts.usdc);
const domain = { domainName: z.literal("GatewayWalletBatched"), domainVersion: z.literal("1"),
  verifyingContract: z.literal(ARC_TESTNET.contracts.gatewayWallet) };
const seconds = Uint64DecimalSchema.refine((value) => /^(0|[1-9][0-9]{0,11})$/u.test(value) && BigInt(value) <= 253_402_300_799n);

export const X402RequirementSchema = z.strictObject({
  x402Version: z.literal(2), scheme: z.literal("exact"), network, asset, ...domain,
  payTo: EvmAddressSchema, amount: Uint256DecimalSchema, maxTimeoutSeconds: Uint64DecimalSchema,
});

export const X402AuthorizationMetadataSchema = z.strictObject({
  network, asset, ...domain, from: EvmAddressSchema, to: EvmAddressSchema, value: Uint256DecimalSchema,
  nonce: TransactionHashSchema, validAfter: seconds, validBefore: seconds,
}).superRefine((authorization, context) => {
  if (!seconds.safeParse(authorization.validAfter).success || !seconds.safeParse(authorization.validBefore).success) return;
  if (BigInt(authorization.validBefore) <= BigInt(authorization.validAfter)) {
    context.addIssue({ code: "custom", path: ["validBefore"], message: "Validity must end after it starts" });
  }
});

export const X402ResponseMetadataSchema = z.strictObject({
  respondedAt: IsoTimestampSchema, httpStatus: z.number().int().min(100).max(599), reportedSuccess: z.boolean(),
  responseDigest: Sha256DigestSchema.nullable(), transferId: CanonicalTransferIdSchema.nullable(),
});

/** Normalized, owner-imported claims only. Never accepts a reusable signature or paid body. */
export const X402ReceiptBundleSchema = z.strictObject({
  schemaVersion: z.literal("openarc.x402-receipt-bundle.v1"), bundleId: CanonicalTransferIdSchema,
  capturedAt: IsoTimestampSchema, provenance: z.literal("imported_metadata"), authentication: z.literal("not_verified"),
  resource: z.strictObject({ originDigest: Sha256DigestSchema, resourceDigest: Sha256DigestSchema }),
  requirement: X402RequirementSchema.optional(), authorizationMetadata: X402AuthorizationMetadataSchema.optional(),
  responseMetadata: X402ResponseMetadataSchema.optional(),
}).superRefine((bundle, context) => {
  if (!bundle.requirement && !bundle.authorizationMetadata && !bundle.responseMetadata) {
    context.addIssue({ code: "custom", message: "At least one metadata stage is required" });
  }
  if (bundle.responseMetadata && IsoTimestampSchema.safeParse(bundle.capturedAt).success &&
    IsoTimestampSchema.safeParse(bundle.responseMetadata.respondedAt).success &&
    compareIsoTimestamps(bundle.responseMetadata.respondedAt, bundle.capturedAt) > 0) {
    context.addIssue({ code: "custom", path: ["responseMetadata", "respondedAt"], message: "Response cannot follow capture" });
  }
});

export const GatewayTransferRequestSchema = z.strictObject({ network, transferId: CanonicalTransferIdSchema });
export const GATEWAY_TRANSFER_STATUSES = ["received", "batched", "confirmed", "completed", "failed"] as const;
export const GatewayTransferSchema = z.strictObject({
  id: CanonicalTransferIdSchema, status: z.enum(GATEWAY_TRANSFER_STATUSES), token: z.literal("USDC"),
  sendingNetwork: network, recipientNetwork: network, fromAddress: EvmAddressSchema, toAddress: EvmAddressSchema,
  amount: Uint256DecimalSchema, nonce: TransactionHashSchema, txHash: TransactionHashSchema.nullable(),
  createdAt: IsoTimestampSchema, updatedAt: IsoTimestampSchema,
}).superRefine((transfer, context) => {
  if (IsoTimestampSchema.safeParse(transfer.createdAt).success && IsoTimestampSchema.safeParse(transfer.updatedAt).success &&
    compareIsoTimestamps(transfer.createdAt, transfer.updatedAt) > 0) {
    context.addIssue({ code: "custom", path: ["updatedAt"], message: "Update cannot predate creation" });
  }
});

export const GatewayTransferObservationSchema = z.strictObject({
  schemaVersion: z.literal("openarc.gateway-transfer-observation.v1"), network,
  transfer: GatewayTransferSchema,
  source: z.strictObject({ sourceId: z.literal("circle_gateway_testnet"), origin: z.literal(GATEWAY_TESTNET_ORIGIN),
    observedAt: IsoTimestampSchema, adapterVersion: z.literal("openarc.gateway-transfer.m07.v1") }),
}).superRefine((observation, context) => {
  if (IsoTimestampSchema.safeParse(observation.transfer.updatedAt).success && IsoTimestampSchema.safeParse(observation.source.observedAt).success &&
    compareIsoTimestamps(observation.transfer.updatedAt, observation.source.observedAt) > 0) {
    context.addIssue({ code: "custom", path: ["source", "observedAt"], message: "Observation cannot precede source update" });
  }
});
export const GatewayTransferEnvelopeSchema = z.strictObject({ ok: z.literal(true), data: GatewayTransferObservationSchema, meta: ApiMetaSchema });

export type X402ReceiptBundle = z.infer<typeof X402ReceiptBundleSchema>;
export type GatewayTransferRequest = z.infer<typeof GatewayTransferRequestSchema>;
export type GatewayTransferObservation = z.infer<typeof GatewayTransferObservationSchema>;
export type GatewayTransferEnvelope = z.infer<typeof GatewayTransferEnvelopeSchema>;

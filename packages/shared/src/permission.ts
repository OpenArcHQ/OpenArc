import { z } from "zod";

import { ApiErrorCodeSchema, CAPABILITIES_PATH, WorkspaceOriginSchema } from "./api.js";
import { ARC_ACCOUNT_SNAPSHOT_PATH, ARC_TRANSACTION_EVIDENCE_PATH } from "./arc-observation.js";
import { ARC_TESTNET } from "./network.js";
import { EvmAddressSchema, IsoTimestampSchema, TransactionHashSchema, compareIsoTimestamps } from "./primitives.js";
import { VaultRevisionSchema, WorkspaceRecordIdSchema } from "./workspace-primitives.js";

export const CAPABILITY_DISCLOSURE = Object.freeze({
  connectorId: "openarc_capabilities",
  purpose: "Inspect enabled OpenArc connections and limits.",
  credentials: "omit",
  openArcRetention: "No private workspace fields or response bodies are retained by the OpenArc API.",
  providerRetention: "No upstream provider is contacted by this check.",
  hostingMetadata: "OpenArc and its hosting provider receive ordinary network metadata, including IP and user-agent.",
} as const);

export const PermissionFailureCodeSchema = z.union([
  ApiErrorCodeSchema,
  z.enum(["REQUEST_UNAVAILABLE", "INVALID_RESPONSE", "RESPONSE_TOO_LARGE"]),
]);

export const CapabilityPermissionReceiptRecordSchema = z.strictObject({
  recordSchema: z.literal("openarc.permission-receipt.v1"),
  kind: z.literal("permission_receipt"),
  recordId: WorkspaceRecordIdSchema,
  recordRevision: VaultRevisionSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  connectorId: z.literal(CAPABILITY_DISCLOSURE.connectorId),
  destination: z.strictObject({
    origin: WorkspaceOriginSchema,
    path: z.literal(CAPABILITIES_PATH),
    method: z.literal("GET"),
    upstreams: z.tuple([]),
  }),
  releasedFields: z.tuple([]),
  purpose: z.literal(CAPABILITY_DISCLOSURE.purpose),
  credentials: z.literal(CAPABILITY_DISCLOSURE.credentials),
  openArcRetention: z.literal(CAPABILITY_DISCLOSURE.openArcRetention),
  providerRetention: z.literal(CAPABILITY_DISCLOSURE.providerRetention),
  hostingMetadata: z.literal(CAPABILITY_DISCLOSURE.hostingMetadata),
  approvedAt: IsoTimestampSchema,
  outcome: z.enum(["approved", "completed", "failed"]),
  resolvedAt: IsoTimestampSchema.nullable(),
  failureCode: PermissionFailureCodeSchema.nullable(),
}).superRefine((receipt, context) => {
  if (![receipt.createdAt, receipt.updatedAt, receipt.approvedAt, receipt.resolvedAt]
    .every((value) => value === null || IsoTimestampSchema.safeParse(value).success)) return;
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  if (receipt.createdAt !== receipt.approvedAt) fail("Receipt creation must equal approval");
  if (receipt.updatedAt !== (receipt.resolvedAt ?? receipt.approvedAt)) {
    fail("Receipt update must match its last outcome time");
  }
  if (receipt.outcome === "approved") {
    if (receipt.resolvedAt !== null || receipt.failureCode !== null) fail("Approval is unresolved");
  } else {
    if (receipt.resolvedAt === null || compareIsoTimestamps(receipt.resolvedAt, receipt.approvedAt) < 0) {
      fail("Resolved receipt cannot predate approval");
    }
    if ((receipt.outcome === "failed") !== (receipt.failureCode !== null)) {
      fail("Only a failed receipt has a failure code");
    }
  }
});

export const ARC_OBSERVATION_DISCLOSURE = Object.freeze({
  credentials: "omit",
  openArcRetention: "No request or response body is retained by the OpenArc API. The approved result is stored only in the encrypted local workspace.",
  providerRetention: "Arc's public RPC receives the released public identifier under Arc's current terms and privacy policy.",
  hostingMetadata: "OpenArc, its hosting provider, and the Arc RPC receive ordinary network metadata, including IP and user-agent where applicable.",
} as const);

const observationBase = {
  recordSchema: z.literal("openarc.permission-receipt.v2"),
  kind: z.literal("permission_receipt"),
  recordId: WorkspaceRecordIdSchema,
  recordRevision: VaultRevisionSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  credentials: z.literal(ARC_OBSERVATION_DISCLOSURE.credentials),
  openArcRetention: z.literal(ARC_OBSERVATION_DISCLOSURE.openArcRetention),
  providerRetention: z.literal(ARC_OBSERVATION_DISCLOSURE.providerRetention),
  hostingMetadata: z.literal(ARC_OBSERVATION_DISCLOSURE.hostingMetadata),
  approvedAt: IsoTimestampSchema,
  outcome: z.enum(["approved", "completed", "failed"]),
  resolvedAt: IsoTimestampSchema.nullable(),
  failureCode: PermissionFailureCodeSchema.nullable(),
};

export const ArcObservationPermissionReceiptRecordSchema = z.discriminatedUnion("connectorId", [
  z.strictObject({
    ...observationBase,
    connectorId: z.literal("arc_account_snapshot"),
    destination: z.strictObject({ origin: WorkspaceOriginSchema,
      path: z.literal(ARC_ACCOUNT_SNAPSHOT_PATH), method: z.literal("POST"),
      upstreams: z.tuple([z.literal(ARC_TESTNET.rpcHttp)]) }),
    releasedFields: z.tuple([z.literal("network"), z.literal("address")]),
    released: z.strictObject({ network: z.literal(ARC_TESTNET.caip2), address: EvmAddressSchema }),
    purpose: z.literal("Observe one public Arc Testnet address at one exact final block."),
  }),
  z.strictObject({
    ...observationBase,
    connectorId: z.literal("arc_transaction_evidence"),
    destination: z.strictObject({ origin: WorkspaceOriginSchema,
      path: z.literal(ARC_TRANSACTION_EVIDENCE_PATH), method: z.literal("POST"),
      upstreams: z.tuple([z.literal(ARC_TESTNET.rpcHttp)]) }),
    releasedFields: z.tuple([z.literal("network"), z.literal("transactionHash")]),
    released: z.strictObject({ network: z.literal(ARC_TESTNET.caip2), transactionHash: TransactionHashSchema }),
    purpose: z.literal("Observe one public Arc Testnet transaction, receipt, anchor, fee, and USDC movement set."),
  }),
]).superRefine((receipt, context) => {
  if (![receipt.createdAt, receipt.updatedAt, receipt.approvedAt, receipt.resolvedAt]
    .every((value) => value === null || IsoTimestampSchema.safeParse(value).success)) return;
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  if (receipt.createdAt !== receipt.approvedAt) fail("Receipt creation must equal approval");
  if (receipt.updatedAt !== (receipt.resolvedAt ?? receipt.approvedAt)) fail("Receipt update must match its last outcome time");
  if (receipt.outcome === "approved") {
    if (receipt.resolvedAt !== null || receipt.failureCode !== null) fail("Approval is unresolved");
  } else {
    if (receipt.resolvedAt === null || compareIsoTimestamps(receipt.resolvedAt, receipt.approvedAt) < 0) {
      fail("Resolved receipt cannot predate approval");
    }
    if ((receipt.outcome === "failed") !== (receipt.failureCode !== null)) fail("Only a failed receipt has a failure code");
  }
});

export const PermissionReceiptRecordSchema = z.union([
  CapabilityPermissionReceiptRecordSchema,
  ArcObservationPermissionReceiptRecordSchema,
]);

export type PermissionReceiptRecord = z.infer<typeof PermissionReceiptRecordSchema>;
export type CapabilityPermissionReceiptRecord = z.infer<typeof CapabilityPermissionReceiptRecordSchema>;
export type ArcObservationPermissionReceiptRecord = z.infer<typeof ArcObservationPermissionReceiptRecordSchema>;
export type PermissionFailureCode = z.infer<typeof PermissionFailureCodeSchema>;

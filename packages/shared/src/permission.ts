import { z } from "zod";

import { ApiErrorCodeSchema, CAPABILITIES_PATH, WorkspaceOriginSchema } from "./api.js";
import { ARC_ACCOUNT_SNAPSHOT_PATH, ARC_TRANSACTION_EVIDENCE_PATH } from "./arc-observation.js";
import { AGENT_REGISTRY_EVIDENCE_PATH, AgentRegistryEvidenceRequestSchema } from "./agent-registry-evidence.js";
import { JOB_EVIDENCE_PATH, JobEvidenceRequestSchema } from "./job-evidence.js";
import { GATEWAY_TRANSFER_PATH, GatewayTransferRequestSchema } from "./x402-evidence.js";
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

export const AGENT_REGISTRY_DISCLOSURE = Object.freeze({
  credentials: "omit",
  openArcRetention: "No request or response body is retained by the OpenArc API. The approved result is stored only in the encrypted local workspace.",
  providerRetention: "Arc's public RPC receives the released public registry identifiers under Arc's current terms and privacy policy.",
  hostingMetadata: "OpenArc, its hosting provider, and the Arc RPC receive ordinary network metadata, including IP and user-agent where applicable.",
} as const);

export const JOB_DISCLOSURE = Object.freeze({
  ...ARC_OBSERVATION_DISCLOSURE,
  providerRetention: "Arc's public RPC receives the job ID and optional submission transaction hash under Arc's current terms and privacy policy.",
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

export const AgentRegistryPermissionReceiptRecordSchema = z.strictObject({
  recordSchema: z.literal("openarc.permission-receipt.v3"),
  kind: z.literal("permission_receipt"),
  recordId: WorkspaceRecordIdSchema,
  recordRevision: VaultRevisionSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  connectorId: z.literal("arc_agent_registry_evidence"),
  destination: z.strictObject({ origin: WorkspaceOriginSchema,
    path: z.literal(AGENT_REGISTRY_EVIDENCE_PATH), method: z.literal("POST"),
    upstreams: z.tuple([z.literal(ARC_TESTNET.rpcHttp)]) }),
  releasedFields: z.array(z.enum([
    "network", "agentId", "feedbackQuery.clientAddress", "feedbackQuery.feedbackIndex",
    "validationRequestHash",
  ])).min(2).max(5),
  released: AgentRegistryEvidenceRequestSchema,
  purpose: z.literal("Observe one ERC-8004 agent identity and optional exact observer or validator claims at one final Arc Testnet block."),
  credentials: z.literal(AGENT_REGISTRY_DISCLOSURE.credentials),
  openArcRetention: z.literal(AGENT_REGISTRY_DISCLOSURE.openArcRetention),
  providerRetention: z.literal(AGENT_REGISTRY_DISCLOSURE.providerRetention),
  hostingMetadata: z.literal(AGENT_REGISTRY_DISCLOSURE.hostingMetadata),
  approvedAt: IsoTimestampSchema,
  outcome: z.enum(["approved", "completed", "failed"]),
  resolvedAt: IsoTimestampSchema.nullable(),
  failureCode: PermissionFailureCodeSchema.nullable(),
}).superRefine((receipt, context) => {
  const expected = ["network", "agentId"];
  if (receipt.released.feedbackQuery) expected.push("feedbackQuery.clientAddress", "feedbackQuery.feedbackIndex");
  if (receipt.released.validationRequestHash) expected.push("validationRequestHash");
  if (JSON.stringify(receipt.releasedFields) !== JSON.stringify(expected)) {
    context.addIssue({ code: "custom", message: "Released-field disclosure must exactly match the request" });
  }
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

export const JobPermissionReceiptRecordSchema = z.strictObject({
  recordSchema: z.literal("openarc.permission-receipt.v4"),
  kind: z.literal("permission_receipt"),
  recordId: WorkspaceRecordIdSchema,
  recordRevision: VaultRevisionSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
  connectorId: z.literal("arc_job_evidence"),
  destination: z.strictObject({ origin: WorkspaceOriginSchema,
    path: z.literal(JOB_EVIDENCE_PATH), method: z.literal("POST"),
    upstreams: z.tuple([z.literal(ARC_TESTNET.rpcHttp)]) }),
  releasedFields: z.array(z.enum([
    "network", "jobId", "submissionTransactionHash",
  ])).min(2).max(3),
  released: JobEvidenceRequestSchema,
  purpose: z.literal("Observe one job on the reviewed Arc Testnet reference contract and an optional exact submission receipt."),
  credentials: z.literal(JOB_DISCLOSURE.credentials),
  openArcRetention: z.literal(JOB_DISCLOSURE.openArcRetention),
  providerRetention: z.literal(JOB_DISCLOSURE.providerRetention),
  hostingMetadata: z.literal(JOB_DISCLOSURE.hostingMetadata),
  approvedAt: IsoTimestampSchema,
  outcome: z.enum(["approved", "completed", "failed"]),
  resolvedAt: IsoTimestampSchema.nullable(),
  failureCode: PermissionFailureCodeSchema.nullable(),
}).superRefine((receipt, context) => {
  const expected = ["network", "jobId"];
  if (![receipt.createdAt, receipt.updatedAt, receipt.approvedAt, receipt.resolvedAt]
    .every((value) => value === null || IsoTimestampSchema.safeParse(value).success)) return;
  if (receipt.released.submissionTransactionHash) expected.push("submissionTransactionHash");
  if (JSON.stringify(receipt.releasedFields) !== JSON.stringify(expected)) {
    context.addIssue({ code: "custom", message: "Released-field disclosure must exactly match the request" });
  }
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

export const GATEWAY_DISCLOSURE = Object.freeze({
  credentials: "omit",
  openArcRetention: "No request or response body is retained by the OpenArc API. The approved result is stored only in the encrypted local workspace.",
  providerRetention: "Circle Gateway receives the exact transfer UUID under Circle's current terms and privacy policy. Provider retention is not controlled by OpenArc.",
  hostingMetadata: "OpenArc, its hosting provider, and Circle Gateway receive ordinary network metadata, including IP and user-agent where applicable.",
} as const);

export const GatewayPermissionReceiptRecordSchema = z.strictObject({
  ...observationBase,
  recordSchema: z.literal("openarc.permission-receipt.v5"),
  connectorId: z.literal("circle_gateway_transfer"),
  destination: z.strictObject({ origin: WorkspaceOriginSchema,
    path: z.literal(GATEWAY_TRANSFER_PATH), method: z.literal("POST"),
    upstreams: z.tuple([z.literal("https://gateway-api-testnet.circle.com")]) }),
  releasedFields: z.tuple([z.literal("network"), z.literal("transferId")]),
  released: GatewayTransferRequestSchema,
  purpose: z.literal("Read one exact Circle Gateway Arc Testnet transfer; this does not verify fulfillment."),
  providerRetention: z.literal(GATEWAY_DISCLOSURE.providerRetention),
  hostingMetadata: z.literal(GATEWAY_DISCLOSURE.hostingMetadata),
}).superRefine((receipt, context) => {
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
  AgentRegistryPermissionReceiptRecordSchema,
  JobPermissionReceiptRecordSchema,
  GatewayPermissionReceiptRecordSchema,
]);

export type PermissionReceiptRecord = z.infer<typeof PermissionReceiptRecordSchema>;
export type CapabilityPermissionReceiptRecord = z.infer<typeof CapabilityPermissionReceiptRecordSchema>;
export type ArcObservationPermissionReceiptRecord = z.infer<typeof ArcObservationPermissionReceiptRecordSchema>;
export type AgentRegistryPermissionReceiptRecord = z.infer<typeof AgentRegistryPermissionReceiptRecordSchema>;
export type PermissionFailureCode = z.infer<typeof PermissionFailureCodeSchema>;
export type JobPermissionReceiptRecord = z.infer<typeof JobPermissionReceiptRecordSchema>;
export type GatewayPermissionReceiptRecord = z.infer<typeof GatewayPermissionReceiptRecordSchema>;

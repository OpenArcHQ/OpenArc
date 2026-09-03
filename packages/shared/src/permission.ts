import { z } from "zod";

import { ApiErrorCodeSchema, CAPABILITIES_PATH, WorkspaceOriginSchema } from "./api.js";
import { IsoTimestampSchema, compareIsoTimestamps } from "./primitives.js";
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

export const PermissionReceiptRecordSchema = z.strictObject({
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

export type PermissionReceiptRecord = z.infer<typeof PermissionReceiptRecordSchema>;
export type PermissionFailureCode = z.infer<typeof PermissionFailureCodeSchema>;

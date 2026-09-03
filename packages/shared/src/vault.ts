import { z } from "zod";

import {
  ActionEnvelopeSchema,
  EvidenceRecordSchema,
  MonitoringPolicySchema,
} from "./evidence.js";
import { ARC_TESTNET } from "./network.js";
import {
  EvmAddressSchema,
  IsoTimestampSchema,
  Sha256DigestSchema,
  compareIsoTimestamps,
} from "./primitives.js";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const nullableText = (maximum: number) => z.string().trim().max(maximum).nullable();
const uniqueArray = <T extends z.ZodType>(item: T, maximum: number) =>
  z.array(item).max(maximum).refine((items) => new Set(items).size === items.length, {
    message: "Expected unique values",
  });

export const WorkspaceRecordIdSchema = z.string().uuid();
export const AgentIdSchema = z.string().regex(/^agent_[0-9a-f]{32}$/u);
export const VaultRevisionSchema = z.string().regex(/^[A-Za-z0-9_-]{32}$/u);
export const WorkspaceRecordSchemaVersion = "openarc.workspace-record.v1" as const;

const recordBase = {
  recordSchema: z.literal(WorkspaceRecordSchemaVersion),
  recordId: WorkspaceRecordIdSchema,
  recordRevision: VaultRevisionSchema,
  createdAt: IsoTimestampSchema,
  updatedAt: IsoTimestampSchema,
};

export const AgentProfileRecordSchema = z.strictObject({
  ...recordBase,
  kind: z.literal("agent_profile"),
  agentId: AgentIdSchema,
  displayName: boundedText(80),
  wallets: z
    .array(
      z.strictObject({
        network: z.literal(ARC_TESTNET.caip2),
        address: EvmAddressSchema,
        classificationSource: z.literal("owner_supplied"),
      }),
    )
    .max(8),
  frameworkLabel: nullableText(80),
  purposeNote: nullableText(500),
  policyRecordIds: uniqueArray(WorkspaceRecordIdSchema, 32),
});

export const MonitoringPolicyRecordSchema = z.strictObject({
  ...recordBase,
  kind: z.literal("monitoring_policy"),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  policy: MonitoringPolicySchema,
});

export const EvidenceRecordRecordSchema = z.strictObject({
  ...recordBase,
  kind: z.literal("evidence_record"),
  evidence: EvidenceRecordSchema,
});

export const ActionEnvelopeRecordSchema = z.strictObject({
  ...recordBase,
  kind: z.literal("action_envelope"),
  action: ActionEnvelopeSchema,
});

export const WorkspaceSettingsRecordSchema = z.strictObject({
  ...recordBase,
  kind: z.literal("workspace_settings"),
  tourSeen: z.boolean(),
  defaultView: z.enum(["overview", "agents", "policies", "evidence", "settings"]),
});

export const SentinelRecordSchema = z.strictObject({
  ...recordBase,
  kind: z.literal("sentinel"),
  marker: z.literal("OPENARC_VAULT_SENTINEL_V1"),
  vaultRevision: VaultRevisionSchema,
  manifest: z
    .array(
      z.strictObject({
        recordId: WorkspaceRecordIdSchema,
        revision: VaultRevisionSchema,
        digest: Sha256DigestSchema,
      }),
    )
    .max(6_601)
    .refine(
      (entries) =>
        entries.every((entry, index) => index === 0 || entries[index - 1]!.recordId < entry.recordId),
      { message: "Manifest entries must use unique canonical record-ID order" },
    ),
});

const WorkspaceRecordVariantSchema = z.discriminatedUnion("kind", [
  AgentProfileRecordSchema,
  MonitoringPolicyRecordSchema,
  EvidenceRecordRecordSchema,
  ActionEnvelopeRecordSchema,
  WorkspaceSettingsRecordSchema,
  SentinelRecordSchema,
]);

export const WorkspaceRecordSchema = WorkspaceRecordVariantSchema.superRefine((record, context) => {
  if (compareIsoTimestamps(record.updatedAt, record.createdAt) < 0) {
    context.addIssue({
      code: "custom",
      message: "Record update time cannot predate record creation",
      path: ["updatedAt"],
    });
  }
});

export type ActionEnvelopeRecord = z.infer<typeof ActionEnvelopeRecordSchema>;
export type AgentProfileRecord = z.infer<typeof AgentProfileRecordSchema>;
export type EvidenceRecordRecord = z.infer<typeof EvidenceRecordRecordSchema>;
export type MonitoringPolicyRecord = z.infer<typeof MonitoringPolicyRecordSchema>;
export type SentinelRecord = z.infer<typeof SentinelRecordSchema>;
export type WorkspaceRecord = z.infer<typeof WorkspaceRecordSchema>;
export type WorkspaceSettingsRecord = z.infer<typeof WorkspaceSettingsRecordSchema>;

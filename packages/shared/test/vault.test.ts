import { describe, expect, it } from "vitest";

import {
  AgentProfileRecordSchema,
  SentinelRecordSchema,
  WorkspaceRecordSchema,
} from "../src/vault.js";

const revision = "A".repeat(32);
const base = {
  recordSchema: "openarc.workspace-record.v1" as const,
  recordId: "11111111-1111-4111-8111-111111111111",
  recordRevision: revision,
  createdAt: "2026-09-02T12:00:00Z",
  updatedAt: "2026-09-02T12:00:00.1Z",
};

describe("encrypted workspace record schema", () => {
  it("accepts a bounded owner-supplied Arc Testnet agent profile", () => {
    const result = AgentProfileRecordSchema.parse({
      ...base,
      kind: "agent_profile",
      agentId: `agent_${"1".repeat(32)}`,
      displayName: "Treasury agent",
      wallets: [
        {
          network: "eip155:5042002",
          address: `0x${"2".repeat(40)}`,
          classificationSource: "owner_supplied",
        },
      ],
      frameworkLabel: "local label",
      purposeNote: null,
      policyRecordIds: [],
    });
    expect(result.displayName).toBe("Treasury agent");
  });

  it("rejects unknown kinds, unknown keys, invalid revisions, and reversed timestamps", () => {
    const valid = {
      ...base,
      kind: "workspace_settings",
      tourSeen: false,
      defaultView: "overview",
    };
    expect(WorkspaceRecordSchema.safeParse({ ...valid, kind: "permission_receipt" }).success).toBe(false);
    expect(WorkspaceRecordSchema.safeParse({ ...valid, surprise: true }).success).toBe(false);
    expect(WorkspaceRecordSchema.safeParse({ ...valid, recordRevision: "short" }).success).toBe(false);
    expect(
      WorkspaceRecordSchema.safeParse({
        ...valid,
        createdAt: "2026-09-02T12:00:00.1Z",
        updatedAt: "2026-09-02T12:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("requires a sorted unique bounded manifest", () => {
    const sentinel = {
      ...base,
      kind: "sentinel",
      marker: "OPENARC_VAULT_SENTINEL_V1",
      vaultRevision: revision,
      manifest: [
        {
          recordId: "22222222-2222-4222-8222-222222222222",
          revision,
          digest: `sha256:${"2".repeat(64)}`,
        },
        {
          recordId: "11111111-1111-4111-8111-111111111111",
          revision,
          digest: `sha256:${"1".repeat(64)}`,
        },
      ],
    };
    expect(SentinelRecordSchema.safeParse(sentinel).success).toBe(false);
    expect(
      SentinelRecordSchema.safeParse({
        ...sentinel,
        manifest: [...sentinel.manifest].reverse(),
      }).success,
    ).toBe(true);
  });
});

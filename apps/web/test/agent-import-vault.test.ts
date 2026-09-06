import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { ARC_TESTNET, AgentImportRecordSchema, AgentMonitoringPolicyRecordSchema,
  AgentProfileRecordSchema, MonitoringPolicyRecordSchema, EvidenceRecordRecordSchema, ActionEnvelopeRecordSchema,
  WorkspaceSettingsRecordSchema, SentinelRecordSchema, PermissionReceiptRecordSchema, ArcObservationRecordSchema,
  AgentRegistryObservationRecordSchema, JobObservationRecordSchema, X402BundleRecordSchema, GatewayObservationRecordSchema,
  type AgentImport, type AgentMonitoringPolicy, type WorkspaceRecord } from "@openarc/shared";
import { VAULT_DATABASE_NAME, readVaultSnapshot } from "../src/vault/db.js";
import { VAULT_MAX_RECORDS, VAULT_MAX_BACKUP_BYTES, VAULT_RECORD_CAPS } from "../src/vault/types.js";
import { assertWorkspaceIntegrity, createLocalWorkspace, createAgentProfileRecord, saveWorkspaceRecords,
  prepareLocalAgentImport, prepareAgentMonitoringPolicyRecord, deleteWorkspaceRecords, unlockLocalWorkspace,
  exportLocalWorkspace, importLocalWorkspace, recoverLocalWorkspace, exportOpaqueRescue } from "../src/vault/service.js";

const passphrase = "Independent local agent import passphrase";
const capturedAt = "2026-09-01T12:00:00Z";
const report = (count = 1): AgentImport => ({ schemaVersion: "openarc.agent-import.v1", importId: crypto.randomUUID(),
  capturedAt, connectorId: "synthetic-agent-v1", authentication: "not_verified",
  events: Array.from({ length: count }, () => ({ eventId: crypto.randomUUID(), actionId: "synthetic-action",
    occurredAt: "2026-09-01T11:59:00Z", network: ARC_TESTNET.caip2, asset: ARC_TESTNET.contracts.usdc,
    decimals: 6, payer: `0x${"11".repeat(20)}`, recipient: `0x${"22".repeat(20)}`, amountBaseUnits: "9007199254740993000",
    reportedStatus: "attempted", contract: null, serviceDigest: null, authorizationNonce: null,
    authorizationDomainDigest: null, approval: "not_supplied" })) });
const policy = (profileId: string): AgentMonitoringPolicy => ({ schemaVersion: "openarc.agent-policy.v2", policyId: crypto.randomUUID(),
  revision: 1, name: "Local review only", agentProfileRecordId: profileId, enabled: true,
  validAfter: "2026-09-01T00:00:00Z", validBefore: "2026-09-02T00:00:00Z", perActionLimit: "1000", dailyLimit: "1000000",
  allowRecipients: [], blockRecipients: [], allowContracts: [], blockContracts: [], allowServices: [], blockServices: [],
  requireApproval: true, mode: "local_monitoring_only" });

afterEach(async () => new Promise<void>((resolve, reject) => {
  const request = indexedDB.deleteDatabase(VAULT_DATABASE_NAME);
  request.onsuccess = () => resolve(); request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error("Test deletion blocked"));
}));
async function setup() {
  const created = await createLocalWorkspace(passphrase);
  const profile = createAgentProfileRecord({ displayName: "Synthetic local agent", walletAddress: "", frameworkLabel: "", purposeNote: "" }, created.meta.revision);
  const workspace = await saveWorkspaceRecords(created, [profile]);
  return { workspace, profile, recoverySecret: created.recoverySecret };
}
const snapshot = (workspace: Awaited<ReturnType<typeof setup>>["workspace"]) =>
  readVaultSnapshot(workspace.meta.vaultId, workspace.meta.revision, workspace.meta.coordinationRevision);

describe("M08 immutable local import and policy persistence", () => {
  it("atomically encrypts new kinds and round-trips unlock, backup, replacement and recovery", async () => {
    const { workspace, profile } = await setup();
    const imported = prepareLocalAgentImport(workspace, report(), profile.recordId, true);
    const monitored = prepareAgentMonitoringPolicyRecord(workspace, policy(profile.recordId));
    const saved = await saveWorkspaceRecords(workspace, [imported, monitored]);
    const raw = JSON.stringify(await snapshot(saved));
    for (const value of [imported.report.importId, imported.report.events[0]!.eventId, "synthetic-agent-v1", "openarc.agent-import.v1", monitored.policy.policyId]) {
      expect(raw).not.toContain(value);
    }
    const unlocked = await unlockLocalWorkspace(saved.meta, passphrase);
    expect(unlocked.records).toContainEqual(expect.objectContaining({ kind: "agent_import", report: imported.report }));
    const backup = await exportLocalWorkspace(unlocked, "Separate M08 backup passphrase");
    expect(JSON.stringify(backup)).not.toContain(imported.report.importId);
    const restored = await importLocalWorkspace(backup, "Separate M08 backup passphrase", passphrase, unlocked.meta);
    const staleImport = prepareLocalAgentImport(unlocked, report(), profile.recordId, true);
    await expect(saveWorkspaceRecords(unlocked, [staleImport])).rejects.toThrow();
    const recovered = await recoverLocalWorkspace(restored.meta, restored.recoverySecret, passphrase);
    expect(recovered.records).toContainEqual(expect.objectContaining({ kind: "agent_monitoring_policy", policy: monitored.policy }));
    expect(() => assertWorkspaceIntegrity(recovered.records)).not.toThrow();
    expect(recovered.records.find((record) => record.kind === "agent_profile")).toMatchObject({ policyRecordIds: [] });
  });

  it("requires explicit profile association and rejects signed/future/versioned imports before saving", async () => {
    const { workspace, profile } = await setup();
    for (const [profileId, confirmed] of [[profile.recordId, false], [crypto.randomUUID(), true]] as const) {
      expect(() => prepareLocalAgentImport(workspace, report(), profileId, confirmed)).toThrow();
    }
    for (const value of [{ ...report(), signature: "SECRET_CANARY" }, { ...report(), authentication: "verified" },
      { ...report(), schemaVersion: "openarc.agent-import.v2" }, { ...report(), capturedAt: "2099-01-01T00:00:00Z" }]) {
      expect(() => prepareLocalAgentImport(workspace, value, profile.recordId, true)).toThrow();
    }
    const future = { ...prepareLocalAgentImport(workspace, report(), profile.recordId, true),
      createdAt: "2099-01-01T00:00:00Z", updatedAt: "2099-01-01T00:00:00Z", report: { ...report(), capturedAt: "2099-01-01T00:00:00Z" } };
    await expect(saveWorkspaceRecords(workspace, [future])).rejects.toThrow("Future-captured");
    expect((await snapshot(workspace)).meta.revision).toBe(workspace.meta.revision);
  });

  it("distinguishes duplicate report identity from conflicting report identity and prevents raw overwrites", async () => {
    const { workspace, profile } = await setup();
    const imported = prepareLocalAgentImport(workspace, report(), profile.recordId, true);
    const saved = await saveWorkspaceRecords(workspace, [imported]);
    expect(() => prepareLocalAgentImport(saved, imported.report, profile.recordId, true)).toThrow(expect.objectContaining({ reason: "DUPLICATE_IMPORT" }));
    const changed = { ...imported.report, connectorId: "changed-connector" };
    expect(() => prepareLocalAgentImport(saved, changed, profile.recordId, true)).toThrow(expect.objectContaining({ reason: "IMPORT_ID_CONFLICT" }));
    for (const value of [{ ...imported, recordId: crypto.randomUUID() }, imported]) {
      await expect(saveWorkspaceRecords(saved, [value])).rejects.toMatchObject({ reason: "DUPLICATE_IMPORT" });
    }
    await expect(saveWorkspaceRecords(saved, [{ ...imported, report: changed }])).rejects.toMatchObject({ reason: "IMPORT_ID_CONFLICT" });
    await expect(saveWorkspaceRecords(saved, [{ ...imported, report: report() }])).rejects.toThrow("immutable");
    await expect(saveWorkspaceRecords(saved, [{ ...profile, recordId: imported.recordId }])).rejects.toThrow("reclassified");
    expect((await snapshot(saved)).meta.revision).toBe(saved.meta.revision);
  });

  it("preserves distinct reports containing conflicting source-event claims for investigation", async () => {
    const { workspace, profile } = await setup();
    const first = report(); const second = { ...first, importId: crypto.randomUUID(),
      events: first.events.map((event) => ({ ...event, amountBaseUnits: "1" })) };
    const records = [first, second].map((item) => prepareLocalAgentImport(workspace, item, profile.recordId, true));
    const saved = await saveWorkspaceRecords(workspace, records);
    expect(saved.records.filter((record) => record.kind === "agent_import")).toHaveLength(2);
    expect(() => assertWorkspaceIntegrity(saved.records)).not.toThrow();
  });

  it("prevents dangling profiles, wrong local links and duplicate persisted IDs", async () => {
    const { workspace, profile } = await setup();
    const imported = prepareLocalAgentImport(workspace, report(), profile.recordId, true);
    const monitored = prepareAgentMonitoringPolicyRecord(workspace, policy(profile.recordId));
    const saved = await saveWorkspaceRecords(workspace, [imported, monitored]);
    await expect(deleteWorkspaceRecords(saved, [profile.recordId])).rejects.toThrow();
    for (const invalid of [
      { ...imported, recordId: crypto.randomUUID() },
      { ...imported, recordId: crypto.randomUUID(), report: report(), linkedAgentProfileRecordId: monitored.recordId },
      { ...monitored, recordId: crypto.randomUUID() },
    ]) expect(() => assertWorkspaceIntegrity([...saved.records, invalid])).toThrow();
    expect(AgentImportRecordSchema.safeParse({ ...imported, linkBasis: null }).success).toBe(false);
    const deleted = await deleteWorkspaceRecords(saved, [imported.recordId, monitored.recordId, profile.recordId]);
    expect(deleted.records.some((record) => record.kind === "agent_import" || record.kind === "agent_monitoring_policy")).toBe(false);
  });

  it("advances policy revisions exactly once and blocks raw identity, kind and timestamp mutation", async () => {
    const { workspace, profile } = await setup();
    const created = prepareAgentMonitoringPolicyRecord(workspace, { ...policy(profile.recordId), revision: 9 });
    expect(created.policy.revision).toBe(1);
    const saved = await saveWorkspaceRecords(workspace, [created]);
    const existing = saved.records.find((record) => record.kind === "agent_monitoring_policy")!;
    const edited = prepareAgentMonitoringPolicyRecord(saved, { ...existing.policy, name: "Revised local rule" }, existing);
    expect(edited.policy.revision).toBe(2); expect(edited.createdAt).toBe(existing.createdAt); expect(edited.policy.policyId).toBe(existing.policy.policyId);
    expect(() => prepareAgentMonitoringPolicyRecord(saved, { ...existing.policy, policyId: crypto.randomUUID() }, existing)).toThrow();
    expect(() => prepareAgentMonitoringPolicyRecord(saved, existing.policy)).toThrow("already stored");
    for (const invalid of [
      { ...edited, policy: { ...edited.policy, revision: 1 } },
      { ...edited, policy: { ...edited.policy, revision: 3 } },
      { ...edited, policy: { ...edited.policy, policyId: crypto.randomUUID() } },
      { ...edited, createdAt: "2026-08-01T00:00:00Z" },
      { ...profile, recordId: edited.recordId },
    ]) await expect(saveWorkspaceRecords(saved, [invalid])).rejects.toThrow();
    const updated = await saveWorkspaceRecords(saved, [edited]);
    expect(updated.records.find((record) => record.kind === "agent_monitoring_policy")).toMatchObject({ policy: { revision: 2, name: "Revised local rule" } });
  });

  it("enforces report/event/policy caps without changing global or backup limits", async () => {
    const { workspace, profile } = await setup();
    const imports = Array.from({ length: 32 }, () => prepareLocalAgentImport(workspace, report(), profile.recordId, true));
    expect(() => assertWorkspaceIntegrity([...workspace.records, ...imports])).not.toThrow();
    expect(() => assertWorkspaceIntegrity([...workspace.records, ...imports, prepareLocalAgentImport(workspace, report(), profile.recordId, true)])).toThrow();
    const full = Array.from({ length: 8 }, () => prepareLocalAgentImport(workspace, report(64), profile.recordId, true));
    expect(() => assertWorkspaceIntegrity([...workspace.records, ...full])).not.toThrow();
    expect(() => assertWorkspaceIntegrity([...workspace.records, ...full, imports[0]!])).toThrow("512");
    expect(() => prepareLocalAgentImport({ ...workspace, records: [...workspace.records, ...full] }, report(), profile.recordId, true)).toThrow("512");
    const policies = Array.from({ length: 100 }, () => prepareAgentMonitoringPolicyRecord(workspace, policy(profile.recordId)));
    expect(() => assertWorkspaceIntegrity([...workspace.records, ...policies])).not.toThrow();
    expect(() => assertWorkspaceIntegrity([...workspace.records, ...policies, prepareAgentMonitoringPolicyRecord(workspace, policy(profile.recordId))])).toThrow();
    expect(VAULT_RECORD_CAPS.agent_import).toBe(32); expect(VAULT_MAX_RECORDS).toBe(6602); expect(VAULT_MAX_BACKUP_BYTES).toBe(32 * 1024 * 1024);
  });

  it("rejects future capture in authenticated records and keeps old variants unchanged with opaque rescue", async () => {
    const { workspace, profile } = await setup();
    const imported = prepareLocalAgentImport(workspace, report(), profile.recordId, true);
    const monitored = prepareAgentMonitoringPolicyRecord(workspace, policy(profile.recordId));
    const saved = await saveWorkspaceRecords(workspace, [imported, monitored]);
    const future = saved.records.map((record) => record.kind === "agent_import" ?
      { ...record, report: { ...record.report, capturedAt: "2099-01-01T00:00:00Z" } } : record);
    expect(() => assertWorkspaceIntegrity(future as WorkspaceRecord[])).toThrow();
    // The pre-M08 variant set deliberately has no additive M08 variants.
    const oldVariants = [AgentProfileRecordSchema, MonitoringPolicyRecordSchema, EvidenceRecordRecordSchema,
      ActionEnvelopeRecordSchema, WorkspaceSettingsRecordSchema, SentinelRecordSchema, PermissionReceiptRecordSchema,
      ArcObservationRecordSchema, AgentRegistryObservationRecordSchema, JobObservationRecordSchema, X402BundleRecordSchema, GatewayObservationRecordSchema];
    const oldAccepts = (value: unknown) => oldVariants.some((schema) => schema.safeParse(value).success);
    expect(oldAccepts(imported)).toBe(false); expect(oldAccepts(monitored)).toBe(false);
    expect(oldAccepts(profile)).toBe(true);
    const rescue = await exportOpaqueRescue();
    expect(JSON.stringify(rescue)).not.toContain(imported.report.importId);
    expect((await snapshot(saved)).records.length).toBe(saved.records.length);
  });

  it("invalidates an atomic write on lock/cancellation and preserves the old vault", async () => {
    const { workspace, profile } = await setup();
    const imported = prepareLocalAgentImport(workspace, report(), profile.recordId, true);
    const abort = new AbortController(); abort.abort();
    await expect(saveWorkspaceRecords(workspace, [imported], () => { throw new Error("SESSION_LOCKED"); }, abort.signal)).rejects.toThrow();
    expect((await snapshot(workspace)).meta.revision).toBe(workspace.meta.revision);
    const unlocked = await unlockLocalWorkspace(workspace.meta, passphrase);
    expect(unlocked.records.some((record) => record.kind === "agent_import")).toBe(false);
    expect(AgentMonitoringPolicyRecordSchema.safeParse({ ...prepareAgentMonitoringPolicyRecord(workspace, policy(profile.recordId)), policy: { ...policy(profile.recordId), mode: "enforced" } }).success).toBe(false);
  });
});

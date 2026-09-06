import "fake-indexeddb/auto";
import { M01_FIXTURES, WorkspaceRecordSchema } from "@openarc/shared";
import { afterEach, describe, expect, it } from "vitest";
import { runGatewayPermissionFlow } from "../src/api/gateway-permission-flow.js";
import { VAULT_DATABASE_NAME, readVaultSnapshot } from "../src/vault/db.js";
import { VaultError } from "../src/vault/errors.js";
import { assertWorkspaceIntegrity, createFixtureWorkspaceRecords, createLocalWorkspace, deleteWorkspaceRecords,
  exportLocalWorkspace, importLocalWorkspace, recoverLocalWorkspace, saveWorkspaceRecords, unlockLocalWorkspace } from "../src/vault/service.js";
import { GATEWAY_TEST_REQUEST, gatewayBundleRecord, gatewayEnvelope } from "./gateway-test-fixtures.js";

const passphrase = "Gateway local test passphrase";
afterEach(async () => new Promise<void>((resolve, reject) => {
  const request = indexedDB.deleteDatabase(VAULT_DATABASE_NAME);
  request.onsuccess = () => resolve();request.onerror = () => reject(request.error);
  request.onblocked = () => reject(new Error("Test deletion blocked"));
}));

async function savedGateway() {
  const created = await createLocalWorkspace(passphrase);
  const bundle = gatewayBundleRecord(created.meta.revision);
  const workspace = await saveWorkspaceRecords(created, [bundle]);
  const result = await runGatewayPermissionFlow({ workspace, origin: "https://app.example.test",
    request: GATEWAY_TEST_REQUEST, linkedBundleRecordId: bundle.recordId, signal: new AbortController().signal,
    assertActive: () => undefined, save: saveWorkspaceRecords, fetch: async () => gatewayEnvelope() });
  return { ...result, bundle };
}

describe("M07 encrypted Gateway and receipt bundle integrity", () => {
  it("round-trips encrypted records through unlock, backup, import and recovery", async () => {
    const saved = await savedGateway();
    const raw = JSON.stringify(await readVaultSnapshot(saved.workspace.meta.vaultId, saved.workspace.meta.revision, saved.workspace.meta.coordinationRevision));
    for (const canary of [saved.bundle.bundle.resource.resourceDigest, GATEWAY_TEST_REQUEST.transferId,
      "circle_gateway_transfer", "imported_metadata", "x402_bundle"]) expect(raw).not.toContain(canary);
    const unlocked = await unlockLocalWorkspace(saved.workspace.meta, passphrase);
    expect(unlocked.records).toContainEqual(saved.observation);
    const backup = await exportLocalWorkspace(unlocked, "Independent gateway backup passphrase");
    expect(JSON.stringify(backup)).not.toContain(GATEWAY_TEST_REQUEST.transferId);
    const imported = await importLocalWorkspace(backup, "Independent gateway backup passphrase", "Restored gateway passphrase", unlocked.meta);
    const recovered = await recoverLocalWorkspace(imported.meta, imported.recoverySecret, passphrase);
    expect(recovered.records).toContainEqual(expect.objectContaining({ kind: "x402_bundle", recordId: saved.bundle.recordId }));
    expect(recovered.records).toContainEqual(expect.objectContaining({ kind: "gateway_observation", recordId: saved.observation.recordId }));
    expect(() => assertWorkspaceIntegrity(recovered.records)).not.toThrow();
  });

  it("requires paired deletion and prevents deleting a locally linked bundle", async () => {
    const saved = await savedGateway();
    for (const id of [saved.receipt.recordId, saved.bundle.recordId]) {
      await expect(deleteWorkspaceRecords(saved.workspace, [id])).rejects.toMatchObject({ code: "INVALID_BACKUP" });
    }
    const remaining = await deleteWorkspaceRecords(saved.workspace, [saved.receipt.recordId, saved.observation.recordId, saved.bundle.recordId]);
    expect(remaining.records.some(record => record.kind === "gateway_observation" || record.kind === "x402_bundle")).toBe(false);
  });

  it("rejects orphaned, mismatched, duplicate and dangling Gateway records", async () => {
    const saved = await savedGateway();
    const records = saved.workspace.records;
    const replace = (replacement: unknown) => records.map(record => record.recordId === saved.observation.recordId ? replacement : record);
    const observation = saved.observation;
    for (const invalid of [
      records.filter(record => record.recordId !== saved.receipt.recordId),
      replace({ ...observation, observation: { ...observation.observation, transfer: { ...observation.observation.transfer, id: crypto.randomUUID() } } }),
      [...records, { ...observation, recordId: crypto.randomUUID() }],
      replace({ ...observation, linkedBundleRecordId: crypto.randomUUID() }),
      replace({ ...observation, linkBasis: null }),
      [...records, { ...saved.bundle, recordId: crypto.randomUUID() }],
    ]) expect(() => assertWorkspaceIntegrity(invalid as typeof records)).toThrow(VaultError);
  });

  it("rejects raw signatures and precomputed authentication claims before encryption", async () => {
    const saved = await savedGateway();
    for (const extra of [{ signature: `0x${"e".repeat(130)}` }, { authentication: "verified" }]) {
      const invalid = { ...saved.bundle, bundle: { ...saved.bundle.bundle, ...extra } };
      expect(WorkspaceRecordSchema.safeParse(invalid).success).toBe(false);
      await expect(saveWorkspaceRecords(saved.workspace, [invalid as typeof saved.bundle])).rejects.toMatchObject({ code: "INVALID_BACKUP" });
    }
  });

  it("preserves old synthetic fixture records while adding separate M07 records", async () => {
    const created = await createLocalWorkspace(passphrase);
    const oldRecords = createFixtureWorkspaceRecords(M01_FIXTURES[0]!, created.meta.revision);
    const oldWorkspace = await saveWorkspaceRecords(created, oldRecords);
    const oldBackup = await exportLocalWorkspace(oldWorkspace, "Older fixture backup passphrase");
    const imported = await importLocalWorkspace(oldBackup, "Older fixture backup passphrase", passphrase, oldWorkspace.meta);
    const fixtureEvidenceBefore = imported.records.filter(record => record.kind === "evidence_record");
    const bundle = gatewayBundleRecord(imported.meta.revision);
    const upgraded = await saveWorkspaceRecords(imported, [bundle]);
    expect(upgraded.records.filter(record => record.kind === "evidence_record")).toEqual(fixtureEvidenceBefore);
    for (const record of fixtureEvidenceBefore) {
      if (record.kind === "evidence_record") expect(record.evidence.source.environment).toBe("synthetic_fixture");
    }
    expect(upgraded.records.filter(record => record.kind === "x402_bundle")).toHaveLength(1);
  });
});

// P08-00 DOCUMENTED KNOWN GAP (to be closed by P08-01, see
// tmp/commerce-port/p08-00-root-vault-kinds-2026-09-15.md). The uncommitted ROOT build adds the Vault record kinds
// task_draft, task_report and research_run. This file proves what the INTEGRATION reader does TODAY with a Vault or
// backup that a ROOT build wrote: it cannot unlock, recover or import it and reports a misleading wrong-passphrase
// error, while opaque rescue still exports the encrypted bytes. These tests assert today's failure on purpose.
// When P08-01 lands an additive dual-read, update the KNOWN GAP expectations deliberately in that packet.
import "fake-indexeddb/auto";

import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceRecordSchema, type WorkspaceRecord } from "@openarc/shared";

import { createManifestSentinel } from "../src/vault/crypto.js";
import { VAULT_DATABASE_NAME } from "../src/vault/db.js";
import { exportOpaqueRescue, importLocalWorkspace, recoverLocalWorkspace, unlockLocalWorkspace } from "../src/vault/service.js";
import type { EncryptedEnvelope, LogicalBackupArchive, PublicVaultMeta, VaultBackupFile } from "../src/vault/types.js";
import {
  VAULT_COMPAT_FILES,
  deleteIndexedDb,
  readFixtureJson,
  readFixtureText,
  readIndexedDbImage,
  readManifest,
  seedIndexedDbImage,
  storeRows,
  type IndexedDbImage,
} from "./vault-compat/fixture-io.js";
import { referenceEncryptBackup, referenceEncryptEnvelope, toB64u } from "./vault-compat/reference-codec.js";
import { ROOT_KIND_RECORD_SCHEMAS, buildRootKindRecords, type RootKind } from "./vault-compat/root-kind-records.js";

const manifest = await readManifest();
const snapshot = await readFixtureJson<IndexedDbImage>(VAULT_COMPAT_FILES.snapshot);
const expectedRecords = await readFixtureJson<WorkspaceRecord[]>(VAULT_COMPAT_FILES.expectedRecords);
const logicalBackup = await readFixtureJson<LogicalBackupArchive>(VAULT_COMPAT_FILES.logicalBackup);
const frozenBackup = JSON.parse(await readFixtureText(VAULT_COMPAT_FILES.encryptedBackup)) as VaultBackupFile;
const meta = storeRows(snapshot, "vaultMeta")[0] as PublicVaultMeta;
const account = expectedRecords.find((record) => record.kind === "arc_observation" &&
  record.observation.schemaVersion === "openarc.arc-account-snapshot.v1");
const walletAgent = expectedRecords.find((record) => record.kind === "agent_profile" && record.wallets.length > 0);
if (account?.kind !== "arc_observation" || walletAgent?.kind !== "agent_profile") throw new Error("Frozen fixture is missing its account observation or wallet agent");
const rootRecords = buildRootKindRecords({ recordRevision: meta.revision, agentProfileRecordId: walletAgent.recordId,
  accountObservationRecordId: account.recordId,
  accountSnapshot: account.observation as RootKindInputSnapshot });
type RootKindInputSnapshot = Parameters<typeof buildRootKindRecords>[0]["accountSnapshot"];
const KINDS = Object.keys(ROOT_KIND_RECORD_SCHEMAS) as RootKind[];
const GAP = "KNOWN GAP P08-00 -> P08-01 (tmp/commerce-port/p08-00-root-vault-kinds-2026-09-15.md)";

/** A valid integration-kind record, used as the control for the reference-encrypted write path. */
const controlRecord = (() => {
  const receipt = expectedRecords.find((record) => record.kind === "permission_receipt" && record.recordSchema === "openarc.permission-receipt.v1")!;
  return { ...receipt, recordId: "7e570000-0000-4000-8000-000000000a01", recordRevision: meta.revision };
})();

afterEach(async () => {
  await deleteIndexedDb(VAULT_DATABASE_NAME);
});

/**
 * Writes the frozen Vault plus extra records exactly as a ROOT build would store them: AES-GCM under the frozen data
 * key and the unchanged v1 record AAD, with a fresh valid manifest sentinel. Only the record kind differs.
 */
async function seedVaultWith(extra: readonly { recordId: string }[]): Promise<IndexedDbImage> {
  await seedIndexedDbImage(snapshot);
  const { key } = await unlockLocalWorkspace(meta, manifest.secrets.workspacePassphrase);
  await deleteIndexedDb(VAULT_DATABASE_NAME);
  const added: EncryptedEnvelope[] = [];
  for (const [index, record] of extra.entries()) {
    added.push(await referenceEncryptEnvelope(key, meta.vaultId, record, meta.revision,
      toB64u(new TextEncoder().encode(`P08ROOTKIND${index}`))));
  }
  const others = (storeRows(snapshot, "records") as EncryptedEnvelope[]).filter((row) => row.id !== meta.sentinelRecordId);
  const sentinel = await createManifestSentinel(meta, key, [...others, ...added], "2026-09-15T09:00:00.000Z");
  const image: IndexedDbImage = { ...snapshot, stores: snapshot.stores.map((store) => store.name === "records"
    ? { ...store, rows: [...others, ...added, sentinel.envelope].sort((left, right) => left.id.localeCompare(right.id)) }
    : store) };
  await seedIndexedDbImage(image);
  return image;
}

async function backupWith(extra: readonly unknown[]): Promise<unknown> {
  const archive = { ...logicalBackup, records: [...logicalBackup.records, ...extra] };
  return referenceEncryptBackup(archive, manifest.secrets.backupPassphrase, frozenBackup.kdf.salt,
    toB64u(new TextEncoder().encode("P08ROOTBKUP!")));
}

describe("P08-00 ROOT-only Vault kinds on the integration reader", { timeout: 60_000 }, () => {
  it("builds ROOT records with the ROOT recordSchema literals, which the integration schema does not know", () => {
    expect(ROOT_KIND_RECORD_SCHEMAS).toEqual({ task_draft: "openarc.task-draft-record.v1",
      task_report: "openarc.task-report-record.v1", research_run: "openarc.research-run.v1" });
    for (const kind of KINDS) {
      expect(rootRecords[kind]).toMatchObject({ kind, recordSchema: ROOT_KIND_RECORD_SCHEMAS[kind] });
      expect(WorkspaceRecordSchema.safeParse(rootRecords[kind]).success, `${GAP}: integration WorkspaceRecordSchema rejects ${kind}`).toBe(false);
    }
  });

  it("control: the same reference write path with an integration-known kind still unlocks and imports", async () => {
    const image = await seedVaultWith([controlRecord]);
    const unlocked = await unlockLocalWorkspace(meta, manifest.secrets.workspacePassphrase);
    expect(unlocked.records).toContainEqual(controlRecord);
    expect(await readIndexedDbImage(VAULT_DATABASE_NAME)).toEqual(image);
    await deleteIndexedDb(VAULT_DATABASE_NAME);
    const imported = await importLocalWorkspace(await backupWith([controlRecord]), manifest.secrets.backupPassphrase,
      "TEST-ONLY control import passphrase", null);
    expect(imported.records.map((record) => record.recordId)).toContain(controlRecord.recordId);
  });

  it.each([...KINDS.map((kind) => [kind] as RootKind[]), KINDS])(
    `${GAP}: a Vault holding %s written by the ROOT build fails unlock and recovery as a wrong passphrase; opaque rescue still works`,
    async (...kinds: RootKind[]) => {
      const extra = kinds.map((kind) => rootRecords[kind]);
      const image = await seedVaultWith(extra);
      await expect(unlockLocalWorkspace(meta, manifest.secrets.workspacePassphrase), `${GAP}: unlock`)
        .rejects.toMatchObject({ code: "INVALID_PASSPHRASE", message: "Wrong passphrase or damaged workspace." });
      await expect(recoverLocalWorkspace(meta, manifest.secrets.recoverySecret, "TEST-ONLY recovery passphrase"), `${GAP}: recovery`)
        .rejects.toMatchObject({ code: "RECOVERY_FAILED", message: "Wrong passphrase or damaged workspace." });
      expect(await readIndexedDbImage(VAULT_DATABASE_NAME), "failed unlock and recovery never write").toEqual(image);
      const rescue = await exportOpaqueRescue();
      expect(rescue.vaultMeta).toEqual(meta);
      expect(rescue.records).toEqual(storeRows(image, "records"));
      for (const record of extra) expect(rescue.records).toContainEqual(expect.objectContaining({ id: record.recordId }));
    },
  );

  it.each([...KINDS.map((kind) => [kind] as RootKind[]), KINDS])(
    `${GAP}: an encrypted backup holding %s written by the ROOT build fails import with INVALID_BACKUP`,
    async (...kinds: RootKind[]) => {
      await expect(importLocalWorkspace(await backupWith(kinds.map((kind) => rootRecords[kind])), manifest.secrets.backupPassphrase,
        "TEST-ONLY import passphrase", null), `${GAP}: import`).rejects.toMatchObject({ code: "INVALID_BACKUP" });
      expect(await readIndexedDbImage(VAULT_DATABASE_NAME), "a failed import creates no Vault").toBeNull();
    },
  );
});

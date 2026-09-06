import {
  assertVaultCapacity,
  createRevision,
  parseEncryptedEnvelope,
  parsePublicVaultMeta,
} from "./crypto.js";
import { VaultError } from "./errors.js";
import {
  VAULT_DATABASE_VERSION,
  type EncryptedEnvelope,
  type PublicVaultMeta,
  type StoredVaultSnapshot,
  type VaultStorageStatus,
} from "./types.js";

export const VAULT_DATABASE_NAME = "openarc-vault";
const META_STORE = "vaultMeta";
const RECORD_STORE = "records";

export async function readVaultMeta(): Promise<PublicVaultMeta | null> {
  const db = await openVaultDatabase();
  try {
    const transaction = db.transaction([META_STORE, RECORD_STORE], "readonly");
    const [result, recordCount] = await Promise.all([
      requestResult<unknown>(transaction.objectStore(META_STORE).get("active")),
      requestResult<number>(transaction.objectStore(RECORD_STORE).count()),
    ]);
    await transactionDone(transaction);
    if (result === undefined && recordCount !== 0) {
      throw new VaultError(
        "INVALID_BACKUP",
        "Encrypted records exist without readable workspace metadata. Export an opaque rescue or delete the unreadable local data.",
      );
    }
    return result === undefined ? null : parsePublicVaultMeta(result);
  } finally {
    db.close();
  }
}

export async function readOpaqueVaultSnapshot(): Promise<{ vaultMeta: unknown; records: unknown[] }> {
  const db = await openOpaqueVaultDatabase();
  try {
    const availableStores = [META_STORE, RECORD_STORE].filter((name) =>
      db.objectStoreNames.contains(name),
    );
    if (availableStores.length === 0) return { vaultMeta: undefined, records: [] };
    const transaction = db.transaction(availableStores, "readonly");
    const [vaultMeta, records] = await Promise.all([
      db.objectStoreNames.contains(META_STORE)
        ? requestResult<unknown>(transaction.objectStore(META_STORE).get("active"))
        : Promise.resolve(undefined),
      db.objectStoreNames.contains(RECORD_STORE)
        ? requestResult<unknown[]>(transaction.objectStore(RECORD_STORE).getAll())
        : Promise.resolve([]),
    ]);
    await transactionDone(transaction);
    return { vaultMeta, records };
  } finally {
    db.close();
  }
}

export async function readVaultSnapshot(
  expectedVaultId: string,
  expectedRevision: string,
  expectedCoordinationRevision: string,
): Promise<{ meta: PublicVaultMeta; records: EncryptedEnvelope[] }> {
  const db = await openVaultDatabase();
  try {
    const transaction = db.transaction([META_STORE, RECORD_STORE], "readonly");
    const metaRequest = transaction.objectStore(META_STORE).get("active");
    const recordsRequest = transaction.objectStore(RECORD_STORE).getAll();
    const [metaInput, recordInputs] = await Promise.all([
      requestResult<unknown>(metaRequest),
      requestResult<unknown[]>(recordsRequest),
    ]);
    await transactionDone(transaction);
    const meta = parsePublicVaultMeta(metaInput);
    const records = recordInputs.map(parseEncryptedEnvelope);
    if (
      meta.vaultId !== expectedVaultId ||
      meta.revision !== expectedRevision ||
      meta.coordinationRevision !== expectedCoordinationRevision ||
      meta.deletionPending
    ) {
      throw conflict();
    }
    assertVaultCapacity(meta, records);
    return { meta, records };
  } finally {
    db.close();
  }
}

export async function initializeVault(
  meta: PublicVaultMeta,
  initialRecords: readonly EncryptedEnvelope[],
  assertActive: () => void = () => undefined,
  signal?: AbortSignal,
): Promise<void> {
  const parsedMeta = parsePublicVaultMeta(meta);
  const parsedRecords = initialRecords.map(parseEncryptedEnvelope);
  if (
    parsedRecords.length < 1 ||
    parsedRecords.filter((record) => record.id === parsedMeta.sentinelRecordId).length !== 1
  ) {
    throw invalidBackup();
  }
  assertVaultCapacity(parsedMeta, parsedRecords);
  const db = await openVaultDatabase();
  try {
    const transaction = db.transaction([META_STORE, RECORD_STORE], "readwrite", {
      durability: "strict",
    });
    const completion = transactionDone(transaction, signal);
    try {
      const metaStore = transaction.objectStore(META_STORE);
      const recordStore = transaction.objectStore(RECORD_STORE);
      const [existing, existingRecordCount] = await Promise.all([
        requestResult<unknown>(metaStore.get("active")),
        requestResult<number>(recordStore.count()),
      ]);
      if (existing !== undefined || existingRecordCount !== 0) {
        throw new VaultError(
          "VAULT_EXISTS",
          "Encrypted OpenArc workspace data already exists here.",
        );
      }
      assertActive();
      metaStore.put(parsedMeta);
      parsedRecords.forEach((record) => recordStore.put(record));
      await completion;
    } catch (error) {
      abortTransaction(transaction);
      await completion.catch(() => undefined);
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function writeEncryptedRecords(
  changedRecords: readonly EncryptedEnvelope[],
  nextMeta: PublicVaultMeta,
  expectedMeta: Pick<PublicVaultMeta, "vaultId" | "revision" | "coordinationRevision">,
  assertActive: () => void = () => undefined,
  signal?: AbortSignal,
): Promise<void> {
  const recordsToWrite = changedRecords.map(parseEncryptedEnvelope);
  if (new Set(recordsToWrite.map((record) => record.id)).size !== recordsToWrite.length) {
    throw invalidBackup();
  }
  const parsedMeta = parsePublicVaultMeta(nextMeta);
  const db = await openVaultDatabase();
  try {
    const transaction = db.transaction([META_STORE, RECORD_STORE], "readwrite", {
      durability: "strict",
    });
    const completion = transactionDone(transaction, signal);
    try {
      await assertRevision(transaction.objectStore(META_STORE), expectedMeta);
      const recordStore = transaction.objectStore(RECORD_STORE);
      const existing = (await requestResult<unknown[]>(recordStore.getAll())).map(parseEncryptedEnvelope);
      assertActive();
      const changedIds = new Set(recordsToWrite.map((record) => record.id));
      const combined = [...recordsToWrite, ...existing.filter((record) => !changedIds.has(record.id))];
      assertVaultCapacity(parsedMeta, combined);
      recordsToWrite.forEach((record) => recordStore.put(record));
      transaction.objectStore(META_STORE).put(parsedMeta);
      await completion;
    } catch (error) {
      abortTransaction(transaction);
      await completion.catch(() => undefined);
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function removeEncryptedRecords(
  ids: readonly string[],
  replacementRecords: readonly EncryptedEnvelope[],
  nextMeta: PublicVaultMeta,
  expectedMeta: Pick<PublicVaultMeta, "vaultId" | "revision" | "coordinationRevision">,
  assertActive: () => void = () => undefined,
  signal?: AbortSignal,
): Promise<void> {
  const parsedMeta = parsePublicVaultMeta(nextMeta);
  const recordsToWrite = replacementRecords.map(parseEncryptedEnvelope);
  const db = await openVaultDatabase();
  try {
    const transaction = db.transaction([META_STORE, RECORD_STORE], "readwrite", {
      durability: "strict",
    });
    const completion = transactionDone(transaction, signal);
    try {
      await assertRevision(transaction.objectStore(META_STORE), expectedMeta);
      const recordStore = transaction.objectStore(RECORD_STORE);
      const existing = (await requestResult<unknown[]>(recordStore.getAll())).map(parseEncryptedEnvelope);
      assertActive();
      const removedIds = new Set(ids);
      const replacementIds = new Set(recordsToWrite.map((record) => record.id));
      const combined = [
        ...recordsToWrite,
        ...existing.filter(
          (record) => !removedIds.has(record.id) && !replacementIds.has(record.id),
        ),
      ];
      assertVaultCapacity(parsedMeta, combined);
      ids.forEach((id) => recordStore.delete(id));
      recordsToWrite.forEach((record) => recordStore.put(record));
      transaction.objectStore(META_STORE).put(parsedMeta);
      await completion;
    } catch (error) {
      abortTransaction(transaction);
      await completion.catch(() => undefined);
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function replaceVault(
  archive: StoredVaultSnapshot,
  expectedCurrent: Pick<PublicVaultMeta, "vaultId" | "revision" | "coordinationRevision"> | null,
  assertActive: () => void = () => undefined,
  signal?: AbortSignal,
): Promise<PublicVaultMeta> {
  const vault = parsePublicVaultMeta(archive.vault);
  const records = archive.records.map(parseEncryptedEnvelope);
  assertVaultCapacity(vault, records);
  const db = await openVaultDatabase();
  try {
    const transaction = db.transaction([META_STORE, RECORD_STORE], "readwrite", {
      durability: "strict",
    });
    const completion = transactionDone(transaction, signal);
    try {
      const metaStore = transaction.objectStore(META_STORE);
      const recordStore = transaction.objectStore(RECORD_STORE);
      const [currentInput, currentRecordCount] = await Promise.all([
        requestResult<unknown>(metaStore.get("active")),
        requestResult<number>(recordStore.count()),
      ]);
      const current = currentInput === undefined ? null : parsePublicVaultMeta(currentInput);
      const matches =
        expectedCurrent === null
          ? current === null && currentRecordCount === 0
          : current?.vaultId === expectedCurrent.vaultId &&
            current.revision === expectedCurrent.revision &&
            current.coordinationRevision === expectedCurrent.coordinationRevision &&
            !current.deletionPending;
      if (!matches) throw conflict();
      const importedMeta = vault;
      assertVaultCapacity(importedMeta, records);
      assertActive();
      metaStore.clear();
      recordStore.clear();
      metaStore.put(importedMeta);
      records.forEach((record) => recordStore.put(record));
      await completion;
      return importedMeta;
    } catch (error) {
      abortTransaction(transaction);
      await completion.catch(() => undefined);
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function deleteLocalVault(onBlocked?: () => void): Promise<void> {
  requireIndexedDb();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(VAULT_DATABASE_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error("IndexedDB deletion failed"));
    request.onblocked = () => onBlocked?.();
  });
}

export async function signalVaultLock(
  expectedMeta: Pick<PublicVaultMeta, "vaultId">,
): Promise<PublicVaultMeta> {
  const db = await openVaultDatabase();
  try {
    const transaction = db.transaction(META_STORE, "readwrite", { durability: "strict" });
    const completion = transactionDone(transaction);
    try {
      const store = transaction.objectStore(META_STORE);
      const currentInput = await requestResult<unknown>(store.get("active"));
      const current = currentInput === undefined ? null : parsePublicVaultMeta(currentInput);
      if (current?.vaultId !== expectedMeta.vaultId) throw conflict();
      const next = { ...current, coordinationRevision: createRevision() };
      store.put(next);
      await completion;
      return next;
    } catch (error) {
      abortTransaction(transaction);
      await completion.catch(() => undefined);
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function markVaultDeleting(vaultId: string): Promise<PublicVaultMeta> {
  const db = await openVaultDatabase();
  try {
    const transaction = db.transaction(META_STORE, "readwrite", { durability: "strict" });
    const completion = transactionDone(transaction);
    try {
      const store = transaction.objectStore(META_STORE);
      const currentInput = await requestResult<unknown>(store.get("active"));
      const current = currentInput === undefined ? null : parsePublicVaultMeta(currentInput);
      if (current?.vaultId !== vaultId) throw conflict();
      const next = {
        ...current,
        coordinationRevision: createRevision(),
        deletionPending: true,
      };
      store.put(next);
      await completion;
      return next;
    } catch (error) {
      abortTransaction(transaction);
      await completion.catch(() => undefined);
      throw error;
    }
  } finally {
    db.close();
  }
}

export async function observeVaultDatabase(
  onUnexpectedClose: (reason: "deletion" | "versionchange" | "close") => void,
): Promise<() => void> {
  const db = await openVaultDatabase();
  return installVaultDatabaseObserver(db, onUnexpectedClose);
}

export function installVaultDatabaseObserver(
  db: IDBDatabase,
  onUnexpectedClose: (reason: "deletion" | "versionchange" | "close") => void,
): () => void {
  let intentional = false;
  let notified = false;
  const notify = (reason: "deletion" | "versionchange" | "close") => {
    if (intentional || notified) return;
    notified = true;
    onUnexpectedClose(reason);
  };
  const close = () => {
    intentional = true;
    db.onversionchange = null;
    db.onclose = null;
    db.close();
  };
  db.onversionchange = (event) => {
    notify(event.newVersion === null ? "deletion" : "versionchange");
    db.close();
  };
  db.onclose = () => {
    notify("close");
  };
  return close;
}

export async function readStorageStatus(): Promise<VaultStorageStatus> {
  if (typeof indexedDB === "undefined") {
    return { supported: false, persistent: null, usage: null, quota: null };
  }
  if (!navigator.storage) return { supported: true, persistent: null, usage: null, quota: null };
  const [persistent, estimate] = await Promise.all([
    navigator.storage.persisted?.().catch(() => false) ?? Promise.resolve(null),
    navigator.storage.estimate?.().catch((): StorageEstimate => ({})) ??
      Promise.resolve({} as StorageEstimate),
  ]);
  return {
    supported: true,
    persistent,
    usage: typeof estimate.usage === "number" ? estimate.usage : null,
    quota: typeof estimate.quota === "number" ? estimate.quota : null,
  };
}

export async function requestPersistentStorage(): Promise<VaultStorageStatus> {
  if (!navigator.storage?.persist) return readStorageStatus();
  try {
    await navigator.storage.persist();
  } catch {
    // Persistence is optional and cannot be a correctness dependency.
  }
  return readStorageStatus();
}

async function openVaultDatabase(): Promise<IDBDatabase> {
  requireIndexedDb();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VAULT_DATABASE_NAME, VAULT_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(RECORD_STORE)) db.createObjectStore(RECORD_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    // IndexedDB open/upgrade requests cannot be cancelled. Keep this promise
    // pending rather than report a failure while a later success can still
    // produce a live database handle.
    request.onblocked = () => undefined;
  });
}

async function openOpaqueVaultDatabase(): Promise<IDBDatabase> {
  requireIndexedDb();
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(VAULT_DATABASE_NAME);
    request.onupgradeneeded = () => {
      request.transaction?.abort();
      reject(new VaultError("VAULT_CONFLICT", "No local encrypted workspace exists."));
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB rescue open failed"));
    request.onblocked = () => undefined;
  });
}

async function assertRevision(
  store: IDBObjectStore,
  expectedMeta: Pick<PublicVaultMeta, "vaultId" | "revision" | "coordinationRevision">,
): Promise<void> {
  const currentInput = await requestResult<unknown>(store.get("active"));
  const current = currentInput === undefined ? null : parsePublicVaultMeta(currentInput);
  if (
    current?.vaultId !== expectedMeta.vaultId ||
    current.revision !== expectedMeta.revision ||
    current.coordinationRevision !== expectedMeta.coordinationRevision ||
    current.deletionPending
  ) {
    throw conflict();
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => abortTransaction(transaction);
    const settle = (callback: () => void) => {
      signal?.removeEventListener("abort", abort);
      callback();
    };
    transaction.oncomplete = () => settle(resolve);
    transaction.onerror = () =>
      settle(() =>
        reject(
          signal?.aborted
            ? signal.reason
            : transaction.error ?? new Error("IndexedDB transaction failed"),
        ),
      );
    transaction.onabort = () => settle(() => reject(signal?.reason ?? transaction.error ?? new Error("IndexedDB transaction aborted")));
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function abortTransaction(transaction: IDBTransaction): void {
  try {
    transaction.abort();
  } catch {
    // The transaction may already have committed or aborted.
  }
}

function requireIndexedDb(): void {
  if (typeof indexedDB === "undefined") {
    throw new VaultError(
      "UNSUPPORTED_BROWSER",
      "This browser cannot provide the encrypted local workspace because IndexedDB is unavailable.",
    );
  }
}

function conflict(): VaultError {
  return new VaultError(
    "VAULT_CONFLICT",
    "This encrypted workspace changed in another tab. Lock and unlock again before continuing.",
  );
}

function invalidBackup(): VaultError {
  return new VaultError("INVALID_BACKUP", "The encrypted workspace data is invalid or incompatible.");
}

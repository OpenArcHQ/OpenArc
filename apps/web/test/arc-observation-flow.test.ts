import {
  API_SCHEMA_VERSION,
  ARC_TESTNET,
  ArcAccountSnapshotEnvelopeSchema,
  type ArcObservationPermissionReceiptRecord,
  type WorkspaceRecord,
} from "@openarc/shared";
import { describe, expect, it, vi } from "vitest";

import { runArcObservationPermissionFlow, ArcObservationFinalizationError } from "../src/api/arc-permission-flow.js";
import { OpenArcRequestError } from "../src/api/client.js";
import type { UnlockedWorkspace } from "../src/vault/types.js";

const address = "0x1111111111111111111111111111111111111111";
const blockHash = `0x${"a".repeat(64)}`;
const envelope = ArcAccountSnapshotEnvelopeSchema.parse({ ok: true,
  meta: { schemaVersion: API_SCHEMA_VERSION, requestId: "11111111-1111-4111-8111-111111111111", buildSha: "test-sha" },
  data: { schemaVersion: "openarc.arc-account-snapshot.v1", network: ARC_TESTNET.caip2, address,
    anchor: { blockNumber: "100", blockHash, blockTimestamp: "2026-09-03T11:59:59Z",
      finality: "deterministic", confirmations: "1" },
    nativeUsdc: { asset: "USDC", interface: "native",
      amount: { baseUnits: "1", decimals: 18, decimal: "0.000000000000000001" } },
    erc20UsdcView: { asset: "USDC", interface: "erc20", contract: ARC_TESTNET.contracts.usdc,
      amount: { baseUnits: "0", decimals: 6, decimal: "0" }, relationship: "same_underlying_balance",
      truncatesSubMicroUsdc: true },
    source: { sourceId: "arc_primary_rpc", origin: ARC_TESTNET.rpcHttp,
      explorerOrigin: ARC_TESTNET.explorerOrigin, network: ARC_TESTNET.caip2,
      sourceRevision: ARC_TESTNET.sourceRevision, observedAt: "2026-09-03T12:00:00Z",
      adapterVersion: "openarc.arc-observation.m04.v1" },
    limitations: ["This is a read-only observation at one exact Arc Testnet block.",
      "The 6-decimal ERC-20 view truncates native precision below one micro-USDC.",
      "A public address is not proof that its owner or controller is an agent."] } });

function setup() {
  let revision = 0;
  const initial = { meta: { revision: "A".repeat(32) }, records: [] } as unknown as UnlockedWorkspace;
  const writes: WorkspaceRecord[][] = [];
  const save = vi.fn(async (workspace: UnlockedWorkspace, changes: readonly WorkspaceRecord[]) => {
    writes.push(structuredClone([...changes]));
    revision += 1;
    const ids = new Set(changes.map((record) => record.recordId));
    return { ...workspace, meta: { ...workspace.meta, revision: String(revision).padStart(32, "A") },
      records: [...workspace.records.filter((record) => !ids.has(record.recordId)), ...changes] } as UnlockedWorkspace;
  });
  const ids = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
  const controller = new AbortController();
  const base = { workspace: initial, origin: "https://app.example.test",
    input: { kind: "account" as const, request: { network: ARC_TESTNET.caip2, address } },
    signal: controller.signal, assertActive: () => { if (controller.signal.aborted) throw new Error("session changed"); },
    save, request: vi.fn(async () => envelope),
    now: vi.fn().mockReturnValueOnce("2026-09-03T11:59:58Z").mockReturnValue("2026-09-03T12:00:01Z"),
    id: () => ids.shift()! };
  return { base, save, writes, controller };
}

describe("M04 encrypted observation transaction", () => {
  it("commits disclosure before contact and atomically commits completion plus observation", async () => {
    const { base, save, writes } = setup();
    const result = await runArcObservationPermissionFlow(base);
    expect(save).toHaveBeenCalledTimes(2);
    expect(base.request).toHaveBeenCalledOnce();
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(base.request.mock.invocationCallOrder[0]!);
    expect(writes[0]).toHaveLength(1);
    expect(writes[0]![0]).toMatchObject({ recordSchema: "openarc.permission-receipt.v2",
      connectorId: "arc_account_snapshot", outcome: "approved", released: { network: ARC_TESTNET.caip2, address },
      destination: { path: "/v1/private/arc/account-snapshot", upstreams: [ARC_TESTNET.rpcHttp] } });
    expect(writes[1]).toHaveLength(2);
    expect(writes[1]!.map((record) => record.kind).sort()).toEqual(["arc_observation", "permission_receipt"]);
    expect(writes[1]!.find((record) => record.kind === "permission_receipt")).toMatchObject({ outcome: "completed" });
    expect(result.observation.observation).toEqual(envelope.data);
    expect(result.observation.permissionReceiptId).toBe(result.receipt.recordId);
  });

  it("proves failed approval persistence causes zero network and zero observation", async () => {
    const { base, save, writes } = setup();
    save.mockRejectedValueOnce(new Error("PRIVATE_STORAGE_CANARY"));
    await expect(runArcObservationPermissionFlow(base)).rejects.toThrow("PRIVATE_STORAGE_CANARY");
    expect(base.request).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
  });

  it("keeps prior state unchanged on source outage and records only the failed disclosure", async () => {
    const { base, writes } = setup();
    base.request.mockRejectedValueOnce(new OpenArcRequestError("SOURCE_UNAVAILABLE", "post-send"));
    await expect(runArcObservationPermissionFlow(base)).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    expect(writes).toHaveLength(2);
    expect(writes[1]).toHaveLength(1);
    expect(writes[1]![0]).toMatchObject({ kind: "permission_receipt", outcome: "failed",
      failureCode: "SOURCE_UNAVAILABLE" });
    expect(writes.flat().some((record) => record.kind === "arc_observation")).toBe(false);
  });

  it("leaves the approved receipt intact when the atomic result save fails", async () => {
    const { base, save, writes } = setup();
    const original = save.getMockImplementation()!;
    save.mockImplementationOnce(original).mockRejectedValueOnce(new Error("PRIVATE_QUOTA_CANARY"));
    await expect(runArcObservationPermissionFlow(base)).rejects.toBeInstanceOf(ArcObservationFinalizationError);
    expect(base.request).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toMatchObject({ outcome: "approved" });
  });

  it("cancellation after approval suppresses every late write", async () => {
    const { base, controller, writes } = setup();
    base.request.mockImplementationOnce(async () => { controller.abort(); throw new OpenArcRequestError("REQUEST_UNAVAILABLE", "post-send"); });
    await expect(runArcObservationPermissionFlow(base)).rejects.toBeDefined();
    expect(writes).toHaveLength(1);
    expect((writes[0]![0] as ArcObservationPermissionReceiptRecord).outcome).toBe("approved");
  });
});

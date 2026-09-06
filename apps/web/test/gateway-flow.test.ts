import { API_CLIENT_HEADER, GATEWAY_TRANSFER_PATH, GatewayPermissionReceiptRecordSchema, type WorkspaceRecord } from "@openarc/shared";
import { describe, expect, it, vi } from "vitest";
import { requestGatewayTransfer } from "../src/api/gateway-transfer.js";
import { GatewayFinalizationError, runGatewayPermissionFlow } from "../src/api/gateway-permission-flow.js";
import { OpenArcRequestError } from "../src/api/client.js";
import type { UnlockedWorkspace } from "../src/vault/types.js";
import { GATEWAY_TEST_REQUEST as request, gatewayBundleRecord, gatewayEnvelope } from "./gateway-test-fixtures.js";

function setup() {
  let revision = 0;
  const initial = { meta: { revision: "A".repeat(32) }, records: [] } as unknown as UnlockedWorkspace;
  const writes: WorkspaceRecord[][] = [];
  const save = vi.fn(async (workspace: UnlockedWorkspace, changes: readonly WorkspaceRecord[]) => {
    writes.push(structuredClone([...changes]));
    const ids = new Set(changes.map((record) => record.recordId));
    return { ...workspace, meta: { ...workspace.meta, revision: String(++revision).padStart(32, "A") },
      records: [...workspace.records.filter((record) => !ids.has(record.recordId)), ...changes] } as UnlockedWorkspace;
  });
  const base = { workspace: initial, origin: "https://app.example.test", request, linkedBundleRecordId: null,
    signal: new AbortController().signal, assertActive: () => undefined, save,
    fetch: vi.fn(async () => gatewayEnvelope()), now: () => "2026-09-05T12:04:00Z", id: () => crypto.randomUUID() };
  return { base, save, writes };
}

describe("M07 Gateway consent and encrypted finalization", () => {
  it("commits exact disclosure before fetching and atomically saves completion with observation", async () => {
    const { base, save, writes } = setup();
    const bundle = gatewayBundleRecord(base.workspace.meta.revision);
    base.workspace.records.push(bundle);
    const result = await runGatewayPermissionFlow({ ...base, linkedBundleRecordId: bundle.recordId });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(base.fetch.mock.invocationCallOrder[0]!);
    expect(writes[0]![0]).toMatchObject({ recordSchema: "openarc.permission-receipt.v5", connectorId: "circle_gateway_transfer",
      releasedFields: ["network", "transferId"], released: request, outcome: "approved" });
    expect(base.fetch).toHaveBeenCalledWith(request, base.signal);
    expect(JSON.stringify(writes[0])).not.toContain(bundle.recordId);
    expect(JSON.stringify(writes[0])).not.toContain("resourceDigest");
    expect(writes[1]!.map((record) => record.kind).sort()).toEqual(["gateway_observation", "permission_receipt"]);
    expect(result.observation).toMatchObject({ linkedBundleRecordId: bundle.recordId, linkBasis: "explicit_local_confirmation",
      permissionReceiptId: result.receipt.recordId });
    expect(result.receipt.outcome).toBe("completed");
  });

  it("sends nothing when encrypted consent persistence fails", async () => {
    const { base, save } = setup();
    save.mockRejectedValueOnce(new Error("STORAGE_FAILURE"));
    await expect(runGatewayPermissionFlow(base)).rejects.toThrow("STORAGE_FAILURE");
    expect(base.fetch).not.toHaveBeenCalled();
  });

  it("preserves the approved receipt and reports uncertain completed finalization", async () => {
    const { base, save, writes } = setup();
    save.mockImplementationOnce(save.getMockImplementation()!).mockRejectedValueOnce(new Error("QUOTA_CANARY"));
    await expect(runGatewayPermissionFlow(base)).rejects.toMatchObject({ name: "GatewayFinalizationError", phase: "completed-request" });
    expect(writes).toHaveLength(1);
    expect(writes[0]![0]).toMatchObject({ outcome: "approved" });
  });

  it("records only a sanitized failure code and does not create an observation", async () => {
    const { base, writes } = setup();
    base.fetch.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_BODY_CANARY"));
    await expect(runGatewayPermissionFlow(base)).rejects.toThrow("PRIVATE_PROVIDER_BODY_CANARY");
    expect(writes[1]![0]).toMatchObject({ outcome: "failed", failureCode: "REQUEST_UNAVAILABLE" });
    expect(JSON.stringify(writes)).not.toContain("PRIVATE_PROVIDER_BODY_CANARY");
    expect(writes.flat().some((record) => record.kind === "gateway_observation")).toBe(false);
  });

  it("distinguishes failed-request receipt persistence errors", async () => {
    const { base, save } = setup();
    base.fetch.mockRejectedValueOnce(new OpenArcRequestError("SOURCE_NOT_FOUND", "post-send"));
    save.mockImplementationOnce(save.getMockImplementation()!).mockRejectedValueOnce(new Error("QUOTA"));
    await expect(runGatewayPermissionFlow(base)).rejects.toMatchObject({ name: "GatewayFinalizationError", phase: "failed-request" });
  });

  it("fails closed when a save returns without the observation/receipt pair", async () => {
    const { base, save } = setup();
    save.mockImplementationOnce(save.getMockImplementation()!).mockImplementationOnce(async workspace => workspace);
    await expect(runGatewayPermissionFlow(base)).rejects.toBeInstanceOf(GatewayFinalizationError);
  });

  it("rejects a nonexistent local association or malformed identifier before saving", async () => {
    for (const input of [{ linkedBundleRecordId: crypto.randomUUID() }, { request: { ...request, transferId: "bad-uuid" } }]) {
      const { base, save } = setup();
      await expect(runGatewayPermissionFlow({ ...base, ...input })).rejects.toThrow();
      expect(save).not.toHaveBeenCalled();expect(base.fetch).not.toHaveBeenCalled();
    }
  });

  it("stops on lock after approval or a delayed response without stale writes", async () => {
    for (const after of ["approval", "response"]) {
      const { base, save } = setup();const controller = new AbortController();
      if (after === "approval") {
        const original = save.getMockImplementation()!;
        save.mockImplementationOnce(async (...args) => { const saved = await original(...args);controller.abort();return saved; });
      } else base.fetch.mockImplementationOnce(async () => { controller.abort();return gatewayEnvelope(); });
      await expect(runGatewayPermissionFlow({ ...base, signal: controller.signal,
        assertActive: () => { if (controller.signal.aborted) throw new Error("SESSION_CHANGED"); } })).rejects.toThrow("SESSION_CHANGED");
      expect(save).toHaveBeenCalledTimes(1);
      if (after === "approval") expect(base.fetch).not.toHaveBeenCalled();
    }
  });

  it("does not finalize an aborted failed request or allow incomplete disclosure", async () => {
    const { base, save, writes } = setup();const controller = new AbortController();
    base.fetch.mockImplementationOnce(async () => { controller.abort();throw new Error("ABORTED"); });
    await expect(runGatewayPermissionFlow({ ...base, signal: controller.signal })).rejects.toThrow("ABORTED");
    expect(save).toHaveBeenCalledTimes(1);
    expect(GatewayPermissionReceiptRecordSchema.safeParse({ ...writes[0]![0], releasedFields: ["network"] }).success).toBe(false);
  });
});

describe("M07 Gateway browser API boundary", () => {
  it("sends only two credentialless identifiers with no-store and no referrer", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(gatewayEnvelope()), { status: 200, headers: { "content-type": "application/json" } }));
    await requestGatewayTransfer(request, new AbortController().signal, fetcher);
    expect(fetcher).toHaveBeenCalledWith(GATEWAY_TRANSFER_PATH, { method: "POST",
      headers: { "X-OpenArc-Client": API_CLIENT_HEADER, "Content-Type": "application/json" }, body: JSON.stringify(request),
      credentials: "omit", redirect: "error", cache: "no-store", referrerPolicy: "no-referrer", signal: expect.any(AbortSignal) });
  });

  it("rejects invalid UUIDs and hidden private fields before network contact", async () => {
    const fetcher = vi.fn();
    for (const body of [{ ...request, transferId: "bad" }, { ...request, privateLabel: "PRIVATE_CANARY" }]) {
      await expect(requestGatewayTransfer(body, new AbortController().signal, fetcher)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects mismatched IDs, networks and extra response assertions", async () => {
    const envelope = gatewayEnvelope();
    for (const data of [
      { ...envelope.data, transfer: { ...envelope.data.transfer, id: crypto.randomUUID() } },
      { ...envelope.data, network: "eip155:1" },
      { ...envelope.data, fulfillmentVerified: true },
    ]) await expect(requestGatewayTransfer(request, new AbortController().signal, async () => new Response(JSON.stringify({ ...envelope, data }),
      { status: 200, headers: { "content-type": "application/json" } }))).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

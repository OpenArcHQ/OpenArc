import type { CapabilitiesEnvelope, PermissionReceiptRecord } from "@openarc/shared";
import { describe, expect, it, vi } from "vitest";

import { CapabilityRequestError } from "../src/api/capabilities.js";
import { PermissionFinalizationError, runCapabilityPermissionFlow } from "../src/api/permission-flow.js";
import type { UnlockedWorkspace } from "../src/vault/types.js";

const initial = { meta: { revision: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, records: [] } as unknown as UnlockedWorkspace;
const capabilities = { ok: true } as unknown as CapabilitiesEnvelope;
function setup() {
  let revision = 0;
  const saved: PermissionReceiptRecord[] = [];
  const save = vi.fn(async (workspace: UnlockedWorkspace, receipts: readonly PermissionReceiptRecord[]) => {
    saved.push(structuredClone(receipts[0]!));
    revision += 1;
    return { ...workspace, meta: { ...workspace.meta, revision: String(revision).padStart(32, "A") },
      records: [...workspace.records.filter((record) => record.kind !== "permission_receipt" || record.recordId !== receipts[0]!.recordId), ...receipts] };
  });
  const commits: PermissionReceiptRecord["outcome"][] = [];
  const controller = new AbortController();
  const base = { workspace: initial, origin: "https://app.example.test", signal: controller.signal,
    assertActive: () => { if (controller.signal.aborted) throw new Error("session changed"); }, save,
    request: vi.fn(async () => capabilities), onCommitted: (_workspace: UnlockedWorkspace, outcome: PermissionReceiptRecord["outcome"]) => commits.push(outcome),
    now: vi.fn().mockReturnValueOnce("2026-09-03T12:00:00Z").mockReturnValue("2026-09-03T12:00:01Z"),
    id: () => "018f47a2-3b4c-7def-8123-456789abcdef" };
  return { base, save, saved, commits, controller };
}

describe("M03 encrypted permission transaction", () => {
  it("commits the approved receipt before the request and then commits completion", async () => {
    const { base, save, saved, commits } = setup();
    await expect(runCapabilityPermissionFlow(base)).resolves.toMatchObject({ capabilities });
    expect(save).toHaveBeenCalledTimes(2);
    expect(base.request).toHaveBeenCalledOnce();
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(base.request.mock.invocationCallOrder[0]!);
    expect(saved.map((receipt) => receipt.outcome)).toEqual(["approved", "completed"]);
    expect(saved[0]).toMatchObject({ releasedFields: [], destination: { origin: base.origin, path: "/v1/private/capabilities", method: "GET", upstreams: [] } });
    expect(commits).toEqual(["approved", "completed"]);
  });

  it("clamps completed and failed receipt times when the wall clock moves backward", async () => {
    const completed = setup();
    completed.base.now.mockReset().mockReturnValueOnce("2026-09-03T12:00:00Z").mockReturnValue("2026-09-03T11:59:59Z");
    await expect(runCapabilityPermissionFlow(completed.base)).resolves.toMatchObject({ capabilities });
    expect(completed.saved[1]).toMatchObject({ outcome: "completed", resolvedAt: "2026-09-03T12:00:00Z",
      updatedAt: "2026-09-03T12:00:00Z" });

    const failed = setup();
    failed.base.now.mockReset().mockReturnValueOnce("2026-09-03T12:00:00.000000001Z").mockReturnValue("2026-09-03T12:00:00Z");
    failed.base.request.mockRejectedValueOnce(new CapabilityRequestError("INVALID_RESPONSE", "post-send"));
    await expect(runCapabilityPermissionFlow(failed.base)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(failed.saved[1]).toMatchObject({ outcome: "failed", resolvedAt: "2026-09-03T12:00:00.000000001Z",
      updatedAt: "2026-09-03T12:00:00.000000001Z" });
  });

  it("proves a failed approval write causes zero network calls", async () => {
    const { base, save } = setup();
    save.mockRejectedValueOnce(new Error("PRIVATE_STORAGE_CANARY"));
    await expect(runCapabilityPermissionFlow(base)).rejects.toThrow("PRIVATE_STORAGE_CANARY");
    expect(base.request).not.toHaveBeenCalled();
  });

  it("records fixed post-send failures while preserving the original approval on final-write failure", async () => {
    const failed = setup();
    failed.base.request.mockRejectedValueOnce(new CapabilityRequestError("INVALID_RESPONSE", "post-send"));
    await expect(runCapabilityPermissionFlow(failed.base)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(failed.saved.map((receipt) => [receipt.outcome, receipt.failureCode])).toEqual([["approved", null], ["failed", "INVALID_RESPONSE"]]);
  });

  it("propagates a failed-outcome storage boundary after preserving approval", async () => {
    const { base, save, saved, commits } = setup();
    const storageCause = new Error("synthetic revision conflict");
    base.request.mockRejectedValueOnce(new CapabilityRequestError("INVALID_RESPONSE", "post-send"));
    save.mockImplementationOnce(save.getMockImplementation()!).mockRejectedValueOnce(storageCause);
    await expect(runCapabilityPermissionFlow(base)).rejects.toMatchObject({
      phase: "failed-request", storageCause,
    });
    expect(saved.map((receipt) => receipt.outcome)).toEqual(["approved"]);
    expect(commits).toEqual(["approved"]);
  });

  it("leaves the encrypted approval intact if completion cannot be saved", async () => {
    const { base, save, saved, commits } = setup();
    save.mockImplementationOnce(save.getMockImplementation()!).mockRejectedValueOnce(new Error("PRIVATE_QUOTA_CANARY"));
    await expect(runCapabilityPermissionFlow(base)).rejects.toBeInstanceOf(PermissionFinalizationError);
    expect(base.request).toHaveBeenCalledOnce();
    expect(saved.map((receipt) => receipt.outcome)).toEqual(["approved"]);
    expect(commits).toEqual(["approved"]);
  });

  it("cancellation after approval prevents a late receipt update", async () => {
    const { base, save, saved, commits, controller } = setup();
    base.request.mockImplementationOnce(async () => { controller.abort(); throw new CapabilityRequestError("REQUEST_UNAVAILABLE", "post-send"); });
    await expect(runCapabilityPermissionFlow(base)).rejects.toBeDefined();
    expect(save).toHaveBeenCalledOnce();
    expect(saved.map((receipt) => receipt.outcome)).toEqual(["approved"]);
    expect(commits).toEqual(["approved"]);
  });
});

import { API_CLIENT_HEADER, JOB_EVIDENCE_PATH, JobPermissionReceiptRecordSchema, type WorkspaceRecord } from "@openarc/shared";
import { describe, expect, it, vi } from "vitest";
import { JOB_TEST_REQUEST as request, jobTestEnvelope } from "../../../test-fixtures/job-evidence.js";
import { requestJobEvidence } from "../src/api/job-evidence.js";
import { JobFinalizationError, runJobPermissionFlow } from "../src/api/job-permission-flow.js";
import { OpenArcRequestError } from "../src/api/client.js";
import type { UnlockedWorkspace } from "../src/vault/types.js";
const envelope = jobTestEnvelope();
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
  const base = { workspace: initial, origin: "https://app.example.test", request,
    linkedActionRecordId: null, signal: new AbortController().signal, assertActive: () => undefined,
    save, fetch: vi.fn(async () => envelope),
    now: vi.fn().mockReturnValueOnce("2026-09-04T11:59:58Z").mockReturnValue("2026-09-04T12:00:01Z"),
    id: () => ids.shift()! };
  return { base, save, writes };
}

describe("M06 job permission flow", () => {
  it("encrypts exact disclosure before contact and atomically stores completion plus evidence", async () => {
    const { base, save, writes } = setup();
    const result = await runJobPermissionFlow(base);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(base.fetch.mock.invocationCallOrder[0]!);
    expect(writes[0]![0]).toMatchObject({ recordSchema: "openarc.permission-receipt.v4",
      connectorId: "arc_job_evidence", releasedFields: ["network", "jobId"], released: request,
      outcome: "approved" });
    expect(JSON.stringify(writes[0])).not.toContain("linkedActionRecordId");
    expect(writes[1]!.map((record) => record.kind).sort()).toEqual([
      "job_observation", "permission_receipt",
    ]);
    expect(result.observation.linkedActionRecordId).toBeNull();
  });

  it("causes zero network on approval failure and preserves the approved receipt on finalization failure", async () => {
    const first = setup();
    first.save.mockRejectedValueOnce(new Error("PRIVATE_STORAGE_CANARY"));
    await expect(runJobPermissionFlow(first.base)).rejects.toThrow("PRIVATE_STORAGE_CANARY");
    expect(first.base.fetch).not.toHaveBeenCalled();

    const second = setup();
    const original = second.save.getMockImplementation()!;
    second.save.mockImplementationOnce(original).mockRejectedValueOnce(new Error("PRIVATE_QUOTA_CANARY"));
    await expect(runJobPermissionFlow(second.base)).rejects.toBeInstanceOf(JobFinalizationError);
    expect(second.writes).toHaveLength(1);
  });

  it("records a sanitized failed receipt without replacing prior evidence", async () => {
    const { base, writes } = setup();
    base.fetch.mockRejectedValueOnce(new OpenArcRequestError("SOURCE_NOT_FOUND", "post-send"));
    await expect(runJobPermissionFlow(base)).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND" });
    expect(writes[1]![0]).toMatchObject({ outcome: "failed", failureCode: "SOURCE_NOT_FOUND" });
    expect(writes.flat().some((record) => record.kind === "job_observation")).toBe(false);
  });
});
describe("M06 job browser boundary", () => {
  it("sends exact credentialless identifiers and binds returned evidence", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(envelope), { status: 200,
      headers: { "content-type": "application/json" } }));
    await requestJobEvidence(request, new AbortController().signal, fetcher);
    expect(fetcher).toHaveBeenCalledWith(JOB_EVIDENCE_PATH, {
      method: "POST", headers: { "X-OpenArc-Client": API_CLIENT_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify(request), credentials: "omit", redirect: "error", cache: "no-store",
      referrerPolicy: "no-referrer", signal: expect.any(AbortSignal),
    });
    for (const data of [{ ...envelope.data, jobId: "2" }, { ...envelope.data, trustScore: 99 },
      { ...envelope.data, budget: { ...envelope.data.budget, decimal: "0" } }]) {
      await expect(requestJobEvidence(request, new AbortController().signal, async () =>
        new Response(JSON.stringify({ ...envelope, data }), { status: 200, headers: { "content-type": "application/json" } })))
        .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
    await expect(requestJobEvidence({ ...request, submissionTransactionHash: `0x${"a".repeat(64)}` }, new AbortController().signal, fetcher))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("rejects nonexistent local links before writing or sending", async () => {
    const { base, save } = setup();
    await expect(runJobPermissionFlow({ ...base, linkedActionRecordId: "11111111-1111-4111-8111-111111111111" }))
      .rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(save).not.toHaveBeenCalled();
    expect(base.fetch).not.toHaveBeenCalled();
  });

  it("does not accept a hidden submission hash in permission disclosure", async () => {
    const { base, writes } = setup();
    await runJobPermissionFlow(base);
    const receipt = writes[0]![0]!;
    expect(JobPermissionReceiptRecordSchema.safeParse({ ...receipt, releasedFields: ["network"] }).success).toBe(false);
  });

  it("stops after approval if the workspace locks, and never finalizes a stale response", async () => {
    const first = setup();
    const controller = new AbortController();
    const originalSave = first.save.getMockImplementation()!;
    first.save.mockImplementationOnce(async (...args) => { const saved = await originalSave(...args); controller.abort(); return saved; });
    const assertActive = () => { if (controller.signal.aborted) throw new Error("SESSION_CHANGED"); };
    await expect(runJobPermissionFlow({ ...first.base, signal: controller.signal, assertActive })).rejects.toThrow("SESSION_CHANGED");
    expect(first.base.fetch).not.toHaveBeenCalled();

    const second = setup();
    const secondController = new AbortController();
    second.base.fetch.mockImplementationOnce(async () => { secondController.abort(); return envelope; });
    await expect(runJobPermissionFlow({ ...second.base, signal: secondController.signal,
      assertActive: () => { if (secondController.signal.aborted) throw new Error("SESSION_CHANGED"); } })).rejects.toThrow("SESSION_CHANGED");
    expect(second.save).toHaveBeenCalledTimes(1);
  });
});

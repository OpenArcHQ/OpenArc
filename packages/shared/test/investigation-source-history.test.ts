import { describe, expect, it } from "vitest";
import { buildInvestigationSourceHistory, INVESTIGATION_SNAPSHOT_AGE_MS } from "../src/investigation-source-history.js";
import { ARC_TRANSACTION_EVIDENCE_PATH } from "../src/arc-observation.js";
import { ARC_TESTNET } from "../src/network.js";
import { CAPABILITIES_PATH } from "../src/api.js";
import { ARC_OBSERVATION_DISCLOSURE, CAPABILITY_DISCLOSURE, GATEWAY_DISCLOSURE,
  PermissionReceiptRecordSchema } from "../src/permission.js";
import { WorkspaceRecordSchema, type WorkspaceRecord } from "../src/vault.js";
import { GATEWAY_TRANSFER_PATH } from "../src/x402-evidence.js";
import { batchObservation, gatewayObservation } from "./x402-fixtures.js";

const id = (n: number) => `11111111-1111-4111-8111-${n.toString().padStart(12, "0")}`;
const observedAt = "2026-09-05T12:00:02Z", now = "2026-09-06T12:00:02Z";
const all = ["openarc_capabilities", "arc_account_snapshot", "arc_transaction_evidence", "arc_agent_registry_evidence", "arc_job_evidence", "circle_gateway_transfer"];
function receipt(n = 1, outcome: "approved" | "completed" | "failed" = "completed", at = observedAt, connector = "arc_transaction_evidence"): WorkspaceRecord {
  const base = { kind: "permission_receipt", recordId: id(n), recordRevision: "A".repeat(32), createdAt: at, updatedAt: at,
    approvedAt: at, outcome, resolvedAt: outcome === "approved" ? null : at, failureCode: outcome === "failed" ? "SOURCE_UNAVAILABLE" : null };
  if (connector === "openarc_capabilities") return PermissionReceiptRecordSchema.parse({ ...base,
    recordSchema: "openarc.permission-receipt.v1", ...CAPABILITY_DISCLOSURE,
    destination: { origin: "https://app.example.test", path: CAPABILITIES_PATH, method: "GET", upstreams: [] }, releasedFields: [] });
  if (connector === "circle_gateway_transfer") return PermissionReceiptRecordSchema.parse({ ...base,
    recordSchema: "openarc.permission-receipt.v5", connectorId: connector, ...GATEWAY_DISCLOSURE,
    destination: { origin: "https://app.example.test", path: GATEWAY_TRANSFER_PATH, method: "POST", upstreams: ["https://gateway-api-testnet.circle.com"] },
    releasedFields: ["network", "transferId"], released: { network: ARC_TESTNET.caip2, transferId: gatewayObservation().transfer.id },
    purpose: "Read one exact Circle Gateway Arc Testnet transfer; this does not verify fulfillment." });
  return PermissionReceiptRecordSchema.parse({ ...base, recordSchema: "openarc.permission-receipt.v2", connectorId: connector,
    ...ARC_OBSERVATION_DISCLOSURE,
    destination: { origin: "https://app.example.test", path: ARC_TRANSACTION_EVIDENCE_PATH, method: "POST", upstreams: [ARC_TESTNET.rpcHttp] },
    releasedFields: ["network", "transactionHash"], released: { network: ARC_TESTNET.caip2, transactionHash: batchObservation().transaction.hash },
    purpose: "Observe one public Arc Testnet transaction, receipt, anchor, fee, and USDC movement set." });
}
function observation(n = 2, permission = 1, time = observedAt, gateway = false): WorkspaceRecord {
  const value = gateway ? gatewayObservation() : batchObservation(); value.source.observedAt = time;
  return WorkspaceRecordSchema.parse({ recordSchema: gateway ? "openarc.gateway-observation-record.v1" : "openarc.arc-observation-record.v1",
    kind: gateway ? "gateway_observation" : "arc_observation", recordId: id(n), recordRevision: "A".repeat(32), createdAt: time, updatedAt: time,
    permissionReceiptId: id(permission), observation: value, ...(gateway ? { linkedBundleRecordId: null, linkBasis: null } : {}) });
}
const history = (records: WorkspaceRecord[], evaluatedAt = now, enabledConnectors = all) => buildInvestigationSourceHistory(records, { evaluatedAt, enabledConnectors });
const tx = (records: WorkspaceRecord[], evaluatedAt = now) => history(records, evaluatedAt).find(row => row.connectorId === "arc_transaction_evidence")!;

describe("M09 saved local source history", () => {
  it("returns exactly six known connectors with disabled or never-checked states", () => {
    expect(history([]).map(row => row.connectorId)).toEqual(all);
    expect(history([]).every(row => row.status === "never_checked")).toBe(true);
    expect(history([], now, []).every(row => row.status === "disabled" && !row.enabled)).toBe(true);
    expect(INVESTIGATION_SNAPSHOT_AGE_MS).toBe(86_400_000);
    expect(history([]).every(row => row.limitations.some(text => text.includes("not current provider availability")))).toBe(true);
  });
  it("does not call a completed capability check an observed chain state", () => {
    const row = history([receipt(1, "completed", observedAt, "openarc_capabilities")])[0]!;
    expect(row.status).toBe("saved_check"); expect(row.savedObservations).toBe(0); expect(row.lastObservationAt).toBeNull();
  });
  it("distinguishes completed receipts with no linked observation", () => {
    expect(tx([receipt()]).status).toBe("completed_without_observation");
    const row = tx([receipt(), observation(), receipt(3, "completed", "2026-09-06T11:00:00Z")]);
    expect(row.status).toBe("completed_without_observation"); expect(row.savedObservations).toBe(1); expect(row.lastObservationAt).toBe(observedAt);
  });
  it("new failure and unresolved approvals retain older saved observations", () => {
    const records = [receipt(), observation(), receipt(3, "failed", "2026-09-06T11:00:00Z")];
    expect(tx(records)).toMatchObject({ status: "last_saved_attempt_failed", savedObservations: 1, lastObservationAt: observedAt });
    records.push(receipt(4, "approved", "2026-09-06T11:01:00Z"));
    expect(tx(records)).toMatchObject({ status: "unresolved_approval", unresolvedApprovals: 1, savedObservations: 1 });
    expect(history(records, now, []).find(row => row.connectorId === "arc_transaction_evidence")).toMatchObject({ status: "disabled", unresolvedApprovals: 1, savedObservations: 1 });
  });
  it("uses an exact older-than24h threshold including nanoseconds", () => {
    const records = [receipt(), observation()];
    expect(tx(records, "2026-09-06T12:00:01.999999999Z").status).toBe("saved_observation");
    expect(tx(records, now).status).toBe("saved_observation");
    expect(tx(records, "2026-09-06T12:00:02.000000001Z").status).toBe("aged_snapshot");
    const fractional = [receipt(1, "completed", "2026-09-05T12:00:02.123456789Z"), observation(2, 1, "2026-09-05T12:00:02.123456789Z")];
    expect(tx(fractional, "2026-09-06T12:00:02.123456789Z").status).toBe("saved_observation");
    expect(tx(fractional, "2026-09-06T12:00:02.123456790Z").status).toBe("aged_snapshot");
  });
  it("states local clock uncertainty rather than turning future evidence into current provider health", () => {
    const row = tx([receipt(), observation()], "2026-09-05T12:00:01Z");
    expect(row.limitations).toContain("The local clock precedes a saved timestamp; freshness cannot be assessed reliably.");
    expect(row.status).toBe("saved_observation");
  });
  it("maps Gateway evidence through its permission connector and never exports private source fields", () => {
    const records = [receipt(1, "completed", observedAt, "circle_gateway_transfer"), observation(2, 1, observedAt, true)];
    const result = history(records), row = result.find(item => item.connectorId === "circle_gateway_transfer")!;
    expect(row).toMatchObject({ status: "saved_observation", savedObservations: 1 });
    for (const value of [gatewayObservation().transfer.id, gatewayObservation().transfer.fromAddress, gatewayObservation().transfer.txHash!, id(1), id(2)]) expect(JSON.stringify(result)).not.toContain(value);
  });
  it("is deterministic under input ordering and does not mutate inputs", () => {
    const records = [receipt(), observation(), receipt(3, "failed", "2026-09-06T11:00:00Z")], before = JSON.stringify(records);
    expect(history(records)).toEqual(history([...records].reverse())); expect(JSON.stringify(records)).toBe(before);
  });
  it("never chooses a favorable completion by UUID when newest attempts have equal timestamps", () => {
    for (const [completedId, failedId] of [[1, 3], [3, 1]]) {
      const records = [receipt(completedId, "completed"), receipt(failedId, "failed"), observation(2, completedId)];
      expect(tx(records).status).toBe("last_saved_attempt_failed");
      expect(tx([...records].reverse()).status).toBe("last_saved_attempt_failed");
    }
  });
  it("preserves a missing observation among equally recent completed attempts", () => {
    for (const [linkedId, missingId] of [[1, 3], [3, 1]]) {
      const records = [receipt(linkedId), receipt(missingId), observation(2, linkedId)];
      expect(tx(records).status).toBe("completed_without_observation");
      expect(tx(records).savedObservations).toBe(1);
    }
  });
  it("rejects excessive inputs, invalid schemas, duplicate identities and unrecognized connector configuration", () => {
    const run = (records: readonly WorkspaceRecord[], enabledConnectors: readonly string[] = all, evaluatedAt = now) => () => buildInvestigationSourceHistory(records, { evaluatedAt, enabledConnectors });
    expect(run(Array.from({ length: 6603 }, () => receipt()))).toThrow("Invalid saved source history inputs.");
    expect(run([receipt(), receipt()])).toThrow("Invalid saved source history inputs.");
    expect(run([{ ...receipt(), PRIVATE_CANARY: true } as never])).toThrow("Invalid saved source history inputs.");
    expect(run([], ["PRIVATE_CANARY"])).toThrow("Invalid saved source history inputs.");
    expect(run([], [all[0]!, all[0]!])).toThrow("Invalid saved source history inputs.");
    expect(run([], all, "PRIVATE_CANARY")).toThrow("Invalid saved source history inputs.");
  });
});

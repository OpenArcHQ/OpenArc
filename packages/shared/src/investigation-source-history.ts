import { IsoTimestampSchema, compareIsoTimestamps } from "./primitives.js";
import { WorkspaceRecordSchema, type WorkspaceRecord } from "./vault.js";
import { INVESTIGATION_LIMITS, type InvestigationSourceHistory } from "./investigation-types.js";

export const INVESTIGATION_SNAPSHOT_AGE_MS = 24 * 60 * 60 * 1_000;
const connectors = [
  ["openarc_capabilities", "OpenArc capability checks"],
  ["arc_account_snapshot", "Arc account snapshots"],
  ["arc_transaction_evidence", "Arc transaction observations"],
  ["arc_agent_registry_evidence", "ERC-8004 registry observations"],
  ["arc_job_evidence", "ERC-8183 reference job observations"],
  ["circle_gateway_transfer", "Circle Gateway Testnet observations"],
] as const;
/** Saved local lookup history, never a live service-health assertion. */
export function buildInvestigationSourceHistory(input: readonly WorkspaceRecord[], options: {
  evaluatedAt: string; enabledConnectors: readonly string[];
}): InvestigationSourceHistory[] {
  try {
    const evaluatedAt = IsoTimestampSchema.parse(options.evaluatedAt);
    if (!Array.isArray(input) || input.length > INVESTIGATION_LIMITS.records ||
      !Array.isArray(options.enabledConnectors) || options.enabledConnectors.length > connectors.length ||
      new Set(options.enabledConnectors).size !== options.enabledConnectors.length ||
      options.enabledConnectors.some(id => !connectors.some(([known]) => known === id))) throw new Error();
    const records = input.map(record => WorkspaceRecordSchema.parse(record));
    if (new Set(records.map(record => record.recordId)).size !== records.length) throw new Error();
    const receipts = records.filter(record => record.kind === "permission_receipt");
    const observations = records.flatMap(record => {
      const connectorId = record.kind === "arc_observation" ?
        record.observation.schemaVersion === "openarc.arc-account-snapshot.v1" ? "arc_account_snapshot" : "arc_transaction_evidence" :
        record.kind === "agent_registry_observation" ? "arc_agent_registry_evidence" :
        record.kind === "job_observation" ? "arc_job_evidence" : record.kind === "gateway_observation" ? "circle_gateway_transfer" : null;
      if (connectorId === null || !("observation" in record) || !("permissionReceiptId" in record)) return [];
      return [{ connectorId, permissionReceiptId: record.permissionReceiptId, time: record.observation.source.observedAt }];
    });
    return connectors.map(([connectorId, label]) => {
      const outcomePriority = { failed: 0, approved: 1, completed: 2 } as const;
      const history = receipts.filter(receipt => receipt.connectorId === connectorId)
        .sort((a, b) => compareIsoTimestamps(b.approvedAt, a.approvedAt) ||
          outcomePriority[a.outcome] - outcomePriority[b.outcome] || a.recordId.localeCompare(b.recordId));
      const saved = observations.filter(observation => observation.connectorId === connectorId)
        .sort((a, b) => compareIsoTimestamps(b.time, a.time));
      const latest = history[0], lastObservationAt = saved[0]?.time ?? null;
      const unresolvedApprovals = history.filter(receipt => receipt.outcome === "approved").length;
      const enabled = options.enabledConnectors.includes(connectorId);
      const aged = lastObservationAt !== null && olderThanDay(lastObservationAt, evaluatedAt);
      const missingLatest = latest !== undefined && connectorId !== "openarc_capabilities" && history.some(receipt =>
        receipt.outcome === "completed" && compareIsoTimestamps(receipt.approvedAt, latest.approvedAt) === 0 &&
        !saved.some(observation => observation.permissionReceiptId === receipt.recordId));
      const status: InvestigationSourceHistory["status"] = !enabled ? "disabled" : unresolvedApprovals > 0 ? "unresolved_approval" :
        latest?.outcome === "failed" ? "last_saved_attempt_failed" : missingLatest ? "completed_without_observation" :
        lastObservationAt !== null ? aged ? "aged_snapshot" : "saved_observation" :
        connectorId === "openarc_capabilities" && latest?.outcome === "completed" ? "saved_check" : "never_checked";
      const limitations = ["Saved local lookup history only; this is not current provider availability.",
        "No automatic refresh occurs. Earlier saved evidence remains available after a failed check.",
        "Aged means older than 24 hours by this interface convention, not invalid evidence or a provider outage."];
      if ([lastObservationAt, latest?.approvedAt].some(time => time && compareIsoTimestamps(time, evaluatedAt) > 0)) {
        limitations.push("The local clock precedes a saved timestamp; freshness cannot be assessed reliably.");
      }
      return { connectorId, label, enabled, status, lastAttemptAt: latest?.approvedAt ?? null,
        lastObservationAt, unresolvedApprovals, savedObservations: saved.length, limitations };
    });
  } catch { throw new Error("Invalid saved source history inputs."); }
}

function olderThanDay(observedAt: string, evaluatedAt: string): boolean {
  // Preserve fractional precision at the exact age boundary, including nanoseconds.
  const shifted = new Date(Date.parse(`${observedAt.slice(0, 19)}Z`) + INVESTIGATION_SNAPSHOT_AGE_MS).toISOString();
  if (shifted.length !== 24) return false; // Beyond the supported four-digit UTC year.
  return compareIsoTimestamps(evaluatedAt, `${shifted.slice(0, 19)}${observedAt.slice(19)}`) > 0;
}

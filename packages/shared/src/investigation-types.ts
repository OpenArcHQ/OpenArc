import type { WorkspaceRecord } from "./vault.js";

/** M09 presentation contracts. These never widen the M01 evidence schema. */
export const INVESTIGATION_LIMITS = Object.freeze({ records: 6_602, events: 512, entries: 7_114,
  queryCharacters: 160, pageSize: 25, detailNodes: 64, detailEdges: 128, factsPerNode: 2_048, exportBytes: 1_048_576 });
export const INVESTIGATION_SOURCE_CLASSES = ["synthetic_fixture", "owner_supplied_unauthenticated",
  "named_testnet_observation", "local_policy_result", "explicit_local_association"] as const;
export type InvestigationSourceClass = typeof INVESTIGATION_SOURCE_CLASSES[number];
export const INVESTIGATION_STATUSES = ["conflicting", "reported_failure", "needs_review", "observed", "synthetic_complete"] as const;
export type InvestigationStatus = typeof INVESTIGATION_STATUSES[number];
export type InvestigationRootKind = "action_envelope" | "evidence_record" | "x402_bundle" | "agent_import" |
  "arc_observation" | "agent_registry_observation" | "job_observation" | "gateway_observation";
export type InvestigationReference = { kind: WorkspaceRecord["kind"]; recordId: string; recordRevision: string;
  eventIndex?: number; eventId?: string; connectorId?: string };
export type InvestigationEntry = { key: string; reference: InvestigationReference; kind: InvestigationRootKind;
  title: string; time: string; sourceClass: InvestigationSourceClass; status: InvestigationStatus; searchText: string };
export type InvestigationFact = { label: string; value: string;
  category: "identifier" | "amount" | "timestamp" | "local_private" | "public_status";
  side: "expected" | "observed" | "context" };
export type InvestigationNode = { key: string; reference: InvestigationReference; title: string; time: string;
  sourceClass: InvestigationSourceClass; status: InvestigationStatus; facts: InvestigationFact[]; limitations: string[] };
export type InvestigationEdge = { from: string; to: string;
  kind: "cited_evidence" | "explicit_local_association" | "local_policy_comparison" | "chronological_sequence";
  label: string };
export type InvestigationComparison = { title: string; status: InvestigationStatus; ruleVersion: string;
  findings: string[]; citations: InvestigationReference[]; limitations: string[] };
export type InvestigationDetail = { root: InvestigationEntry; evaluatedAt: string; nodes: InvestigationNode[];
  edges: InvestigationEdge[]; page: number; pageCount: number; totalNodes: number; totalEdges: number;
  omittedCrossPageEdges: number; comparisons: InvestigationComparison[]; limitations: string[];
  replayScope: { supplied: number; compared: number; completeLocalCollection: boolean } | null };
export type InvestigationFilter = { query?: string; status?: InvestigationStatus | "all";
  sourceClass?: InvestigationSourceClass | "all"; exceptionsOnly?: boolean; page?: number };
export type InvestigationPage = { entries: InvestigationEntry[]; total: number; page: number; pageCount: number };
export type InvestigationSourceHistory = { connectorId: string; label: string; enabled: boolean;
  status: "disabled" | "never_checked" | "unresolved_approval" | "last_saved_attempt_failed" | "saved_observation" | "aged_snapshot" | "saved_check" | "completed_without_observation";
  lastAttemptAt: string | null; lastObservationAt: string | null; unresolvedApprovals: number; savedObservations: number;
  limitations: string[] };
export const INVESTIGATION_SOURCE_LIMITATIONS: Record<InvestigationSourceClass, string> = {
  synthetic_fixture: "Synthetic fixture evidence is not live payment activity.",
  owner_supplied_unauthenticated: "Owner-supplied claims do not verify authorship, approval, execution or fulfillment.",
  named_testnet_observation: "A saved Testnet observation is bounded to its named source and time; it does not prove intent or service quality.",
  local_policy_result: "Local monitoring only; wallet enforcement and complete history are not verified.",
  explicit_local_association: "This relationship is an explicit local owner claim, not independently authenticated identity.",
};

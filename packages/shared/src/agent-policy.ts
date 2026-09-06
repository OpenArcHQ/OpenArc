import { z } from "zod";

import { AGENT_POLICY_MAX_EVENTS, AGENT_POLICY_MAX_IMPORTS, AgentAttemptEventSchema,
  AgentConnectorIdSchema, AgentImportIdSchema } from "./agent-import.js";
import { EvmAddressSchema, IsoTimestampSchema, Sha256DigestSchema, Uint256DecimalSchema,
  compareIsoTimestamps } from "./primitives.js";

export const AGENT_POLICY_MAX_RULE_VALUES = 16;
const addresses = z.array(EvmAddressSchema).max(AGENT_POLICY_MAX_RULE_VALUES).refine((items) => new Set(items).size === items.length);
const services = z.array(Sha256DigestSchema).max(AGENT_POLICY_MAX_RULE_VALUES).refine((items) => new Set(items).size === items.length);
export const AgentMonitoringPolicySchema = z.strictObject({
  schemaVersion: z.literal("openarc.agent-policy.v2"), policyId: AgentImportIdSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), name: z.string().trim().min(1).max(80),
  agentProfileRecordId: AgentImportIdSchema, enabled: z.boolean(),
  validAfter: IsoTimestampSchema, validBefore: IsoTimestampSchema,
  perActionLimit: Uint256DecimalSchema.nullable(), dailyLimit: Uint256DecimalSchema.nullable(),
  allowRecipients: addresses, blockRecipients: addresses,
  allowContracts: addresses, blockContracts: addresses,
  allowServices: services, blockServices: services,
  requireApproval: z.boolean(), mode: z.literal("local_monitoring_only"),
}).superRefine((policy, context) => {
  if (IsoTimestampSchema.safeParse(policy.validAfter).success && IsoTimestampSchema.safeParse(policy.validBefore).success &&
    compareIsoTimestamps(policy.validBefore, policy.validAfter) <= 0) {
    context.addIssue({ code: "custom", path: ["validBefore"], message: "Policy validity must end after it starts" });
  }
});
export type AgentMonitoringPolicy = z.infer<typeof AgentMonitoringPolicySchema>;

export const AgentPolicyEventInputSchema = z.strictObject({
  importRecordId: AgentImportIdSchema, agentProfileRecordId: AgentImportIdSchema,
  connectorId: AgentConnectorIdSchema, eventIndex: z.number().int().min(0).max(63), event: AgentAttemptEventSchema,
});
export type AgentPolicyEventInput = z.infer<typeof AgentPolicyEventInputSchema>;
export const AgentPolicyEvaluationInputSchema = z.strictObject({
  selected: AgentPolicyEventInputSchema,
  events: z.array(AgentPolicyEventInputSchema).min(1).max(AGENT_POLICY_MAX_EVENTS),
  policy: AgentMonitoringPolicySchema, evaluatedAt: IsoTimestampSchema,
}).superRefine((input, context) => {
  if (new Set(input.events.map((entry) => entry.importRecordId)).size > AGENT_POLICY_MAX_IMPORTS) {
    context.addIssue({ code: "custom", path: ["events"], message: "At most 32 imports may be compared" });
  }
  const imports = new Map<string, AgentPolicyEventInput>();
  const positions = new Set<string>();
  for (const entry of input.events) {
    const position = JSON.stringify([entry.importRecordId, entry.eventIndex]);
    if (positions.has(position)) context.addIssue({ code: "custom", path: ["events"], message: "Each import event position must be supplied exactly once" });
    positions.add(position);
    const previous = imports.get(entry.importRecordId);
    if (previous && (previous.connectorId !== entry.connectorId || previous.agentProfileRecordId !== entry.agentProfileRecordId)) {
      context.addIssue({ code: "custom", path: ["events"], message: "One import cannot have contradictory source or local association metadata" });
    }
    imports.set(entry.importRecordId, entry);
  }
  if (!input.events.some((entry) => JSON.stringify(entry) === JSON.stringify(input.selected))) {
    context.addIssue({ code: "custom", path: ["selected"], message: "Selected event must exactly match a supplied entry" });
  }
  if (IsoTimestampSchema.safeParse(input.evaluatedAt).success) for (const entry of input.events) {
    if (IsoTimestampSchema.safeParse(entry.event.occurredAt).success && compareIsoTimestamps(entry.event.occurredAt, input.evaluatedAt) > 0) {
      context.addIssue({ code: "custom", path: ["events"], message: "Evaluation cannot predate a supplied event" });
    }
  }
});
export type AgentPolicyEvaluationInput = z.infer<typeof AgentPolicyEvaluationInputSchema>;

export const AGENT_POLICY_RULE_VERSION = "openarc.agent-policy-rules.v1" as const;
export type AgentPolicyStatus = "conflicting" | "flagged" | "unevaluable" | "within_supplied_rules" | "not_applicable";
export type AgentPolicyCitation = Pick<AgentPolicyEventInput, "importRecordId" | "connectorId" | "eventIndex"> & { eventId: string };
export type AgentPolicyFinding = {
  rule: "scope" | "validity" | "source_identity" | "authorization_reuse" | "per_action" | "daily" | "recipient" | "contract" | "service" | "approval";
  code: string;
  status: AgentPolicyStatus;
  citations: AgentPolicyCitation[];
};
export type AgentPolicyEvaluation = {
  ruleVersion: typeof AGENT_POLICY_RULE_VERSION;
  policyId: string; policyRevision: number; evaluatedAt: string; reportedAttemptAt: string;
  status: AgentPolicyStatus;
  enforcement: "not_verified"; approvalVerification: "not_verified";
  findings: AgentPolicyFinding[]; violations: AgentPolicyFinding[]; gaps: AgentPolicyFinding[]; warnings: AgentPolicyFinding[];
  citations: AgentPolicyCitation[];
  daily: { utcDay: string; observedAttemptTotalBaseUnits: string | null; evaluation: "not_applicable" | "evaluated"; history: "partial_supplied_events"; excludedConflictingSourceEvents: number };
};

/** Pure local comparison of unverified reports, never a wallet permission or spend assertion. */
export function evaluateAgentPolicy(raw: AgentPolicyEvaluationInput): AgentPolicyEvaluation {
  const input = AgentPolicyEvaluationInputSchema.parse(raw);
  const { selected, policy, evaluatedAt } = input;
  const findings: AgentPolicyFinding[] = [], gaps: AgentPolicyFinding[] = [], warnings: AgentPolicyFinding[] = [];
  const day = selected.event.occurredAt.slice(0, 10);
  const result: AgentPolicyEvaluation = {
    ruleVersion: AGENT_POLICY_RULE_VERSION, policyId: policy.policyId, policyRevision: policy.revision,
    evaluatedAt, reportedAttemptAt: selected.event.occurredAt, status: "not_applicable",
    enforcement: "not_verified", approvalVerification: "not_verified", findings, violations: [], gaps, warnings,
    citations: cite(input.events), daily: { utcDay: day, observedAttemptTotalBaseUnits: null, evaluation: "not_applicable", history: "partial_supplied_events", excludedConflictingSourceEvents: 0 },
  };
  const add = (rule: AgentPolicyFinding["rule"], code: string, status: AgentPolicyStatus, entries = [selected]): AgentPolicyFinding => {
    const finding = { rule, code, status, citations: cite(entries) }; findings.push(finding);
    if (status === "unevaluable") gaps.push(finding);
    if (status === "flagged" || status === "conflicting") result.violations.push(finding);
    return finding;
  };
  if (!policy.enabled || policy.agentProfileRecordId !== selected.agentProfileRecordId) {
    add("scope", !policy.enabled ? "POLICY_DISABLED" : "POLICY_AGENT_MISMATCH", "not_applicable");
    return result;
  }
  add("scope", "LOCAL_AGENT_ASSOCIATION_ONLY", "within_supplied_rules");
  result.daily.evaluation = "evaluated";
  add("validity", compareIsoTimestamps(selected.event.occurredAt, policy.validAfter) < 0 ? "POLICY_NOT_YET_ACTIVE" :
    compareIsoTimestamps(selected.event.occurredAt, policy.validBefore) >= 0 ? "POLICY_EXPIRED" : "WITHIN_REPORTED_ATTEMPT_WINDOW",
  compareIsoTimestamps(selected.event.occurredAt, policy.validAfter) < 0 || compareIsoTimestamps(selected.event.occurredAt, policy.validBefore) >= 0 ? "flagged" : "within_supplied_rules");

  // Source identity is independent of the owner's local profile association and report capture.
  const groups = new Map<string, AgentPolicyEventInput[]>();
  for (const entry of input.events) {
    const key = JSON.stringify([entry.connectorId, entry.event.eventId]);
    const group = groups.get(key) ?? []; group.push(entry); groups.set(key, group);
  }
  const duplicates: AgentPolicyEventInput[] = [], conflicts: AgentPolicyEventInput[] = [], counted: AgentPolicyEventInput[] = [];
  const selectedKey = JSON.stringify([selected.connectorId, selected.event.eventId]);
  for (const group of groups.values()) {
    const scoped = group.filter((entry) => entry.agentProfileRecordId === selected.agentProfileRecordId);
    if (!scoped.length) continue;
    const variants = new Set(group.map((entry) => canonicalEventContent(entry.event)));
    if (variants.size > 1) {
      const intersectsDay = scoped.some((entry) => entry.event.occurredAt.slice(0, 10) === day);
      if (JSON.stringify([group[0]!.connectorId, group[0]!.event.eventId]) === selectedKey || (policy.dailyLimit !== null && intersectsDay)) conflicts.push(...group);
      if (intersectsDay) result.daily.excludedConflictingSourceEvents++;
    } else {
      if (group.length > 1) duplicates.push(...group);
      if (scoped[0]!.event.occurredAt.slice(0, 10) === day) counted.push(scoped[0]!);
    }
  }
  if (duplicates.length) warnings.push({ rule: "source_identity", code: "IDENTICAL_SOURCE_EVENT_DUPLICATES", status: "not_applicable", citations: cite(duplicates) });
  if (conflicts.length) add("source_identity", "SOURCE_EVENT_CONTENT_CONFLICT", "conflicting", conflicts);
  else add("source_identity", "NO_CONFLICT_IN_SUPPLIED_SOURCE_IDENTITIES", "within_supplied_rules", input.events);

  const nonceGroups = new Map<string, AgentPolicyEventInput[]>();
  for (const entry of input.events) {
    const event = entry.event;
    if (!event.authorizationNonce || !event.authorizationDomainDigest) continue;
    const key = JSON.stringify([event.network, event.asset, event.payer, event.authorizationDomainDigest, event.authorizationNonce]);
    const group = nonceGroups.get(key) ?? []; group.push(entry); nonceGroups.set(key, group);
  }
  const reused = [...nonceGroups.values()].filter((group) => group.some((entry) => JSON.stringify(entry) === JSON.stringify(selected)) &&
    new Set(group.map((entry) => JSON.stringify([entry.connectorId, entry.event.actionId]))).size > 1).flat();
  if (reused.length) add("authorization_reuse", "POSSIBLE_AUTHORIZATION_REPLAY_NOT_EXECUTION_PROOF", "conflicting", reused);
  const missingNonce = !selected.event.authorizationNonce || !selected.event.authorizationDomainDigest ? [selected] : [];
  if (missingNonce.length) add("authorization_reuse", "AUTHORIZATION_UNIQUENESS_UNEVALUABLE", "unevaluable", missingNonce);
  else if (!reused.length) add("authorization_reuse", "NO_REUSE_IN_SUPPLIED_ACTIONS_ONLY", "within_supplied_rules", input.events);

  add("per_action", policy.perActionLimit === null ? "PER_ACTION_LIMIT_NOT_CONFIGURED" : BigInt(selected.event.amountBaseUnits) > BigInt(policy.perActionLimit) ? "PER_ACTION_LIMIT_EXCEEDED" : "REPORTED_AMOUNT_WITHIN_PER_ACTION_LIMIT",
    policy.perActionLimit === null ? "not_applicable" : BigInt(selected.event.amountBaseUnits) > BigInt(policy.perActionLimit) ? "flagged" : "within_supplied_rules");
  const total = counted.reduce((sum, entry) => sum + BigInt(entry.event.amountBaseUnits), 0n);
  result.daily.observedAttemptTotalBaseUnits = total.toString();
  const dailyInputs = input.events.filter((entry) => entry.agentProfileRecordId === selected.agentProfileRecordId && entry.event.occurredAt.slice(0, 10) === day);
  if (policy.dailyLimit === null) add("daily", "DAILY_LIMIT_NOT_CONFIGURED", "not_applicable", dailyInputs);
  else {
    add("daily", "DAILY_HISTORY_INCOMPLETE", "unevaluable", dailyInputs);
    if (result.daily.excludedConflictingSourceEvents) add("daily", "CONFLICTING_ATTEMPTS_EXCLUDED_FROM_TOTAL", "unevaluable", conflicts);
    if (total > BigInt(policy.dailyLimit)) add("daily", "SUPPLIED_DAILY_ATTEMPTS_EXCEED_LIMIT", "flagged", dailyInputs);
  }
  const listRule = (rule: "recipient" | "contract" | "service", value: string | null, allow: string[], block: string[]): void => {
    if (!allow.length && !block.length) { add(rule, "LISTS_NOT_CONFIGURED", "not_applicable"); return; }
    if (value === null) { add(rule, "REQUIRED_FACT_NOT_SUPPLIED", "unevaluable"); return; }
    if (block.includes(value)) { add(rule, "BLOCK_LIST_MATCH", "flagged"); return; }
    if (allow.length && !allow.includes(value)) { add(rule, "OUTSIDE_ALLOW_LIST", "flagged"); return; }
    add(rule, "WITHIN_SUPPLIED_LIST_RULES", "within_supplied_rules");
  };
  listRule("recipient", selected.event.recipient, policy.allowRecipients, policy.blockRecipients);
  listRule("contract", selected.event.contract, policy.allowContracts, policy.blockContracts);
  listRule("service", selected.event.serviceDigest, policy.allowServices, policy.blockServices);
  add("approval", !policy.requireApproval ? "APPROVAL_NOT_REQUIRED" : selected.event.approval === "not_supplied" ? "APPROVAL_NOT_SUPPLIED" :
    selected.event.approval === "reported_denied" ? "REPORTED_APPROVAL_DENIED" : "REPORTED_APPROVAL_NOT_VERIFIED",
  !policy.requireApproval ? "not_applicable" : selected.event.approval === "not_supplied" ? "unevaluable" : selected.event.approval === "reported_denied" ? "flagged" : "within_supplied_rules");
  const precedence: AgentPolicyStatus[] = ["conflicting", "flagged", "unevaluable", "within_supplied_rules", "not_applicable"];
  result.status = precedence.find((status) => findings.some((finding) => finding.status === status))!;
  return result;
}

function cite(entries: AgentPolicyEventInput[]): AgentPolicyCitation[] {
  const citations = new Map<string, AgentPolicyCitation>();
  for (const entry of entries) {
    const citation = { importRecordId: entry.importRecordId, connectorId: entry.connectorId, eventId: entry.event.eventId, eventIndex: entry.eventIndex };
    citations.set(JSON.stringify(citation), citation);
  }
  return [...citations.values()].sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
}

function canonicalEventContent(event: AgentPolicyEventInput["event"]): string {
  // Compare equal UTC instants without rewriting source evidence or rounding nanoseconds.
  const occurredAt = event.occurredAt.replace(/\.(\d+)Z$/u, (_match, fraction: string) => {
    const significant = fraction.replace(/0+$/u, "");
    return significant ? `.${significant}Z` : "Z";
  });
  return JSON.stringify({ ...event, occurredAt });
}

import { z } from "zod";
import { WorkspaceRecordSchema, type WorkspaceRecord } from "./vault.js";
import { IsoTimestampSchema, compareIsoTimestamps } from "./primitives.js";
import { reconcileAction } from "./reconciliation.js";
import { reconcileX402 } from "./x402-reconciliation.js";
import { evaluateAgentPolicy, type AgentPolicyEventInput } from "./agent-policy.js";
import { INVESTIGATION_LIMITS as L, INVESTIGATION_SOURCE_CLASSES, INVESTIGATION_STATUSES,
  INVESTIGATION_SOURCE_LIMITATIONS as LIMITATIONS, type InvestigationReference as Ref,
  type InvestigationEntry as Entry, type InvestigationNode as Node, type InvestigationFact as Fact,
  type InvestigationDetail as Detail, type InvestigationFilter, type InvestigationPage,
  type InvestigationStatus as Status, type InvestigationComparison as Comparison,
  type InvestigationEdge as Edge } from "./investigation-types.js";

/** Deliberately generic: untrusted record contents never appear in errors. */
export class InvestigationError extends Error {
  constructor() { super("Investigation input is unavailable or invalid."); this.name = "InvestigationError"; }
}
function fail(): never { throw new InvestigationError(); }
const refSchema = z.strictObject({ kind: z.string(), recordId: z.string().uuid(), recordRevision: z.string(),
  eventIndex: z.number().int().min(0).max(63).optional(), eventId: z.string().uuid().optional(), connectorId: z.string().optional() });
const filterSchema = z.strictObject({ query: z.string().max(L.queryCharacters).optional(),
  status: z.enum([...INVESTIGATION_STATUSES, "all"]).optional(),
  sourceClass: z.enum([...INVESTIGATION_SOURCE_CLASSES, "all"]).optional(), exceptionsOnly: z.boolean().optional(),
  page: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional() });
const optionsSchema = z.strictObject({ evaluatedAt: IsoTimestampSchema,
  page: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(), policyRecordId: z.string().uuid().optional() });
const rootKinds = new Set(["action_envelope", "evidence_record", "x402_bundle", "agent_import", "arc_observation",
  "agent_registry_observation", "job_observation", "gateway_observation"]);
const key = (ref: Ref): string => JSON.stringify([ref.kind, ref.recordId, ref.recordRevision, ref.eventIndex ?? null]);
const reference = (record: WorkspaceRecord, eventIndex?: number): Ref => ({ kind: record.kind,
  recordId: record.recordId, recordRevision: record.recordRevision,
  ...(record.kind === "agent_import" && eventIndex !== undefined ? { eventIndex,
    eventId: record.report.events[eventIndex]!.eventId, connectorId: record.report.connectorId } : {}) });
const compare = (a: { time: string; key: string }, b: { time: string; key: string }): number =>
  compareIsoTimestamps(a.time, b.time) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

function validated(raw: readonly WorkspaceRecord[]): WorkspaceRecord[] {
  if (!Array.isArray(raw) || raw.length > L.records) fail();
  const records = raw.map((record) => { const result = WorkspaceRecordSchema.safeParse(record); return result.success ? result.data : fail(); });
  const ids = new Set<string>(); let events = 0; let reports = 0;
  const sourceIds = new Set<string>();
  for (const record of records) {
    if (ids.has(record.recordId)) fail(); ids.add(record.recordId);
    if (record.kind === "agent_import") { events += record.report.events.length; reports++; }
    const unique = record.kind === "evidence_record" ? `e:${record.evidence.evidenceId}` :
      record.kind === "action_envelope" ? `a:${record.action.actionId}` :
      record.kind === "agent_profile" ? `p:${record.agentId}` :
      record.kind === "agent_import" ? `i:${record.report.importId}` :
      record.kind === "agent_monitoring_policy" ? `v2:${record.policy.policyId}` :
      record.kind === "monitoring_policy" ? `v1:${record.policy.policyId}` : null;
    if (unique && sourceIds.has(unique)) fail(); if (unique) sourceIds.add(unique);
  }
  if (events > L.events || reports > 32) fail();
  const byId = new Map(records.map((record) => [record.recordId, record]));
  const requireKind = (id: string | null, kind: WorkspaceRecord["kind"]): void => {
    if (id !== null && byId.get(id)?.kind !== kind) fail();
  };
  for (const record of records) {
    if (record.kind === "agent_import") requireKind(record.linkedAgentProfileRecordId, "agent_profile");
    if (record.kind === "agent_monitoring_policy") requireKind(record.policy.agentProfileRecordId, "agent_profile");
    if (record.kind === "agent_registry_observation") requireKind(record.linkedAgentProfileRecordId, "agent_profile");
    if (record.kind === "job_observation") requireKind(record.linkedActionRecordId, "action_envelope");
    if (record.kind === "gateway_observation") requireKind(record.linkedBundleRecordId, "x402_bundle");
  }
  return records.sort((left, right) => left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0);
}

function asNode(record: WorkspaceRecord, eventIndex?: number): Node {
  const ref = reference(record, eventIndex);
  let time = record.createdAt, sourceClass: Node["sourceClass"] = "explicit_local_association";
  let status: Status = "needs_review", title: string = record.kind.replaceAll("_", " ");
  let payload: unknown = null; const limitations: string[] = [];
  switch (record.kind) {
    case "agent_import": {
      if (eventIndex === undefined || !record.report.events[eventIndex]) fail();
      const event = record.report.events[eventIndex]!; time = event.occurredAt;
      sourceClass = "owner_supplied_unauthenticated"; title = "Imported agent attempt";
      status = event.reportedStatus === "failed" ? "reported_failure" : "needs_review"; payload = event;
      break;
    }
    case "x402_bundle": sourceClass = "owner_supplied_unauthenticated"; time = record.bundle.capturedAt;
      title = "Imported payment metadata"; payload = record.bundle;
      status = record.bundle.responseMetadata?.reportedSuccess === false ? "reported_failure" : "needs_review"; break;
    case "action_envelope": sourceClass = "synthetic_fixture"; time = record.action.createdAt; payload = { ...record.action, reconciliation: undefined, policyEvaluation: undefined };
      title = "Synthetic action"; status = "needs_review"; break;
    case "evidence_record": sourceClass = "synthetic_fixture"; time = record.evidence.occurredAt ?? record.evidence.observedAt;
      title = `Synthetic ${record.evidence.evidenceType}`; payload = record.evidence.payload; limitations.push(...record.evidence.limitations); break;
    case "arc_observation": sourceClass = "named_testnet_observation"; time = record.observation.source.observedAt;
      title = "transaction" in record.observation ? "Saved Arc transaction" : "Saved Arc account";
      status = "receipt" in record.observation && record.observation.receipt.status === "failed" ? "reported_failure" : "observed";
      payload = record.observation; limitations.push(...record.observation.limitations); break;
    case "agent_registry_observation": sourceClass = "named_testnet_observation"; time = record.observation.source.observedAt;
      title = "Saved registry observation"; status = "observed"; payload = record.observation; limitations.push(...record.observation.limitations); break;
    case "job_observation": sourceClass = "named_testnet_observation"; time = record.observation.source.observedAt;
      title = "Saved job observation"; status = record.observation.status === "Rejected" || record.observation.status === "Expired" ? "reported_failure" : "observed";
      payload = record.observation; limitations.push(...record.observation.limitations); break;
    case "gateway_observation": sourceClass = "named_testnet_observation"; time = record.observation.source.observedAt;
      title = "Saved Gateway observation"; status = record.observation.transfer.status === "failed" ? "reported_failure" : "observed";
      payload = record.observation; limitations.push("Gateway status and batch inclusion do not prove individual payment settlement or fulfillment."); break;
    case "agent_profile": title = record.displayName; payload = { displayName: record.displayName, agentId: record.agentId, wallets: record.wallets }; break;
    case "agent_monitoring_policy": title = "Local report monitoring policy"; sourceClass = "local_policy_result"; payload = record.policy; break;
    case "monitoring_policy": title = "Synthetic monitoring policy"; sourceClass = "synthetic_fixture"; payload = record.policy; break;
    default: fail();
  }
  const facts: Fact[] = [{ label: "recordId", value: record.recordId, category: "identifier", side: "context" },
    { label: "time", value: time, category: "timestamp", side: "context" }];
  flattenFacts(payload, [], facts);
  if (record.kind === "monitoring_policy" || record.kind === "agent_monitoring_policy" ||
    (record.kind === "evidence_record" && ["intent", "payment_requirement"].includes(record.evidence.evidenceType))) {
    for (const fact of facts) if (fact.side !== "context") fact.side = "expected";
  }
  if (facts.length > L.factsPerNode) fail();
  return { key: key(ref), reference: ref, title, time, sourceClass, status, facts,
    limitations: [...new Set([LIMITATIONS[sourceClass], ...limitations])] };
}

// Only schema-normalized payloads enter this walker. Arbitrary prose stays private.
function flattenFacts(value: unknown, path: string[], out: Fact[]): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) { value.forEach((child, index) => flattenFacts(child, [...path, String(index)], out)); return; }
  if (typeof value === "object") { for (const [field, child] of Object.entries(value)) flattenFacts(child, [...path, field], out); return; }
  const field = path.at(-1) ?? "value", text = String(value);
  let category: Fact["category"] = "local_private";
  if (/^(?:recordId|eventId|actionId|agentId|policyId|bundleId|id|address|from|to|payer|recipient|payTo|fromAddress|toAddress|asset|network|contract|verifyingContract|owner|agentWallet|client|provider|evaluator|hook|nonce|authorizationNonce|.*Hash|hash|.*Digest|digest)$/u.test(field)) category = "identifier";
  else if ((/^(?:amount|amountBaseUnits|baseUnits|perActionLimit|dailyLimit|maximumAmountBaseUnits)$/u.test(field) ||
    (field === "value" && path.includes("authorizationMetadata"))) && /^(0|[1-9][0-9]*)$/u.test(text)) category = "amount";
  else if (/^(?:occurredAt|observedAt|capturedAt|respondedAt|createdAt|updatedAt|validAfter|validBefore|expiresAt|at|timestamp|blockTimestamp)$/u.test(field) &&
    IsoTimestampSchema.safeParse(value).success) category = "timestamp";
  else if (["status", "reportedStatus", "authentication", "approval", "mode", "reportedSuccess"].includes(field)) category = "public_status";
  const expected = path.includes("requirement") || path.includes("perActionLimit") || path.includes("dailyLimit") || path.includes("allowRecipients") || path.includes("blockRecipients");
  out.push({ label: path.join("."), value: text, category, side: expected ? "expected" : "observed" });
}

function entry(node: Node): Entry {
  return { key: node.key, reference: node.reference, kind: node.reference.kind as Entry["kind"], title: node.title,
    time: node.time, sourceClass: node.sourceClass, status: node.status,
    searchText: [node.title, ...node.facts.map((fact) => fact.value)].join(" ").toLowerCase() };
}
function indexOf(records: WorkspaceRecord[]): Entry[] {
  const entries: Entry[] = [];
  const groups = new Map<string, { variants: Set<string>; entries: Entry[] }>();
  for (const record of records) {
    if (!rootKinds.has(record.kind)) continue;
    if (record.kind !== "agent_import") { entries.push(entry(asNode(record))); continue; }
    record.report.events.forEach((event, i) => {
      const item = entry(asNode(record, i)); entries.push(item);
      const identity = JSON.stringify([record.report.connectorId, event.eventId]);
      const group = groups.get(identity) ?? { variants: new Set<string>(), entries: [] };
      // Same equivalence as M08: trailing fractional zeroes do not change an instant.
      const occurredAt = event.occurredAt.replace(/\.(\d+)Z$/u, (_match, fraction: string) => {
        const significant = fraction.replace(/0+$/u, ""); return significant ? `.${significant}Z` : "Z";
      });
      group.variants.add(JSON.stringify({ ...event, occurredAt })); group.entries.push(item); groups.set(identity, group);
    });
  }
  for (const group of groups.values()) if (group.variants.size > 1) for (const item of group.entries) item.status = "conflicting";
  if (entries.length > L.entries) fail();
  return entries.sort(compare);
}
export function buildInvestigationIndex(records: readonly WorkspaceRecord[]): Entry[] { return indexOf(validated(records)); }

export function filterInvestigations(entries: readonly Entry[], raw: InvestigationFilter = {}): InvestigationPage {
  const parsed = filterSchema.safeParse(raw); if (!parsed.success || !Array.isArray(entries) || entries.length > L.entries) fail();
  const filter = parsed.data, query = (filter.query ?? "").trim().toLowerCase();
  const keys = new Set<string>();
  for (const item of entries) {
    if (!item || typeof item.searchText !== "string" || !IsoTimestampSchema.safeParse(item.time).success ||
      !INVESTIGATION_STATUSES.includes(item.status) || !INVESTIGATION_SOURCE_CLASSES.includes(item.sourceClass) ||
      !refSchema.safeParse(item.reference).success || item.key !== key(item.reference) || keys.has(item.key)) fail();
    keys.add(item.key);
  }
  const matches = entries.filter((item) => (!query || item.searchText.includes(query)) &&
    (!filter.status || filter.status === "all" || item.status === filter.status) &&
    (!filter.sourceClass || filter.sourceClass === "all" || item.sourceClass === filter.sourceClass) &&
    (!filter.exceptionsOnly || ["conflicting", "reported_failure", "needs_review"].includes(item.status))).sort(compare);
  const page = filter.page ?? 1, pageCount = Math.max(1, Math.ceil(matches.length / L.pageSize));
  if (page > pageCount) fail();
  return { entries: matches.slice((page - 1) * L.pageSize, page * L.pageSize), total: matches.length, page, pageCount };
}

export function buildInvestigationDetail(raw: readonly WorkspaceRecord[], rawRef: Ref,
  rawOptions: { evaluatedAt: string; page?: number; policyRecordId?: string }): Detail {
  try { return detail(validated(raw), rawRef, rawOptions); } catch { return fail(); }
}
function detail(records: WorkspaceRecord[], rawRef: Ref, rawOptions: { evaluatedAt: string; page?: number; policyRecordId?: string }): Detail {
  const refResult = refSchema.safeParse(rawRef), optionResult = optionsSchema.safeParse(rawOptions);
  if (!refResult.success || !optionResult.success) fail();
  if (rawRef.eventIndex === undefined && (rawRef.eventId !== undefined || rawRef.connectorId !== undefined)) fail();
  const options = optionResult.data, roots = indexOf(records);
  const root = roots.find((item) => JSON.stringify(item.reference) === JSON.stringify(referenceFromInput(rawRef)));
  if (!root) fail();
  const byId = new Map(records.map((record) => [record.recordId, record]));
  const selected = byId.get(root.reference.recordId)!;
  const nodes = new Map<string, Node>(), edges: Edge[] = [], comparisons: Comparison[] = [];
  const add = (record: WorkspaceRecord, eventIndex?: number): Node => {
    const node = asNode(record, eventIndex);
    node.status = roots.find((item) => item.key === node.key)?.status ?? node.status;
    nodes.set(node.key, node); return node;
  };
  const connect = (from: Node, to: Node, kind: Edge["kind"]): void => {
    const edge = { from: from.key, to: to.key, kind, label: kind.replaceAll("_", " ") };
    if (!edges.some((existing) => existing.from === edge.from && existing.to === edge.to && existing.kind === kind)) edges.push(edge);
  };
  const rootNode = add(selected, root.reference.eventIndex); rootNode.status = root.status;
  const limitations = ["Search and comparisons cover supplied local records only; this is not a complete-history audit."];
  let replayScope: Detail["replayScope"] = null;
  let bundle = selected.kind === "x402_bundle" ? selected : null;
  if (selected.kind === "gateway_observation" && selected.linkedBundleRecordId) {
    const target = byId.get(selected.linkedBundleRecordId)!;
    if (target.kind !== "x402_bundle") fail(); bundle = target;
  }
  if (bundle) {
    const bundleNode = add(bundle);
    for (const record of records) if (record.kind === "gateway_observation" && record.linkedBundleRecordId === bundle.recordId) {
      connect(bundleNode, add(record), "explicit_local_association");
    }
  }
  let action = selected.kind === "action_envelope" ? selected : null;
  if (selected.kind === "job_observation" && selected.linkedActionRecordId) {
    const target = byId.get(selected.linkedActionRecordId)!; if (target.kind !== "action_envelope") fail(); action = target;
  }
  if (action) {
    const actionNode = add(action), evidenceIds = new Set([...action.action.intentEvidenceIds, ...action.action.attemptEvidenceIds,
      ...action.action.paymentEvidenceIds, ...action.action.fulfillmentEvidenceIds, ...action.action.settlementEvidenceIds]);
    const evidence = records.filter((record): record is Extract<WorkspaceRecord, { kind: "evidence_record" }> => record.kind === "evidence_record" && evidenceIds.has(record.evidence.evidenceId));
    if (evidence.length !== evidenceIds.size) fail();
    for (const record of evidence) connect(actionNode, add(record), "cited_evidence");
    for (const record of records) if (record.kind === "job_observation" && record.linkedActionRecordId === action.recordId) connect(actionNode, add(record), "explicit_local_association");
    const profile = records.find((record) => record.kind === "agent_profile" && record.agentId === action.action.agentId);
    if (!profile || profile.kind !== "agent_profile") fail();
    connect(add(profile), actionNode, "explicit_local_association");
    const policies = profile.policyRecordIds.map((id) => { const record = byId.get(id); if (record?.kind !== "monitoring_policy") fail(); return record; });
    for (const record of policies) connect(add(record), actionNode, "local_policy_comparison");
    const result = reconcileAction({ action: { ...action.action, reconciliation: null, policyEvaluation: null },
      evidence: evidence.map((record) => record.evidence), policies: policies.map((record) => record.policy), evaluatedAt: options.evaluatedAt });
    comparisons.push({ title: "Synthetic action comparison", status: result.conflicts.length ? "conflicting" :
      result.state === "RECONCILED" && result.policyEvaluation.state !== "flagged" && !result.gaps.length ? "synthetic_complete" :
      result.state === "FAILED" ? "reported_failure" : "needs_review",
      ruleVersion: result.ruleVersion, findings: [result.state, ...result.gaps.map((gap) => gap.code), ...result.conflicts.map((conflict) => conflict.code)],
      citations: [reference(action), reference(profile), ...policies.map((record) => reference(record)),
        ...evidence.map((record) => reference(record))], limitations: result.limitations });
  }
  if (selected.kind === "agent_registry_observation" && selected.linkedAgentProfileRecordId) connect(add(byId.get(selected.linkedAgentProfileRecordId)!), rootNode, "explicit_local_association");
  if (selected.kind === "agent_import") {
    if (compareIsoTimestamps(selected.report.capturedAt, options.evaluatedAt) > 0) fail();
    connect(add(byId.get(selected.linkedAgentProfileRecordId)!), rootNode, "explicit_local_association");
    if (options.policyRecordId) {
      const policy = byId.get(options.policyRecordId);
      if (policy?.kind !== "agent_monitoring_policy" || policy.policy.agentProfileRecordId !== selected.linkedAgentProfileRecordId) fail();
      const inputs: AgentPolicyEventInput[] = [];
      for (const record of records) if (record.kind === "agent_import") {
        if (compareIsoTimestamps(record.report.capturedAt, options.evaluatedAt) > 0) fail();
        record.report.events.forEach((event, eventIndex) => {
          inputs.push({ importRecordId: record.recordId, agentProfileRecordId: record.linkedAgentProfileRecordId,
            connectorId: record.report.connectorId, eventIndex, event });
        });
      }
      const result = evaluateAgentPolicy({ selected: inputs.find((item) => item.importRecordId === selected.recordId && item.eventIndex === root.reference.eventIndex)!,
        events: inputs, policy: policy.policy, evaluatedAt: options.evaluatedAt });
      const policyNode = add(policy);
      for (const input of inputs) connect(policyNode, add(byId.get(input.importRecordId)!, input.eventIndex), "local_policy_comparison");
      comparisons.push({ title: "Local agent policy comparison", status: result.status === "conflicting" ? "conflicting" : "needs_review",
        ruleVersion: result.ruleVersion, findings: [result.status, ...result.findings.map((finding) => finding.code)],
        citations: [reference(policy), ...inputs.map((input) => reference(byId.get(input.importRecordId)!, input.eventIndex))],
        limitations: [LIMITATIONS.local_policy_result, "Daily totals count supplied attempts, not confirmed spend; history remains partial."] });
    } else limitations.push("No report policy was selected. Index status is not a policy evaluation.");
  } else if (options.policyRecordId) fail();
  const ordered = [...nodes.values()].sort(compare);
  if (ordered.some((node) => compareIsoTimestamps(node.time, options.evaluatedAt) > 0)) fail();
  const pageCount = Math.max(1, Math.ceil(ordered.length / L.detailNodes)), page = options.page ?? 1;
  if (page > pageCount) fail();
  const visible = ordered.slice((page - 1) * L.detailNodes, page * L.detailNodes), visibleKeys = new Set(visible.map((node) => node.key));
  const visibleEdges = edges.filter((edge) => visibleKeys.has(edge.from) && visibleKeys.has(edge.to));
  if (visibleEdges.length > L.detailEdges) fail();
  if (bundle) {
    const bundles = records.filter((record) => record.kind === "x402_bundle");
    const complete = bundles.length <= 64;
    replayScope = { supplied: bundles.length, compared: complete ? bundles.length : 1, completeLocalCollection: complete };
    if (!complete) limitations.push("More than 64 saved bundles: collection duplicate/replay coverage is unavailable; only selected metadata is compared.");
    const gatewayNodes = visible.filter((node) => node.reference.kind === "gateway_observation");
    const targets = gatewayNodes.length ? gatewayNodes : [null];
    for (const node of targets) {
      const gateway = node ? byId.get(node.reference.recordId) : null;
      if (gateway && gateway.kind !== "gateway_observation") fail();
      const result = reconcileX402({ bundleRecordId: bundle.recordId, bundle: bundle.bundle, evaluatedAt: options.evaluatedAt,
        ...(gateway ? { gateway: { recordId: gateway.recordId, observation: gateway.observation } } : {}),
        otherBundles: complete ? bundles.filter((record) => record.recordId !== bundle.recordId).map((record) => ({ recordId: record.recordId, bundle: record.bundle })) : [] });
      comparisons.push({ title: gateway ? "Selected bundle versus saved Gateway observation" : "Selected bundle metadata comparison",
        status: result.conflicts.length ? "conflicting" : result.providerResponse === "reported_failure" ? "reported_failure" : "needs_review",
        ruleVersion: result.ruleVersion, findings: [...result.conflicts.map((finding) => finding.code), ...result.gaps.map((finding) => finding.code),
          result.metadataAgreement, result.gatewayStatus, ...(complete ? result.duplicates.map((finding) => finding.code) : ["COLLECTION_REPLAY_COVERAGE_UNAVAILABLE"])],
        citations: result.inputRecordIds.map((id) => reference(byId.get(id)!)), limitations: result.limitations });
    }
    limitations.push("Gateway comparisons cover observations on this detail page; all explicitly linked observations remain in page totals.");
  }
  return { root, evaluatedAt: options.evaluatedAt, nodes: visible, edges: visibleEdges, page, pageCount,
    totalNodes: ordered.length, totalEdges: edges.length, omittedCrossPageEdges: edges.length - visibleEdges.length,
    comparisons, limitations, replayScope };
}

function referenceFromInput(ref: Ref): Ref {
  return { kind: ref.kind, recordId: ref.recordId, recordRevision: ref.recordRevision,
    ...(ref.eventIndex === undefined ? {} : { eventIndex: ref.eventIndex, eventId: ref.eventId, connectorId: ref.connectorId }) };
}

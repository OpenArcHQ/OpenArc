import { describe, expect, it } from "vitest";
import { AgentMonitoringPolicySchema, AgentPolicyEvaluationInputSchema, evaluateAgentPolicy,
  type AgentMonitoringPolicy, type AgentPolicyEventInput } from "../src/agent-policy.js";
import { ARC_TESTNET } from "../src/network.js";

const id = (n: number) => `11111111-1111-4111-8111-${n.toString().padStart(12, "0")}`;
const address = (n: string) => `0x${n.repeat(40)}`;
const digest = `sha256:${"a".repeat(64)}`;
const now = "2026-09-06T12:00:00Z";
function entry(n = 1, changes: Partial<AgentPolicyEventInput["event"]> = {}): AgentPolicyEventInput {
  return { importRecordId: id(1), agentProfileRecordId: id(2), connectorId: "local:agent", eventIndex: (n - 1) % 64, event: {
    eventId: id(n), actionId: `action-${n}`, occurredAt: "2026-09-05T12:00:00Z", network: ARC_TESTNET.caip2,
    asset: ARC_TESTNET.contracts.usdc, decimals: 6, payer: address("1"), recipient: address("2"), amountBaseUnits: "1000000",
    reportedStatus: "attempted", contract: null, serviceDigest: null, authorizationNonce: `0x${n.toString(16).padStart(64, "0")}`,
    authorizationDomainDigest: digest, approval: "reported_approved", ...changes,
  } };
}
function policy(changes: Partial<AgentMonitoringPolicy> = {}): AgentMonitoringPolicy {
  return { schemaVersion: "openarc.agent-policy.v2", policyId: id(3), revision: 1, name: "Local test", agentProfileRecordId: id(2),
    enabled: true, validAfter: "2026-09-05T00:00:00Z", validBefore: "2026-09-06T00:00:00Z", perActionLimit: "1000000", dailyLimit: null,
    allowRecipients: [], blockRecipients: [], allowContracts: [], blockContracts: [], allowServices: [], blockServices: [],
    requireApproval: true, mode: "local_monitoring_only", ...changes };
}
const evaluate = (events = [entry()], changes: Partial<AgentMonitoringPolicy> = {}) => evaluateAgentPolicy({ selected: events[0]!, events, policy: policy(changes), evaluatedAt: now });

describe("M08 policy comparison", () => {
  it("compares historical attempt validity, not today's policy time; never asserts enforcement", () => {
    const result = evaluate(); expect(result.status).toBe("within_supplied_rules");
    expect(result.enforcement).toBe("not_verified"); expect(result.approvalVerification).toBe("not_verified");
    expect(result.policyId).toBe(id(3)); expect(result.policyRevision).toBe(1); expect(result.evaluatedAt).toBe(now);
    expect(result.citations).toEqual([{ importRecordId: id(1), connectorId: "local:agent", eventId: id(1), eventIndex: 0 }]);
  });
  it("enforces exact inclusive-start/exclusive-end validity at nanosecond precision", () => {
    expect(evaluate([entry(1, { occurredAt: "2026-09-05T00:00:00Z" })]).status).toBe("within_supplied_rules");
    expect(evaluate([entry(1, { occurredAt: "2026-09-04T23:59:59.999999999Z" })]).violations.some((f) => f.code === "POLICY_NOT_YET_ACTIVE")).toBe(true);
    expect(evaluate([entry(1, { occurredAt: "2026-09-06T00:00:00Z" })]).violations.some((f) => f.code === "POLICY_EXPIRED")).toBe(true);
  });
  it.each([{ enabled: false }, { agentProfileRecordId: id(9) }])("disabled or differently scoped policy is not applicable", (changes) => {
    const result = evaluate([entry(1, { approval: "reported_denied" })], changes);
    expect(result.status).toBe("not_applicable"); expect(result.daily.evaluation).toBe("not_applicable"); expect(result.daily.observedAttemptTotalBaseUnits).toBeNull();
  });
  it("uses exact BigInt amounts above safe JS integers, includes all reported statuses", () => {
    const amount = "9007199254740993";
    const result = evaluate([entry(1, { amountBaseUnits: amount }), entry(2, { amountBaseUnits: amount, reportedStatus: "failed" }), entry(3, { amountBaseUnits: amount, reportedStatus: "succeeded" })], { perActionLimit: "9007199254740992", dailyLimit: "27021597764222978" });
    expect(result.daily.observedAttemptTotalBaseUnits).toBe("27021597764222979"); expect(result.status).toBe("flagged");
    expect(result.gaps.some((f) => f.code === "DAILY_HISTORY_INCOMPLETE")).toBe(true);
  });
  it("under-limit and exactly-at-limit daily totals remain unevaluable", () => {
    for (const dailyLimit of ["1000000", "2000000"]) expect(evaluate([entry()], { dailyLimit }).status).toBe("unevaluable");
  });
  it("uses UTC calendar day and selected local agent, never rolling 24h", () => {
    const events = [entry(), entry(2, { occurredAt: "2026-09-04T23:59:59Z" }), entry(3, { occurredAt: "2026-09-05T00:00:00Z" }), entry(4, { occurredAt: "2026-09-06T00:00:00Z" }), { ...entry(5), importRecordId: id(5), agentProfileRecordId: id(5) }];
    expect(evaluate(events, { dailyLimit: "999999999" }).daily.observedAttemptTotalBaseUnits).toBe("2000000");
  });
  it("deduplicates same source event across reports, cites both, counts distinct same-action attempts", () => {
    const events = [entry(), { ...entry(), importRecordId: id(8) }, entry(2, { actionId: "action-1", authorizationNonce: entry().event.authorizationNonce })];
    const result = evaluate(events, { dailyLimit: "9000000" });
    expect(result.daily.observedAttemptTotalBaseUnits).toBe("2000000"); expect(result.warnings[0]!.citations).toHaveLength(2);
    expect(result.violations).toEqual([]);
  });
  it("deduplicates equivalent timestamp spellings without rewriting imported evidence", () => {
    for (const [left, right] of [["2026-09-05T12:00:00Z", "2026-09-05T12:00:00.000Z"],
      ["2026-09-05T12:00:00.1234Z", "2026-09-05T12:00:00.123400000Z"]]) {
      const events = [entry(1, { occurredAt: left }), { ...entry(1, { occurredAt: right }), importRecordId: id(8) }];
      const before = JSON.stringify(events);
      const result = evaluate(events, { dailyLimit: "2000000" });
      expect(result.daily.observedAttemptTotalBaseUnits).toBe("1000000"); expect(result.violations).toEqual([]);
      expect(result.warnings[0]!.code).toBe("IDENTICAL_SOURCE_EVENT_DUPLICATES");
      expect(result.warnings[0]!.citations).toHaveLength(2); expect(JSON.stringify(events)).toBe(before);
    }
  });
  it("preserves an actual one-nanosecond difference as conflicting source content", () => {
    const result = evaluate([entry(1, { occurredAt: "2026-09-05T12:00:00.000000001Z" }),
      { ...entry(1, { occurredAt: "2026-09-05T12:00:00.000000002Z" }), importRecordId: id(8) }]);
    expect(result.status).toBe("conflicting"); expect(result.violations[0]!.code).toBe("SOURCE_EVENT_CONTENT_CONFLICT");
  });
  it("changed same-source content conflicts without selecting a winning amount; gaps survive", () => {
    const result = evaluate([entry(), { ...entry(1, { amountBaseUnits: "9" }), importRecordId: id(8) }], { dailyLimit: "5" });
    expect(result.status).toBe("conflicting"); expect(result.daily.observedAttemptTotalBaseUnits).toBe("0");
    expect(result.daily.excludedConflictingSourceEvents).toBe(1); expect(result.gaps).toHaveLength(2);
  });
  it("uses exact ordinal selection and cites both conflicting same-ID variants within an import", () => {
    const first = entry(1, { amountBaseUnits: "1" });
    const second = { ...entry(1, { amountBaseUnits: "9" }), eventIndex: 1 };
    const result = evaluateAgentPolicy({ selected: second, events: [first, second], policy: policy({ perActionLimit: "5" }), evaluatedAt: now });
    expect(result.status).toBe("conflicting");
    expect(result.violations.find((f) => f.code === "PER_ACTION_LIMIT_EXCEEDED")?.citations).toEqual([{ importRecordId: id(1), connectorId: "local:agent", eventId: id(1), eventIndex: 1 }]);
    expect(result.violations.find((f) => f.code === "SOURCE_EVENT_CONTENT_CONFLICT")?.citations).toHaveLength(2);
  });
  it("possible nonce reuse requires exact domain/network/asset/payer and distinct actions, not executed proof", () => {
    const a = entry(); const b = entry(2, { authorizationNonce: a.event.authorizationNonce });
    expect(evaluate([a, b]).violations.some((f) => f.code === "POSSIBLE_AUTHORIZATION_REPLAY_NOT_EXECUTION_PROOF")).toBe(true);
    for (const change of [{ payer: address("3") }, { authorizationDomainDigest: `sha256:${"b".repeat(64)}` }, { actionId: a.event.actionId }]) {
      expect(evaluate([a, { ...b, event: { ...b.event, ...change } }]).violations).toEqual([]);
    }
    expect(evaluate([entry(1, { authorizationDomainDigest: null })]).status).toBe("unevaluable");
  });
  it("unrelated historical source conflicts and nonce reuse do not poison the selected attempt", () => {
    const old = entry(2, { occurredAt: "2026-09-04T12:00:00Z" });
    const changed = { ...old, importRecordId: id(8), event: { ...old.event, amountBaseUnits: "1" } };
    const replay = entry(3, { occurredAt: "2026-09-04T12:01:00Z", authorizationNonce: old.event.authorizationNonce });
    const unknown = entry(4, { authorizationNonce: null });
    expect(evaluate([entry(), old, changed, replay, unknown]).status).toBe("within_supplied_rules");
    expect(evaluate([entry(), old, changed, replay], { dailyLimit: "9999999" }).status).toBe("unevaluable");
  });
  it("same-day conflict affects configured daily totals but not an unrelated selected per-action rule", () => {
    const a = entry(2); const b = { ...entry(2, { amountBaseUnits: "1" }), importRecordId: id(8) };
    expect(evaluate([entry(), a, b]).status).toBe("within_supplied_rules");
    expect(evaluate([entry(), a, b], { dailyLimit: "9999999" }).status).toBe("conflicting");
  });
  it("a selected authorization context catches reuse across days and local profile associations", () => {
    const other = { ...entry(2, { occurredAt: "2026-09-04T12:00:00Z", authorizationNonce: entry().event.authorizationNonce }), importRecordId: id(8), agentProfileRecordId: id(9) };
    const result = evaluate([entry(), other]);
    expect(result.status).toBe("conflicting"); expect(result.violations[0]!.citations).toHaveLength(2);
  });
  it("distinct connectors cannot hide possible replay by reusing the same source-local action ID", () => {
    const first = entry();
    const second = { ...entry(2, { actionId: first.event.actionId, authorizationNonce: first.event.authorizationNonce }), importRecordId: id(8), connectorId: "another:connector" };
    const result = evaluate([first, second]);
    expect(result.status).toBe("conflicting");
    expect(result.violations[0]!.code).toBe("POSSIBLE_AUTHORIZATION_REPLAY_NOT_EXECUTION_PROOF");
    expect(evaluate([first, { ...second, connectorId: first.connectorId }]).violations).toEqual([]);
  });
  it("block wins, missing list facts and approval are gaps, denied approval is flagged", () => {
    const result = evaluate([entry(1, { approval: "not_supplied" })], { allowRecipients: [address("2")], blockRecipients: [address("2")], allowContracts: [address("3")], blockServices: [digest] });
    expect(result.status).toBe("flagged"); expect(result.gaps).toHaveLength(3);
    expect(result.violations[0]!.code).toBe("BLOCK_LIST_MATCH");
    expect(evaluate([entry(1, { approval: "reported_denied" })]).violations[0]!.code).toBe("REPORTED_APPROVAL_DENIED");
    expect(evaluate([entry()], { allowRecipients: [address("3")] }).violations[0]!.code).toBe("OUTSIDE_ALLOW_LIST");
  });
  it("results remain deterministic under input permutation and bounded at 512 attempts", () => {
    const events = Array.from({ length: 512 }, (_, index) => ({ ...entry(index + 1, { amountBaseUnits: ((1n << 256n) - 1n).toString() }), importRecordId: id(Math.floor(index / 64) + 1) }));
    const a = evaluate(events, { perActionLimit: null, dailyLimit: "0" });
    const b = evaluateAgentPolicy({ selected: events[0]!, events: [...events].reverse(), policy: policy({ perActionLimit: null, dailyLimit: "0" }), evaluatedAt: now });
    expect(a).toEqual(b); expect(a.daily.observedAttemptTotalBaseUnits).toBe((((1n << 256n) - 1n) * 512n).toString());
    expect(a.findings.length).toBeLessThan(20); expect(a.citations).toHaveLength(512);
  });
});

describe("M08 policy/input strict boundaries", () => {
  it("rejects invalid revision/window/limits and duplicate normalized list entries", () => {
    for (const change of [{ revision: 0 }, { revision: Number.MAX_SAFE_INTEGER + 1 }, { revision: 1.5 }, { name: "a".repeat(81) }, { validBefore: "2026-09-05T00:00:00Z" }, { validAfter: "bad" },
      { dailyLimit: "01" }, { perActionLimit: (1n << 256n).toString() }, { allowRecipients: [address("a"), address("A")] }, { blockServices: [digest, digest] }, { allowServices: Array.from({ length: 17 }, () => digest) }, { mode: "enforced" }, { arbitrary: true }]) {
      expect(AgentMonitoringPolicySchema.safeParse({ ...policy(), ...change }).success).toBe(false);
    }
  });
  it("rejects future events, absent/mismatched selection, excess input bounds and contradictory import associations", () => {
    const base = { selected: entry(), events: [entry()], policy: policy(), evaluatedAt: now };
    for (const changes of [{ evaluatedAt: "2026-09-05T11:59:59.999999999Z" }, { events: [] }, { selected: entry(2) },
      { events: Array.from({ length: 513 }, () => entry()) },
      { events: Array.from({ length: 33 }, (_, i) => ({ ...entry(i + 1), importRecordId: id(i + 1) })) },
      { events: [entry(), entry()] }, { selected: { ...entry(), eventIndex: 1 } },
      { events: [{ ...entry(), eventIndex: 64 }] }, { events: [{ ...entry(), eventIndex: -1 }] }, { events: [{ ...entry(), eventIndex: 0.5 }] },
      { events: [entry(), { ...entry(2), agentProfileRecordId: id(9) }] }, { events: [entry(), { ...entry(2), connectorId: "different" }] }, { arbitrary: true }]) {
      expect(AgentPolicyEvaluationInputSchema.safeParse({ ...base, ...changes }).success).toBe(false);
    }
  });
});

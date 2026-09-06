import { describe, expect, it } from "vitest";
import { buildInvestigationReport, serializeInvestigationReport, InvestigationReportSchema,
  INVESTIGATION_REPORT_FILENAME } from "../src/investigation-export.js";
import { INVESTIGATION_LIMITS, type InvestigationDetail } from "../src/investigation-types.js";

const privateText = "PRIVATE_INVESTIGATION_CANARY";
const identifier = "act_0123456789abcdef0123456789abcdef";
const amount = "9007199254740993123456789.000001";
const at = "2026-09-06T12:00:00.000000001Z";
const reference = { kind: "agent_import" as const, recordId: "11111111-1111-4111-8111-111111111111",
  recordRevision: "A".repeat(32), eventIndex: 1, eventId: "22222222-2222-4222-8222-222222222222", connectorId: privateText };
function detail(): InvestigationDetail {
  const root = { key: `${privateText}-key`, reference, kind: "agent_import" as const, title: privateText,
    time: at, sourceClass: "owner_supplied_unauthenticated" as const, status: "needs_review" as const, searchText: privateText };
  return { root, evaluatedAt: at, nodes: [{ key: root.key, reference, title: privateText, time: at,
    sourceClass: root.sourceClass, status: root.status, facts: [
      { label: privateText, value: identifier, category: "identifier", side: "observed" },
      { label: privateText, value: amount, category: "amount", side: "expected" },
      { label: privateText, value: at, category: "timestamp", side: "context" },
      { label: privateText, value: privateText, category: "local_private", side: "context" },
      { label: privateText, value: privateText, category: "public_status", side: "observed" },
    ], limitations: [privateText] }], edges: [{ from: root.key, to: root.key, kind: "chronological_sequence", label: privateText }],
    page: 1, pageCount: 1, totalNodes: 1, totalEdges: 1, omittedCrossPageEdges: 0,
    comparisons: [{ title: privateText, status: "needs_review", ruleVersion: privateText,
      findings: [privateText], citations: [reference], limitations: [privateText] }], limitations: [privateText],
    replayScope: { supplied: 1, compared: 1, completeLocalCollection: true } };
}

describe("M09 redacted investigation exports", () => {
  it.each(["openarc.reconcile.v1", "openarc.x402-reconciliation.m07.v1", "openarc.agent-policy-rules.v1"])("retains only reviewed engine provenance %s", (version) => {
    const input = detail(); input.comparisons[0]!.ruleVersion = version;
    const result = buildInvestigationReport(input);
    expect(result.comparisons[0]!.ruleVersion).toBe(version);
    expect(InvestigationReportSchema.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toContain(privateText);
  });
  it("replaces unreviewed dynamic rule provenance with null and a value-free omission", () => {
    const result = buildInvestigationReport(detail());
    expect(result.comparisons[0]!.ruleVersion).toBeNull();
    expect(result.omittedFields).toContainEqual({ category: "context", reason: "unsafe_value", count: 1 });
    expect(JSON.stringify(result)).not.toContain(privateText);
    expect(InvestigationReportSchema.safeParse({ ...result, comparisons: [{ ...result.comparisons[0], ruleVersion: privateText }] }).success).toBe(false);
  });
  it("exports only static classes, aliases and omission counts by default", () => {
    const input = detail(), before = JSON.stringify(input);
    const result = buildInvestigationReport(input), json = serializeInvestigationReport(input);
    expect(InvestigationReportSchema.safeParse(result).success).toBe(true);
    expect(JSON.parse(json)).toEqual(result); expect(JSON.stringify(input)).toBe(before);
    for (const canary of [privateText, identifier, amount, at, reference.recordId, reference.eventId, reference.recordRevision]) expect(json).not.toContain(canary);
    expect(result.warning).toBe("PLAINTEXT_REPORT_NOT_ENCRYPTED_BACKUP");
    expect(result.nodes[0]!.fields).toEqual([]); expect(result.nodes[0]!.reference).toBeUndefined();
    expect(result.nodes[0]!.alias).toBe("item-001"); expect(result.comparisons[0]!.citations).toEqual(["item-001"]);
    expect(result.omittedFields).toContainEqual({ category: "identifier", reason: "not_selected", count: 4 });
    expect(INVESTIGATION_REPORT_FILENAME).toBe("openarc-investigation-report.json");
  });
  it.each(["includeIdentifiers", "includeAmounts", "includeTimestamps"] as const)("requires independent explicit %s opt-in", (choice) => {
    const json = serializeInvestigationReport(detail(), { [choice]: true });
    expect(json).not.toContain(privateText);
    for (const [option, value] of [["includeIdentifiers", identifier], ["includeAmounts", amount], ["includeTimestamps", at]]) {
      expect(json.includes(value)).toBe(option === choice);
    }
  });
  it("never includes labels, source free text, connector text or private-category facts even with every opt-in", () => {
    const result = buildInvestigationReport(detail(), { includeIdentifiers: true, includeAmounts: true, includeTimestamps: true });
    expect(JSON.stringify(result)).not.toContain(privateText);
    expect(result.nodes[0]!.fields.map(field => field.value)).toEqual([identifier, amount, at]);
    expect(result.nodes[0]!.reference).toEqual({ recordId: reference.recordId, recordRevision: reference.recordRevision,
      eventIndex: 1, eventId: reference.eventId });
    expect(result.nodes[0]!.fields.every(field => !Object.hasOwn(field, "label"))).toBe(true);
  });
  it.each([
    ["identifier", "https://private.test/path?PRIVATE_CANARY"], ["identifier", "private@example.test"],
    ["identifier", "private label"], ["identifier", "a".repeat(161)],
    ["amount", "01"], ["amount", "1.00"], ["amount", "1e9"], ["amount", "-1"], ["amount", "9".repeat(161)],
    ["timestamp", "2026-09-06T12:00:00+01:00"], ["timestamp", "PRIVATE_CANARY"],
  ] as const)("omits unsafe opt-in %s without reproducing value in manifest", (category, value) => {
    const input = detail(); input.nodes[0]!.facts = [{ label: privateText, value, category, side: "context" }];
    const result = buildInvestigationReport(input, { includeIdentifiers: true, includeAmounts: true, includeTimestamps: true });
    expect(result.nodes[0]!.fields).toEqual([]);
    expect(result.omittedFields).toContainEqual({ category, reason: "unsafe_value", count: 1 });
    expect(JSON.stringify(result.omittedFields)).not.toContain(value);
  });
  it("counts outside-page citations without leaking their identifiers", () => {
    const input = detail(); input.comparisons[0]!.citations.push({ ...reference, recordId: "33333333-3333-4333-8333-333333333333" });
    const result = buildInvestigationReport(input);
    expect(result.comparisons[0]!.citationsOutsidePage).toBe(1);
    expect(result.omittedFields).toContainEqual({ category: "context", reason: "not_on_page", count: 1 });
    expect(JSON.stringify(result)).not.toContain("33333333-3333-4333-8333-333333333333");
  });
  it("bounds 64 nodes/128 edges and rejects exports exceeding one MiB", () => {
    const input = detail(), node = input.nodes[0]!;
    input.nodes = Array.from({ length: 64 }, (_, index) => ({ ...node, key: `node-${index}` }));
    input.root.key = "node-0"; input.totalNodes = 64;
    input.edges = Array.from({ length: 128 }, () => ({ from: "node-0", to: "node-1", kind: "cited_evidence", label: privateText })); input.totalEdges = 128;
    expect(buildInvestigationReport(input).nodes).toHaveLength(64);
    expect(new TextEncoder().encode(serializeInvestigationReport(input)).length).toBeLessThan(INVESTIGATION_LIMITS.exportBytes);
    input.nodes = input.nodes.map(item => ({ ...item, facts: Array.from({ length: 128 }, () => ({ label: privateText, value: "a".repeat(160), category: "identifier", side: "context" })) }));
    expect(() => buildInvestigationReport(input, { includeIdentifiers: true })).toThrow("Invalid investigation report inputs.");
  });
  it("rejects unknown enum values, invalid counts, duplicate keys and dangling edges with a generic error", () => {
    const cases = [
      (input: InvestigationDetail) => { input.nodes[0]!.sourceClass = privateText as never; },
      (input: InvestigationDetail) => { input.nodes[0]!.status = privateText as never; },
      (input: InvestigationDetail) => { input.root.status = privateText as never; },
      (input: InvestigationDetail) => { input.nodes.push(input.nodes[0]!); input.totalNodes = 2; },
      (input: InvestigationDetail) => { input.edges[0]!.to = "missing"; },
      (input: InvestigationDetail) => { input.page = 0; }, (input: InvestigationDetail) => { input.pageCount = 1.5; },
      (input: InvestigationDetail) => { input.totalNodes = Number.NaN; },
      (input: InvestigationDetail) => { input.omittedCrossPageEdges = -1; },
      (input: InvestigationDetail) => { input.nodes = Array.from({ length: 65 }, (_, i) => ({ ...input.nodes[0]!, key: `${i}` })); input.totalNodes = 65; },
      (input: InvestigationDetail) => { input.edges = Array.from({ length: 129 }, () => input.edges[0]!); input.totalEdges = 129; },
      (input: InvestigationDetail) => { input.nodes[0]!.facts = Array.from({ length: INVESTIGATION_LIMITS.factsPerNode + 1 }, () => input.nodes[0]!.facts[0]!); },
      (input: InvestigationDetail) => { input.pageCount = 2; },
      (input: InvestigationDetail) => { input.totalNodes = 2; },
      (input: InvestigationDetail) => { input.omittedCrossPageEdges = 1; },
    ];
    for (const mutate of cases) { const input = detail(); mutate(input); expect(() => buildInvestigationReport(input)).toThrow("Invalid investigation report inputs."); }
    expect(() => buildInvestigationReport(detail(), { includeIdentifiers: "yes" } as never)).toThrow("Invalid investigation report inputs.");
  });
  it("report schema rejects unknown fields, dangling aliases and unselected optional data", () => {
    const result = buildInvestigationReport(detail());
    expect(InvestigationReportSchema.safeParse({ ...result, private: privateText }).success).toBe(false);
    expect(InvestigationReportSchema.safeParse({ ...result, edges: [{ from: "item-001", to: "item-099", kind: "cited_evidence" }] }).success).toBe(false);
    expect(InvestigationReportSchema.safeParse({ ...result, nodes: [{ ...result.nodes[0], reference: { recordId: identifier, recordRevision: "A".repeat(32) } }] }).success).toBe(false);
  });
  it("rejects contradictory replay coverage rather than exporting a false complete scope", () => {
    const input = detail();
    input.replayScope = { supplied: 1, compared: 2, completeLocalCollection: false };
    expect(() => buildInvestigationReport(input)).toThrow("Invalid investigation report inputs.");
    input.replayScope = { supplied: 2, compared: 1, completeLocalCollection: true };
    expect(() => buildInvestigationReport(input)).toThrow("Invalid investigation report inputs.");
  });
});

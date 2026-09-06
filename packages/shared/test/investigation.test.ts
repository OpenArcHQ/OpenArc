import { describe, expect, it } from "vitest";
import { buildInvestigationIndex, filterInvestigations, buildInvestigationDetail, InvestigationError } from "../src/investigation.js";
import { WorkspaceRecordSchema, type WorkspaceRecord } from "../src/vault.js";
import { ARC_TESTNET } from "../src/network.js";
import { M01_FIXTURES } from "../src/fixtures.js";
import { gatewayObservation, x402Bundle } from "./x402-fixtures.js";
import { jobTestEnvelope } from "../../../test-fixtures/job-evidence.js";

const id = (n: number) => `11111111-1111-4111-8111-${n.toString().padStart(12, "0")}`;
const at = "2026-09-06T12:00:00Z";
const options = { evaluatedAt: "2026-09-07T12:00:00Z" };
const base = (n: number) => ({ recordSchema: "openarc.workspace-record.v1", recordId: id(n), recordRevision: "A".repeat(32), createdAt: at, updatedAt: at });
const parse = (value: unknown) => WorkspaceRecordSchema.parse(value);
const profile = () => parse({ ...base(1), kind: "agent_profile", agentId: `agent_${"1".repeat(32)}`, displayName: "PRIVATE_LABEL_CANARY",
  wallets: [], frameworkLabel: null, purposeNote: null, policyRecordIds: [] });
const event = (n = 1) => ({ eventId: id(n), actionId: `action-${n}`, occurredAt: at, network: ARC_TESTNET.caip2,
  asset: ARC_TESTNET.contracts.usdc, decimals: 6, payer: `0x${"1".repeat(40)}`, recipient: `0x${"2".repeat(40)}`,
  amountBaseUnits: "9007199254740993", reportedStatus: "attempted", contract: null, serviceDigest: null,
  authorizationNonce: null, authorizationDomainDigest: null, approval: "not_supplied" });
const report = (n = 2, events = [event()]) => parse({ ...base(n), recordSchema: "openarc.agent-import-record.v1", kind: "agent_import",
  report: { schemaVersion: "openarc.agent-import.v1", importId: id(n), capturedAt: at, connectorId: "local:agent", authentication: "not_verified", events },
  linkedAgentProfileRecordId: id(1), linkBasis: "explicit_local_confirmation" });
const policy = () => parse({ ...base(3), recordSchema: "openarc.agent-policy-record.v2", kind: "agent_monitoring_policy", policy: {
  schemaVersion: "openarc.agent-policy.v2", policyId: id(3), revision: 1, name: "PRIVATE_POLICY_CANARY", agentProfileRecordId: id(1), enabled: true,
  validAfter: "2026-09-01T00:00:00Z", validBefore: "2026-10-01T00:00:00Z", perActionLimit: "9007199254740992", dailyLimit: "9007199254740994",
  allowRecipients: [], blockRecipients: [], allowContracts: [], blockContracts: [], allowServices: [], blockServices: [], requireApproval: false, mode: "local_monitoring_only" } });
const bundle = (n = 10) => parse({ ...base(n), recordSchema: "openarc.x402-bundle-record.v1", kind: "x402_bundle", bundle: { ...x402Bundle(), bundleId: id(n) } });
const gateway = (n = 11, linked: string | null = id(10)) => parse({ ...base(n), recordSchema: "openarc.gateway-observation-record.v1", kind: "gateway_observation",
  permissionReceiptId: id(9000 + n), linkedBundleRecordId: linked, linkBasis: linked ? "explicit_local_confirmation" : null, observation: gatewayObservation() });
const root = (records: WorkspaceRecord[], kind: string, ordinal?: number) => buildInvestigationIndex(records).find((item) => item.kind === kind && (ordinal === undefined || item.reference.eventIndex === ordinal))!.reference;
function fixtureRecords(index: number, deny = false): WorkspaceRecord[] {
  const fixture = M01_FIXTURES[index]!;
  return [parse({ ...base(1), kind: "agent_profile", agentId: fixture.action.agentId, displayName: "fixture",
    wallets: [], frameworkLabel: null, purposeNote: null, policyRecordIds: fixture.policies.map((_, i) => id(30 + i)) }),
  parse({ ...base(2), kind: "action_envelope", action: fixture.action }),
  ...fixture.evidence.map((evidence, i) => parse({ ...base(10 + i), kind: "evidence_record", evidence })),
  ...fixture.policies.map((policy, i) => parse({ ...base(30 + i), kind: "monitoring_policy", revision: 1,
    policy: { ...policy, ...(deny ? { maximumAmountBaseUnits: "0" } : {}) } }))]
    .map((record) => ({ ...record, createdAt: fixture.result.evaluatedAt, updatedAt: fixture.result.evaluatedAt }));
}

describe("M09 bounded local investigation projection", () => {
  it("keeps report variants separately addressable and cheap conflicts distinct from policy evaluation", () => {
    const records = [profile(), report(2, [event(), { ...event(), amountBaseUnits: "1" }])];
    const index = buildInvestigationIndex(records);
    expect(index).toHaveLength(2); expect(new Set(index.map((item) => item.key)).size).toBe(2);
    expect(index.map((item) => item.status)).toEqual(["conflicting", "conflicting"]);
    const detail = buildInvestigationDetail(records, index[1]!.reference, options);
    expect(detail.comparisons).toEqual([]);
    expect(detail.nodes.find((node) => node.reference.eventIndex === 1)?.facts).toContainEqual({ label: "amountBaseUnits", value: "1", category: "amount", side: "observed" });
    expect(detail.nodes.find((node) => node.reference.eventIndex === 1)?.status).toBe("conflicting");
  });
  it("fails generically for stale, forged, extra or missing event references", () => {
    const records = [profile(), report()]; const ref = root(records, "agent_import");
    for (const change of [{ recordRevision: "B".repeat(32) }, { eventIndex: 1 }, { eventId: id(999) }, { connectorId: "other" }, { extra: "PRIVATE_SECRET" }, { eventIndex: undefined }]) {
      expect(() => buildInvestigationDetail(records, { ...ref, ...change }, options)).toThrow(InvestigationError);
    }
    expect(() => buildInvestigationDetail(records, ref, { evaluatedAt: "2026-09-06T11:59:59.999999999Z" })).toThrow(InvestigationError);
  });
  it("cannot evaluate a report before capture merely because its events are historical", () => {
    const old = event(); old.occurredAt = "2026-09-05T12:00:00Z";
    const records = [profile(), report(2, [old])];
    expect(() => buildInvestigationDetail(records, root(records, "agent_import"), { evaluatedAt: "2026-09-06T11:59:59Z" })).toThrow(InvestigationError);
  });
  it("equivalent fractional timestamp spellings do not create false source conflicts", () => {
    const records = [profile(), report(2, [event(), { ...event(), occurredAt: at.replace("Z", ".000000000Z") }])];
    expect(buildInvestigationIndex(records).every((item) => item.status === "needs_review")).toBe(true);
    const shifted = [profile(), report(2, [event(), { ...event(), occurredAt: "2026-09-06T11:59:59.999999999Z" }])];
    expect(buildInvestigationIndex(shifted).every((item) => item.status === "conflicting")).toBe(true);
  });
  it("private labels that resemble timestamps and identifiers remain private", () => {
    const agent = { ...profile(), displayName: at } as WorkspaceRecord;
    const records = [agent, report(), policy()];
    const result = buildInvestigationDetail(records, root(records, "agent_import"), { ...options, policyRecordId: id(3) });
    expect(result.nodes.find((node) => node.reference.kind === "agent_profile")!.facts.find((fact) => fact.label === "displayName")!.category).toBe("local_private");
    expect(result.nodes.find((node) => node.reference.kind === "agent_monitoring_policy")!.facts.find((fact) => fact.label === "name")!.category).toBe("local_private");
  });
  it("enforces query, strict filter, page bounds and deterministic sorted pagination", () => {
    const records = Array.from({ length: 30 }, (_, n) => bundle(n + 10)); const entries = buildInvestigationIndex(records);
    const first = filterInvestigations(entries, {}), second = filterInvestigations([...entries].reverse(), { page: 2 });
    expect(first.entries).toHaveLength(25); expect(second.entries).toHaveLength(5); expect(first.total).toBe(30);
    expect(first.entries.map((item) => item.key)).toEqual(filterInvestigations([...entries].reverse()).entries.map((item) => item.key));
    expect(filterInvestigations(entries, { query: "IMPORTED PAYMENT", sourceClass: "owner_supplied_unauthenticated", exceptionsOnly: true }).total).toBe(30);
    for (const filter of [{ query: "x".repeat(161) }, { page: 0 }, { page: 3 }, { page: 1.5 }, { status: "executed" }, { unknown: true }]) {
      expect(() => filterInvestigations(entries, filter as never)).toThrow(InvestigationError);
    }
    expect(() => filterInvestigations([...entries, entries[0]!])).toThrow(InvestigationError);
  });
  it("uses unchanged M08 rules only after explicit applicable policy selection with exact amounts", () => {
    const records = [profile(), report(), policy()];
    expect(buildInvestigationDetail(records, root(records, "agent_import"), options).comparisons).toEqual([]);
    const result = buildInvestigationDetail(records, root(records, "agent_import"), { ...options, policyRecordId: id(3) });
    expect(result.comparisons[0]!.ruleVersion).toBe("openarc.agent-policy-rules.v1");
    expect(result.comparisons[0]!.findings).toContain("PER_ACTION_LIMIT_EXCEEDED");
    expect(result.comparisons[0]!.findings).toContain("DAILY_HISTORY_INCOMPLETE");
    expect(result.comparisons[0]!.limitations.join(" ")).toContain("not confirmed spend");
    expect(() => buildInvestigationDetail(records, root(records, "agent_import"), { ...options, policyRecordId: id(999) })).toThrow(InvestigationError);
  });
  it("retains all supplied policy evidence through 64-node pages and cross-page edge counts", () => {
    const reports = Array.from({ length: 8 }, (_, i) => report(10 + i, Array.from({ length: 64 }, (_, j) => event(i * 64 + j + 1))));
    const records = [profile(), policy(), ...reports]; const ref = root(records, "agent_import", 0);
    const first = buildInvestigationDetail(records, ref, { ...options, policyRecordId: id(3) });
    expect(first.totalNodes).toBe(514); expect(first.totalEdges).toBe(513); expect(first.pageCount).toBe(9);
    const pages = Array.from({ length: first.pageCount }, (_, i) => buildInvestigationDetail(records, ref, { ...options, policyRecordId: id(3), page: i + 1 }));
    expect(new Set(pages.flatMap((page) => page.nodes.map((node) => node.key))).size).toBe(514);
    for (const page of pages) {
      expect(page.nodes.length).toBeLessThanOrEqual(64); expect(page.edges.length).toBeLessThanOrEqual(128);
      const keys = new Set(page.nodes.map((node) => node.key)); expect(page.edges.every((edge) => keys.has(edge.from) && keys.has(edge.to))).toBe(true);
      expect(page.omittedCrossPageEdges).toBe(page.totalEdges - page.edges.length);
    }
    expect(first.comparisons[0]!.citations).toHaveLength(513);
  });
  it("never joins a same-transfer Gateway observation without an explicit stored link", () => {
    const records = [bundle(), gateway(11, null)]; const detail = buildInvestigationDetail(records, root(records, "x402_bundle"), options);
    expect(detail.nodes).toHaveLength(1); expect(detail.edges).toEqual([]);
    expect(detail.comparisons[0]!.findings).toContain("GATEWAY_NOT_OBSERVED");
    expect(buildInvestigationIndex(records).map((item) => item.sourceClass)).toContain("named_testnet_observation");
  });
  it("preserves every explicit Gateway observation without choosing a winner", () => {
    const records = [bundle(), ...Array.from({ length: 70 }, (_, i) => gateway(i + 20))];
    const result = buildInvestigationDetail(records, root(records, "x402_bundle"), options);
    const second = buildInvestigationDetail(records, root(records, "x402_bundle"), { ...options, page: 2 });
    expect(buildInvestigationDetail([...records].reverse(), root(records, "x402_bundle"), options)).toEqual(result);
    expect(result.totalNodes).toBe(71); expect(result.totalEdges).toBe(70);
    expect(result.comparisons.length + second.comparisons.length).toBe(70);
    expect(result.comparisons.every((comparison) => comparison.limitations.join(" ").includes("individual-payment"))).toBe(true);
    expect(new Set([...result.nodes, ...second.nodes].map((node) => node.key)).size).toBe(71);
  });
  it("classifies named failures without promoting them to successful observation or inferring live health", () => {
    const failed = gateway(); if (failed.kind !== "gateway_observation") throw new Error();
    const records = [bundle(), { ...failed, observation: { ...failed.observation, transfer: { ...failed.observation.transfer, status: "failed" as const } } }];
    expect(buildInvestigationIndex(records).find((item) => item.kind === "gateway_observation")!.status).toBe("reported_failure");
    const bad = { ...failed, observation: { ...failed.observation, source: { ...failed.observation.source, origin: "https://arbitrary.test" } } };
    expect(() => buildInvestigationIndex([bundle(), bad as never])).toThrow(InvestigationError);
    expect(() => buildInvestigationIndex([gateway()])).toThrow(InvestigationError);
  });
  it("retains separately linked job observations and never reclassifies ISO job descriptions", () => {
    const fixtures = fixtureRecords(0);
    const observation = jobTestEnvelope().data;
    const job = (n: number) => parse({ ...base(n), recordSchema: "openarc.job-observation-record.v1", kind: "job_observation",
      permissionReceiptId: id(999), linkedActionRecordId: id(2), linkBasis: "explicit_local_confirmation",
      observation: { ...observation, description: at } });
    const records = [...fixtures, job(90), job(91)];
    const detail = buildInvestigationDetail(records, root(records, "action_envelope"), options);
    expect(detail.nodes.filter((node) => node.reference.kind === "job_observation")).toHaveLength(2);
    expect(detail.edges.filter((edge) => edge.kind === "explicit_local_association" &&
      detail.nodes.find((node) => node.key === edge.to)?.reference.kind === "job_observation")).toHaveLength(2);
    for (const node of detail.nodes.filter((node) => node.reference.kind === "job_observation")) {
      expect(node.sourceClass).toBe("named_testnet_observation");
      expect(node.facts.find((fact) => fact.label === "description")).toEqual({ label: "description", value: at, category: "local_private", side: "observed" });
    }
  });
  it("accepts the full6602-record bound without mutating the input and rejects6603", () => {
    const records = Array.from({ length: 6602 }, (_, n) => bundle(10 + n));
    const first = records[0], last = records.at(-1);
    const index = buildInvestigationIndex(records);
    expect(index).toHaveLength(6602); expect(records[0]).toBe(first); expect(records.at(-1)).toBe(last);
    expect(filterInvestigations(index, { page: 265 }).entries).toHaveLength(2);
    expect(() => buildInvestigationIndex([...records, bundle(9000)])).toThrow(InvestigationError);
  });
  it("makes over-64 bundle replay coverage unavailable instead of silently truncating collection", () => {
    const records = Array.from({ length: 65 }, (_, i) => bundle(i + 10));
    const result = buildInvestigationDetail(records, root(records, "x402_bundle"), options);
    expect(result.replayScope).toEqual({ supplied: 65, compared: 1, completeLocalCollection: false });
    expect(result.comparisons[0]!.findings).toContain("COLLECTION_REPLAY_COVERAGE_UNAVAILABLE");
    const bounded = buildInvestigationDetail(records.slice(0, 64), root(records, "x402_bundle"), options);
    expect(bounded.replayScope).toEqual({ supplied: 64, compared: 64, completeLocalCollection: true });
  });
  it("recomputes M01 synthetic comparison without trusting cached result or widening provenance", () => {
    const fixture = M01_FIXTURES[0]!;
    const agent = parse({ ...base(1), kind: "agent_profile", agentId: fixture.action.agentId, displayName: "fixture",
      wallets: [], frameworkLabel: null, purposeNote: null, policyRecordIds: fixture.policies.map((_, i) => id(30 + i)) });
    const records = [agent, parse({ ...base(2), kind: "action_envelope", action: fixture.action }),
      ...fixture.evidence.map((evidence, i) => parse({ ...base(10 + i), kind: "evidence_record", evidence })),
      ...fixture.policies.map((policy, i) => parse({ ...base(30 + i), kind: "monitoring_policy", revision: 1, policy }))];
    const result = buildInvestigationDetail(records, root(records, "action_envelope"), options);
    expect(result.comparisons[0]!.ruleVersion).toBe("openarc.reconcile.v1");
    expect(result.nodes.filter((node) => node.reference.kind !== "agent_profile").every((node) => node.sourceClass === "synthetic_fixture")).toBe(true);
    expect(result.edges.every((edge) => ["cited_evidence", "local_policy_comparison", "explicit_local_association"].includes(edge.kind))).toBe(true);
    expect(result.comparisons[0]!.citations.map((ref) => ref.recordId)).toContain(id(1));
    for (const [i] of fixture.policies.entries()) expect(result.comparisons[0]!.citations.map((ref) => ref.recordId)).toContain(id(30 + i));
    expect(result.nodes.filter((node) => node.reference.kind === "monitoring_policy").flatMap((node) => node.facts)
      .filter((fact) => fact.side !== "context").every((fact) => fact.side === "expected")).toBe(true);
    const cached = records[1]!;
    if (cached.kind !== "action_envelope") throw new Error();
    const changed = [...records]; changed[1] = { ...cached, action: { ...cached.action, policyEvaluation: fixture.result.policyEvaluation,
      reconciliation: { ...fixture.result, limitations: ["PRIVATE_CACHED_CANARY"] } } };
    expect(buildInvestigationDetail(changed, root(changed, "action_envelope"), options).comparisons).toEqual(result.comparisons);
  });
  it("fails explicitly on capacity, duplicate IDs, schema violations and dangling associations", () => {
    const records = [profile(), report()];
    expect(() => buildInvestigationIndex([...records, records[1]!])).toThrow(InvestigationError);
    expect(() => buildInvestigationIndex([report()])).toThrow(InvestigationError);
    expect(() => buildInvestigationIndex([{ ...profile(), secret: "PRIVATE_CANARY" } as never])).toThrow("Investigation input is unavailable or invalid.");
    expect(() => buildInvestigationIndex(Array.from({ length: 6603 }, () => profile()))).toThrow(InvestigationError);
    const overflow = Array.from({ length: 9 }, (_, i) => report(i + 10, Array.from({ length: 64 }, (_, j) => event(i * 64 + j + 1))));
    expect(() => buildInvestigationIndex([profile(), ...overflow])).toThrow(InvestigationError);
  });
  it("only a freshly RECONCILED synthetic result can be called complete; denied, refunded and failed cannot", () => {
    const complete = fixtureRecords(0), denied = fixtureRecords(0, true), failed = fixtureRecords(4), refunded = fixtureRecords(5);
    expect(buildInvestigationDetail(complete, root(complete, "action_envelope"), { evaluatedAt: M01_FIXTURES[0]!.result.evaluatedAt }).comparisons[0]!.status).toBe("synthetic_complete");
    expect(buildInvestigationDetail(denied, root(denied, "action_envelope"), options).comparisons[0]!.status).not.toBe("synthetic_complete");
    expect(buildInvestigationDetail(failed, root(failed, "action_envelope"), options).comparisons[0]!.status).toBe("reported_failure");
    expect(buildInvestigationDetail(refunded, root(refunded, "action_envelope"), options).comparisons[0]!.status).not.toBe("synthetic_complete");
    expect(() => buildInvestigationDetail(complete.filter((record) => record.recordId !== id(10)), root(complete, "action_envelope"), options)).toThrow(InvestigationError);
  });
  it("keeps all128 canonical movement facts within the2048 bound and does not infer payment links", () => {
    const address = `0x${"1".repeat(40)}`, hash = `0x${"a".repeat(64)}`;
    const native = { baseUnits: "1000000000000000000", decimals: 18, decimal: "1" }, erc20 = { baseUnits: "1000000", decimals: 6, decimal: "1" };
    const observation = { schemaVersion: "openarc.arc-transaction-evidence.v1", network: ARC_TESTNET.caip2,
      transaction: { hash, blockNumber: "100", blockHash: hash, transactionIndex: "0", from: address, to: address, nativeValue: native },
      receipt: { status: "success", gasUsed: "1", effectiveGasPrice: native, fee: native },
      anchor: { blockNumber: "100", blockHash: hash, blockTimestamp: at, finality: "deterministic", confirmations: "1" },
      movements: Array.from({ length: 128 }, (_, i) => ({ classification: "canonical_eip7708_usdc", emitter: ARC_TESTNET.usdcSystemEmitter,
        logIndex: String(i * 2), from: address, to: address, amount: native,
        erc20Corroboration: { emitter: ARC_TESTNET.contracts.usdc, logIndex: String(i * 2 + 1), amount: erc20 } })),
      coverage: { totalLogs: 256, canonicalMovements: 128, corroboratedMovements: 128, unsupportedLogs: 0, completeForUsdcTransfers: true },
      source: { sourceId: "arc_primary_rpc", origin: ARC_TESTNET.rpcHttp, explorerOrigin: ARC_TESTNET.explorerOrigin,
        network: ARC_TESTNET.caip2, sourceRevision: ARC_TESTNET.sourceRevision, observedAt: at, adapterVersion: "openarc.arc-observation.m04.v1" },
      limitations: ["This is a read-only observation of one Arc Testnet transaction and receipt.",
        "EIP-7708 system events are canonical; matching ERC-20 events are corroboration, not additional movements.",
        "Transaction inclusion does not prove intent, authorization, fulfillment, or service quality."] };
    const records = [parse({ ...base(1), recordSchema: "openarc.arc-observation-record.v1", kind: "arc_observation", permissionReceiptId: id(999), observation }), bundle()];
    const detail = buildInvestigationDetail(records, root(records, "arc_observation"), options);
    expect(detail.nodes).toHaveLength(1); expect(detail.edges).toEqual([]); expect(detail.comparisons).toEqual([]);
    expect(detail.nodes[0]!.facts.length).toBeGreaterThan(128); expect(detail.nodes[0]!.facts.length).toBeLessThanOrEqual(2048);
    expect(detail.nodes[0]!.facts.some((fact) => fact.label === "movements.127.amount.baseUnits" && fact.value === native.baseUnits)).toBe(true);
  });
});

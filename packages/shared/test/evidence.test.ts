import { describe, expect, it } from "vitest";

import {
  ActionEnvelopeSchema,
  ActionTransitionSchema,
  AllowedActionStateEdges,
  AttentionActionStateSchema,
  EvidenceEngineError,
  EvidenceFixtureSchema,
  EvidenceRecordSchema,
  IsoTimestampSchema,
  M01_FIXTURES,
  MonitoringPolicySchema,
  PolicyEvaluationSchema,
  PositiveActionStateSchema,
  ReconciliationResultSchema,
  reconcileAction,
  sortEvidence,
  stateHistoryIssues,
} from "../src/index.js";
import type { ActionState } from "../src/index.js";

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const complete = M01_FIXTURES.find((fixture) => fixture.fixtureId === "complete")!;
const reconciliationInput = (
  fixture: typeof complete,
  overrides: Partial<{
    action: unknown;
    evidence: unknown;
    policies: unknown;
    evaluatedAt: unknown;
  }> = {},
) => ({
  action: fixture.action,
  evidence: fixture.evidence,
  policies: fixture.policies,
  evaluatedAt: fixture.evaluatedAt,
  ...overrides,
});

describe("M01 evidence fixtures", () => {
  it("reconciles every frozen fixture to its declared state", () => {
    expect(M01_FIXTURES.map((fixture) => fixture.fixtureId)).toEqual([
      "complete",
      "missing",
      "conflict",
      "expired",
      "failed",
      "refunded",
    ]);

    for (const fixture of M01_FIXTURES) {
      expect(Object.isFrozen(fixture)).toBe(true);
      expect(Object.isFrozen(fixture.evidence)).toBe(true);
      const result = reconcileAction(reconciliationInput(fixture));
      expect(result).toEqual(fixture.result);
      expect(result.state).toBe(fixture.expectedState);
      expect(result.limitations.length).toBeGreaterThan(0);
      expect(result.evidenceIds).toEqual(
        fixture.evidence.map((record) => record.evidenceId).sort((left, right) => {
          const leftRecord = fixture.evidence.find((record) => record.evidenceId === left)!;
          const rightRecord = fixture.evidence.find((record) => record.evidenceId === right)!;
          const leftTime = leftRecord.occurredAt ?? leftRecord.observedAt;
          const rightTime = rightRecord.occurredAt ?? rightRecord.observedAt;
          return leftTime.localeCompare(rightTime) || left.localeCompare(right);
        }),
      );
    }
  });

  it("is deterministic when the workspace evidence order changes", () => {
    const reversed = reconcileAction(
      reconciliationInput(complete, { evidence: [...complete.evidence].reverse() }),
    );
    expect(reversed).toEqual(complete.result);
  });

  it("keeps authorization, settlement, fulfillment, and refund meanings separate", () => {
    expect(M01_FIXTURES.find((fixture) => fixture.fixtureId === "missing")?.result.state).toBe(
      "INTENT_NOT_SUPPLIED",
    );
    expect(M01_FIXTURES.find((fixture) => fixture.fixtureId === "failed")?.result.state).toBe(
      "FAILED",
    );
    expect(M01_FIXTURES.find((fixture) => fixture.fixtureId === "refunded")?.result.state).toBe(
      "REFUNDED",
    );
  });
});

describe("append-only action states", () => {
  const actionWithStates = (states: unknown[]) => {
    const action = clone(complete.action);
    action.states = states as typeof action.states;
    return action;
  };

  const evidenceIdByState: Partial<Record<ActionState, string[]>> = {
    PERMITTED: complete.action.intentEvidenceIds,
    ATTEMPTED: complete.action.attemptEvidenceIds,
    AUTHORIZED: [complete.evidence.find((record) => record.evidenceType === "authorization")!.evidenceId],
    FULFILLED: complete.action.fulfillmentEvidenceIds,
    SETTLED: [complete.evidence.find((record) => record.evidenceType === "settlement")!.evidenceId],
  };

  it("accepts the complete fixture path with required relationship citations", () => {
    expect(ActionEnvelopeSchema.parse(complete.action).states.map((transition) => transition.state)).toEqual([
      "PROPOSED", "PERMITTED", "ATTEMPTED", "AUTHORIZED", "FULFILLED", "SETTLED",
    ]);
  });

  it("binds the first PROPOSED transition to the exact creation instant", () => {
    const impossible = clone(complete.action);
    impossible.createdAt = "2026-09-01T13:00:00Z";
    expect(() => ActionEnvelopeSchema.parse(impossible)).toThrow(/at action creation/u);

    const equivalent = clone(complete.action);
    equivalent.createdAt = "2026-09-01T11:59:00.000000000Z";
    expect(ActionEnvelopeSchema.parse(equivalent).states[0]!.at).toBe("2026-09-01T11:59:00Z");
  });

  it("freezes and exercises the complete pairwise state-edge matrix", () => {
    const expected: Record<ActionState, readonly ActionState[]> = {
      PROPOSED: ["PERMITTED", "ATTEMPTED", "DENIED_BY_POLICY", "INTENT_NOT_SUPPLIED", "UNSUPPORTED"],
      PERMITTED: ["ATTEMPTED", "DENIED_BY_POLICY", "EXPIRED", "INTENT_NOT_SUPPLIED", "UNSUPPORTED"],
      ATTEMPTED: ["AUTHORIZED", "FULFILLED", "FAILED", "EXPIRED", "DENIED_BY_POLICY", "FULFILLMENT_UNVERIFIED", "SETTLEMENT_UNVERIFIED", "INTENT_NOT_SUPPLIED", "CONFLICTING_EVIDENCE", "UNSUPPORTED"],
      AUTHORIZED: ["FULFILLED", "SETTLING", "SETTLED", "FAILED", "EXPIRED", "FULFILLMENT_UNVERIFIED", "SETTLEMENT_UNVERIFIED", "INTENT_NOT_SUPPLIED", "CONFLICTING_EVIDENCE", "UNSUPPORTED"],
      FULFILLED: ["SETTLING", "SETTLED", "RECONCILED", "FAILED", "SETTLEMENT_UNVERIFIED", "INTENT_NOT_SUPPLIED", "CONFLICTING_EVIDENCE"],
      SETTLING: ["SETTLED", "FAILED", "EXPIRED", "SETTLEMENT_UNVERIFIED", "CONFLICTING_EVIDENCE"],
      SETTLED: ["RECONCILED", "REFUNDED", "FULFILLMENT_UNVERIFIED", "INTENT_NOT_SUPPLIED", "CONFLICTING_EVIDENCE"],
      RECONCILED: ["REFUNDED", "CONFLICTING_EVIDENCE"],
      DENIED_BY_POLICY: [],
      EXPIRED: [],
      FAILED: [],
      REFUNDED: [],
      CONFLICTING_EVIDENCE: [],
      FULFILLMENT_UNVERIFIED: [],
      SETTLEMENT_UNVERIFIED: [],
      INTENT_NOT_SUPPLIED: [],
      UNSUPPORTED: [],
    };
    expect(AllowedActionStateEdges).toEqual(expected);
    const allStates = [...PositiveActionStateSchema.options, ...AttentionActionStateSchema.options];
    for (const from of allStates) {
      for (const to of allStates) {
        const issues = stateHistoryIssues([
          { sequence: 1, state: from, at: "2026-09-01T12:00:00Z", evidenceIds: from === "PROPOSED" ? [] : [complete.evidence[0]!.evidenceId] },
          { sequence: 2, state: to, at: "2026-09-01T12:01:00Z", evidenceIds: to === "PROPOSED" ? [] : [complete.evidence[0]!.evidenceId] },
        ]);
        const rejectedEdge = issues.some((issue) => issue.includes(`${from} -> ${to}`));
        expect(rejectedEdge, `${from} -> ${to}`).toBe(!expected[from].includes(to));
      }
    }

    expect(() => ActionTransitionSchema.parse({
      sequence: 1,
      state: "PROPOSED",
      at: "2026-09-01T12:00:00Z",
      evidenceIds: [complete.evidence[0]!.evidenceId],
    })).toThrow(/must not cite evidence/u);
    for (const state of allStates.filter((state) => state !== "PROPOSED")) {
      expect(() => ActionTransitionSchema.parse({
        sequence: 1,
        state,
        at: "2026-09-01T12:00:00Z",
        evidenceIds: [],
      }), state).toThrow(/must cite supporting evidence/u);
    }
  });

  it.each([
    [
      { sequence: 1, state: "AUTHORIZED", at: "2026-09-01T12:01:00Z", evidenceIds: [] },
      { sequence: 2, state: "ATTEMPTED", at: "2026-09-01T12:02:00Z", evidenceIds: [] },
    ],
    [
      { sequence: 1, state: "PROPOSED", at: "2026-09-01T12:02:00Z", evidenceIds: [] },
      { sequence: 2, state: "ATTEMPTED", at: "2026-09-01T12:01:00Z", evidenceIds: evidenceIdByState.ATTEMPTED! },
    ],
    [
      { sequence: 1, state: "PROPOSED", at: "2026-09-01T12:00:00Z", evidenceIds: [] },
      { sequence: 3, state: "ATTEMPTED", at: "2026-09-01T12:01:00Z", evidenceIds: [] },
    ],
    [
      { sequence: 1, state: "FAILED", at: "2026-09-01T12:00:00Z", evidenceIds: [] },
      { sequence: 2, state: "SETTLED", at: "2026-09-01T12:01:00Z", evidenceIds: [] },
    ],
    [{ sequence: 1, state: "AUTHORIZED", at: "2026-09-01T12:00:00Z", evidenceIds: [] }],
  ])("rejects a non-monotonic or non-terminal history", (states) => {
    expect(() => ActionEnvelopeSchema.parse(actionWithStates(states))).toThrow();
  });

  it("compares fractional UTC instants chronologically instead of lexically", () => {
    const action = actionWithStates([
      { sequence: 1, state: "PROPOSED", at: "2026-09-01T12:00:00.0002Z", evidenceIds: [] },
      { sequence: 2, state: "ATTEMPTED", at: "2026-09-01T12:00:00.0001Z", evidenceIds: evidenceIdByState.ATTEMPTED! },
    ]);
    expect(() => ActionEnvelopeSchema.parse(action)).toThrow(/timestamps must be monotonic/u);

    const later = clone(complete.evidence[0]!);
    later.occurredAt = "2026-09-01T12:00:00.0002Z";
    const earlier = clone(complete.evidence[1]!);
    earlier.occurredAt = "2026-09-01T12:00:00.0001Z";
    expect(sortEvidence([later, earlier]).map((record) => record.evidenceId)).toEqual([
      earlier.evidenceId,
      later.evidenceId,
    ]);
  });

  it("bounds UTC timestamp precision and length", () => {
    expect(IsoTimestampSchema.parse("2026-09-01T12:00:00.123456789Z")).toBe(
      "2026-09-01T12:00:00.123456789Z",
    );
    expect(() => IsoTimestampSchema.parse("2026-09-01T12:00:00.1234567890Z")).toThrow(
      /at most 9 fractional-second digits|at most 30 characters/u,
    );
    expect(() =>
      IsoTimestampSchema.parse(`2026-09-01T12:00:00.${"1".repeat(100_000)}Z`),
    ).toThrow();
  });

  it("rejects skipped states, empty citations, and relationship-incompatible citations", () => {
    const skipped = actionWithStates([
      { sequence: 1, state: "PROPOSED", at: "2026-09-01T12:00:00Z", evidenceIds: [] },
      { sequence: 2, state: "SETTLED", at: "2026-09-01T12:01:00Z", evidenceIds: evidenceIdByState.SETTLED! },
    ]);
    expect(() => ActionEnvelopeSchema.parse(skipped)).toThrow(/not allowed/u);

    const empty = clone(complete.action);
    empty.states.find((transition) => transition.state === "AUTHORIZED")!.evidenceIds = [];
    expect(() => ActionEnvelopeSchema.parse(empty)).toThrow(/must cite supporting evidence/u);

    const wrong = clone(complete.action);
    wrong.states.find((transition) => transition.state === "SETTLED")!.evidenceIds = complete.action.intentEvidenceIds;
    expect(() => ActionEnvelopeSchema.parse(wrong)).toThrow(/outside its permitted action relationship/u);
  });

  it("accepts only semantically supported SETTLING and RECONCILED transitions", () => {
    const pendingEvidence = clone(complete.evidence);
    const pendingSettlement = pendingEvidence.find((record) => record.evidenceType === "settlement")!;
    if (pendingSettlement.evidenceType !== "settlement") throw new Error("Expected settlement");
    pendingSettlement.payload.settlementStatus = "pending";
    const pendingAction = clone(complete.action);
    pendingAction.states.at(-1)!.state = "SETTLING";
    const pendingResult = reconcileAction(
      reconciliationInput(complete, { action: pendingAction, evidence: pendingEvidence }),
    );
    expect(pendingResult.state).toBe("SETTLEMENT_UNVERIFIED");
    expect(pendingResult.gaps.map((gap) => gap.code)).toContain("SETTLEMENT_PENDING");

    const reconciledAction = clone(complete.action);
    const fulfillmentId = complete.action.fulfillmentEvidenceIds[0]!;
    const settlementId = complete.evidence.find((record) => record.evidenceType === "settlement")!.evidenceId;
    reconciledAction.states.push({
      sequence: reconciledAction.states.length + 1,
      state: "RECONCILED",
      at: "2026-09-01T12:08:00Z",
      evidenceIds: [fulfillmentId, settlementId],
    });
    expect(reconcileAction(reconciliationInput(complete, { action: reconciledAction })).state).toBe(
      "RECONCILED",
    );
  });

  it("rejects a terminal action conclusion that contradicts reconciliation", () => {
    const action = clone(complete.action);
    const settlementId = complete.evidence.find((record) => record.evidenceType === "settlement")!.evidenceId;
    action.states.push({
      sequence: action.states.length + 1,
      state: "INTENT_NOT_SUPPLIED",
      at: "2026-09-01T12:08:00Z",
      evidenceIds: [settlementId],
    });
    expect(() => reconcileAction(reconciliationInput(complete, { action }))).toThrowError(
      /contradicts reconciliation state/u,
    );
  });
});

describe("fail-closed reconciliation", () => {
  it("rejects unknown schema versions and malformed records", () => {
    const unknown = clone(complete.evidence[0]);
    (unknown as { schemaVersion: string }).schemaVersion = "openarc.evidence.v2";
    expect(() => EvidenceRecordSchema.parse(unknown)).toThrow();

    const oversized = clone(complete.evidence[0]);
    oversized.limitations = ["x".repeat(241)];
    expect(() => EvidenceRecordSchema.parse(oversized)).toThrow();

    const unsupportedWithoutLimit = clone(complete.evidence[0]);
    unsupportedWithoutLimit.limitations = [];
    expect(() => EvidenceRecordSchema.parse(unsupportedWithoutLimit)).toThrow();

    const unsafeReference = clone(complete.evidence[0]);
    unsafeReference.source.reference = "https://user:password@example.com/evidence";
    expect(() => EvidenceRecordSchema.parse(unsafeReference)).toThrow();

    const impossibleObservation = clone(complete.evidence[0]!);
    impossibleObservation.observedAt = "2026-09-01T12:00:00Z";
    impossibleObservation.occurredAt = "2026-09-01T12:00:01Z";
    expect(() => EvidenceRecordSchema.parse(impossibleObservation)).toThrow(
      /cannot occur after it was observed/u,
    );
  });

  it("rejects inverted validity windows and false source authority", () => {
    const authorization = clone(
      complete.evidence.find((record) => record.evidenceType === "authorization")!,
    );
    if (authorization.evidenceType !== "authorization") throw new Error("Expected authorization");
    authorization.payload.validAfter = "2026-09-01T13:00:00Z";
    authorization.payload.validBefore = "2026-09-01T11:00:00Z";
    expect(() => EvidenceRecordSchema.parse(authorization)).toThrow(/validAfter must precede/u);

    const settlement = clone(
      complete.evidence.find((record) => record.evidenceType === "settlement")!,
    );
    settlement.source = {
      ...settlement.source,
      kind: "owner",
      sourceId: "owner-local",
      network: null,
    };
    expect(() => EvidenceRecordSchema.parse(settlement)).toThrow(/onchain evidence requires/u);
  });

  it("rejects inputs above the bounded evidence cap", () => {
    const oversized = Array.from({ length: 65 }, (_, index) => ({
      ...clone(complete.evidence[0]!),
      evidenceId: `evd_${index.toString(16).padStart(32, "0")}`,
    }));
    expect(() =>
      reconcileAction(reconciliationInput(complete, { evidence: oversized })),
    ).toThrow();
  });

  it("refuses to derive a conclusion without cited evidence", () => {
    const action = clone(complete.action);
    action.kind = "transfer";
    action.states = [{
      sequence: 1,
      state: "PROPOSED",
      at: action.createdAt,
      evidenceIds: [],
    }];
    action.intentEvidenceIds = [];
    action.attemptEvidenceIds = [];
    action.paymentEvidenceIds = [];
    action.fulfillmentEvidenceIds = [];
    action.settlementEvidenceIds = [];
    expect(() => reconcileAction({ action, evidence: [], policies: [], evaluatedAt: complete.evaluatedAt })).toThrowError(
      /at least one cited evidence/u,
    );
  });

  it("rejects duplicate evidence IDs", () => {
    expect(() =>
      reconcileAction(
        reconciliationInput(complete, {
          evidence: [...complete.evidence, complete.evidence[0]],
        }),
      ),
    ).toThrowError(EvidenceEngineError);
    try {
      reconcileAction(
        reconciliationInput(complete, {
          evidence: [...complete.evidence, complete.evidence[0]],
        }),
      );
    } catch (error) {
      expect((error as EvidenceEngineError).code).toBe("DUPLICATE_EVIDENCE_ID");
    }
  });

  it("rejects dangling and wrongly classified relationships", () => {
    const danglingAction = clone(complete.action);
    danglingAction.intentEvidenceIds = ["evd_ffffffffffffffffffffffffffffffff"];
    danglingAction.states.find((transition) => transition.state === "PERMITTED")!.evidenceIds =
      danglingAction.intentEvidenceIds;
    expect(() =>
      reconcileAction(reconciliationInput(complete, { action: danglingAction })),
    ).toThrowError(
      /missing evidence/u,
    );

    const wrongRelationship = clone(complete.action);
    wrongRelationship.intentEvidenceIds = [complete.action.attemptEvidenceIds[0]!];
    wrongRelationship.attemptEvidenceIds = [complete.action.intentEvidenceIds[0]!];
    wrongRelationship.states.find((transition) => transition.state === "PERMITTED")!.evidenceIds =
      wrongRelationship.intentEvidenceIds;
    wrongRelationship.states.find((transition) => transition.state === "ATTEMPTED")!.evidenceIds =
      wrongRelationship.attemptEvidenceIds;
    expect(() =>
      reconcileAction(reconciliationInput(complete, { action: wrongRelationship })),
    ).toThrowError(
      /cannot be cited/u,
    );
  });

  it("rejects dangling or uncited state-transition evidence", () => {
    const dangling = clone(complete.action);
    dangling.attemptEvidenceIds = ["evd_ffffffffffffffffffffffffffffffff"];
    dangling.states.find((transition) => transition.state === "ATTEMPTED")!.evidenceIds =
      dangling.attemptEvidenceIds;
    expect(() => reconcileAction(reconciliationInput(complete, { action: dangling }))).toThrowError(
      /references missing evidence/u,
    );

    const uncited = clone(complete.action);
    const externalRecord = clone(complete.evidence[0]!);
    externalRecord.evidenceId = "evd_ffffffffffffffffffffffffffffffff";
    uncited.states.find((transition) => transition.state === "ATTEMPTED")!.evidenceIds =
      [externalRecord.evidenceId];
    expect(() =>
      reconcileAction(
        reconciliationInput(complete, {
          action: uncited,
          evidence: [...complete.evidence, externalRecord],
        }),
      ),
    ).toThrowError(/outside its permitted action relationship/u);
  });

  it("rejects an evidence record attached to another action", () => {
    const evidence = clone(complete.evidence);
    evidence[0]!.actionId = "act_ffffffffffffffffffffffffffffffff";
    expect(() =>
      reconcileAction(reconciliationInput(complete, { evidence })),
    ).toThrowError(/different action/u);
  });

  it("detects a replayed authorization nonce across action IDs", () => {
    const authorization = complete.evidence.find(
      (record) => record.evidenceType === "authorization",
    )!;
    const replay = EvidenceRecordSchema.parse({
      ...clone(authorization),
      evidenceId: "evd_ffffffffffffffffffffffffffffffff",
      actionId: "act_ffffffffffffffffffffffffffffffff",
    });
    const result = reconcileAction(
      reconciliationInput(complete, { evidence: [...complete.evidence, replay] }),
    );
    expect(result.state).toBe("CONFLICTING_EVIDENCE");
    expect(result.conflicts.map((conflict) => conflict.code)).toContain(
      "AUTHORIZATION_NONCE_REPLAY",
    );
    expect(result.evidenceIds).toContain(replay.evidenceId);
  });

  it("rejects precomputed policy or reconciliation output as engine input", () => {
    const withReconciliation = clone(complete.action);
    withReconciliation.reconciliation = clone(complete.result);
    withReconciliation.policyEvaluation = clone(complete.result.policyEvaluation);
    expect(() =>
      reconcileAction(reconciliationInput(complete, { action: withReconciliation })),
    ).toThrowError(/must be unresolved/u);

    const withPolicy = clone(complete.action);
    withPolicy.policyEvaluation = clone(complete.result.policyEvaluation);
    expect(() =>
      reconcileAction(reconciliationInput(complete, { action: withPolicy })),
    ).toThrowError(/must be unresolved/u);

    const mismatched = clone(complete.action);
    mismatched.reconciliation = {
      ...clone(complete.result),
      actionId: "act_ffffffffffffffffffffffffffffffff",
    };
    expect(() => ActionEnvelopeSchema.parse(mismatched)).toThrow(/different action/u);
  });

  it("rejects contradictory cached result, policy, and fixture shapes", () => {
    expect(() => PolicyEvaluationSchema.parse({
      ...clone(complete.result.policyEvaluation),
      state: "permitted",
      violations: [{ code: "POLICY_EXPIRED", detail: "Contradictory cached output." }],
    })).toThrow(/permitted policy evaluation cannot contain violations/u);

    expect(() => ReconciliationResultSchema.parse({
      ...clone(complete.result),
      conflicts: [{
        code: "RECIPIENT_MISMATCH",
        evidenceIds: complete.result.evidenceIds.slice(0, 2),
        detail: "Contradictory cached output.",
      }],
    })).toThrow(/cannot retain a higher-precedence conflict/u);

    expect(() => ReconciliationResultSchema.parse({
      ...clone(complete.result),
      policyEvaluation: {
        mode: "local_monitoring_only",
        state: "unevaluable",
        matchedPolicyIds: complete.policies.map((policy) => policy.policyId),
        violations: [],
      },
    })).toThrow(/evaluable or inapplicable/u);

    expect(() => ReconciliationResultSchema.parse({
      ...clone(complete.result),
      limitations: [],
    })).toThrow();

    expect(() => EvidenceFixtureSchema.parse({
      ...clone(complete),
      expectedState: "FAILED",
    })).toThrow(/expected state must equal/u);

    expect(() => EvidenceFixtureSchema.parse({
      ...clone(complete),
      expectedState: "FAILED",
      result: {
        ...clone(complete.result),
        state: "FAILED",
      },
    })).toThrow(/deterministic recomputation/u);
  });

  it("fails closed when causal source times or transition citations run backwards", () => {
    const earlyEvidence = clone(complete.evidence);
    const settlement = earlyEvidence.find((record) => record.evidenceType === "settlement")!;
    settlement.occurredAt = "2026-09-01T11:00:00Z";
    const result = reconcileAction(reconciliationInput(complete, { evidence: earlyEvidence }));
    expect(result.state).toBe("CONFLICTING_EVIDENCE");
    expect(result.conflicts.map((conflict) => conflict.code)).toContain("SOURCE_TIME_MISMATCH");

    const earlyTransition = clone(complete.action);
    earlyTransition.states.find((transition) => transition.state === "AUTHORIZED")!.at =
      "2026-09-01T12:02:30Z";
    expect(() =>
      reconcileAction(reconciliationInput(complete, { action: earlyTransition })),
    ).toThrow(/semantically incompatible evidence/u);
  });

  it("fails closed when fulfillment cites a different resource", () => {
    const evidence = clone(complete.evidence);
    const fulfillment = evidence.find((record) => record.evidenceType === "fulfillment")!;
    if (fulfillment.evidenceType !== "fulfillment") throw new Error("Expected fulfillment");
    fulfillment.payload.resourceDigest = `sha256:${"f".repeat(64)}`;
    const result = reconcileAction(reconciliationInput(complete, { evidence }));
    expect(result.state).toBe("CONFLICTING_EVIDENCE");
    expect(result.conflicts.map((conflict) => conflict.code)).toContain("RESOURCE_MISMATCH");
  });

  it("fails closed on conflicting validity windows", () => {
    const authorization = clone(
      complete.evidence.find((record) => record.evidenceType === "authorization")!,
    );
    if (authorization.evidenceType !== "authorization") throw new Error("Expected authorization");
    authorization.evidenceId = "evd_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    authorization.payload.validBefore = "2026-09-01T12:29:00Z";
    const action = clone(complete.action);
    action.paymentEvidenceIds.push(authorization.evidenceId);
    const result = reconcileAction(
      reconciliationInput(complete, { action, evidence: [...complete.evidence, authorization] }),
    );
    expect(result.state).toBe("CONFLICTING_EVIDENCE");
    expect(result.conflicts.map((conflict) => conflict.code)).toContain("VALIDITY_WINDOW_MISMATCH");
  });

  it("fails closed on conflicting transaction and block references", () => {
    const settlement = clone(
      complete.evidence.find((record) => record.evidenceType === "settlement")!,
    );
    if (settlement.evidenceType !== "settlement") throw new Error("Expected settlement");
    settlement.evidenceId = "evd_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    settlement.payload.transactionHash = `0x${"a".repeat(64)}`;
    settlement.payload.blockHash = `0x${"b".repeat(64)}`;
    settlement.payload.blockNumber = "999999";
    const action = clone(complete.action);
    action.settlementEvidenceIds.push(settlement.evidenceId);
    const result = reconcileAction(
      reconciliationInput(complete, { action, evidence: [...complete.evidence, settlement] }),
    );
    expect(result.state).toBe("CONFLICTING_EVIDENCE");
    expect(result.conflicts.map((conflict) => conflict.code)).toEqual(expect.arrayContaining([
      "TRANSACTION_MISMATCH", "BLOCK_HASH_MISMATCH", "BLOCK_NUMBER_MISMATCH",
    ]));
  });

  it("keeps one material conflict closed over more than 16 cited records", () => {
    const intentBase = complete.evidence.find((record) => record.evidenceType === "intent")!;
    const attemptBase = complete.evidence.find((record) => record.evidenceType === "attempt")!;
    if (intentBase.evidenceType !== "intent" || attemptBase.evidenceType !== "attempt") {
      throw new Error("Expected intent and attempt");
    }
    const intentClones = Array.from({ length: 7 }, (_, index) => ({
      ...clone(intentBase),
      evidenceId: `evd_a${index.toString(16)}${"0".repeat(30)}`,
    }));
    const attemptClones = Array.from({ length: 7 }, (_, index) => ({
      ...clone(attemptBase),
      evidenceId: `evd_b${index.toString(16)}${"0".repeat(30)}`,
    }));
    intentClones[0]!.payload.payTo = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const action = clone(complete.action);
    action.intentEvidenceIds.push(...intentClones.map((record) => record.evidenceId));
    action.attemptEvidenceIds.push(...attemptClones.map((record) => record.evidenceId));

    const result = reconcileAction(reconciliationInput(complete, {
      action,
      evidence: [...complete.evidence, ...intentClones, ...attemptClones],
    }));
    const recipientConflict = result.conflicts.find((conflict) => conflict.code === "RECIPIENT_MISMATCH")!;
    expect(result.state).toBe("CONFLICTING_EVIDENCE");
    expect(recipientConflict.evidenceIds).toHaveLength(19);
    expect(result.evidenceIds).toHaveLength(20);
  });

  it("uses one explicit all-record overflow conflict above 16 material groups", () => {
    const evidence = clone(complete.evidence);
    const action = clone(complete.action);
    const intent = clone(evidence.find((record) => record.evidenceType === "intent")!);
    const attempt = clone(evidence.find((record) => record.evidenceType === "attempt")!);
    const requirement = clone(evidence.find((record) => record.evidenceType === "payment_requirement")!);
    const authorization = clone(evidence.find((record) => record.evidenceType === "authorization")!);
    const fulfillment = clone(evidence.find((record) => record.evidenceType === "fulfillment")!);
    const settlement = clone(evidence.find((record) => record.evidenceType === "settlement")!);
    if (
      intent.evidenceType !== "intent" ||
      attempt.evidenceType !== "attempt" ||
      requirement.evidenceType !== "payment_requirement" ||
      authorization.evidenceType !== "authorization" ||
      fulfillment.evidenceType !== "fulfillment" ||
      settlement.evidenceType !== "settlement"
    ) {
      throw new Error("Expected the complete evidence sequence");
    }
    const clones = [intent, attempt, requirement, authorization, fulfillment, settlement];
    clones.forEach((record, index) => {
      record.evidenceId = `evd_c${index.toString(16)}${"0".repeat(30)}`;
    });
    const alternative = {
      payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      payTo: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      amountBaseUnits: "999",
      authorizationNonce: `0x${"c".repeat(64)}`,
      resourceDigest: `sha256:${"d".repeat(64)}`,
    };
    Object.assign(intent.payload, alternative, { mandateDigest: `sha256:${"e".repeat(64)}` });
    Object.assign(attempt.payload, alternative, { connectorEventId: `evt_${"f".repeat(24)}` });
    Object.assign(requirement.payload, alternative, {
      validBefore: "2026-09-01T12:29:00Z",
      requirementDigest: `sha256:${"a".repeat(64)}`,
    });
    Object.assign(authorization.payload, alternative, {
      validBefore: "2026-09-01T12:29:00Z",
      authorizationDigest: `sha256:${"b".repeat(64)}`,
    });
    Object.assign(fulfillment.payload, {
      resourceDigest: alternative.resourceDigest,
      providerStatus: "failed",
      responseDigest: null,
    });
    fulfillment.source.sourceId = "alternate-provider";
    Object.assign(settlement.payload, alternative, {
      transactionHash: `0x${"d".repeat(64)}`,
      blockHash: `0x${"e".repeat(64)}`,
      blockNumber: "999999",
      settlementStatus: "pending",
    });
    action.intentEvidenceIds.push(intent.evidenceId);
    action.attemptEvidenceIds.push(attempt.evidenceId);
    action.paymentEvidenceIds.push(requirement.evidenceId, authorization.evidenceId);
    action.fulfillmentEvidenceIds.push(fulfillment.evidenceId);
    action.settlementEvidenceIds.push(settlement.evidenceId);

    const result = reconcileAction(reconciliationInput(complete, {
      action,
      evidence: [...evidence, ...clones],
    }));
    expect(result.state).toBe("CONFLICTING_EVIDENCE");
    expect(result.conflicts).toEqual([expect.objectContaining({
      code: "CONFLICT_SET_OVERFLOW",
      evidenceIds: expect.arrayContaining(result.evidenceIds),
    })]);
    expect(result.conflicts[0]!.evidenceIds).toHaveLength(12);
  });

  it("fails closed on duplicate, failed-settlement, and invalid-reference refunds", () => {
    const refunded = M01_FIXTURES.find((fixture) => fixture.fixtureId === "refunded")!;
    const baseAction = clone(refunded.action);
    baseAction.states = baseAction.states.filter((transition) => transition.state !== "REFUNDED");
    const baseEvidence = clone(refunded.evidence);
    const refund = baseEvidence.find((record) => record.evidenceType === "refund")!;
    if (refund.evidenceType !== "refund") throw new Error("Expected refund");

    const secondRefund = clone(refund);
    secondRefund.evidenceId = "evd_cccccccccccccccccccccccccccccccc";
    secondRefund.payload.refundTransactionHash = `0x${"d".repeat(64)}`;
    secondRefund.payload.blockNumber = `${BigInt(secondRefund.payload.blockNumber) + 1n}`;
    baseAction.settlementEvidenceIds.push(secondRefund.evidenceId);
    const duplicateResult = reconcileAction({
      action: baseAction,
      evidence: [...baseEvidence, secondRefund],
      policies: refunded.policies,
      evaluatedAt: refunded.evaluatedAt,
    });
    expect(duplicateResult.state).toBe("CONFLICTING_EVIDENCE");
    expect(duplicateResult.conflicts.map((conflict) => conflict.code)).toContain(
      "REFUND_COUNT_MISMATCH",
    );

    const failedAction = clone(refunded.action);
    failedAction.states = failedAction.states.filter(
      (transition) => transition.state !== "SETTLED" && transition.state !== "REFUNDED",
    );
    const failedEvidence = clone(refunded.evidence);
    const failedSettlement = failedEvidence.find((record) => record.evidenceType === "settlement")!;
    if (failedSettlement.evidenceType !== "settlement") throw new Error("Expected settlement");
    failedSettlement.payload.settlementStatus = "failed";
    const failedResult = reconcileAction({
      action: failedAction,
      evidence: failedEvidence,
      policies: refunded.policies,
      evaluatedAt: refunded.evaluatedAt,
    });
    expect(failedResult.state).toBe("CONFLICTING_EVIDENCE");
    expect(failedResult.conflicts.map((conflict) => conflict.code)).toContain(
      "REFUND_SETTLEMENT_STATUS_MISMATCH",
    );

    const invalidAction = clone(refunded.action);
    invalidAction.states = invalidAction.states.filter((transition) => transition.state !== "REFUNDED");
    const invalidEvidence = clone(refunded.evidence);
    const invalidRefund = invalidEvidence.find((record) => record.evidenceType === "refund")!;
    const original = invalidEvidence.find((record) => record.evidenceType === "settlement")!;
    if (invalidRefund.evidenceType !== "refund" || original.evidenceType !== "settlement") {
      throw new Error("Expected refund and settlement");
    }
    invalidRefund.payload.refundTransactionHash = original.payload.transactionHash;
    const invalidResult = reconcileAction({
      action: invalidAction,
      evidence: invalidEvidence,
      policies: refunded.policies,
      evaluatedAt: refunded.evaluatedAt,
    });
    expect(invalidResult.state).toBe("CONFLICTING_EVIDENCE");
    expect(invalidResult.conflicts.map((conflict) => conflict.code)).toContain(
      "REFUND_REFERENCE_MISMATCH",
    );
  });

  it("does not expire a policy before a later fractional UTC instant", () => {
    const policy = MonitoringPolicySchema.parse({
      ...clone(complete.policies[0]),
      expiresAt: "2026-09-01T12:15:00.0002Z",
    });
    const result = reconcileAction(
      reconciliationInput(complete, { policies: [policy], evaluatedAt: "2026-09-01T12:15:00.0001Z" }),
    );
    expect(result.policyEvaluation.state).toBe("permitted");
    expect(result.policyEvaluation.violations).toEqual([]);
  });

  it("rejects an evaluation that predates used evidence or the final transition", () => {
    expect(() => reconcileAction(
      reconciliationInput(complete, { evaluatedAt: "2026-09-01T11:00:00Z" }),
    )).toThrowError(/cannot be evaluated before used evidence/u);

    const laterTransition = clone(complete.action);
    laterTransition.states.at(-1)!.at = "2026-09-01T12:20:00.000000001Z";
    expect(() => reconcileAction(
      reconciliationInput(complete, {
        action: laterTransition,
        evaluatedAt: "2026-09-01T12:20:00Z",
      }),
    )).toThrowError(/cannot be evaluated before used evidence or the final action transition/u);
  });

  it("compares 78-digit policy limits without floating point", () => {
    const policy = MonitoringPolicySchema.parse({
      ...clone(complete.policies[0]),
      maximumAmountBaseUnits: "1",
    });
    const result = reconcileAction(reconciliationInput(complete, { policies: [policy] }));
    expect(result.state).toBe("DENIED_BY_POLICY");
    expect(result.policyEvaluation).toMatchObject({
      mode: "local_monitoring_only",
      state: "flagged",
    });
    expect(result.policyEvaluation.violations.map((violation) => violation.code)).toContain(
      "AMOUNT_ABOVE_LIMIT",
    );
  });

  it("marks a matched policy unevaluable when no payment facts are cited", () => {
    const fulfillment = complete.evidence.find((record) => record.evidenceType === "fulfillment")!;
    const action = clone(complete.action);
    action.states = [
      { sequence: 1, state: "PROPOSED", at: action.createdAt, evidenceIds: [] },
      {
        sequence: 2,
        state: "INTENT_NOT_SUPPLIED",
        at: fulfillment.observedAt,
        evidenceIds: [fulfillment.evidenceId],
      },
    ];
    action.intentEvidenceIds = [];
    action.attemptEvidenceIds = [];
    action.paymentEvidenceIds = [];
    action.fulfillmentEvidenceIds = [fulfillment.evidenceId];
    action.settlementEvidenceIds = [];

    const result = reconcileAction({
      action,
      evidence: [fulfillment],
      policies: complete.policies,
      evaluatedAt: complete.evaluatedAt,
    });
    expect(result.state).toBe("INTENT_NOT_SUPPLIED");
    expect(result.policyEvaluation).toEqual({
      mode: "local_monitoring_only",
      state: "unevaluable",
      matchedPolicyIds: complete.policies.map((policy) => policy.policyId),
      violations: [],
    });
  });

  it("rejects duplicate policy IDs", () => {
    expect(() =>
      reconcileAction(
        reconciliationInput(complete, {
          policies: [complete.policies[0], complete.policies[0]],
        }),
      ),
    ).toThrowError(EvidenceEngineError);
  });
});

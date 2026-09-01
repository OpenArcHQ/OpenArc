import { describe, expect, it } from "vitest";

import {
  ActionEnvelopeSchema,
  AttentionActionStateSchema,
  EvidenceEngineError,
  EvidenceRecordSchema,
  M01_FIXTURES,
  MonitoringPolicySchema,
  PositiveActionStateSchema,
  reconcileAction,
} from "../src/index.js";

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

  it("accepts the complete positive path", () => {
    const states = PositiveActionStateSchema.options.map((state, index) => ({
      sequence: index + 1,
      state,
      at: `2026-09-01T12:${index.toString().padStart(2, "0")}:00Z`,
      evidenceIds: [],
    }));
    expect(ActionEnvelopeSchema.parse(actionWithStates(states)).states).toHaveLength(8);
  });

  it.each(AttentionActionStateSchema.options)("accepts %s only as the final state", (state) => {
    const states = [
      { sequence: 1, state: "PROPOSED", at: "2026-09-01T12:00:00Z", evidenceIds: [] },
      { sequence: 2, state, at: "2026-09-01T12:01:00Z", evidenceIds: [] },
    ];
    expect(ActionEnvelopeSchema.parse(actionWithStates(states)).states.at(-1)?.state).toBe(state);
  });

  it.each([
    [
      { sequence: 1, state: "AUTHORIZED", at: "2026-09-01T12:01:00Z", evidenceIds: [] },
      { sequence: 2, state: "ATTEMPTED", at: "2026-09-01T12:02:00Z", evidenceIds: [] },
    ],
    [
      { sequence: 1, state: "PROPOSED", at: "2026-09-01T12:02:00Z", evidenceIds: [] },
      { sequence: 2, state: "ATTEMPTED", at: "2026-09-01T12:01:00Z", evidenceIds: [] },
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
});

describe("fail-closed reconciliation", () => {
  it("rejects unknown schema versions and malformed records", () => {
    const unknown = clone(complete.evidence[0]);
    (unknown as { schemaVersion: string }).schemaVersion = "openarc.evidence.v2";
    expect(() => EvidenceRecordSchema.parse(unknown)).toThrow();

    const oversized = clone(complete.evidence[0]);
    oversized.limitations = ["x".repeat(241)];
    expect(() => EvidenceRecordSchema.parse(oversized)).toThrow();

    const unsafeReference = clone(complete.evidence[0]);
    unsafeReference.source.reference = "https://user:password@example.com/evidence";
    expect(() => EvidenceRecordSchema.parse(unsafeReference)).toThrow();
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
    expect(() =>
      reconcileAction(reconciliationInput(complete, { action: danglingAction })),
    ).toThrowError(
      /missing evidence/u,
    );

    const wrongRelationship = clone(complete.action);
    wrongRelationship.intentEvidenceIds = [complete.action.attemptEvidenceIds[0]!];
    wrongRelationship.attemptEvidenceIds = [complete.action.intentEvidenceIds[0]!];
    expect(() =>
      reconcileAction(reconciliationInput(complete, { action: wrongRelationship })),
    ).toThrowError(
      /cannot be cited/u,
    );
  });

  it("rejects dangling or uncited state-transition evidence", () => {
    const dangling = clone(complete.action);
    dangling.states[0]!.evidenceIds = ["evd_ffffffffffffffffffffffffffffffff"];
    expect(() => reconcileAction(reconciliationInput(complete, { action: dangling }))).toThrowError(
      /transition references missing evidence/u,
    );

    const uncited = clone(complete.action);
    const externalRecord = clone(complete.evidence[0]!);
    externalRecord.evidenceId = "evd_ffffffffffffffffffffffffffffffff";
    uncited.states[0]!.evidenceIds = [externalRecord.evidenceId];
    expect(() =>
      reconcileAction(
        reconciliationInput(complete, {
          action: uncited,
          evidence: [...complete.evidence, externalRecord],
        }),
      ),
    ).toThrowError(/not cited by an action relationship/u);
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

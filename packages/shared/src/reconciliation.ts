import { z } from "zod";

import {
  ActionEnvelopeSchema,
  EvidenceIdSchema,
  EvidenceRecordSchema,
  MonitoringPolicySchema,
  PolicyEvaluationSchema,
  ReconciliationResultSchema,
} from "./evidence.js";
import { IsoTimestampSchema, compareIsoTimestamps } from "./primitives.js";

import type {
  ActionEnvelope,
  EvidenceRecord,
  MonitoringPolicy,
  PaymentCorrelation,
  PolicyEvaluation,
  ReconciliationResult,
} from "./evidence.js";

const ReconciliationInputSchema = z.strictObject({
  action: ActionEnvelopeSchema,
  evidence: z.array(EvidenceRecordSchema).max(64),
  policies: z.array(MonitoringPolicySchema).max(32),
  evaluatedAt: IsoTimestampSchema,
});

export type EvidenceEngineErrorCode =
  | "DUPLICATE_EVIDENCE_ID"
  | "DANGLING_EVIDENCE_REFERENCE"
  | "WRONG_EVIDENCE_RELATIONSHIP"
  | "WRONG_ACTION_SUBJECT"
  | "PRECOMPUTED_RESULT_NOT_ALLOWED"
  | "EVALUATION_TIME_INVALID"
  | "STATE_RESULT_MISMATCH"
  | "NO_CITED_EVIDENCE"
  | "DUPLICATE_POLICY_ID";

export class EvidenceEngineError extends Error {
  readonly code: EvidenceEngineErrorCode;

  constructor(code: EvidenceEngineErrorCode, message: string) {
    super(message);
    this.name = "EvidenceEngineError";
    this.code = code;
  }
}

const relationshipTypes = {
  intentEvidenceIds: new Set(["intent"]),
  attemptEvidenceIds: new Set(["attempt"]),
  paymentEvidenceIds: new Set(["payment_requirement", "authorization"]),
  fulfillmentEvidenceIds: new Set(["fulfillment"]),
  settlementEvidenceIds: new Set(["settlement", "refund"]),
} as const;

const conflictCodeByField = {
  network: "NETWORK_MISMATCH",
  asset: "ASSET_MISMATCH",
  payer: "PAYER_MISMATCH",
  payTo: "RECIPIENT_MISMATCH",
  amountBaseUnits: "AMOUNT_MISMATCH",
  authorizationNonce: "NONCE_MISMATCH",
  resourceDigest: "RESOURCE_MISMATCH",
} as const;

const conflictOrder = [
  "NETWORK_MISMATCH",
  "ASSET_MISMATCH",
  "PAYER_MISMATCH",
  "RECIPIENT_MISMATCH",
  "AMOUNT_MISMATCH",
  "NONCE_MISMATCH",
  "RESOURCE_MISMATCH",
  "VALIDITY_WINDOW_MISMATCH",
  "MANDATE_MISMATCH",
  "CONNECTOR_EVENT_MISMATCH",
  "REQUIREMENT_MISMATCH",
  "AUTHORIZATION_MISMATCH",
  "PROVIDER_SOURCE_MISMATCH",
  "FULFILLMENT_STATUS_MISMATCH",
  "RESPONSE_MISMATCH",
  "TRANSACTION_MISMATCH",
  "BLOCK_HASH_MISMATCH",
  "BLOCK_NUMBER_MISMATCH",
  "SETTLEMENT_STATUS_MISMATCH",
  "SOURCE_TIME_MISMATCH",
  "CONFLICT_SET_OVERFLOW",
  "AUTHORIZATION_NONCE_REPLAY",
  "REFUND_COUNT_MISMATCH",
  "REFUND_SETTLEMENT_STATUS_MISMATCH",
  "REFUND_REFERENCE_MISMATCH",
  "REFUND_AMOUNT_MISMATCH",
] as const;

const gapDefinitions = [
  ["INTENT_MISSING", "No owner-supplied or signed intent evidence is cited."],
  ["ATTEMPT_MISSING", "No agent-reported attempt evidence is cited."],
  ["REQUIREMENT_MISSING", "No provider payment requirement is cited."],
  ["AUTHORIZATION_MISSING", "No signed payment authorization is cited."],
  ["FULFILLMENT_MISSING", "No provider fulfillment evidence is cited."],
  ["SETTLEMENT_MISSING", "No Gateway or onchain settlement evidence is cited."],
] as const;

function correlation(record: EvidenceRecord): PaymentCorrelation | null {
  switch (record.evidenceType) {
    case "intent":
    case "attempt":
    case "payment_requirement":
    case "authorization":
    case "settlement":
      return record.payload;
    case "fulfillment":
    case "refund":
      return null;
  }
}

function evidenceTime(record: EvidenceRecord): string {
  return record.occurredAt ?? record.observedAt;
}

type Conflict = z.infer<typeof ReconciliationResultSchema>["conflicts"][number];

function appendValueConflict(
  conflicts: Conflict[],
  code: Conflict["code"],
  entries: readonly { evidenceId: string; value: string }[],
  detail: string,
) {
  if (entries.length < 2) return;
  const values = new Set(entries.map((entry) => entry.value));
  if (values.size < 2) return;
  conflicts.push({
    code,
    evidenceIds: entries.map((entry) => entry.evidenceId).sort(),
    detail,
  });
}

export function sortEvidence(records: readonly EvidenceRecord[]): EvidenceRecord[] {
  return [...records].sort((left, right) => {
    const timeOrder = compareIsoTimestamps(evidenceTime(left), evidenceTime(right));
    return timeOrder || left.evidenceId.localeCompare(right.evidenceId);
  });
}

const transitionEvidenceTypes: Readonly<Record<ActionEnvelope["states"][number]["state"], ReadonlySet<EvidenceRecord["evidenceType"]>>> = {
  PROPOSED: new Set(),
  PERMITTED: new Set(["intent"]),
  ATTEMPTED: new Set(["attempt"]),
  AUTHORIZED: new Set(["authorization"]),
  FULFILLED: new Set(["fulfillment"]),
  SETTLING: new Set(["settlement"]),
  SETTLED: new Set(["settlement"]),
  RECONCILED: new Set(["fulfillment", "settlement"]),
  DENIED_BY_POLICY: new Set(["intent", "attempt"]),
  EXPIRED: new Set(["payment_requirement", "authorization"]),
  FAILED: new Set(["fulfillment", "settlement"]),
  REFUNDED: new Set(["refund"]),
  CONFLICTING_EVIDENCE: new Set([
    "intent", "attempt", "payment_requirement", "authorization", "fulfillment", "settlement", "refund",
  ]),
  FULFILLMENT_UNVERIFIED: new Set(["authorization", "settlement"]),
  SETTLEMENT_UNVERIFIED: new Set(["authorization", "fulfillment"]),
  INTENT_NOT_SUPPLIED: new Set(["attempt", "payment_requirement", "authorization", "fulfillment", "settlement"]),
  UNSUPPORTED: new Set([
    "intent", "attempt", "payment_requirement", "authorization", "fulfillment", "settlement", "refund",
  ]),
};

function transitionEvidenceIsSemanticallyValid(
  state: ActionEnvelope["states"][number]["state"],
  records: readonly EvidenceRecord[],
  transitionAt: string,
): boolean {
  if (state === "PROPOSED") return records.length === 0;
  if (records.length === 0 || records.some((record) => !transitionEvidenceTypes[state].has(record.evidenceType))) {
    return false;
  }
  if (records.some((record) => compareIsoTimestamps(record.observedAt, transitionAt) > 0)) {
    return false;
  }
  if (state === "RECONCILED") {
    return records.some(
      (record) => record.evidenceType === "fulfillment" && record.payload.providerStatus === "fulfilled",
    ) && records.some(
      (record) => record.evidenceType === "settlement" && record.payload.settlementStatus === "settled",
    );
  }
  if (state === "FULFILLED") {
    return records.every(
      (record) => record.evidenceType === "fulfillment" && record.payload.providerStatus === "fulfilled",
    );
  }
  if (state === "SETTLED") {
    return records.every(
      (record) => record.evidenceType === "settlement" && record.payload.settlementStatus === "settled",
    );
  }
  if (state === "SETTLING") {
    return records.every(
      (record) => record.evidenceType === "settlement" && record.payload.settlementStatus === "pending",
    );
  }
  if (state === "FAILED") {
    return records.some(
      (record) =>
        (record.evidenceType === "fulfillment" && record.payload.providerStatus === "failed") ||
        (record.evidenceType === "settlement" && record.payload.settlementStatus === "failed"),
    );
  }
  if (state === "EXPIRED") {
    const at = transitionAt;
    return records.some(
      (record) =>
        (record.evidenceType === "authorization" || record.evidenceType === "payment_requirement") &&
        compareIsoTimestamps(at, record.payload.validBefore) > 0,
    );
  }
  return true;
}

function evaluatePolicies(
  action: ActionEnvelope,
  records: readonly EvidenceRecord[],
  policies: readonly MonitoringPolicy[],
  evaluatedAt: string,
): PolicyEvaluation {
  if (action.kind !== "paid_api_request") {
    return PolicyEvaluationSchema.parse({
      mode: "local_monitoring_only",
      state: "not_applicable",
      matchedPolicyIds: [],
      violations: [],
    });
  }

  const matching = policies
    .filter((policy) => policy.enabled && policy.actionKind === action.kind)
    .sort((left, right) => left.policyId.localeCompare(right.policyId));
  if (matching.length === 0) {
    return PolicyEvaluationSchema.parse({
      mode: "local_monitoring_only",
      state: "not_applicable",
      matchedPolicyIds: [],
      violations: [],
    });
  }

  const baseline = records
    .filter((record) => correlation(record) !== null)
    .sort((left, right) => {
      const priority = ["intent", "payment_requirement", "authorization", "attempt", "settlement"];
      return priority.indexOf(left.evidenceType) - priority.indexOf(right.evidenceType);
    })[0];
  const facts = baseline ? correlation(baseline) : null;
  if (!facts) {
    return PolicyEvaluationSchema.parse({
      mode: "local_monitoring_only",
      state: "unevaluable",
      matchedPolicyIds: matching.map((policy) => policy.policyId),
      violations: [],
    });
  }
  const violations: z.infer<typeof PolicyEvaluationSchema>["violations"] = [];

  for (const policy of matching) {
    if (policy.expiresAt && compareIsoTimestamps(evaluatedAt, policy.expiresAt) > 0) {
      violations.push({
        code: "POLICY_EXPIRED",
        detail: "The local monitoring policy expired before this evaluation.",
      });
    }
    if (facts.network !== policy.network) {
      violations.push({ code: "NETWORK_NOT_ALLOWED", detail: "The cited network is not allowed." });
    }
    if (facts.asset !== policy.asset) {
      violations.push({ code: "ASSET_NOT_ALLOWED", detail: "The cited asset is not allowed." });
    }
    if (policy.allowedRecipients.length > 0 && !policy.allowedRecipients.includes(facts.payTo)) {
      violations.push({
        code: "RECIPIENT_NOT_ALLOWED",
        detail: "The cited recipient is outside the local allowlist.",
      });
    }
    if (BigInt(facts.amountBaseUnits) > BigInt(policy.maximumAmountBaseUnits)) {
      violations.push({
        code: "AMOUNT_ABOVE_LIMIT",
        detail: "The cited base-unit amount exceeds the local monitoring limit.",
      });
    }
  }

  const uniqueViolations = [...new Map(violations.map((item) => [item.code, item])).values()];
  return PolicyEvaluationSchema.parse({
    mode: "local_monitoring_only",
    state: uniqueViolations.length > 0 ? "flagged" : "permitted",
    matchedPolicyIds: matching.map((policy) => policy.policyId),
    violations: uniqueViolations,
  });
}

export function reconcileAction(input: {
  action: unknown;
  evidence: unknown;
  policies: unknown;
  evaluatedAt: unknown;
}): ReconciliationResult {
  const parsed = ReconciliationInputSchema.parse(input);
  const { action, evidence, policies, evaluatedAt } = parsed;

  if (action.policyEvaluation !== null || action.reconciliation !== null) {
    throw new EvidenceEngineError(
      "PRECOMPUTED_RESULT_NOT_ALLOWED",
      "Reconciliation input must be unresolved; cached policy and reconciliation results are not trusted inputs",
    );
  }

  const evidenceById = new Map<string, EvidenceRecord>();
  for (const record of evidence) {
    if (evidenceById.has(record.evidenceId)) {
      throw new EvidenceEngineError(
        "DUPLICATE_EVIDENCE_ID",
        `Duplicate evidence ID: ${record.evidenceId}`,
      );
    }
    evidenceById.set(record.evidenceId, record);
  }

  const policyIds = new Set<string>();
  for (const policy of policies) {
    if (policyIds.has(policy.policyId)) {
      throw new EvidenceEngineError("DUPLICATE_POLICY_ID", `Duplicate policy ID: ${policy.policyId}`);
    }
    policyIds.add(policy.policyId);
  }

  const referenced: EvidenceRecord[] = [];
  const relationshipEvidenceIds = new Set<string>();
  for (const [relationship, allowedTypes] of Object.entries(relationshipTypes)) {
    const evidenceIds = action[relationship as keyof typeof relationshipTypes];
    const allowed = allowedTypes as ReadonlySet<string>;
    for (const evidenceId of evidenceIds) {
      const record = evidenceById.get(evidenceId);
      if (!record) {
        throw new EvidenceEngineError(
          "DANGLING_EVIDENCE_REFERENCE",
          `Action references missing evidence: ${evidenceId}`,
        );
      }
      if (!allowed.has(record.evidenceType)) {
        throw new EvidenceEngineError(
          "WRONG_EVIDENCE_RELATIONSHIP",
          `${record.evidenceType} cannot be cited by ${relationship}`,
        );
      }
      if (record.actionId !== action.actionId) {
        throw new EvidenceEngineError(
          "WRONG_ACTION_SUBJECT",
          `Evidence ${evidenceId} belongs to a different action`,
        );
      }
      referenced.push(record);
      relationshipEvidenceIds.add(record.evidenceId);
    }
  }

  if (referenced.length === 0) {
    throw new EvidenceEngineError(
      "NO_CITED_EVIDENCE",
      "Reconciliation requires at least one cited evidence record",
    );
  }
  const usedEvidenceIds = new Set(referenced.map((record) => record.evidenceId));

  for (const transition of action.states) {
    const transitionRecords: EvidenceRecord[] = [];
    for (const evidenceId of transition.evidenceIds) {
      const record = evidenceById.get(evidenceId);
      if (!record) {
        throw new EvidenceEngineError(
          "DANGLING_EVIDENCE_REFERENCE",
          `State transition references missing evidence: ${evidenceId}`,
        );
      }
      if (record.actionId !== action.actionId) {
        throw new EvidenceEngineError(
          "WRONG_ACTION_SUBJECT",
          `State transition evidence ${evidenceId} belongs to a different action`,
        );
      }
      if (!relationshipEvidenceIds.has(evidenceId)) {
        throw new EvidenceEngineError(
          "WRONG_EVIDENCE_RELATIONSHIP",
          `State transition evidence ${evidenceId} is not cited by an action relationship`,
        );
      }
      transitionRecords.push(record);
    }
    if (!transitionEvidenceIsSemanticallyValid(transition.state, transitionRecords, transition.at)) {
      throw new EvidenceEngineError(
        "WRONG_EVIDENCE_RELATIONSHIP",
        `State ${transition.state} cites missing, wrongly typed, or semantically incompatible evidence`,
      );
    }
  }

  const sorted = sortEvidence(referenced);
  const byType = new Map<string, EvidenceRecord[]>();
  for (const record of sorted) {
    const group = byType.get(record.evidenceType) ?? [];
    group.push(record);
    byType.set(record.evidenceType, group);
  }

  const gaps: z.infer<typeof ReconciliationResultSchema>["gaps"] = gapDefinitions
    .filter(([code]) => {
      const typeByGap = {
        INTENT_MISSING: "intent",
        ATTEMPT_MISSING: "attempt",
        REQUIREMENT_MISSING: "payment_requirement",
        AUTHORIZATION_MISSING: "authorization",
        FULFILLMENT_MISSING: "fulfillment",
        SETTLEMENT_MISSING: "settlement",
      } as const;
      return (byType.get(typeByGap[code]) ?? []).length === 0;
    })
    .map(([code, detail]) => ({ code, detail }));

  const conflicts: Conflict[] = [];
  const correlated = sorted
    .map((record) => ({ record, facts: correlation(record) }))
    .filter((entry): entry is { record: EvidenceRecord; facts: PaymentCorrelation } => entry.facts !== null);

  for (const field of Object.keys(conflictCodeByField) as Array<keyof PaymentCorrelation>) {
    const values = new Map<string, string[]>();
    for (const { record, facts } of correlated) {
      const value = facts[field];
      const evidenceIds = values.get(value) ?? [];
      evidenceIds.push(record.evidenceId);
      values.set(value, evidenceIds);
    }
    if (field === "resourceDigest") {
      for (const record of (byType.get("fulfillment") ?? []).filter(
        (candidate): candidate is Extract<EvidenceRecord, { evidenceType: "fulfillment" }> =>
          candidate.evidenceType === "fulfillment",
      )) {
        const evidenceIds = values.get(record.payload.resourceDigest) ?? [];
        evidenceIds.push(record.evidenceId);
        values.set(record.payload.resourceDigest, evidenceIds);
      }
    }
    if (values.size > 1) {
      conflicts.push({
        code: conflictCodeByField[field],
        evidenceIds: [...values.values()].flat().sort(),
        detail: `Cited records disagree on ${field}.`,
      });
    }
  }

  const intentRecords = (byType.get("intent") ?? []).filter(
    (record): record is Extract<EvidenceRecord, { evidenceType: "intent" }> =>
      record.evidenceType === "intent",
  );
  const attemptRecords = (byType.get("attempt") ?? []).filter(
    (record): record is Extract<EvidenceRecord, { evidenceType: "attempt" }> =>
      record.evidenceType === "attempt",
  );
  const requirementRecords = (byType.get("payment_requirement") ?? []).filter(
    (record): record is Extract<EvidenceRecord, { evidenceType: "payment_requirement" }> =>
      record.evidenceType === "payment_requirement",
  );
  const authorizationRecords = (byType.get("authorization") ?? []).filter(
    (record): record is Extract<EvidenceRecord, { evidenceType: "authorization" }> =>
      record.evidenceType === "authorization",
  );
  const fulfillmentRecords = (byType.get("fulfillment") ?? []).filter(
    (record): record is Extract<EvidenceRecord, { evidenceType: "fulfillment" }> =>
      record.evidenceType === "fulfillment",
  );
  const settlementRecords = (byType.get("settlement") ?? []).filter(
    (record): record is Extract<EvidenceRecord, { evidenceType: "settlement" }> =>
      record.evidenceType === "settlement",
  );
  const refundRecords = (byType.get("refund") ?? []).filter(
    (record): record is Extract<EvidenceRecord, { evidenceType: "refund" }> =>
      record.evidenceType === "refund",
  );

  if (
    settlementRecords.length > 0 &&
    settlementRecords.every((record) => record.payload.settlementStatus === "pending")
  ) {
    gaps.push({
      code: "SETTLEMENT_PENDING",
      detail: "Settlement evidence is cited, but no cited settlement is final.",
    });
  }

  const causalStage: Readonly<Partial<Record<EvidenceRecord["evidenceType"], number>>> = {
    intent: 0,
    attempt: 1,
    payment_requirement: 2,
    authorization: 3,
    fulfillment: 4,
    settlement: 5,
    refund: 6,
  };
  const sourceTimeMismatchIds = new Set<string>();
  for (const earlierStageRecord of sorted) {
    for (const laterStageRecord of sorted) {
      const earlierStage = causalStage[earlierStageRecord.evidenceType];
      const laterStage = causalStage[laterStageRecord.evidenceType];
      if (
        earlierStage === undefined ||
        laterStage === undefined ||
        earlierStage >= laterStage ||
        compareIsoTimestamps(evidenceTime(earlierStageRecord), evidenceTime(laterStageRecord)) <= 0
      ) {
        continue;
      }
      sourceTimeMismatchIds.add(earlierStageRecord.evidenceId);
      sourceTimeMismatchIds.add(laterStageRecord.evidenceId);
    }
  }
  if (sourceTimeMismatchIds.size > 0) {
    conflicts.push({
      code: "SOURCE_TIME_MISMATCH",
      evidenceIds: [...sourceTimeMismatchIds].sort(),
      detail: "Cited source times contradict the supported causal evidence sequence.",
    });
  }

  appendValueConflict(
    conflicts,
    "VALIDITY_WINDOW_MISMATCH",
    [...requirementRecords, ...authorizationRecords].map((record) => ({
      evidenceId: record.evidenceId,
      value: `${record.payload.validAfter}|${record.payload.validBefore}`,
    })),
    "Cited requirement and authorization records disagree on the exact validity window.",
  );
  appendValueConflict(
    conflicts,
    "MANDATE_MISMATCH",
    intentRecords.map((record) => ({ evidenceId: record.evidenceId, value: record.payload.mandateDigest })),
    "Cited intent records disagree on the mandate digest.",
  );
  appendValueConflict(
    conflicts,
    "CONNECTOR_EVENT_MISMATCH",
    attemptRecords.map((record) => ({ evidenceId: record.evidenceId, value: record.payload.connectorEventId })),
    "Cited attempt records disagree on the connector event.",
  );
  appendValueConflict(
    conflicts,
    "REQUIREMENT_MISMATCH",
    requirementRecords.map((record) => ({ evidenceId: record.evidenceId, value: record.payload.requirementDigest })),
    "Cited provider records disagree on the payment requirement digest.",
  );
  appendValueConflict(
    conflicts,
    "AUTHORIZATION_MISMATCH",
    authorizationRecords.map((record) => ({ evidenceId: record.evidenceId, value: record.payload.authorizationDigest })),
    "Cited signed records disagree on the authorization digest.",
  );
  appendValueConflict(
    conflicts,
    "PROVIDER_SOURCE_MISMATCH",
    [...requirementRecords, ...fulfillmentRecords].map((record) => ({
      evidenceId: record.evidenceId,
      value: `${record.source.sourceId}|${record.source.adapterVersion}`,
    })),
    "Payment requirement and fulfillment evidence name different synthetic provider sources.",
  );
  appendValueConflict(
    conflicts,
    "FULFILLMENT_STATUS_MISMATCH",
    fulfillmentRecords.map((record) => ({ evidenceId: record.evidenceId, value: record.payload.providerStatus })),
    "Cited provider records disagree on fulfillment status.",
  );
  appendValueConflict(
    conflicts,
    "RESPONSE_MISMATCH",
    fulfillmentRecords.map((record) => ({ evidenceId: record.evidenceId, value: record.payload.responseDigest ?? "null" })),
    "Cited provider records disagree on the response digest.",
  );
  appendValueConflict(
    conflicts,
    "TRANSACTION_MISMATCH",
    settlementRecords.map((record) => ({ evidenceId: record.evidenceId, value: record.payload.transactionHash })),
    "Cited settlement records disagree on the transaction hash.",
  );
  appendValueConflict(
    conflicts,
    "BLOCK_HASH_MISMATCH",
    settlementRecords.map((record) => ({ evidenceId: record.evidenceId, value: record.payload.blockHash })),
    "Cited settlement records disagree on the block hash.",
  );
  appendValueConflict(
    conflicts,
    "BLOCK_NUMBER_MISMATCH",
    settlementRecords.map((record) => ({ evidenceId: record.evidenceId, value: record.payload.blockNumber })),
    "Cited settlement records disagree on the block number.",
  );
  appendValueConflict(
    conflicts,
    "SETTLEMENT_STATUS_MISMATCH",
    settlementRecords.map((record) => ({ evidenceId: record.evidenceId, value: record.payload.settlementStatus })),
    "Cited settlement records disagree on settlement status.",
  );

  const authorizations = evidence.filter((record) => record.evidenceType === "authorization");
  for (const record of byType.get("authorization") ?? []) {
    if (record.evidenceType !== "authorization") continue;
    const replayed = authorizations.filter(
      (candidate) =>
        candidate.actionId !== action.actionId &&
        candidate.evidenceType === "authorization" &&
        candidate.payload.authorizationNonce === record.payload.authorizationNonce,
    );
    if (replayed.length > 0) {
      for (const item of replayed) usedEvidenceIds.add(item.evidenceId);
      conflicts.push({
        code: "AUTHORIZATION_NONCE_REPLAY",
        evidenceIds: [record.evidenceId, ...replayed.map((item) => item.evidenceId)].sort(),
        detail: "The same authorization nonce appears under another action.",
      });
    }
  }

  if (refundRecords.length > 1) {
    conflicts.push({
      code: "REFUND_COUNT_MISMATCH",
      evidenceIds: refundRecords.map((record) => record.evidenceId).sort(),
      detail: "M01 supports exactly one full refund record for a reconciled action.",
    });
  }
  for (const refund of refundRecords) {
    const original = settlementRecords.find(
      (record) => record.payload.transactionHash === refund.payload.originalTransactionHash,
    );
    if (!original) {
      conflicts.push({
        code: "REFUND_REFERENCE_MISMATCH",
        evidenceIds: [refund.evidenceId],
        detail: "The refund does not reference a cited original settlement.",
      });
      continue;
    }
    if (original.payload.settlementStatus !== "settled") {
      conflicts.push({
        code: "REFUND_SETTLEMENT_STATUS_MISMATCH",
        evidenceIds: [refund.evidenceId, original.evidenceId].sort(),
        detail: "A refund requires a cited original settlement with settled status.",
      });
    }
    if (original.payload.amountBaseUnits !== refund.payload.amountBaseUnits) {
      conflicts.push({
        code: "REFUND_AMOUNT_MISMATCH",
        evidenceIds: [refund.evidenceId, original.evidenceId].sort(),
        detail: "The refund does not exactly match a cited settlement amount.",
      });
    }
    const invalidReference =
      refund.payload.refundTransactionHash === original.payload.transactionHash ||
      BigInt(refund.payload.blockNumber) < BigInt(original.payload.blockNumber) ||
      (
        refund.payload.blockNumber === original.payload.blockNumber &&
        refund.payload.blockHash !== original.payload.blockHash
      );
    if (invalidReference) {
      conflicts.push({
        code: "REFUND_REFERENCE_MISMATCH",
        evidenceIds: [refund.evidenceId, original.evidenceId].sort(),
        detail: "The refund transaction or block reference is not a valid later reference.",
      });
    }
  }

  const orderedConflicts = [
    ...new Map(conflicts.map((conflict) => [`${conflict.code}:${conflict.evidenceIds.join(",")}`, conflict])).values(),
  ].sort(
    (left, right) => conflictOrder.indexOf(left.code) - conflictOrder.indexOf(right.code),
  );
  const deduplicatedConflicts: Conflict[] = orderedConflicts.length <= 16
    ? orderedConflicts
    : [{
        code: "CONFLICT_SET_OVERFLOW",
        evidenceIds: [...new Set(orderedConflicts.flatMap((conflict) => conflict.evidenceIds))].sort(),
        detail: `${orderedConflicts.length} material conflict groups exceed the 16-detail output cap; inspect every cited record.`,
      }];

  const policyEvaluation = evaluatePolicies(action, sorted, policies, evaluatedAt);
  const expiredAuthorization = (byType.get("authorization") ?? []).some((record) => {
    if (record.evidenceType !== "authorization") return false;
    const at = evidenceTime(record);
    return compareIsoTimestamps(at, record.payload.validAfter) < 0 ||
      compareIsoTimestamps(at, record.payload.validBefore) > 0;
  });
  const expiredRequirementWithoutAuthorization =
    (byType.get("authorization") ?? []).length === 0 &&
    (byType.get("payment_requirement") ?? []).some(
      (record) =>
        record.evidenceType === "payment_requirement" &&
        compareIsoTimestamps(evaluatedAt, record.payload.validBefore) > 0,
    );
  const hasFailure = sorted.some(
    (record) =>
      (record.evidenceType === "fulfillment" && record.payload.providerStatus === "failed") ||
      (record.evidenceType === "settlement" && record.payload.settlementStatus === "failed"),
  );
  const hasRefund = refundRecords.length > 0;
  const hasSettledPayment = settlementRecords.some(
    (record) => record.payload.settlementStatus === "settled",
  );

  let state: z.infer<typeof ReconciliationResultSchema>["state"];
  if (deduplicatedConflicts.length > 0) state = "CONFLICTING_EVIDENCE";
  else if (hasRefund) state = "REFUNDED";
  else if (hasFailure) state = "FAILED";
  else if (expiredAuthorization || expiredRequirementWithoutAuthorization) state = "EXPIRED";
  else if (policyEvaluation.state === "flagged") state = "DENIED_BY_POLICY";
  else if (action.kind !== "paid_api_request") state = "UNSUPPORTED";
  else if (gaps.some((gap) => gap.code === "INTENT_MISSING")) state = "INTENT_NOT_SUPPLIED";
  else if (gaps.some((gap) => gap.code === "SETTLEMENT_MISSING") || !hasSettledPayment) state = "SETTLEMENT_UNVERIFIED";
  else if (gaps.some((gap) => gap.code === "FULFILLMENT_MISSING")) state = "FULFILLMENT_UNVERIFIED";
  else if (gaps.length > 0) state = "UNSUPPORTED";
  else state = "RECONCILED";

  const finalActionState = action.states.at(-1)!.state;
  const conclusionStates = new Set([
    "RECONCILED",
    "DENIED_BY_POLICY",
    "EXPIRED",
    "FAILED",
    "REFUNDED",
    "CONFLICTING_EVIDENCE",
    "FULFILLMENT_UNVERIFIED",
    "SETTLEMENT_UNVERIFIED",
    "INTENT_NOT_SUPPLIED",
    "UNSUPPORTED",
  ]);
  if (conclusionStates.has(finalActionState) && finalActionState !== state) {
    throw new EvidenceEngineError(
      "STATE_RESULT_MISMATCH",
      `Final action state ${finalActionState} contradicts reconciliation state ${state}`,
    );
  }

  const resultEvidence = sortEvidence(
    evidence.filter((record) => usedEvidenceIds.has(record.evidenceId)),
  );
  if (
    resultEvidence.some((record) => compareIsoTimestamps(evaluatedAt, record.observedAt) < 0) ||
    compareIsoTimestamps(evaluatedAt, action.states.at(-1)!.at) < 0
  ) {
    throw new EvidenceEngineError(
      "EVALUATION_TIME_INVALID",
      "Reconciliation cannot be evaluated before used evidence or the final action transition",
    );
  }

  return ReconciliationResultSchema.parse({
    schemaVersion: "openarc.reconciliation.v1",
    ruleVersion: "openarc.reconcile.v1",
    actionId: action.actionId,
    evaluatedAt,
    state,
    evidenceIds: resultEvidence.map((record) => record.evidenceId),
    gaps,
    conflicts: deduplicatedConflicts,
    limitations: [
      "Synthetic fixture evidence does not describe a live agent or payment.",
      "Reconciliation proves only exact agreement between cited normalized records.",
    ],
    policyEvaluation,
  });
}

export function parseEvidenceId(value: unknown): string {
  return EvidenceIdSchema.parse(value);
}

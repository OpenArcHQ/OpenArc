import { z } from "zod";

import {
  ActionEnvelopeSchema,
  EvidenceIdSchema,
  EvidenceRecordSchema,
  MonitoringPolicySchema,
  PolicyEvaluationSchema,
  ReconciliationResultSchema,
} from "./evidence.js";
import { IsoTimestampSchema } from "./primitives.js";

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
  "AUTHORIZATION_NONCE_REPLAY",
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

export function sortEvidence(records: readonly EvidenceRecord[]): EvidenceRecord[] {
  return [...records].sort((left, right) => {
    const timeOrder = evidenceTime(left).localeCompare(evidenceTime(right));
    return timeOrder || left.evidenceId.localeCompare(right.evidenceId);
  });
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
  const violations: z.infer<typeof PolicyEvaluationSchema>["violations"] = [];

  for (const policy of matching) {
    if (policy.expiresAt && evaluatedAt > policy.expiresAt) {
      violations.push({
        code: "POLICY_EXPIRED",
        detail: "The local monitoring policy expired before this evaluation.",
      });
    }
    if (!facts) continue;
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

  for (const transition of action.states) {
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
    }
  }

  const sorted = sortEvidence(referenced);
  const byType = new Map<string, EvidenceRecord[]>();
  for (const record of sorted) {
    const group = byType.get(record.evidenceType) ?? [];
    group.push(record);
    byType.set(record.evidenceType, group);
  }

  const gaps = gapDefinitions
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

  const conflicts: Array<z.infer<typeof ReconciliationResultSchema>["conflicts"][number]> = [];
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
    if (values.size > 1) {
      conflicts.push({
        code: conflictCodeByField[field],
        evidenceIds: [...values.values()].flat().sort(),
        detail: `Cited records disagree on ${field}.`,
      });
    }
  }

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
      conflicts.push({
        code: "AUTHORIZATION_NONCE_REPLAY",
        evidenceIds: [record.evidenceId, ...replayed.map((item) => item.evidenceId)].sort(),
        detail: "The same authorization nonce appears under another action.",
      });
    }
  }

  const settlements = (byType.get("settlement") ?? []).filter(
    (record): record is Extract<EvidenceRecord, { evidenceType: "settlement" }> =>
      record.evidenceType === "settlement",
  );
  for (const refund of (byType.get("refund") ?? []).filter(
    (record): record is Extract<EvidenceRecord, { evidenceType: "refund" }> =>
      record.evidenceType === "refund",
  )) {
    const original = settlements.find(
      (record) => record.payload.transactionHash === refund.payload.originalTransactionHash,
    );
    if (!original || original.payload.amountBaseUnits !== refund.payload.amountBaseUnits) {
      conflicts.push({
        code: "REFUND_AMOUNT_MISMATCH",
        evidenceIds: [refund.evidenceId, ...(original ? [original.evidenceId] : [])].sort(),
        detail: "The refund does not exactly match a cited settlement amount.",
      });
    }
  }

  const deduplicatedConflicts = [
    ...new Map(conflicts.map((conflict) => [`${conflict.code}:${conflict.evidenceIds.join(",")}`, conflict])).values(),
  ].sort(
    (left, right) => conflictOrder.indexOf(left.code) - conflictOrder.indexOf(right.code),
  );

  const policyEvaluation = evaluatePolicies(action, sorted, policies, evaluatedAt);
  const expiredAuthorization = (byType.get("authorization") ?? []).some((record) => {
    if (record.evidenceType !== "authorization") return false;
    const at = evidenceTime(record);
    return at < record.payload.validAfter || at > record.payload.validBefore;
  });
  const expiredRequirementWithoutAuthorization =
    (byType.get("authorization") ?? []).length === 0 &&
    (byType.get("payment_requirement") ?? []).some(
      (record) =>
        record.evidenceType === "payment_requirement" && evaluatedAt > record.payload.validBefore,
    );
  const hasFailure = sorted.some(
    (record) =>
      (record.evidenceType === "fulfillment" && record.payload.providerStatus === "failed") ||
      (record.evidenceType === "settlement" && record.payload.settlementStatus === "failed"),
  );
  const hasRefund = (byType.get("refund") ?? []).length > 0;

  let state: z.infer<typeof ReconciliationResultSchema>["state"];
  if (deduplicatedConflicts.length > 0) state = "CONFLICTING_EVIDENCE";
  else if (hasRefund) state = "REFUNDED";
  else if (hasFailure) state = "FAILED";
  else if (expiredAuthorization || expiredRequirementWithoutAuthorization) state = "EXPIRED";
  else if (policyEvaluation.state === "flagged") state = "DENIED_BY_POLICY";
  else if (action.kind !== "paid_api_request") state = "UNSUPPORTED";
  else if (gaps.some((gap) => gap.code === "INTENT_MISSING")) state = "INTENT_NOT_SUPPLIED";
  else if (gaps.some((gap) => gap.code === "SETTLEMENT_MISSING")) state = "SETTLEMENT_UNVERIFIED";
  else if (gaps.some((gap) => gap.code === "FULFILLMENT_MISSING")) state = "FULFILLMENT_UNVERIFIED";
  else if (gaps.length > 0) state = "UNSUPPORTED";
  else state = "RECONCILED";

  return ReconciliationResultSchema.parse({
    schemaVersion: "openarc.reconciliation.v1",
    ruleVersion: "openarc.reconcile.v1",
    actionId: action.actionId,
    evaluatedAt,
    state,
    evidenceIds: sorted.map((record) => record.evidenceId),
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

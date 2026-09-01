import { z } from "zod";

import { ARC_TESTNET } from "./network.js";
import {
  CanonicalIntegerSchema,
  EvmAddressSchema,
  IsoTimestampSchema,
  Sha256DigestSchema,
  TransactionHashSchema,
  compareIsoTimestamps,
} from "./primitives.js";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const uniqueArray = <T extends z.ZodType>(item: T, maximum: number, minimum = 0) =>
  z.array(item).min(minimum).max(maximum).refine((items) => new Set(items).size === items.length, {
    message: "Expected unique values",
  });
const isFixtureReference = (value: string) => /^fixture:[a-z0-9._/-]{1,160}$/u.test(value);

export const ActionIdSchema = z.string().regex(/^act_[0-9a-f]{32}$/u);
export const EvidenceIdSchema = z.string().regex(/^evd_[0-9a-f]{32}$/u);
export const PolicyIdSchema = z.string().regex(/^pol_[0-9a-f]{32}$/u);
export const Bytes32Schema = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/u, "Expected a lowercase 32-byte value");

export const EvidenceClassSchema = z.enum([
  "local",
  "signed",
  "agent_reported",
  "provider",
  "gateway",
  "onchain",
  "openarc_derived",
]);

export const ActionKindSchema = z.enum([
  "paid_api_request",
  "transfer",
  "contract_call",
  "bridge",
  "swap",
]);

export const EvidenceSourceSchema = z.strictObject({
  kind: z.enum(["owner", "agent_connector", "provider", "gateway", "arc_rpc", "arc_contract"]),
  sourceId: z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/u),
  label: boundedText(80),
  reference: z
    .string()
    .max(240)
    .refine(isFixtureReference, "M01 accepts only a bounded synthetic fixture reference"),
  origin: z.null(),
  environment: z.literal("synthetic_fixture"),
  adapterVersion: z.literal("m01.fixture.v1"),
  network: z.literal(ARC_TESTNET.caip2).nullable(),
});

export const PaymentCorrelationSchema = z.strictObject({
  network: z.literal(ARC_TESTNET.caip2),
  asset: z.literal(ARC_TESTNET.contracts.usdc.toLowerCase()),
  payer: EvmAddressSchema,
  payTo: EvmAddressSchema,
  amountBaseUnits: CanonicalIntegerSchema.refine((value) => value !== "0", {
    message: "Payment amount must be positive",
  }),
  authorizationNonce: Bytes32Schema,
  resourceDigest: Sha256DigestSchema,
});

const validityWindowShape = {
  validAfter: IsoTimestampSchema,
  validBefore: IsoTimestampSchema,
};

const validWindow = <T extends { validAfter: string; validBefore: string }>(value: T) =>
  compareIsoTimestamps(value.validAfter, value.validBefore) < 0;

const IntentPayloadSchema = PaymentCorrelationSchema.extend({
  mandateDigest: Sha256DigestSchema,
});

const AttemptPayloadSchema = PaymentCorrelationSchema.extend({
  connectorEventId: z.string().regex(/^evt_[0-9a-f]{24}$/u),
});

const RequirementPayloadSchema = PaymentCorrelationSchema.extend({
  ...validityWindowShape,
  requirementDigest: Sha256DigestSchema,
}).refine(validWindow, {
  message: "validAfter must precede validBefore",
});

const AuthorizationPayloadSchema = PaymentCorrelationSchema.extend({
  ...validityWindowShape,
  authorizationDigest: Sha256DigestSchema,
}).refine(validWindow, {
  message: "validAfter must precede validBefore",
});

const FulfillmentPayloadSchema = z.strictObject({
  resourceDigest: Sha256DigestSchema,
  providerStatus: z.enum(["fulfilled", "failed"]),
  responseDigest: Sha256DigestSchema.nullable(),
}).superRefine((payload, context) => {
  if (payload.providerStatus === "fulfilled" && payload.responseDigest === null) {
    context.addIssue({
      code: "custom",
      message: "Fulfilled provider evidence requires a response digest",
      path: ["responseDigest"],
    });
  }
});

const SettlementPayloadSchema = PaymentCorrelationSchema.extend({
  transactionHash: TransactionHashSchema,
  blockHash: TransactionHashSchema,
  blockNumber: CanonicalIntegerSchema,
  settlementStatus: z.enum(["pending", "settled", "failed"]),
});

const RefundPayloadSchema = z.strictObject({
  originalTransactionHash: TransactionHashSchema,
  refundTransactionHash: TransactionHashSchema,
  amountBaseUnits: CanonicalIntegerSchema.refine((value) => value !== "0"),
  blockHash: TransactionHashSchema,
  blockNumber: CanonicalIntegerSchema,
});

const evidenceBase = {
  schemaVersion: z.literal("openarc.evidence.v1"),
  evidenceId: EvidenceIdSchema,
  actionId: ActionIdSchema,
  source: EvidenceSourceSchema,
  observedAt: IsoTimestampSchema,
  occurredAt: IsoTimestampSchema.nullable(),
  limitations: uniqueArray(boundedText(240), 8, 1),
};

const EvidenceRecordVariantSchema = z.discriminatedUnion("evidenceType", [
  z.strictObject({
    ...evidenceBase,
    evidenceType: z.literal("intent"),
    class: z.enum(["local", "signed"]),
    payload: IntentPayloadSchema,
  }),
  z.strictObject({
    ...evidenceBase,
    evidenceType: z.literal("attempt"),
    class: z.literal("agent_reported"),
    payload: AttemptPayloadSchema,
  }),
  z.strictObject({
    ...evidenceBase,
    evidenceType: z.literal("payment_requirement"),
    class: z.literal("provider"),
    payload: RequirementPayloadSchema,
  }),
  z.strictObject({
    ...evidenceBase,
    evidenceType: z.literal("authorization"),
    class: z.literal("signed"),
    payload: AuthorizationPayloadSchema,
  }),
  z.strictObject({
    ...evidenceBase,
    evidenceType: z.literal("fulfillment"),
    class: z.literal("provider"),
    payload: FulfillmentPayloadSchema,
  }),
  z.strictObject({
    ...evidenceBase,
    evidenceType: z.literal("settlement"),
    class: z.enum(["gateway", "onchain"]),
    payload: SettlementPayloadSchema,
  }),
  z.strictObject({
    ...evidenceBase,
    evidenceType: z.literal("refund"),
    class: z.enum(["gateway", "onchain"]),
    payload: RefundPayloadSchema,
  }),
]);

export const EvidenceRecordSchema = EvidenceRecordVariantSchema.superRefine((record, context) => {
  const failSource = (message: string) =>
    context.addIssue({ code: "custom", message, path: ["source"] });

  if (
    record.occurredAt !== null &&
    compareIsoTimestamps(record.occurredAt, record.observedAt) > 0
  ) {
    context.addIssue({
      code: "custom",
      message: "Evidence cannot occur after it was observed",
      path: ["occurredAt"],
    });
  }

  if (record.evidenceType === "intent" || record.evidenceType === "authorization") {
    if (record.source.kind !== "owner" || record.source.network !== null) {
      failSource(`${record.evidenceType} evidence requires a synthetic owner source without a network claim`);
    }
    return;
  }
  if (record.evidenceType === "attempt") {
    if (record.source.kind !== "agent_connector" || record.source.network !== null) {
      failSource("attempt evidence requires a synthetic agent-connector source without a network claim");
    }
    return;
  }
  if (record.evidenceType === "payment_requirement" || record.evidenceType === "fulfillment") {
    if (record.source.kind !== "provider" || record.source.network !== null) {
      failSource(`${record.evidenceType} evidence requires a synthetic provider source without a network claim`);
    }
    return;
  }
  if (record.class === "gateway") {
    if (record.source.kind !== "gateway" || record.source.network !== ARC_TESTNET.caip2) {
      failSource(`${record.evidenceType} gateway evidence requires the pinned synthetic Gateway source and network`);
    }
    return;
  }
  if (
    record.source.kind !== "arc_rpc" &&
    record.source.kind !== "arc_contract"
  ) {
    failSource(`${record.evidenceType} onchain evidence requires a pinned synthetic Arc source`);
  }
  if (record.source.network !== ARC_TESTNET.caip2) {
    failSource(`${record.evidenceType} onchain evidence requires the pinned Arc Testnet network`);
  }
});

export const PositiveActionStateSchema = z.enum([
  "PROPOSED",
  "PERMITTED",
  "ATTEMPTED",
  "AUTHORIZED",
  "FULFILLED",
  "SETTLING",
  "SETTLED",
  "RECONCILED",
]);

export const AttentionActionStateSchema = z.enum([
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

export const ActionStateSchema = z.union([
  PositiveActionStateSchema,
  AttentionActionStateSchema,
]);

export const ActionTransitionSchema = z.strictObject({
  sequence: z.number().int().min(1).max(16),
  state: ActionStateSchema,
  at: IsoTimestampSchema,
  evidenceIds: uniqueArray(EvidenceIdSchema, 8),
}).superRefine((transition, context) => {
  if (transition.state === "PROPOSED" && transition.evidenceIds.length !== 0) {
    context.addIssue({
      code: "custom",
      message: "PROPOSED records action creation and must not cite evidence",
      path: ["evidenceIds"],
    });
  }
  if (transition.state !== "PROPOSED" && transition.evidenceIds.length === 0) {
    context.addIssue({
      code: "custom",
      message: `${transition.state} must cite supporting evidence`,
      path: ["evidenceIds"],
    });
  }
  if (transition.state === "RECONCILED" && transition.evidenceIds.length < 2) {
    context.addIssue({
      code: "custom",
      message: "RECONCILED must cite fulfillment and settlement evidence",
      path: ["evidenceIds"],
    });
  }
  if (transition.state === "CONFLICTING_EVIDENCE" && transition.evidenceIds.length < 2) {
    context.addIssue({
      code: "custom",
      message: "CONFLICTING_EVIDENCE must cite at least two records",
      path: ["evidenceIds"],
    });
  }
});

export const AllowedActionStateEdges: Readonly<Record<z.infer<typeof ActionStateSchema>, readonly z.infer<typeof ActionStateSchema>[]>> = Object.freeze({
  PROPOSED: Object.freeze([
    "PERMITTED", "ATTEMPTED", "DENIED_BY_POLICY", "INTENT_NOT_SUPPLIED", "UNSUPPORTED",
  ]),
  PERMITTED: Object.freeze([
    "ATTEMPTED", "DENIED_BY_POLICY", "EXPIRED", "INTENT_NOT_SUPPLIED", "UNSUPPORTED",
  ]),
  ATTEMPTED: Object.freeze([
    "AUTHORIZED", "FULFILLED", "FAILED", "EXPIRED", "DENIED_BY_POLICY",
    "FULFILLMENT_UNVERIFIED", "SETTLEMENT_UNVERIFIED", "INTENT_NOT_SUPPLIED",
    "CONFLICTING_EVIDENCE", "UNSUPPORTED",
  ]),
  AUTHORIZED: Object.freeze([
    "FULFILLED", "SETTLING", "SETTLED", "FAILED", "EXPIRED",
    "FULFILLMENT_UNVERIFIED", "SETTLEMENT_UNVERIFIED", "INTENT_NOT_SUPPLIED",
    "CONFLICTING_EVIDENCE", "UNSUPPORTED",
  ]),
  FULFILLED: Object.freeze([
    "SETTLING", "SETTLED", "RECONCILED", "FAILED", "SETTLEMENT_UNVERIFIED",
    "INTENT_NOT_SUPPLIED", "CONFLICTING_EVIDENCE",
  ]),
  SETTLING: Object.freeze([
    "SETTLED", "FAILED", "EXPIRED", "SETTLEMENT_UNVERIFIED", "CONFLICTING_EVIDENCE",
  ]),
  SETTLED: Object.freeze([
    "RECONCILED", "REFUNDED", "FULFILLMENT_UNVERIFIED", "INTENT_NOT_SUPPLIED",
    "CONFLICTING_EVIDENCE",
  ]),
  RECONCILED: Object.freeze(["REFUNDED", "CONFLICTING_EVIDENCE"]),
  DENIED_BY_POLICY: Object.freeze([]),
  EXPIRED: Object.freeze([]),
  FAILED: Object.freeze([]),
  REFUNDED: Object.freeze([]),
  CONFLICTING_EVIDENCE: Object.freeze([]),
  FULFILLMENT_UNVERIFIED: Object.freeze([]),
  SETTLEMENT_UNVERIFIED: Object.freeze([]),
  INTENT_NOT_SUPPLIED: Object.freeze([]),
  UNSUPPORTED: Object.freeze([]),
}) as Readonly<Record<z.infer<typeof ActionStateSchema>, readonly z.infer<typeof ActionStateSchema>[]>>;

export function stateHistoryIssues(
  history: readonly z.infer<typeof ActionTransitionSchema>[],
): string[] {
  const issues: string[] = [];
  let priorAt: string | null = null;

  if (history[0]?.state !== "PROPOSED") issues.push("Action state history must begin at PROPOSED");

  history.forEach((transition, index) => {
    if (transition.sequence !== index + 1) issues.push("State sequence must be contiguous");
    if (priorAt !== null && compareIsoTimestamps(transition.at, priorAt) < 0) {
      issues.push("State timestamps must be monotonic");
    }
    priorAt = transition.at;

    if (index > 0) {
      const previous = history[index - 1]!;
      if (!AllowedActionStateEdges[previous.state].includes(transition.state)) {
        issues.push(`State transition ${previous.state} -> ${transition.state} is not allowed`);
      }
    }
  });

  return [...new Set(issues)];
}

export const PolicyViolationSchema = z.strictObject({
  code: z.enum([
    "POLICY_EXPIRED",
    "NETWORK_NOT_ALLOWED",
    "ASSET_NOT_ALLOWED",
    "RECIPIENT_NOT_ALLOWED",
    "AMOUNT_ABOVE_LIMIT",
  ]),
  detail: boundedText(240),
});

export const PolicyEvaluationSchema = z.strictObject({
  mode: z.literal("local_monitoring_only"),
  state: z.enum(["permitted", "flagged", "unevaluable", "not_applicable"]),
  matchedPolicyIds: uniqueArray(PolicyIdSchema, 32),
  violations: z.array(PolicyViolationSchema).max(16),
}).superRefine((evaluation, context) => {
  if (new Set(evaluation.violations.map((violation) => violation.code)).size !== evaluation.violations.length) {
    context.addIssue({ code: "custom", message: "Policy violation codes must be unique" });
  }
  if (evaluation.state === "not_applicable") {
    if (evaluation.matchedPolicyIds.length !== 0 || evaluation.violations.length !== 0) {
      context.addIssue({
        code: "custom",
        message: "A not-applicable policy evaluation cannot contain matches or violations",
      });
    }
    return;
  }
  if (evaluation.matchedPolicyIds.length === 0) {
    context.addIssue({ code: "custom", message: `${evaluation.state} requires a matched policy` });
  }
  if (evaluation.state === "unevaluable" && evaluation.violations.length !== 0) {
    context.addIssue({
      code: "custom",
      message: "An unevaluable policy evaluation cannot contain derived violations",
    });
  }
  if (evaluation.state === "permitted" && evaluation.violations.length !== 0) {
    context.addIssue({
      code: "custom",
      message: "A permitted policy evaluation cannot contain violations",
    });
  }
  if (evaluation.state === "flagged" && evaluation.violations.length === 0) {
    context.addIssue({ code: "custom", message: "A flagged policy evaluation requires a violation" });
  }
});

export const ReconciliationGapSchema = z.strictObject({
  code: z.enum([
    "INTENT_MISSING",
    "ATTEMPT_MISSING",
    "REQUIREMENT_MISSING",
    "AUTHORIZATION_MISSING",
    "FULFILLMENT_MISSING",
    "SETTLEMENT_MISSING",
    "SETTLEMENT_PENDING",
  ]),
  detail: boundedText(240),
});

export const ReconciliationConflictSchema = z.strictObject({
  code: z.enum([
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
  ]),
  evidenceIds: uniqueArray(EvidenceIdSchema, 64, 1),
  detail: boundedText(240),
});

export const ReconciliationResultSchema = z.strictObject({
  schemaVersion: z.literal("openarc.reconciliation.v1"),
  ruleVersion: z.literal("openarc.reconcile.v1"),
  actionId: ActionIdSchema,
  evaluatedAt: IsoTimestampSchema,
  state: ActionStateSchema,
  evidenceIds: uniqueArray(EvidenceIdSchema, 64, 1),
  gaps: z.array(ReconciliationGapSchema).max(16),
  conflicts: z.array(ReconciliationConflictSchema).max(16),
  limitations: uniqueArray(boundedText(240), 8, 1),
  policyEvaluation: PolicyEvaluationSchema,
}).superRefine((result, context) => {
  const gapCodes = new Set(result.gaps.map((gap) => gap.code));
  if (gapCodes.size !== result.gaps.length) {
    context.addIssue({ code: "custom", message: "Reconciliation gaps must have unique codes" });
  }
  const conflictKeys = new Set(
    result.conflicts.map((conflict) => `${conflict.code}:${[...conflict.evidenceIds].sort().join(",")}`),
  );
  if (conflictKeys.size !== result.conflicts.length) {
    context.addIssue({ code: "custom", message: "Reconciliation conflicts must be unique" });
  }
  if (result.state === "CONFLICTING_EVIDENCE" && result.conflicts.length === 0) {
    context.addIssue({ code: "custom", message: "CONFLICTING_EVIDENCE requires a conflict" });
  }
  if (result.state !== "CONFLICTING_EVIDENCE" && result.conflicts.length !== 0) {
    context.addIssue({
      code: "custom",
      message: `${result.state} cannot retain a higher-precedence conflict`,
    });
  }
  if (
    result.state === "RECONCILED" &&
    (
      result.gaps.length !== 0 ||
      !["permitted", "not_applicable"].includes(result.policyEvaluation.state)
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "RECONCILED requires no gaps and an evaluable or inapplicable policy result",
    });
  }
  if (result.state === "DENIED_BY_POLICY" && result.policyEvaluation.state !== "flagged") {
    context.addIssue({ code: "custom", message: "DENIED_BY_POLICY requires a flagged policy evaluation" });
  }
  if (result.state === "INTENT_NOT_SUPPLIED" && !gapCodes.has("INTENT_MISSING")) {
    context.addIssue({ code: "custom", message: "INTENT_NOT_SUPPLIED requires INTENT_MISSING" });
  }
  if (result.state === "FULFILLMENT_UNVERIFIED" && !gapCodes.has("FULFILLMENT_MISSING")) {
    context.addIssue({ code: "custom", message: "FULFILLMENT_UNVERIFIED requires FULFILLMENT_MISSING" });
  }
  if (
    result.state === "SETTLEMENT_UNVERIFIED" &&
    !gapCodes.has("SETTLEMENT_MISSING") &&
    !gapCodes.has("SETTLEMENT_PENDING")
  ) {
    context.addIssue({
      code: "custom",
      message: "SETTLEMENT_UNVERIFIED requires missing or pending settlement evidence",
    });
  }
});

const actionReferenceLists = {
  intentEvidenceIds: uniqueArray(EvidenceIdSchema, 8),
  attemptEvidenceIds: uniqueArray(EvidenceIdSchema, 8),
  paymentEvidenceIds: uniqueArray(EvidenceIdSchema, 8),
  fulfillmentEvidenceIds: uniqueArray(EvidenceIdSchema, 8),
  settlementEvidenceIds: uniqueArray(EvidenceIdSchema, 8),
};

export const ActionEnvelopeSchema = z
  .strictObject({
    schemaVersion: z.literal("openarc.action.v1"),
    actionId: ActionIdSchema,
    agentId: z.string().regex(/^agent_[0-9a-f]{32}$/u),
    kind: ActionKindSchema,
    createdAt: IsoTimestampSchema,
    states: z.array(ActionTransitionSchema).min(1).max(16),
    ...actionReferenceLists,
    policyEvaluation: PolicyEvaluationSchema.nullable(),
    reconciliation: ReconciliationResultSchema.nullable(),
  })
  .superRefine((action, context) => {
    for (const issue of stateHistoryIssues(action.states)) {
      context.addIssue({ code: "custom", message: issue, path: ["states"] });
    }
    if (
      action.states[0] !== undefined &&
      compareIsoTimestamps(action.states[0].at, action.createdAt) !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: "The PROPOSED transition must occur at action creation",
        path: ["states", 0, "at"],
      });
    }
    const references = [
      ...action.intentEvidenceIds,
      ...action.attemptEvidenceIds,
      ...action.paymentEvidenceIds,
      ...action.fulfillmentEvidenceIds,
      ...action.settlementEvidenceIds,
    ];
    if (new Set(references).size !== references.length) {
      context.addIssue({
        code: "custom",
        message: "An evidence ID may appear in only one action relationship list",
      });
    }
    if (action.reconciliation !== null && action.reconciliation.actionId !== action.actionId) {
      context.addIssue({
        code: "custom",
        message: "Embedded reconciliation belongs to a different action",
        path: ["reconciliation", "actionId"],
      });
    }
    if (
      action.reconciliation !== null &&
      (
        action.policyEvaluation === null ||
        JSON.stringify(action.reconciliation.policyEvaluation) !== JSON.stringify(action.policyEvaluation)
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Embedded policy and reconciliation output must agree exactly",
        path: ["policyEvaluation"],
      });
    }
    const finalState = action.states.at(-1)?.state;
    const terminalConclusionStates = new Set([
      "RECONCILED", "DENIED_BY_POLICY", "EXPIRED", "FAILED", "REFUNDED",
      "CONFLICTING_EVIDENCE", "FULFILLMENT_UNVERIFIED", "SETTLEMENT_UNVERIFIED",
      "INTENT_NOT_SUPPLIED", "UNSUPPORTED",
    ]);
    if (
      action.reconciliation !== null &&
      finalState !== undefined &&
      terminalConclusionStates.has(finalState) &&
      action.reconciliation.state !== finalState
    ) {
      context.addIssue({
        code: "custom",
        message: "Embedded reconciliation contradicts the final action conclusion",
        path: ["reconciliation", "state"],
      });
    }

    const relationshipIds = {
      intent: new Set(action.intentEvidenceIds),
      attempt: new Set(action.attemptEvidenceIds),
      payment: new Set(action.paymentEvidenceIds),
      fulfillment: new Set(action.fulfillmentEvidenceIds),
      settlement: new Set(action.settlementEvidenceIds),
    } as const;
    const allRelationshipIds = new Set(references);
    const allowedBucketsByState: Readonly<Record<z.infer<typeof ActionStateSchema>, readonly (keyof typeof relationshipIds)[]>> = {
      PROPOSED: [],
      PERMITTED: ["intent"],
      ATTEMPTED: ["attempt"],
      AUTHORIZED: ["payment"],
      FULFILLED: ["fulfillment"],
      SETTLING: ["settlement"],
      SETTLED: ["settlement"],
      RECONCILED: ["fulfillment", "settlement"],
      DENIED_BY_POLICY: ["intent", "attempt"],
      EXPIRED: ["payment"],
      FAILED: ["fulfillment", "settlement"],
      REFUNDED: ["settlement"],
      CONFLICTING_EVIDENCE: ["intent", "attempt", "payment", "fulfillment", "settlement"],
      FULFILLMENT_UNVERIFIED: ["payment", "settlement"],
      SETTLEMENT_UNVERIFIED: ["payment", "fulfillment"],
      INTENT_NOT_SUPPLIED: ["attempt", "payment", "fulfillment", "settlement"],
      UNSUPPORTED: ["intent", "attempt", "payment", "fulfillment", "settlement"],
    };

    action.states.forEach((transition, index) => {
      const allowedBuckets = allowedBucketsByState[transition.state];
      const allowedIds = new Set(
        allowedBuckets.flatMap((bucket) => [...relationshipIds[bucket]]),
      );
      for (const evidenceId of transition.evidenceIds) {
        if (!allRelationshipIds.has(evidenceId) || !allowedIds.has(evidenceId)) {
          context.addIssue({
            code: "custom",
            message: `${transition.state} cites evidence outside its permitted action relationship`,
            path: ["states", index, "evidenceIds"],
          });
        }
      }
      if (transition.state === "RECONCILED") {
        const hasFulfillment = transition.evidenceIds.some((id) => relationshipIds.fulfillment.has(id));
        const hasSettlement = transition.evidenceIds.some((id) => relationshipIds.settlement.has(id));
        if (!hasFulfillment || !hasSettlement) {
          context.addIssue({
            code: "custom",
            message: "RECONCILED must cite both fulfillment and settlement relationships",
            path: ["states", index, "evidenceIds"],
          });
        }
      }
    });
  });

export const MonitoringPolicySchema = z.strictObject({
  schemaVersion: z.literal("openarc.policy.v1"),
  policyId: PolicyIdSchema,
  label: boundedText(160),
  mode: z.literal("local_monitoring_only"),
  enabled: z.boolean(),
  actionKind: z.literal("paid_api_request"),
  network: z.literal(ARC_TESTNET.caip2),
  asset: z.literal(ARC_TESTNET.contracts.usdc.toLowerCase()),
  maximumAmountBaseUnits: CanonicalIntegerSchema,
  allowedRecipients: uniqueArray(EvmAddressSchema, 16),
  expiresAt: IsoTimestampSchema.nullable(),
});

export type ActionEnvelope = z.infer<typeof ActionEnvelopeSchema>;
export type ActionState = z.infer<typeof ActionStateSchema>;
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
export type MonitoringPolicy = z.infer<typeof MonitoringPolicySchema>;
export type PaymentCorrelation = z.infer<typeof PaymentCorrelationSchema>;
export type PolicyEvaluation = z.infer<typeof PolicyEvaluationSchema>;
export type ReconciliationResult = z.infer<typeof ReconciliationResultSchema>;

import { z } from "zod";

import { ARC_TESTNET } from "./network.js";
import {
  CanonicalIntegerSchema,
  EvmAddressSchema,
  IsoTimestampSchema,
  Sha256DigestSchema,
  TransactionHashSchema,
} from "./primitives.js";

const boundedText = (maximum: number) => z.string().trim().min(1).max(maximum);
const uniqueArray = <T extends z.ZodType>(item: T, maximum: number) =>
  z.array(item).max(maximum).refine((items) => new Set(items).size === items.length, {
    message: "Expected unique values",
  });
const isEvidenceReference = (value: string) => {
  if (/^fixture:[a-z0-9._/-]{1,160}$/u.test(value)) return true;
  return /^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?(?::[0-9]{1,5})?(?:[/?#][^\s]*)?$/iu.test(
    value,
  );
};

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
  sourceId: z.string().regex(/^[a-z][a-z0-9._-]{1,63}$/u),
  label: boundedText(80),
  reference: z
    .string()
    .max(240)
    .refine(isEvidenceReference, "Expected a bounded fixture or HTTPS reference"),
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

const ValidityWindowSchema = z
  .strictObject({
    validAfter: IsoTimestampSchema,
    validBefore: IsoTimestampSchema,
  })
  .refine((value) => value.validAfter < value.validBefore, {
    message: "validAfter must precede validBefore",
  });

const IntentPayloadSchema = PaymentCorrelationSchema.extend({
  mandateDigest: Sha256DigestSchema,
});

const AttemptPayloadSchema = PaymentCorrelationSchema.extend({
  connectorEventId: z.string().regex(/^evt_[0-9a-f]{24}$/u),
});

const RequirementPayloadSchema = PaymentCorrelationSchema.extend({
  ...ValidityWindowSchema.shape,
  requirementDigest: Sha256DigestSchema,
});

const AuthorizationPayloadSchema = PaymentCorrelationSchema.extend({
  ...ValidityWindowSchema.shape,
  authorizationDigest: Sha256DigestSchema,
});

const FulfillmentPayloadSchema = z.strictObject({
  resourceDigest: Sha256DigestSchema,
  providerStatus: z.enum(["fulfilled", "failed"]),
  responseDigest: Sha256DigestSchema.nullable(),
});

const SettlementPayloadSchema = PaymentCorrelationSchema.extend({
  transactionHash: TransactionHashSchema,
  blockHash: TransactionHashSchema,
  blockNumber: CanonicalIntegerSchema,
  settlementStatus: z.enum(["settled", "failed"]),
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
  limitations: uniqueArray(boundedText(240), 8),
};

export const EvidenceRecordSchema = z.discriminatedUnion("evidenceType", [
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
});

const positiveStateOrder = new Map(
  PositiveActionStateSchema.options.map((state, index) => [state, index]),
);

export function stateHistoryIssues(
  history: readonly z.infer<typeof ActionTransitionSchema>[],
): string[] {
  const issues: string[] = [];
  let priorPositive = -1;
  let priorAt = "";
  let terminalSeen = false;

  if (history[0]?.state !== "PROPOSED") issues.push("Action state history must begin at PROPOSED");

  history.forEach((transition, index) => {
    if (transition.sequence !== index + 1) issues.push("State sequence must be contiguous");
    if (priorAt && transition.at < priorAt) issues.push("State timestamps must be monotonic");
    priorAt = transition.at;

    const positiveOrder = positiveStateOrder.get(
      transition.state as z.infer<typeof PositiveActionStateSchema>,
    );
    if (positiveOrder === undefined) {
      if (terminalSeen || index !== history.length - 1) {
        issues.push("An attention or terminal state must be the final transition");
      }
      terminalSeen = true;
      return;
    }
    if (terminalSeen || positiveOrder <= priorPositive) {
      issues.push("Positive action states must advance monotonically");
    }
    priorPositive = positiveOrder;
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
  state: z.enum(["permitted", "flagged", "not_applicable"]),
  matchedPolicyIds: uniqueArray(PolicyIdSchema, 32),
  violations: z.array(PolicyViolationSchema).max(16),
});

export const ReconciliationGapSchema = z.strictObject({
  code: z.enum([
    "INTENT_MISSING",
    "ATTEMPT_MISSING",
    "REQUIREMENT_MISSING",
    "AUTHORIZATION_MISSING",
    "FULFILLMENT_MISSING",
    "SETTLEMENT_MISSING",
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
    "AUTHORIZATION_NONCE_REPLAY",
    "REFUND_AMOUNT_MISMATCH",
  ]),
  evidenceIds: uniqueArray(EvidenceIdSchema, 16),
  detail: boundedText(240),
});

export const ReconciliationResultSchema = z.strictObject({
  schemaVersion: z.literal("openarc.reconciliation.v1"),
  ruleVersion: z.literal("openarc.reconcile.v1"),
  actionId: ActionIdSchema,
  evaluatedAt: IsoTimestampSchema,
  state: ActionStateSchema,
  evidenceIds: uniqueArray(EvidenceIdSchema, 64),
  gaps: z.array(ReconciliationGapSchema).max(16),
  conflicts: z.array(ReconciliationConflictSchema).max(16),
  limitations: uniqueArray(boundedText(240), 8),
  policyEvaluation: PolicyEvaluationSchema,
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

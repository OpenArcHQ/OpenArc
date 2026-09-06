import { z } from "zod";

import { ARC_TESTNET } from "./network.js";
import {
  ActionEnvelopeSchema,
  ActionStateSchema,
  EvidenceRecordSchema,
  MonitoringPolicySchema,
  ReconciliationResultSchema,
} from "./evidence.js";
import { reconcileAction } from "./reconciliation.js";

import type { ActionEnvelope, EvidenceRecord, MonitoringPolicy } from "./evidence.js";

const FixtureSlugSchema = z.string().regex(/^[a-z][a-z0-9-]{1,47}$/u);

export const EvidenceFixtureSchema = z.strictObject({
  fixtureVersion: z.literal("openarc.fixture.v1"),
  fixtureId: FixtureSlugSchema,
  title: z.string().min(1).max(80),
  summary: z.string().min(1).max(240),
  expectedState: ActionStateSchema,
  action: ActionEnvelopeSchema,
  evidence: z.array(EvidenceRecordSchema).min(1).max(64),
  policies: z.array(MonitoringPolicySchema).max(32),
  evaluatedAt: z.literal("2026-09-01T12:15:00Z"),
  result: ReconciliationResultSchema,
}).superRefine((fixture, context) => {
  if (fixture.expectedState !== fixture.result.state) {
    context.addIssue({ code: "custom", message: "Fixture expected state must equal its result state" });
  }
  if (fixture.action.actionId !== fixture.result.actionId) {
    context.addIssue({ code: "custom", message: "Fixture action and result IDs must match" });
  }
  if (fixture.evaluatedAt !== fixture.result.evaluatedAt) {
    context.addIssue({ code: "custom", message: "Fixture and result evaluation timestamps must match" });
  }
  if (fixture.evidence.some((record) => record.actionId !== fixture.action.actionId)) {
    context.addIssue({ code: "custom", message: "Every fixture evidence record must belong to its action" });
  }
  if (fixture.action.policyEvaluation !== null || fixture.action.reconciliation !== null) {
    context.addIssue({
      code: "custom",
      message: "Fixture actions must be unresolved reconciliation inputs",
    });
  }
  const fixtureIds = [...new Set(fixture.evidence.map((record) => record.evidenceId))].sort();
  const resultIds = [...fixture.result.evidenceIds].sort();
  if (fixtureIds.length !== fixture.evidence.length || JSON.stringify(fixtureIds) !== JSON.stringify(resultIds)) {
    context.addIssue({
      code: "custom",
      message: "Fixture evidence must exactly match the records cited by its result",
    });
  }
  try {
    const recomputed = reconcileAction({
      action: fixture.action,
      evidence: fixture.evidence,
      policies: fixture.policies,
      evaluatedAt: fixture.evaluatedAt,
    });
    if (JSON.stringify(recomputed) !== JSON.stringify(fixture.result)) {
      context.addIssue({
        code: "custom",
        message: "Fixture result must exactly equal deterministic recomputation",
        path: ["result"],
      });
    }
  } catch {
    context.addIssue({
      code: "custom",
      message: "Fixture action and evidence must be valid unresolved reconciliation input",
    });
  }
});

export type EvidenceFixture = z.infer<typeof EvidenceFixtureSchema>;

type FixtureMode = "complete" | "missing" | "conflict" | "expired" | "failed" | "refunded";

const id = (prefix: "act" | "agent" | "evd" | "pol", fixture: number, item = 0) =>
  `${prefix}_${fixture.toString(16).padStart(2, "0")}${item
    .toString(16)
    .padStart(2, "0")}${"0".repeat(28)}`;
const hex = (value: number) => ((value % 15) + 1).toString(16);
const digest = (value: number) => `sha256:${hex(value).repeat(64)}`;
const bytes32 = (value: number) => `0x${hex(value).repeat(64)}`;
const address = (value: number) => `0x${hex(value).repeat(40)}`;

const source = (
  kind: "owner" | "agent_connector" | "provider" | "gateway" | "arc_rpc" | "arc_contract",
  sourceId: string,
  label: string,
  reference: string,
  network: typeof ARC_TESTNET.caip2 | null,
) => ({
  kind,
  sourceId,
  label,
  reference,
  origin: null,
  environment: "synthetic_fixture" as const,
  adapterVersion: "m01.fixture.v1" as const,
  network,
});

function makeRecord(
  fixture: number,
  item: number,
  input: Omit<z.input<typeof EvidenceRecordSchema>, "schemaVersion" | "evidenceId" | "actionId">,
): EvidenceRecord {
  return EvidenceRecordSchema.parse({
    schemaVersion: "openarc.evidence.v1",
    evidenceId: id("evd", fixture, item),
    actionId: id("act", fixture),
    ...input,
  });
}

function buildFixture(fixture: number, mode: FixtureMode): EvidenceFixture {
  const actionId = id("act", fixture);
  const payTo = address(8);
  const alternatePayTo = address(9);
  const core = {
    network: ARC_TESTNET.caip2,
    asset: ARC_TESTNET.contracts.usdc.toLowerCase(),
    payer: address(fixture),
    payTo,
    amountBaseUnits: `${fixture}250000`,
    authorizationNonce: bytes32(fixture),
    resourceDigest: digest(fixture),
  } as const;
  const validity =
    mode === "expired"
      ? { validAfter: "2026-09-01T11:50:00Z", validBefore: "2026-09-01T12:02:00Z" }
      : { validAfter: "2026-09-01T11:50:00Z", validBefore: "2026-09-01T12:30:00Z" };

  const intent = makeRecord(fixture, 1, {
    evidenceType: "intent",
    class: "local",
    source: source("owner", "owner-local", "Owner-supplied fixture", `fixture:m01/${mode}/intent`, null),
    observedAt: "2026-09-01T12:00:00Z",
    occurredAt: "2026-09-01T12:00:00Z",
    payload: { ...core, mandateDigest: digest(fixture + 20) },
    limitations: ["Owner-supplied intent is not wallet or protocol enforcement."],
  });
  const attempt = makeRecord(fixture, 2, {
    evidenceType: "attempt",
    class: "agent_reported",
    source: source("agent_connector", "fixture-agent", "Synthetic agent fixture", `fixture:m01/${mode}/attempt`, null),
    observedAt: "2026-09-01T12:01:00Z",
    occurredAt: "2026-09-01T12:01:00Z",
    payload: { ...core, connectorEventId: `evt_${hex(fixture + 1).repeat(24)}` },
    limitations: ["Agent-reported attempt does not prove authorization or settlement."],
  });
  const requirement = makeRecord(fixture, 3, {
    evidenceType: "payment_requirement",
    class: "provider",
    source: source("provider", "fixture-provider", "Synthetic provider fixture", `fixture:m01/${mode}/requirement`, null),
    observedAt: "2026-09-01T12:02:00Z",
    occurredAt: "2026-09-01T12:02:00Z",
    payload: { ...core, ...validity, requirementDigest: digest(fixture + 30) },
    limitations: ["A payment requirement is a provider claim, not settlement evidence."],
  });
  const authorization = makeRecord(fixture, 4, {
    evidenceType: "authorization",
    class: "signed",
    source: source("owner", "fixture-signature", "Synthetic signed fixture", `fixture:m01/${mode}/authorization`, null),
    observedAt: "2026-09-01T12:04:00Z",
    occurredAt: mode === "expired" ? "2026-09-01T12:03:00Z" : "2026-09-01T12:03:00Z",
    payload: {
      ...core,
      ...(mode === "conflict" ? { payTo: alternatePayTo } : {}),
      ...validity,
      authorizationDigest: digest(fixture + 40),
    },
    limitations: ["Synthetic signature metadata is not a reusable payment authorization."],
  });
  const fulfillment = makeRecord(fixture, 5, {
    evidenceType: "fulfillment",
    class: "provider",
    source: source("provider", "fixture-provider", "Synthetic provider fixture", `fixture:m01/${mode}/fulfillment`, null),
    observedAt: "2026-09-01T12:05:00Z",
    occurredAt: "2026-09-01T12:05:00Z",
    payload: {
      resourceDigest: core.resourceDigest,
      providerStatus: mode === "failed" ? "failed" : "fulfilled",
      responseDigest: mode === "failed" ? null : digest(fixture + 50),
    },
    limitations: ["Provider fulfillment does not prove response quality or settlement."],
  });
  const settlement = makeRecord(fixture, 6, {
    evidenceType: "settlement",
    class: "onchain",
    source: source(
      "arc_rpc",
      "arc-testnet-fixture",
      "Synthetic Arc Testnet fixture",
      `fixture:m01/${mode}/settlement`,
      ARC_TESTNET.caip2,
    ),
    observedAt: "2026-09-01T12:07:00Z",
    occurredAt: "2026-09-01T12:06:00Z",
    payload: {
      ...core,
      transactionHash: bytes32(fixture + 60),
      blockHash: bytes32(fixture + 70),
      blockNumber: `${1000 + fixture}`,
      settlementStatus: "settled",
    },
    limitations: ["Synthetic onchain settlement does not prove offchain fulfillment or intent."],
  });
  if (settlement.evidenceType !== "settlement") {
    throw new Error("Fixture settlement failed strict parsing");
  }
  const refund = makeRecord(fixture, 7, {
    evidenceType: "refund",
    class: "onchain",
    source: source(
      "arc_rpc",
      "arc-testnet-fixture",
      "Synthetic Arc Testnet fixture",
      `fixture:m01/${mode}/refund`,
      ARC_TESTNET.caip2,
    ),
    observedAt: "2026-09-01T12:09:00Z",
    occurredAt: "2026-09-01T12:08:00Z",
    payload: {
      originalTransactionHash: settlement.payload.transactionHash,
      refundTransactionHash: bytes32(fixture + 80),
      amountBaseUnits: core.amountBaseUnits,
      blockHash: bytes32(fixture + 90),
      blockNumber: `${1100 + fixture}`,
    },
    limitations: ["A refund is a later state and does not erase the original settlement."],
  });

  const evidence = [
    ...(mode === "missing" ? [] : [intent]),
    attempt,
    requirement,
    authorization,
    fulfillment,
    ...(["expired", "failed"].includes(mode) ? [] : [settlement]),
    ...(mode === "refunded" ? [refund] : []),
  ];

  const states: z.input<typeof ActionEnvelopeSchema>["states"] = [
    { sequence: 1, state: "PROPOSED", at: "2026-09-01T11:59:00Z", evidenceIds: [] },
  ];
  if (mode !== "missing") {
    states.push({ sequence: states.length + 1, state: "PERMITTED", at: intent.observedAt, evidenceIds: [intent.evidenceId] });
  }
  states.push({ sequence: states.length + 1, state: "ATTEMPTED", at: attempt.observedAt, evidenceIds: [attempt.evidenceId] });
  states.push({ sequence: states.length + 1, state: "AUTHORIZED", at: authorization.observedAt, evidenceIds: [authorization.evidenceId] });
  if (mode === "expired") {
    states.push({ sequence: states.length + 1, state: "EXPIRED", at: authorization.observedAt, evidenceIds: [authorization.evidenceId] });
  } else if (mode === "failed") {
    states.push({ sequence: states.length + 1, state: "FAILED", at: fulfillment.observedAt, evidenceIds: [fulfillment.evidenceId] });
  } else {
    states.push({ sequence: states.length + 1, state: "FULFILLED", at: fulfillment.observedAt, evidenceIds: [fulfillment.evidenceId] });
    states.push({ sequence: states.length + 1, state: "SETTLED", at: settlement.observedAt, evidenceIds: [settlement.evidenceId] });
    if (mode === "refunded") {
      states.push({ sequence: states.length + 1, state: "REFUNDED", at: refund.observedAt, evidenceIds: [refund.evidenceId] });
    }
  }

  const action: ActionEnvelope = ActionEnvelopeSchema.parse({
    schemaVersion: "openarc.action.v1",
    actionId,
    agentId: id("agent", fixture),
    kind: "paid_api_request",
    createdAt: "2026-09-01T11:59:00Z",
    states,
    intentEvidenceIds: mode === "missing" ? [] : [intent.evidenceId],
    attemptEvidenceIds: [attempt.evidenceId],
    paymentEvidenceIds: [requirement.evidenceId, authorization.evidenceId],
    fulfillmentEvidenceIds: [fulfillment.evidenceId],
    settlementEvidenceIds: [
      ...(["expired", "failed"].includes(mode) ? [] : [settlement.evidenceId]),
      ...(mode === "refunded" ? [refund.evidenceId] : []),
    ],
    policyEvaluation: null,
    reconciliation: null,
  });

  const policy: MonitoringPolicy = MonitoringPolicySchema.parse({
    schemaVersion: "openarc.policy.v1",
    policyId: id("pol", fixture),
    label: "Synthetic API payment monitoring policy",
    mode: "local_monitoring_only",
    enabled: true,
    actionKind: "paid_api_request",
    network: ARC_TESTNET.caip2,
    asset: ARC_TESTNET.contracts.usdc.toLowerCase(),
    maximumAmountBaseUnits: "999999999999",
    allowedRecipients: [payTo],
    expiresAt: "2026-09-02T00:00:00Z",
  });

  const expectedState = {
    complete: "RECONCILED",
    missing: "INTENT_NOT_SUPPLIED",
    conflict: "CONFLICTING_EVIDENCE",
    expired: "EXPIRED",
    failed: "FAILED",
    refunded: "REFUNDED",
  }[mode];
  const evaluatedAt = "2026-09-01T12:15:00Z" as const;
  const result = reconcileAction({ action, evidence, policies: [policy], evaluatedAt });

  return EvidenceFixtureSchema.parse({
    fixtureVersion: "openarc.fixture.v1",
    fixtureId: mode,
    title: {
      complete: "Complete evidence arc",
      missing: "Settlement without intent",
      conflict: "Recipient conflict",
      expired: "Expired authorization",
      failed: "Provider-reported failure",
      refunded: "Settled, then refunded",
    }[mode],
    summary: {
      complete: "Every required synthetic record agrees under the v1 rule.",
      missing: "Fulfillment and settlement exist, but no intent record is cited.",
      conflict: "The signed authorization names a different recipient.",
      expired: "The synthetic authorization occurred after its validity window.",
      failed: "The provider reports failure and no settlement is cited.",
      refunded: "A later exact refund remains visible after the original settlement.",
    }[mode],
    expectedState,
    action,
    evidence,
    policies: [policy],
    evaluatedAt,
    result,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export const M01_FIXTURES = deepFreeze(
  (["complete", "missing", "conflict", "expired", "failed", "refunded"] as const).map(
    (mode, index) => buildFixture(index + 1, mode),
  ),
);

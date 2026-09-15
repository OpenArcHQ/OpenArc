import { z } from "zod";

import { Bytes32Schema } from "../evidence.js";
import { IsoTimestampSchema, Uint256DecimalSchema, compareIsoTimestamps } from "../primitives.js";
import { CanonicalTransferIdSchema } from "../x402-evidence.js";
import {
  CommerceActionStatusSchema,
  CommerceApprovalIdSchema,
  CommerceApprovalStatusSchema,
  CommerceReservationIdSchema,
  type CommerceActionStatus,
  type CommerceApprovalStatus,
} from "./control-action.js";
import { CommerceActionIdSchema } from "./control-budget.js";
import { CommerceGrantIdSchema } from "./control-grant.js";
import { CommerceGrantStatusSchema, type CommerceGrantStatus } from "./control-grant-model.js";
import {
  EVIDENCE_V2_FACT_KINDS,
  EVIDENCE_V2_GATEWAY_COMMITTED_LIMITATION,
  EVIDENCE_V2_SCHEMA_VERSION,
  EVIDENCE_V2_UNKNOWN_PAYMENT_LIMITATION,
  EvidenceV2AdapterVersionSchema,
  EvidenceV2FactSchema,
  EvidenceV2OriginSchema,
  EvidenceV2SourceIdSchema,
  derivePaymentCertainty,
  evidenceV2CertaintyForLaneState,
  evidenceV2FactStatus,
  summarizeEvidenceV2Exposure,
  type EvidenceV2Actor,
  type EvidenceV2ExposureBucket,
  type EvidenceV2ExposureSummary,
  type EvidenceV2Fact,
  type EvidenceV2FactOf,
  type EvidenceV2LaneExposure,
  type EvidenceV2PaymentCertainty,
} from "./evidence-v2.js";
import {
  CommerceAccountIdSchema,
  CommerceAgentIdSchema,
  CommerceOrganizationIdSchema,
  CommerceProviderIdSchema,
} from "./identity.js";
import { CommerceStateDimensionsSchema, type CommerceStateDimensions } from "./states.js";

/**
 * P05-02a — pure projection of commerce control facts into evidence v2.
 *
 * Input types are minimal structural shapes of the PORT-03/04 store reads
 * (action, approval, reservation, grant, payment attempt). Shared never
 * imports the database package: a store read object passes directly, and any
 * extra field on it (nonce, binding digest, token or session material) is
 * stripped before projection and never reaches a fact.
 *
 * Rules:
 *   * no clock: expiry is derived only against the explicit `evaluatedAt`,
 *     and a record is expired when `expiresAt <= evaluatedAt` (the same
 *     boundary as the SQL `NOT (expires_at > now)`);
 *   * attribution uses canonical server IDs only (account, agent, provider);
 *   * payment stays `not_requested` while no attempt exists, and an unknown
 *     attempt is unknown exposure in its own bucket;
 *   * dispatched attempts map through `derivePaymentCertainty`; nothing here
 *     yields paid, settled, refunded, failed or released;
 *   * the output depends only on the input set, never on array order.
 */

export const CONTROL_EVIDENCE_PROJECTION_RULE_VERSION = "openarc.control-evidence-projection.v1" as const;

export const CONTROL_RESERVATION_STATUSES = ["held", "claimed", "unknown", "committed", "released"] as const;
export type ControlReservationStatus = (typeof CONTROL_RESERVATION_STATUSES)[number];

export const CONTROL_PAYMENT_ATTEMPT_STATES = ["persisted", "unknown", "pending", "committed"] as const;
export type ControlPaymentAttemptState = (typeof CONTROL_PAYMENT_ATTEMPT_STATES)[number];

/** Structural subset of `CommerceActionMetadata`. */
export interface ControlActionFacts {
  readonly actionId: string;
  readonly exposureKey: { readonly organizationId: string; readonly subjectAgentId: string };
  readonly providerId: string;
  readonly status: CommerceActionStatus;
  readonly reservationId: string | null;
  readonly approvalId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
}

/** Structural subset of `CommerceApprovalMetadata`. */
export interface ControlApprovalFacts {
  readonly approvalId: string;
  readonly actionId: string;
  readonly organizationId: string;
  readonly subjectAgentId: string;
  readonly status: CommerceApprovalStatus;
  readonly decidedBy: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly decidedAt: string | null;
}

/** Structural shape of a `budget_reservations` row (schema10). */
export interface ControlReservationFacts {
  readonly organizationId: string;
  readonly reservationId: string;
  readonly actionId: string;
  readonly debitAtomic: string;
  readonly status: ControlReservationStatus;
  readonly createdAt: string;
  readonly claimedAt: string | null;
  readonly resolvedAt: string | null;
}

/** Structural subset of `CommerceGrantMetadata`. */
export interface ControlGrantFacts {
  readonly grantId: string;
  readonly organizationId: string;
  readonly subjectAgentId: string;
  readonly actionId: string;
  readonly reservationId: string;
  readonly providerId: string;
  readonly generation: string;
  readonly status: CommerceGrantStatus;
  readonly issuedAt: string;
  readonly updatedAt: string;
  readonly expiresAt: string;
  readonly claimedAt: string | null;
  readonly revokedAt: string | null;
}

/** Structural subset of the schema15 `PaymentAttemptRecord`. */
export interface ControlPaymentAttemptFacts {
  readonly organizationId: string;
  readonly attemptId: string;
  readonly grantId: string;
  readonly actionId: string;
  readonly providerId: string;
  readonly valueAtomic: string;
  readonly payerAddress: string;
  readonly payToAddress: string;
  readonly state: ControlPaymentAttemptState;
  readonly persistedAt: string;
  readonly dispatchedAt: string | null;
  readonly observedAt: string | null;
  readonly transferId: string | null;
  readonly gatewayStatus: "received" | "batched" | "confirmed" | "completed" | null;
  readonly batchTxHash: string | null;
}

/** The source that recorded Gateway observations on attempts. Required only when an attempt is pending or committed. */
export interface ControlPaymentObservationSource {
  readonly class: "gateway" | "facilitator";
  readonly sourceId: string;
  readonly origin: string;
  readonly adapterVersion: string;
}

/**
 * Operator attribution the store reads do not carry. Canonical account IDs
 * only; `null` attributes the transition to the OpenArc API and says so.
 */
export interface ControlEvidenceAttribution {
  readonly cancelledBy: string | null;
  readonly revokedBy: string | null;
}

export interface ControlEvidenceProjectionInput {
  readonly evaluatedAt: string;
  readonly action: ControlActionFacts;
  readonly approval: ControlApprovalFacts | null;
  readonly reservation: ControlReservationFacts | null;
  readonly grant: ControlGrantFacts | null;
  readonly paymentAttempts: readonly ControlPaymentAttemptFacts[];
  readonly paymentSource: ControlPaymentObservationSource | null;
  readonly attribution: ControlEvidenceAttribution;
}

/** Disagreements between records, typically snapshots read at different instants. */
export const CONTROL_EVIDENCE_INCONSISTENCIES = [
  "approval_record_missing",
  "approval_status_disagrees",
  "grant_record_missing",
  "grant_status_disagrees",
  "reservation_record_missing",
  "reservation_released_with_payment_attempt",
] as const;
export type ControlEvidenceInconsistency = (typeof CONTROL_EVIDENCE_INCONSISTENCIES)[number];

export interface ControlPaymentAttemptProjection {
  readonly attemptId: string;
  readonly state: ControlPaymentAttemptState;
  /** `null` only for a persisted attempt, which was never dispatched. */
  readonly certainty: EvidenceV2PaymentCertainty | null;
  readonly exposureBucket: EvidenceV2ExposureBucket;
}

export interface ControlEvidenceProjection {
  readonly ruleVersion: typeof CONTROL_EVIDENCE_PROJECTION_RULE_VERSION;
  readonly evaluatedAt: string;
  readonly actionId: string;
  readonly facts: readonly EvidenceV2Fact[];
  readonly evidenceIds: readonly string[];
  readonly exposure: EvidenceV2ExposureSummary;
  readonly paymentAttempts: readonly ControlPaymentAttemptProjection[];
  readonly dimensions: CommerceStateDimensions;
  readonly inconsistencies: readonly ControlEvidenceInconsistency[];
}

export const CONTROL_EVIDENCE_PROJECTION_INPUT_ERRORS = [
  "invalid_input",
  "identity_mismatch",
  "record_after_evaluation",
  "payment_attempt_without_grant",
  "payment_source_required",
] as const;
export type ControlEvidenceProjectionInputErrorDetail = (typeof CONTROL_EVIDENCE_PROJECTION_INPUT_ERRORS)[number];

export class ControlEvidenceProjectionInputError extends Error {
  constructor(readonly detail: ControlEvidenceProjectionInputErrorDetail) {
    super(`Control evidence projection input invalid: ${detail}`);
    this.name = "ControlEvidenceProjectionInputError";
  }
}

export const CONTROL_EVIDENCE_LIMITATIONS = Object.freeze({
  controlPlane: "OpenArc control-plane record; not an external observation.",
  derivedExpiry: "Expiry derived by OpenArc against the evaluation instant; the store has not recorded this transition.",
  actorNotRecorded: "The acting account is not recorded in this read; attributed to the OpenArc API.",
  instantNotRecorded: "The instant of this transition is not recorded in this read.",
  combinedExposure: "Combines the reservation with its payment attempts; unknown exposure is never folded into another bucket.",
  reservationReleased: "The reservation was released; it holds no exposure.",
  gatewayPending: "Gateway reports the transfer is not completed; the exposure remains held.",
} as const);

// ───────────────────────── input validation ─────────────────────────

const END = "(?![\\s\\S])";
const UUID_V4 = new RegExp(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}${END}`, "u");
const ADDRESS = new RegExp(`^0x[0-9a-fA-F]{40}${END}`, "u");
const GENERATION = new RegExp(`^[1-9][0-9]{0,9}${END}`, "u");
const PositiveAmountSchema = Uint256DecimalSchema.refine((value) => value !== "0", "Expected a positive amount");
const timestamp = IsoTimestampSchema;

const InputSchema = z.object({
  evaluatedAt: timestamp,
  action: z.object({
    actionId: CommerceActionIdSchema,
    exposureKey: z.object({ organizationId: CommerceOrganizationIdSchema, subjectAgentId: CommerceAgentIdSchema }),
    providerId: CommerceProviderIdSchema,
    status: CommerceActionStatusSchema,
    reservationId: CommerceReservationIdSchema.nullable(),
    approvalId: CommerceApprovalIdSchema.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp,
  }),
  approval: z.object({
    approvalId: CommerceApprovalIdSchema,
    actionId: CommerceActionIdSchema,
    organizationId: CommerceOrganizationIdSchema,
    subjectAgentId: CommerceAgentIdSchema,
    status: CommerceApprovalStatusSchema,
    decidedBy: CommerceAccountIdSchema.nullable(),
    createdAt: timestamp,
    expiresAt: timestamp,
    decidedAt: timestamp.nullable(),
  }).nullable(),
  reservation: z.object({
    organizationId: CommerceOrganizationIdSchema,
    reservationId: CommerceReservationIdSchema,
    actionId: CommerceActionIdSchema,
    debitAtomic: PositiveAmountSchema,
    status: z.enum(CONTROL_RESERVATION_STATUSES),
    createdAt: timestamp,
    claimedAt: timestamp.nullable(),
    resolvedAt: timestamp.nullable(),
  }).nullable(),
  grant: z.object({
    grantId: CommerceGrantIdSchema,
    organizationId: CommerceOrganizationIdSchema,
    subjectAgentId: CommerceAgentIdSchema,
    actionId: CommerceActionIdSchema,
    reservationId: CommerceReservationIdSchema,
    providerId: CommerceProviderIdSchema,
    generation: z.string().regex(GENERATION),
    status: CommerceGrantStatusSchema,
    issuedAt: timestamp,
    updatedAt: timestamp,
    expiresAt: timestamp,
    claimedAt: timestamp.nullable(),
    revokedAt: timestamp.nullable(),
  }).nullable(),
  paymentAttempts: z.array(z.object({
    organizationId: CommerceOrganizationIdSchema,
    attemptId: z.string().regex(UUID_V4),
    grantId: CommerceGrantIdSchema,
    actionId: CommerceActionIdSchema,
    providerId: CommerceProviderIdSchema,
    valueAtomic: PositiveAmountSchema,
    payerAddress: z.string().regex(ADDRESS),
    payToAddress: z.string().regex(ADDRESS),
    state: z.enum(CONTROL_PAYMENT_ATTEMPT_STATES),
    persistedAt: timestamp,
    dispatchedAt: timestamp.nullable(),
    observedAt: timestamp.nullable(),
    transferId: CanonicalTransferIdSchema.nullable(),
    gatewayStatus: z.enum(["received", "batched", "confirmed", "completed"]).nullable(),
    batchTxHash: Bytes32Schema.nullable(),
  })).max(32),
  paymentSource: z.object({
    class: z.enum(["gateway", "facilitator"]),
    sourceId: EvidenceV2SourceIdSchema,
    origin: EvidenceV2OriginSchema,
    adapterVersion: EvidenceV2AdapterVersionSchema,
  }).nullable(),
  attribution: z.object({
    cancelledBy: CommerceAccountIdSchema.nullable(),
    revokedBy: CommerceAccountIdSchema.nullable(),
  }),
});
type ParsedInput = z.infer<typeof InputSchema>;

const before = (left: string, right: string) => compareIsoTimestamps(left, right) < 0;

/** Row shapes the schema10/12/15 CHECK constraints guarantee. A violation is malformed input. */
function shapesHold(input: ParsedInput): boolean {
  const { action, approval, reservation, grant, paymentAttempts } = input;
  const actionOk = !before(action.updatedAt, action.createdAt) && before(action.createdAt, action.expiresAt) && (() => {
    switch (action.status) {
      case "pending_approval":
        return action.approvalId !== null && action.reservationId === null;
      case "reserved_not_granted":
      case "grant_issued":
        return action.reservationId !== null;
      case "rejected":
        return action.approvalId !== null && action.reservationId === null;
      case "cancelled":
      case "expired":
        return action.approvalId !== null || action.reservationId !== null;
    }
  })();
  const approvalOk = approval === null || (before(approval.createdAt, approval.expiresAt) && (
    approval.status === "pending" || approval.status === "expired"
      ? approval.decidedBy === null && approval.decidedAt === null
      : approval.decidedBy !== null && approval.decidedAt !== null && !before(approval.decidedAt, approval.createdAt)
  ));
  const reservationOk = reservation === null || (reservation.status === "held"
    ? reservation.claimedAt === null && reservation.resolvedAt === null
    : reservation.status === "claimed" || reservation.status === "unknown"
      ? reservation.claimedAt !== null && reservation.resolvedAt === null
      : reservation.resolvedAt !== null);
  const grantOk = grant === null || (before(grant.issuedAt, grant.expiresAt) && !before(grant.updatedAt, grant.issuedAt) &&
    (grant.claimedAt === null || before(grant.claimedAt, grant.expiresAt)) && (
    grant.status === "issued" || grant.status === "expired"
      ? grant.claimedAt === null && grant.revokedAt === null
      : grant.status === "claimed"
        ? grant.claimedAt !== null && grant.revokedAt === null
        : grant.revokedAt !== null
  ));
  const attemptsOk = paymentAttempts.every((attempt) => {
    switch (attempt.state) {
      case "persisted":
        return attempt.dispatchedAt === null && attempt.observedAt === null && attempt.transferId === null &&
          attempt.gatewayStatus === null && attempt.batchTxHash === null;
      case "unknown":
        return attempt.dispatchedAt !== null && attempt.observedAt === null && attempt.transferId === null &&
          attempt.gatewayStatus === null && attempt.batchTxHash === null;
      case "pending":
        return attempt.dispatchedAt !== null && attempt.observedAt !== null && attempt.transferId !== null &&
          attempt.gatewayStatus !== null && attempt.gatewayStatus !== "completed";
      case "committed":
        return attempt.dispatchedAt !== null && attempt.observedAt !== null && attempt.transferId !== null &&
          attempt.gatewayStatus === "completed" && attempt.batchTxHash !== null;
    }
  });
  return actionOk && approvalOk && reservationOk && grantOk && attemptsOk;
}

// ───────────────────────── deterministic evidence IDs ─────────────────────────

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;
const SHA256_H0 = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19] as const;

function utf8Bytes(text: string): number[] {
  const bytes: number[] = [];
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return bytes;
}

const rotr = (value: number, bits: number) => ((value >>> bits) | (value << (32 - bits))) >>> 0;
const at = (values: readonly number[], index: number) => values[index] ?? 0;

/**
 * Synchronous SHA-256 of the UTF-8 encoding of `text`, as lowercase hex.
 * Pure and dependency-free so evidence IDs are deterministic in every runtime.
 */
export function controlEvidenceSha256Hex(text: string): string {
  const message = utf8Bytes(text);
  const bitLength = message.length * 8;
  message.push(0x80);
  while (message.length % 64 !== 56) message.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  message.push((high >>> 24) & 0xff, (high >>> 16) & 0xff, (high >>> 8) & 0xff, high & 0xff,
    (low >>> 24) & 0xff, (low >>> 16) & 0xff, (low >>> 8) & 0xff, low & 0xff);
  const state: number[] = [...SHA256_H0];
  const words: number[] = new Array<number>(64).fill(0);
  for (let offset = 0; offset < message.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const base = offset + index * 4;
      words[index] = ((at(message, base) << 24) | (at(message, base + 1) << 16) | (at(message, base + 2) << 8) | at(message, base + 3)) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const w15 = at(words, index - 15);
      const w2 = at(words, index - 2);
      const sigma0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const sigma1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      words[index] = (at(words, index - 16) + sigma0 + at(words, index - 7) + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [at(state, 0), at(state, 1), at(state, 2), at(state, 3), at(state, 4), at(state, 5), at(state, 6), at(state, 7)];
    for (let index = 0; index < 64; index += 1) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + at(SHA256_K, index) + at(words, index)) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    const round = [a, b, c, d, e, f, g, h];
    for (let index = 0; index < 8; index += 1) state[index] = (at(state, index) + at(round, index)) >>> 0;
  }
  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type FactDraft = DistributiveOmit<EvidenceV2Fact, "evidenceId" | "schemaVersion" | "dataClass" | "digest">;

/** The evidence ID is a digest of the complete fact, so different content can never reuse an ID. */
function buildFact(draft: FactDraft): EvidenceV2Fact {
  const body = { ...draft, schemaVersion: EVIDENCE_V2_SCHEMA_VERSION, dataClass: "organization_protected", digest: null };
  const evidenceId = `evd_${controlEvidenceSha256Hex(canonicalJson([CONTROL_EVIDENCE_PROJECTION_RULE_VERSION, body])).slice(0, 32)}`;
  return Object.freeze(EvidenceV2FactSchema.parse({ ...body, evidenceId }));
}

// ───────────────────────── projection ─────────────────────────

const CONTROL_PLANE_SOURCE = Object.freeze({
  class: "local", sourceId: "openarc.control-plane", origin: "openarc:control-plane",
  adapterVersion: CONTROL_EVIDENCE_PROJECTION_RULE_VERSION,
} as const);
const COMBINED_EXPOSURE_SOURCE = Object.freeze({
  class: "local", sourceId: "openarc.control-projection", origin: "openarc:reconciler",
  adapterVersion: CONTROL_EVIDENCE_PROJECTION_RULE_VERSION,
} as const);
const DERIVED_SOURCE = Object.freeze({
  class: "openarc_derived", sourceId: "openarc.control-projection", origin: "openarc:reconciler",
  adapterVersion: CONTROL_EVIDENCE_PROJECTION_RULE_VERSION,
} as const);

const AUTHORIZATION_BY_ACTION_STATUS: Readonly<Record<CommerceActionStatus, CommerceStateDimensions["authorization"]>> = Object.freeze({
  pending_approval: "pending",
  reserved_not_granted: "authorized",
  grant_issued: "authorized",
  rejected: "denied",
  cancelled: "revoked",
  expired: "expired",
});

/** Action statuses an approval status can coexist with in one consistent read. */
const ACTION_STATUSES_FOR_APPROVAL: Readonly<Record<CommerceApprovalStatus, readonly CommerceActionStatus[]>> = Object.freeze({
  pending: ["pending_approval", "cancelled", "expired"],
  approved: ["reserved_not_granted", "grant_issued", "cancelled", "expired"],
  rejected: ["rejected"],
  expired: ["pending_approval", "cancelled", "expired"],
});

const RESERVATION_BUCKET: Readonly<Record<ControlReservationStatus, EvidenceV2ExposureBucket | null>> = Object.freeze({
  held: "held",
  claimed: "claimed",
  unknown: "unknown",
  committed: "committed",
  released: null,
});

/** Higher wins when a reservation and its attempts disagree: the more uncertain exposure is shown. */
const BUCKET_PRECEDENCE: Readonly<Record<EvidenceV2ExposureBucket, number>> = Object.freeze({
  held: 0,
  claimed: 1,
  committed: 2,
  unknown: 3,
});

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

type AuthorizationDecision = EvidenceV2FactOf<"authorization_decision">["normalized"]["decision"];
type GrantEvidenceStatus = EvidenceV2FactOf<"grant_state">["normalized"]["status"];
type PaymentNormalized = EvidenceV2FactOf<"payment_observation">["normalized"];

/**
 * Projects one action with its approval, reservation, grant and payment
 * attempts into evidence v2 facts, an exposure summary and commerce state
 * dimensions. Pure and deterministic. Malformed or foreign records throw
 * `ControlEvidenceProjectionInputError`; snapshots that disagree are kept and
 * reported as `inconsistencies`, with `reconciliation: "conflicting"`.
 */
export function projectControlEvidence(input: ControlEvidenceProjectionInput): ControlEvidenceProjection {
  const parsed = InputSchema.safeParse(input);
  if (!parsed.success || !shapesHold(parsed.data)) throw new ControlEvidenceProjectionInputError("invalid_input");
  const { evaluatedAt, action, approval, reservation, grant, paymentSource, attribution } = parsed.data;
  const attempts = [...parsed.data.paymentAttempts].sort((left, right) => compareText(left.attemptId, right.attemptId));
  if (new Set(attempts.map((attempt) => attempt.attemptId)).size !== attempts.length) {
    throw new ControlEvidenceProjectionInputError("invalid_input");
  }

  const organizationId = action.exposureKey.organizationId;
  const subjectAgentId = action.exposureKey.subjectAgentId;
  const actionId = action.actionId;

  const same = (consistent: boolean) => {
    if (!consistent) throw new ControlEvidenceProjectionInputError("identity_mismatch");
  };
  if (approval !== null) {
    same(approval.approvalId === action.approvalId && approval.actionId === actionId &&
      approval.organizationId === organizationId && approval.subjectAgentId === subjectAgentId);
  }
  if (reservation !== null) {
    same(reservation.reservationId === action.reservationId && reservation.actionId === actionId &&
      reservation.organizationId === organizationId);
  }
  if (grant !== null) {
    same(grant.actionId === actionId && grant.organizationId === organizationId && grant.subjectAgentId === subjectAgentId &&
      grant.providerId === action.providerId && grant.reservationId === action.reservationId);
  }
  for (const attempt of attempts) {
    if (grant === null) throw new ControlEvidenceProjectionInputError("payment_attempt_without_grant");
    same(attempt.grantId === grant.grantId && attempt.actionId === actionId &&
      attempt.organizationId === organizationId && attempt.providerId === action.providerId);
  }

  const recorded = [
    action.createdAt, action.updatedAt,
    approval?.createdAt ?? null, approval?.decidedAt ?? null,
    reservation?.createdAt ?? null, reservation?.claimedAt ?? null, reservation?.resolvedAt ?? null,
    grant?.issuedAt ?? null, grant?.updatedAt ?? null, grant?.claimedAt ?? null, grant?.revokedAt ?? null,
    ...attempts.flatMap((attempt) => [attempt.persistedAt, attempt.dispatchedAt, attempt.observedAt]),
  ];
  for (const instant of recorded) {
    if (instant !== null && compareIsoTimestamps(instant, evaluatedAt) > 0) {
      throw new ControlEvidenceProjectionInputError("record_after_evaluation");
    }
  }
  const expiredBy = (expiresAt: string) => compareIsoTimestamps(expiresAt, evaluatedAt) <= 0;

  const L = CONTROL_EVIDENCE_LIMITATIONS;
  const facts: EvidenceV2Fact[] = [];
  const inconsistencies = new Set<ControlEvidenceInconsistency>();
  const api: EvidenceV2Actor = { kind: "system", component: "api" };
  const reconciler: EvidenceV2Actor = { kind: "system", component: "reconciler" };
  const agent: EvidenceV2Actor = { kind: "agent", agentId: subjectAgentId };
  const human = (accountId: string): EvidenceV2Actor => ({ kind: "human_account", accountId });
  const actionScope = { organizationId, providerId: action.providerId, actionId };
  const actionSubject = { kind: "action", canonicalId: actionId } as const;

  // ── action and approval: authorization_decision ──
  const decide = (decision: AuthorizationDecision, derived: boolean, actor: EvidenceV2Actor, occurredAt: string | null, limitations: string[]) => {
    facts.push(buildFact({
      kind: "authorization_decision", source: derived ? DERIVED_SOURCE : CONTROL_PLANE_SOURCE, subject: actionSubject,
      scope: actionScope, actor, chain: null, occurredAt, observedAt: evaluatedAt, limitations, normalized: { decision },
    }));
  };

  if (action.approvalId !== null) {
    decide("approval_requested", false, agent, action.createdAt, [L.controlPlane]);
    if (approval === null) inconsistencies.add("approval_record_missing");
  }
  const wasAuthorized = action.status === "reserved_not_granted" || action.status === "grant_issued" ||
    ((action.status === "cancelled" || action.status === "expired") && action.reservationId !== null);
  if (wasAuthorized) {
    if (action.approvalId === null) {
      decide("authorized", false, agent, action.createdAt, [L.controlPlane]);
    } else if (approval !== null && approval.status === "approved" && approval.decidedBy !== null) {
      decide("authorized", false, human(approval.decidedBy), approval.decidedAt, [L.controlPlane]);
    } else {
      decide("authorized", false, api, null, [L.controlPlane, L.actorNotRecorded, L.instantNotRecorded]);
    }
  }
  if (approval !== null) {
    if ((approval.status === "approved" || approval.status === "rejected") && approval.decidedBy !== null) {
      decide(approval.status, false, human(approval.decidedBy), approval.decidedAt, [L.controlPlane]);
    }
    if (!ACTION_STATUSES_FOR_APPROVAL[approval.status].includes(action.status)) inconsistencies.add("approval_status_disagrees");
  }
  if (action.status === "rejected" && approval?.status !== "rejected") {
    decide("rejected", false, api, action.updatedAt, [L.controlPlane, L.actorNotRecorded]);
  }
  if (action.status === "cancelled") {
    if (attribution.cancelledBy !== null) decide("cancelled", false, human(attribution.cancelledBy), action.updatedAt, [L.controlPlane]);
    else decide("cancelled", false, api, action.updatedAt, [L.controlPlane, L.actorNotRecorded]);
  }

  let authorization = AUTHORIZATION_BY_ACTION_STATUS[action.status];
  if (action.status === "expired") {
    decide("expired", false, api, action.updatedAt, [L.controlPlane]);
  } else if (approval?.status === "expired") {
    decide("expired", false, api, null, [L.controlPlane, L.instantNotRecorded]);
    if (action.status === "pending_approval") authorization = "expired";
  } else {
    const candidates: string[] = [];
    if ((action.status === "pending_approval" || action.status === "reserved_not_granted") && expiredBy(action.expiresAt)) {
      candidates.push(action.expiresAt);
    }
    if (action.status === "pending_approval" && approval?.status === "pending" && expiredBy(approval.expiresAt)) {
      candidates.push(approval.expiresAt);
    }
    const earliest = candidates.sort(compareIsoTimestamps)[0];
    if (earliest !== undefined) {
      decide("expired", true, reconciler, earliest, [L.derivedExpiry]);
      authorization = "expired";
    }
  }

  // ── grant: grant_state ──
  if (grant !== null) {
    const grantScope = { organizationId, providerId: grant.providerId, actionId };
    const grantSubject = { kind: "authorization_grant", canonicalId: grant.grantId } as const;
    const record = (status: GrantEvidenceStatus, derived: boolean, actor: EvidenceV2Actor, occurredAt: string | null, limitations: string[]) => {
      facts.push(buildFact({
        kind: "grant_state", source: derived ? DERIVED_SOURCE : CONTROL_PLANE_SOURCE, subject: grantSubject,
        scope: grantScope, actor, chain: null, occurredAt, observedAt: evaluatedAt, limitations, normalized: { status },
      }));
    };
    record("issued", false, agent, grant.issuedAt, [L.controlPlane]);
    if (grant.generation !== "1") {
      if (grant.status === "issued") record("replaced", false, agent, grant.updatedAt, [L.controlPlane]);
      else record("replaced", false, agent, null, [L.controlPlane, L.instantNotRecorded]);
    }
    // A claim is never erased: revoke-after-claim keeps the claimed fact.
    if (grant.claimedAt !== null) record("claimed", false, { kind: "provider", providerId: grant.providerId }, grant.claimedAt, [L.controlPlane]);
    if (grant.status === "revoked") {
      if (attribution.revokedBy !== null) record("revoked", false, human(attribution.revokedBy), grant.revokedAt, [L.controlPlane]);
      else record("revoked", false, api, grant.revokedAt, [L.controlPlane, L.actorNotRecorded]);
    }
    let grantExpired = false;
    if (grant.status === "expired") {
      if (!expiredBy(grant.expiresAt)) throw new ControlEvidenceProjectionInputError("record_after_evaluation");
      record("expired", false, api, grant.expiresAt, [L.controlPlane]);
      grantExpired = true;
    } else if (grant.status === "issued" && expiredBy(grant.expiresAt)) {
      record("expired", true, reconciler, grant.expiresAt, [L.derivedExpiry]);
      grantExpired = true;
    }
    const grantConsistent = action.status === "grant_issued" ||
      (action.status === "cancelled" && grant.status === "revoked" && grant.claimedAt === null);
    if (!grantConsistent) inconsistencies.add("grant_status_disagrees");
    if (action.status === "grant_issued") {
      if (grant.status === "revoked") authorization = "revoked";
      else if (grantExpired) authorization = "expired";
    }
  } else if (action.status === "grant_issued") {
    inconsistencies.add("grant_record_missing");
  }

  // ── reservation: budget_exposure ──
  if (action.reservationId !== null && reservation === null) inconsistencies.add("reservation_record_missing");
  const reservationBucket = reservation === null ? null : RESERVATION_BUCKET[reservation.status];
  if (reservation !== null) {
    const occurredAt = reservation.status === "held" ? reservation.createdAt
      : reservation.status === "claimed" || reservation.status === "unknown" ? reservation.claimedAt : reservation.resolvedAt;
    const limitations: string[] = [L.controlPlane];
    if (reservation.status === "released") limitations.push(L.reservationReleased);
    if (reservation.status === "unknown") limitations.push(EVIDENCE_V2_UNKNOWN_PAYMENT_LIMITATION);
    facts.push(buildFact({
      kind: "budget_exposure", source: CONTROL_PLANE_SOURCE,
      subject: { kind: "budget_reservation", canonicalId: reservation.reservationId }, scope: actionScope, actor: api,
      chain: null, occurredAt, observedAt: evaluatedAt, limitations,
      normalized: {
        exposure: summarizeEvidenceV2Exposure(reservationBucket === null ? [] : [{ bucket: reservationBucket, amountAtomic: reservation.debitAtomic }]),
      },
    }));
  }

  // ── payment attempts: payment_observation ──
  const attemptProjections: ControlPaymentAttemptProjection[] = [];
  for (const attempt of attempts) {
    if (attempt.state === "persisted") {
      attemptProjections.push(Object.freeze({ attemptId: attempt.attemptId, state: attempt.state, certainty: null, exposureBucket: "held" }));
      continue;
    }
    if (attempt.state === "unknown") {
      // Dispatched and never observed (schema15 keeps observed_at NULL): there is no
      // Gateway observation to cite and no lane reason to invent. Unknown and held.
      attemptProjections.push(Object.freeze({
        attemptId: attempt.attemptId, state: attempt.state,
        certainty: evidenceV2CertaintyForLaneState("unknown"), exposureBucket: "unknown",
      }));
      continue;
    }
    if (paymentSource === null) throw new ControlEvidenceProjectionInputError("payment_source_required");
    const { transferId, gatewayStatus, batchTxHash, observedAt } = attempt;
    if (transferId === null || observedAt === null) throw new ControlEvidenceProjectionInputError("invalid_input");
    let lane: EvidenceV2LaneExposure;
    if (attempt.state === "pending" && (gatewayStatus === "received" || gatewayStatus === "batched" || gatewayStatus === "confirmed")) {
      lane = { state: "pending", disposition: "held", transferId, gatewayStatus, batchTxHash };
    } else if (attempt.state === "committed" && gatewayStatus === "completed" && batchTxHash !== null) {
      lane = { state: "committed", disposition: "committed", transferId, gatewayStatus, batchTxHash, onchainReceiptVerified: false };
    } else {
      throw new ControlEvidenceProjectionInputError("invalid_input");
    }
    const certainty = derivePaymentCertainty(lane);
    attemptProjections.push(Object.freeze({
      attemptId: attempt.attemptId, state: attempt.state, certainty: certainty.certainty,
      exposureBucket: certainty.certainty === "unknown" ? "unknown" : certainty.exposure,
    }));
    const common = {
      transferId, amountAtomic: attempt.valueAtomic,
      payer: attempt.payerAddress.toLowerCase(), payTo: attempt.payToAddress.toLowerCase(),
    };
    let normalized: PaymentNormalized;
    let limitations: string[];
    if (lane.state === "pending" && certainty.certainty === "pending") {
      normalized = { laneState: "pending", certainty: "pending", gatewayStatus: lane.gatewayStatus, batchTransactionHash: lane.batchTxHash, ...common };
      limitations = [L.gatewayPending];
    } else if (lane.state === "committed" && certainty.certainty === "submitted_pending_chain") {
      normalized = { laneState: "committed", certainty: "submitted_pending_chain", gatewayStatus: "completed", batchTransactionHash: lane.batchTxHash, ...common };
      limitations = [EVIDENCE_V2_GATEWAY_COMMITTED_LIMITATION];
    } else {
      throw new Error("Payment certainty rule disagrees with the attempt state");
    }
    facts.push(buildFact({
      kind: "payment_observation", source: paymentSource, subject: actionSubject,
      scope: { organizationId, providerId: attempt.providerId, actionId },
      actor: { kind: "external_party", role: paymentSource.class, address: null },
      chain: null, occurredAt: null, observedAt, limitations, normalized,
    }));
  }

  // ── exposure summary ──
  let exposure: EvidenceV2ExposureSummary;
  if (attemptProjections.length === 0) {
    exposure = summarizeEvidenceV2Exposure(reservation === null || reservationBucket === null ? []
      : [{ bucket: reservationBucket, amountAtomic: reservation.debitAtomic }]);
  } else {
    if (reservation?.status === "released") inconsistencies.add("reservation_released_with_payment_attempt");
    const buckets = attemptProjections.map((projection) => projection.exposureBucket);
    if (reservationBucket !== null) buckets.push(reservationBucket);
    const bucket = buckets.reduce((left, right) => (BUCKET_PRECEDENCE[right] > BUCKET_PRECEDENCE[left] ? right : left));
    const amountAtomic = reservation?.debitAtomic ??
      attempts.map((attempt) => BigInt(attempt.valueAtomic)).reduce((left, right) => (right > left ? right : left)).toString();
    exposure = summarizeEvidenceV2Exposure([{ bucket, amountAtomic }]);
    const limitations: string[] = [L.controlPlane, L.combinedExposure];
    if (bucket === "unknown") limitations.push(EVIDENCE_V2_UNKNOWN_PAYMENT_LIMITATION);
    facts.push(buildFact({
      kind: "budget_exposure", source: COMBINED_EXPOSURE_SOURCE, subject: actionSubject, scope: actionScope,
      actor: reconciler, chain: null, occurredAt: null, observedAt: evaluatedAt, limitations, normalized: { exposure },
    }));
  }

  // ── dimensions: payment and settlement only from attempts, never inferred ──
  let payment: CommerceStateDimensions["payment"] = "not_requested";
  let settlement: CommerceStateDimensions["settlement"] = "not_requested";
  const dispatched = attemptProjections.flatMap((projection) => (projection.certainty === null ? [] : [projection.certainty]));
  if (attemptProjections.length > 0) {
    if (dispatched.includes("unknown")) {
      payment = "unknown";
      settlement = "unknown";
    } else if (dispatched.length === 0) {
      payment = "required";
    } else {
      payment = dispatched.every((certainty) => certainty === "onchain_confirmed") ? "paid" : "submitted";
      settlement = "pending";
    }
  }
  const dimensions = Object.freeze(CommerceStateDimensionsSchema.parse({
    authorization,
    payment,
    delivery: "not_requested",
    evaluation: "not_requested",
    settlement,
    reconciliation: inconsistencies.size > 0 ? "conflicting" : "unreconciled",
  }));

  // IDs are digests of the complete fact, so an equal ID is equal content: identical
  // observations (for example two attempts reporting one transfer) collapse to one fact.
  const unique = [...new Map(facts.map((fact) => [fact.evidenceId, fact])).values()];
  const kindOrder = (fact: EvidenceV2Fact) => EVIDENCE_V2_FACT_KINDS.indexOf(fact.kind);
  unique.sort((left, right) =>
    compareIsoTimestamps(left.occurredAt ?? left.observedAt, right.occurredAt ?? right.observedAt) ||
    kindOrder(left) - kindOrder(right) ||
    compareText(evidenceV2FactStatus(left), evidenceV2FactStatus(right)) ||
    compareText(left.evidenceId, right.evidenceId));

  return Object.freeze({
    ruleVersion: CONTROL_EVIDENCE_PROJECTION_RULE_VERSION,
    evaluatedAt,
    actionId,
    facts: Object.freeze(unique),
    evidenceIds: Object.freeze(unique.map((fact) => fact.evidenceId).sort()),
    exposure,
    paymentAttempts: Object.freeze(attemptProjections),
    dimensions,
    inconsistencies: Object.freeze([...inconsistencies].sort()),
  });
}

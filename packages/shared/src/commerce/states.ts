import { z } from "zod";

/**
 * Evidence classes recognized by the commerce state vocabulary.
 *
 * NOTE: enum order below is NOT a transition graph. It is a flat set of
 * independent classifications.
 */
export const CommerceEvidenceClassSchema = z.enum([
  "local",
  "signed",
  "agent_reported",
  "provider",
  "facilitator",
  "gateway",
  "onchain",
  "evaluator",
  "openarc_derived",
]);

export type CommerceEvidenceClass = z.infer<
  typeof CommerceEvidenceClassSchema
>;

/**
 * Commerce lifecycle state vocabulary.
 *
 * NOTE: enum order is NOT a transition graph. There is no implied ordering,
 * no success cascade, and no state is inferred from another. This packet
 * deliberately provides no projection function.
 */
export const CommerceStateSchema = z.enum([
  "PROPOSED",
  "DENIED",
  "AUTHORIZED",
  "PAYMENT_REQUIRED",
  "PAYMENT_SUBMITTED",
  "PAID",
  "DELIVERY_PENDING",
  "DELIVERED",
  "ACCEPTED",
  "SETTLING",
  "SETTLED",
  "RECONCILED",
  "EXPIRED",
  "FAILED",
  "REFUNDED",
  "DISPUTED",
  "CONFLICTING_EVIDENCE",
]);

export type CommerceState = z.infer<typeof CommerceStateSchema>;

/**
 * Separately observed facts across lifecycle dimensions.
 *
 * These dimensions carry independently observed facts and MAY contradict one
 * another (for example paid while delivery is pending and settlement is
 * unknown). A parser must NOT invent a success cascade or infer one dimension
 * from another. Later versioned reconciliation resolves conflicts using
 * evidence refs. This schema is strict: all dimensions are required and no
 * defaults or coercions are applied.
 */
export const CommerceStateDimensionsSchema = z.strictObject({
  authorization: z.enum([
    "not_requested",
    "pending",
    "denied",
    "authorized",
    "expired",
    "revoked",
  ]),
  payment: z.enum([
    "not_requested",
    "required",
    "submitted",
    "unknown",
    "paid",
    "failed",
    "refunded",
  ]),
  delivery: z.enum(["not_requested", "pending", "delivered", "failed"]),
  evaluation: z.enum([
    "not_requested",
    "pending",
    "accepted",
    "rejected",
    "disputed",
  ]),
  settlement: z.enum([
    "not_requested",
    "pending",
    "unknown",
    "settled",
    "refunded",
    "failed",
  ]),
  reconciliation: z.enum(["unreconciled", "reconciled", "conflicting"]),
});

export type CommerceStateDimensions = z.infer<
  typeof CommerceStateDimensionsSchema
>;

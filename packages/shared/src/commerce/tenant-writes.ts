import { z } from "zod";

import { IsoTimestampSchema } from "../primitives.js";
import { createCommerceSuccessEnvelopeSchema } from "./api.js";
import {
  CommerceAccountIdSchema,
  CommerceAgentIdSchema,
  CommerceAgentProfileSchema,
  CommerceHumanRoleSchema,
  CommerceOrganizationAccessViewSchema,
  CommerceOrganizationIdSchema,
  CommerceProviderIdSchema,
  CommerceProviderProfileSchema,
} from "./identity.js";

/**
 * Frozen tenant write-wire contracts.
 *
 * These are browser-safe, strict Zod contracts for organization-scoped writes.
 * They describe request bodies, safe mutation receipts and status/result data
 * objects only: no route strings, no parser defaults, no principal, session,
 * idempotency key, authority or authorization. Status transitions and durable
 * persistence remain the job of the future transport/server controller.
 */

/**
 * Exact lower-case canonical UUIDv4. The version nibble is fixed to `4` and
 * the variant nibble to `8`, `9`, `a` or `b`. `(?![\s\S])` pins the absolute
 * end of input so a trailing newline cannot satisfy `$`. This logical mutation
 * id is a correlation identifier, not an authentication credential.
 */
const MUTATION_ID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export const CommerceTenantMutationIdSchema = z
  .string()
  .regex(new RegExp(`^${MUTATION_ID_PATTERN}(?![\\s\\S])`));

export type CommerceTenantMutationId = z.infer<
  typeof CommerceTenantMutationIdSchema
>;

/**
 * Canonical unpadded base64url encoding of exactly 32 bytes. That is exactly
 * 43 characters whose final character must carry zero padding bits, so only
 * the low two bits of the final base64 index may be zero. No decode dependency
 * is required or used. Padding, whitespace and noncanonical trailing bits are
 * rejected. This value is an HTTP header value only and deliberately does not
 * appear in any body, receipt/status or response DTO.
 */
const BASE64URL_FINAL_ALPHABET = "AEIMQUYcgkosw048";

export const CommerceTenantIdempotencyKeySchema = z
  .string()
  .regex(
    new RegExp(
      `^[A-Za-z0-9_-]{42}[${BASE64URL_FINAL_ALPHABET}](?![\\s\\S])`,
    ),
  );

export type CommerceTenantIdempotencyKey = z.infer<
  typeof CommerceTenantIdempotencyKeySchema
>;

/**
 * Authoritative reusable identity leaves. `displayName` and both profile
 * status enums are taken from the existing frozen identity schemas so this
 * module cannot drift into a second source of truth. The membership status is
 * the accepted `active` / `suspended` enum. None of these schemas is modified.
 */
const DisplayNameSchema = CommerceAgentProfileSchema.shape.displayName;
const AgentStatusSchema = CommerceAgentProfileSchema.shape.status;
const ProviderStatusSchema = CommerceProviderProfileSchema.shape.status;
const MembershipStatusSchema =
  CommerceOrganizationAccessViewSchema.shape.membershipStatus;

export const CommerceOrganizationCreateBodySchema = z.strictObject({
  mutationId: CommerceTenantMutationIdSchema,
  displayName: DisplayNameSchema,
});

export const CommerceAgentCreateBodySchema = z.strictObject({
  mutationId: CommerceTenantMutationIdSchema,
  displayName: DisplayNameSchema,
});

export const CommerceProviderCreateBodySchema = z.strictObject({
  mutationId: CommerceTenantMutationIdSchema,
  displayName: DisplayNameSchema,
});

export type CommerceOrganizationCreateBody = z.infer<
  typeof CommerceOrganizationCreateBodySchema
>;
export type CommerceAgentCreateBody = z.infer<
  typeof CommerceAgentCreateBodySchema
>;
export type CommerceProviderCreateBody = z.infer<
  typeof CommerceProviderCreateBodySchema
>;

/**
 * Rejects a patch object that explicitly carries a key whose value is
 * `undefined`. Zod's optional fields would otherwise accept `undefined` and
 * drop the key, silently treating a present-but-undefined field as absent.
 * This runs on the raw input before the strict object parses it.
 */
function rejectExplicitUndefinedKeys(
  value: unknown,
  ctx: z.RefinementCtx,
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  for (const key of Object.keys(value)) {
    if ((value as Record<string, unknown>)[key] === undefined) {
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: "Explicit undefined patch fields are not allowed",
      });
    }
  }
}

/**
 * Strict patch builder: unknown keys are rejected rather than stripped,
 * explicit `undefined` values are rejected, and at least one field must be
 * defined. The DTO does not infer or authorize state transitions.
 */
function strictPatchSchema<T extends z.ZodRawShape>(shape: T) {
  return z
    .unknown()
    .superRefine(rejectExplicitUndefinedKeys)
    .pipe(z.strictObject(shape))
    .refine((value) => Object.keys(value).length > 0, {
      message: "patch must define at least one field",
    });
}

const AgentPatchSchema = strictPatchSchema({
  displayName: DisplayNameSchema.optional(),
  status: AgentStatusSchema.optional(),
});

const ProviderPatchSchema = strictPatchSchema({
  displayName: DisplayNameSchema.optional(),
  status: ProviderStatusSchema.optional(),
});

export const CommerceAgentUpdateBodySchema = z.strictObject({
  mutationId: CommerceTenantMutationIdSchema,
  patch: AgentPatchSchema,
});

export const CommerceProviderUpdateBodySchema = z.strictObject({
  mutationId: CommerceTenantMutationIdSchema,
  patch: ProviderPatchSchema,
});

export type CommerceAgentUpdateBody = z.infer<
  typeof CommerceAgentUpdateBodySchema
>;
export type CommerceProviderUpdateBody = z.infer<
  typeof CommerceProviderUpdateBodySchema
>;

/**
 * Membership target account is a transport PATH parameter, never a body
 * field, so it is absent from this contract. Only the accepted human role and
 * membership status values are carried.
 */
export const CommerceMembershipSetBodySchema = z.strictObject({
  mutationId: CommerceTenantMutationIdSchema,
  role: CommerceHumanRoleSchema,
  membershipStatus: MembershipStatusSchema,
});

export type CommerceMembershipSetBody = z.infer<
  typeof CommerceMembershipSetBodySchema
>;

export const CommerceTenantMutationStatusRequestSchema = z.strictObject({
  organizationId: CommerceOrganizationIdSchema,
  mutationId: CommerceTenantMutationIdSchema,
});

export const CommerceOrganizationMutationStatusRequestSchema = z.strictObject({
  mutationId: CommerceTenantMutationIdSchema,
});

export type CommerceTenantMutationStatusRequest = z.infer<
  typeof CommerceTenantMutationStatusRequestSchema
>;
export type CommerceOrganizationMutationStatusRequest = z.infer<
  typeof CommerceOrganizationMutationStatusRequestSchema
>;

/**
 * Safe immutable receipt. The union is closed and discriminated by operation,
 * and each variant has an exact `operation` / `resourceType` pair. No request
 * payload, display name, idempotency key, hash, session, actor, role or raw
 * response blob is representable. Organization creation follows the accepted
 * durable bootstrap convention `resourceId === "openarc:org:" + mutationId`.
 */
export const CommerceTenantMutationReceiptSchema = z
  .discriminatedUnion("operation", [
    z.strictObject({
      mutationId: CommerceTenantMutationIdSchema,
      operation: z.literal("tenant.organization.create"),
      resourceType: z.literal("organization"),
      resourceId: CommerceOrganizationIdSchema,
      committedAt: IsoTimestampSchema,
    }),
    z.strictObject({
      mutationId: CommerceTenantMutationIdSchema,
      operation: z.literal("tenant.agent.create"),
      resourceType: z.literal("agent"),
      resourceId: CommerceAgentIdSchema,
      committedAt: IsoTimestampSchema,
    }),
    z.strictObject({
      mutationId: CommerceTenantMutationIdSchema,
      operation: z.literal("tenant.agent.update"),
      resourceType: z.literal("agent"),
      resourceId: CommerceAgentIdSchema,
      committedAt: IsoTimestampSchema,
    }),
    z.strictObject({
      mutationId: CommerceTenantMutationIdSchema,
      operation: z.literal("tenant.provider.create"),
      resourceType: z.literal("provider"),
      resourceId: CommerceProviderIdSchema,
      committedAt: IsoTimestampSchema,
    }),
    z.strictObject({
      mutationId: CommerceTenantMutationIdSchema,
      operation: z.literal("tenant.provider.update"),
      resourceType: z.literal("provider"),
      resourceId: CommerceProviderIdSchema,
      committedAt: IsoTimestampSchema,
    }),
    z.strictObject({
      mutationId: CommerceTenantMutationIdSchema,
      operation: z.literal("tenant.membership.set"),
      resourceType: z.literal("membership"),
      resourceId: CommerceAccountIdSchema,
      committedAt: IsoTimestampSchema,
    }),
  ])
  .superRefine((receipt, ctx) => {
    if (
      receipt.operation === "tenant.organization.create" &&
      receipt.resourceId !== `openarc:org:${receipt.mutationId}`
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["resourceId"],
        message:
          "organization resourceId must equal 'openarc:org:' + mutationId",
      });
    }
  });

export type CommerceTenantMutationReceipt = z.infer<
  typeof CommerceTenantMutationReceiptSchema
>;

export const CommerceTenantMutationResultSchema = z
  .strictObject({
    organizationId: CommerceOrganizationIdSchema,
    replayed: z.boolean(),
    receipt: CommerceTenantMutationReceiptSchema,
  })
  .superRefine((value, ctx) => {
    if (
      value.receipt.operation === "tenant.organization.create" &&
      value.organizationId !== value.receipt.resourceId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["organizationId"],
        message:
          "organizationId must equal the organization receipt resourceId",
      });
    }
  });

export type CommerceTenantMutationResult = z.infer<
  typeof CommerceTenantMutationResultSchema
>;

/**
 * Closed status discriminated union. `committed` carries the safe receipt;
 * `not_found` carries only the organization id. For an organization receipt
 * the top-level organization id must equal the receipt resource id; other
 * resource ids encode non-organization kinds and their linkage is owned by the
 * database and caller scope checks. There is deliberately no `pending` or
 * successor state: an unknown transport outcome is not a committed DTO.
 */
export const CommerceTenantMutationStatusSchema = z
  .discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("committed"),
      organizationId: CommerceOrganizationIdSchema,
      receipt: CommerceTenantMutationReceiptSchema,
    }),
    z.strictObject({
      status: z.literal("not_found"),
      organizationId: CommerceOrganizationIdSchema,
    }),
  ])
  .superRefine((value, ctx) => {
    if (
      value.status === "committed" &&
      value.receipt.operation === "tenant.organization.create" &&
      value.organizationId !== value.receipt.resourceId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["organizationId"],
        message:
          "organizationId must equal the organization receipt resourceId",
      });
    }
  });

export type CommerceTenantMutationStatus = z.infer<
  typeof CommerceTenantMutationStatusSchema
>;

/**
 * Typed strict-v2 success envelopes. These reuse the existing factory and add
 * no envelope or error-catalog behavior. Bodies carry no organization/account
 * principal or role authority except the explicitly requested membership role
 * in that body. Plain schemas are neither authentication nor payment
 * authorization.
 */
export const CommerceTenantMutationResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceTenantMutationResultSchema);

export const CommerceTenantMutationStatusResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceTenantMutationStatusSchema);

export type CommerceTenantMutationResponse = z.infer<
  typeof CommerceTenantMutationResponseSchema
>;
export type CommerceTenantMutationStatusResponse = z.infer<
  typeof CommerceTenantMutationStatusResponseSchema
>;

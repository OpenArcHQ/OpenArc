import { z } from "zod";

import { createCommerceSuccessEnvelopeSchema } from "./api.js";
import {
  CommerceAgentIdSchema,
  CommerceAgentProfileSchema,
  CommerceOrganizationAccessViewSchema,
  CommerceOrganizationIdSchema,
  CommerceOrganizationSchema,
  CommerceProviderIdSchema,
  CommerceProviderProfileSchema,
} from "./identity.js";

/**
 * Frozen tenant read-wire contracts.
 *
 * These are browser-safe, strict Zod contracts for organization-scoped reads.
 * They describe request objects and response data objects only: no route
 * strings, no parser defaults, no selected account/role/principal/session and
 * no authorization. Account identity and tenant comparison remain the job of
 * the future transport/session controller.
 */

export const COMMERCE_TENANT_NETWORK = "eip155:5042002" as const;

const ListLimitSchema = z.number().int().min(1).max(100);

/**
 * Requests. `limit` is optional with no parser default; the repository owns
 * the default of 50. Every request is strict, so callers cannot smuggle an
 * account, role, principal, session, network, digest or raw payload.
 */
export const CommerceOrganizationListRequestSchema = z.strictObject({
  afterOrganizationId: CommerceOrganizationIdSchema.optional(),
  limit: ListLimitSchema.optional(),
});

export const CommerceOrganizationContextRequestSchema = z.strictObject({
  organizationId: CommerceOrganizationIdSchema,
});

export const CommerceAgentListRequestSchema = z.strictObject({
  organizationId: CommerceOrganizationIdSchema,
  afterAgentId: CommerceAgentIdSchema.optional(),
  limit: ListLimitSchema.optional(),
});

export const CommerceProviderListRequestSchema = z.strictObject({
  organizationId: CommerceOrganizationIdSchema,
  afterProviderId: CommerceProviderIdSchema.optional(),
  limit: ListLimitSchema.optional(),
});

export type CommerceOrganizationListRequest = z.infer<
  typeof CommerceOrganizationListRequestSchema
>;
export type CommerceOrganizationContextRequest = z.infer<
  typeof CommerceOrganizationContextRequestSchema
>;
export type CommerceAgentListRequest = z.infer<
  typeof CommerceAgentListRequestSchema
>;
export type CommerceProviderListRequest = z.infer<
  typeof CommerceProviderListRequestSchema
>;

function isStrictlyAscending(ids: readonly string[]): boolean {
  for (let index = 1; index < ids.length; index += 1) {
    if (!(ids[index - 1]! < ids[index]!)) return false;
  }
  return true;
}

/**
 * A cursor is either null or exactly the last item id. A non-null cursor
 * requires at least one item; an empty page therefore must carry a null cursor.
 */
function cursorMatchesLastItem(
  cursor: string | null,
  ids: readonly string[],
): boolean {
  if (cursor === null) return true;
  if (ids.length === 0) return false;
  return cursor === ids[ids.length - 1];
}

function pageIssues(
  ids: readonly string[],
  cursor: string | null,
  ctx: z.RefinementCtx,
): void {
  if (!isStrictlyAscending(ids)) {
    ctx.addIssue({
      code: "custom",
      path: ["items"],
      message: "item ids must be strictly ascending in canonical lexical order",
    });
  }
  if (!cursorMatchesLastItem(cursor, ids)) {
    ctx.addIssue({
      code: "custom",
      path: ["nextCursor"],
      message:
        "nextCursor must be null or exactly the last item id, and non-null only for a non-empty page",
    });
  }
}

export const CommerceOrganizationPageSchema = z
  .strictObject({
    items: z.array(CommerceOrganizationSchema).max(100),
    nextCursor: CommerceOrganizationIdSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    pageIssues(
      value.items.map((item) => item.organizationId),
      value.nextCursor,
      ctx,
    );
  });

export const CommerceOrganizationContextSchema = z
  .strictObject({
    organization: CommerceOrganizationSchema,
    access: CommerceOrganizationAccessViewSchema,
    network: z.literal(COMMERCE_TENANT_NETWORK),
  })
  .refine(
    (value) =>
      value.organization.organizationId === value.access.organizationId,
    {
      message:
        "organization.organizationId must equal access.organizationId",
      path: ["access", "organizationId"],
    },
  );

export const CommerceAgentPageSchema = z
  .strictObject({
    organizationId: CommerceOrganizationIdSchema,
    items: z.array(CommerceAgentProfileSchema).max(100),
    nextCursor: CommerceAgentIdSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    pageIssues(
      value.items.map((item) => item.agentId),
      value.nextCursor,
      ctx,
    );
    value.items.forEach((item, index) => {
      if (item.organizationId !== value.organizationId) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "organizationId"],
          message:
            "item organizationId must match the page organizationId",
        });
      }
    });
  });

export const CommerceProviderPageSchema = z
  .strictObject({
    organizationId: CommerceOrganizationIdSchema,
    items: z.array(CommerceProviderProfileSchema).max(100),
    nextCursor: CommerceProviderIdSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    pageIssues(
      value.items.map((item) => item.providerId),
      value.nextCursor,
      ctx,
    );
    value.items.forEach((item, index) => {
      if (item.organizationId !== value.organizationId) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "organizationId"],
          message:
            "item organizationId must match the page organizationId",
        });
      }
    });
  });

export type CommerceOrganizationPage = z.infer<
  typeof CommerceOrganizationPageSchema
>;
export type CommerceOrganizationContext = z.infer<
  typeof CommerceOrganizationContextSchema
>;
export type CommerceAgentPage = z.infer<typeof CommerceAgentPageSchema>;
export type CommerceProviderPage = z.infer<typeof CommerceProviderPageSchema>;

/**
 * Typed success envelopes over each response data shape. These reuse the
 * existing v2 factory and add no envelope or error-catalog behavior.
 */
export const CommerceOrganizationPageResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceOrganizationPageSchema);
export const CommerceOrganizationContextResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceOrganizationContextSchema);
export const CommerceAgentPageResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceAgentPageSchema);
export const CommerceProviderPageResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceProviderPageSchema);

export type CommerceOrganizationPageResponse = z.infer<
  typeof CommerceOrganizationPageResponseSchema
>;
export type CommerceOrganizationContextResponse = z.infer<
  typeof CommerceOrganizationContextResponseSchema
>;
export type CommerceAgentPageResponse = z.infer<
  typeof CommerceAgentPageResponseSchema
>;
export type CommerceProviderPageResponse = z.infer<
  typeof CommerceProviderPageResponseSchema
>;

const PROTECTED_CLASS = "organization_protected" as const;

function protectedFields<K extends string>(
  keys: readonly K[],
): Readonly<Record<K, typeof PROTECTED_CLASS>> {
  const map = {} as Record<K, typeof PROTECTED_CLASS>;
  for (const key of keys) {
    map[key] = PROTECTED_CLASS;
  }
  return Object.freeze(map);
}

/**
 * Conservative top-level field classification for the four response data
 * shapes. Nested existing DTO field maps remain identity.ts authority. This
 * metadata is not automatic redaction, persistence permission or
 * authorization.
 */
export const COMMERCE_TENANT_READ_FIELD_CLASSES = Object.freeze({
  organizationPage: protectedFields([
    "items",
    "nextCursor",
  ] as const),
  organizationContext: protectedFields([
    "organization",
    "access",
    "network",
  ] as const),
  agentPage: protectedFields([
    "organizationId",
    "items",
    "nextCursor",
  ] as const),
  providerPage: protectedFields([
    "organizationId",
    "items",
    "nextCursor",
  ] as const),
});

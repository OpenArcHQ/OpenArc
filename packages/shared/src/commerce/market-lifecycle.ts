import { z } from "zod";

import { IsoTimestampSchema, Sha256DigestSchema } from "../primitives.js";
import { createCommerceSuccessEnvelopeSchema } from "./api.js";
import {
  CommerceOrganizationIdSchema,
  CommerceProviderIdSchema,
  CommerceProviderProfileSchema,
} from "./identity.js";
import {
  CommerceListingIdSchema,
  CommerceListingOwnerSchema,
  CommerceListingVersionSchema,
} from "./listing.js";
import { CommerceTenantMutationIdSchema } from "./tenant-writes.js";

/**
 * Frozen marketplace lifecycle wire contracts.
 *
 * These are pure, strict Zod DTOs. They describe declared shape only: no SQL,
 * transport, route registry, authorization, moderator-grant provisioning,
 * publication execution, endpoint fetch or purchase/payment authority lives
 * here. Approving an origin review is manual wire metadata, NOT DNS/SSRF proof,
 * endorsement, availability or payment authority. Organization/listing/version
 * targets are always transport PATH parameters, never body fields.
 */

export const CommerceMarketOriginReviewDecisionSchema = z.enum([
  "approved",
  "rejected",
]);

export type CommerceMarketOriginReviewDecision = z.infer<
  typeof CommerceMarketOriginReviewDecisionSchema
>;

export const CommerceMarketOriginReviewReasonCodeSchema = z.enum([
  "manual_review",
  "origin_policy",
  "terms_policy",
  "manifest_policy",
  "other",
]);

export type CommerceMarketOriginReviewReasonCode = z.infer<
  typeof CommerceMarketOriginReviewReasonCodeSchema
>;

/**
 * Exact origin-review body. `reviewedEndpointDigest` is binding metadata, not
 * proof of authority: the future database recomputes the version-bound
 * descriptor digest and a caller cannot declare authority by matching it.
 * `reasonDigest` is a REQUIRED nullable digest because private reviewer notes
 * are never transmitted on the wire.
 */
export const CommerceMarketOriginReviewBodySchema = z.strictObject({
  mutationId: CommerceTenantMutationIdSchema,
  expectedUpdatedAt: IsoTimestampSchema,
  decision: CommerceMarketOriginReviewDecisionSchema,
  reviewedEndpointDigest: Sha256DigestSchema,
  reasonCode: CommerceMarketOriginReviewReasonCodeSchema,
  reasonDigest: Sha256DigestSchema.nullable(),
});

export type CommerceMarketOriginReviewBody = z.infer<
  typeof CommerceMarketOriginReviewBodySchema
>;

/**
 * Publish body. `expectedUpdatedAt` is the accepted owner-version CAS token;
 * `expectedActiveVersion` is the root pointer CAS expectation. Publishing a new
 * version atomically pauses the previous active version and swaps the root
 * pointer under locks, so a stale expectation is an explicit conflict rather
 * than a silent update. `null` means the first publication.
 */
export const CommerceMarketPublishBodySchema = z.strictObject({
  mutationId: CommerceTenantMutationIdSchema,
  expectedUpdatedAt: IsoTimestampSchema,
  expectedActiveVersion: CommerceListingVersionSchema.nullable(),
});

export type CommerceMarketPublishBody = z.infer<
  typeof CommerceMarketPublishBodySchema
>;

/** Pause body: identical shape to publish, a distinct exported schema. */
export const CommerceMarketPauseBodySchema = z.strictObject({
  mutationId: CommerceTenantMutationIdSchema,
  expectedUpdatedAt: IsoTimestampSchema,
  expectedActiveVersion: CommerceListingVersionSchema.nullable(),
});

export type CommerceMarketPauseBody = z.infer<
  typeof CommerceMarketPauseBodySchema
>;

/** Retire body: identical shape to publish, a distinct exported schema. */
export const CommerceMarketRetireBodySchema = z.strictObject({
  mutationId: CommerceTenantMutationIdSchema,
  expectedUpdatedAt: IsoTimestampSchema,
  expectedActiveVersion: CommerceListingVersionSchema.nullable(),
});

export type CommerceMarketRetireBody = z.infer<
  typeof CommerceMarketRetireBodySchema
>;

/**
 * Owner root request. Targets stay strict body IDs here because this DTO
 * describes a direct-edit route load, not a collection query.
 */
export const CommerceMarketOwnerRootRequestSchema = z.strictObject({
  organizationId: CommerceOrganizationIdSchema,
  listingId: CommerceListingIdSchema,
});

export type CommerceMarketOwnerRootRequest = z.infer<
  typeof CommerceMarketOwnerRootRequestSchema
>;

/**
 * Owner root detail. A present `item` must bind both the requested
 * organization and listing; a null `item` is a truthful miss. Whether a null
 * miss is authorized belongs to the future repository/service, not this DTO.
 */
export const CommerceMarketOwnerRootDetailSchema = z
  .strictObject({
    organizationId: CommerceOrganizationIdSchema,
    listingId: CommerceListingIdSchema,
    item: CommerceListingOwnerSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const item = value.item;
    if (item === null) return;
    if (item.organizationId !== value.organizationId) {
      ctx.addIssue({
        code: "custom",
        path: ["item", "organizationId"],
        message: "item organizationId must match the requested organizationId",
      });
    }
    if (item.listingId !== value.listingId) {
      ctx.addIssue({
        code: "custom",
        path: ["item", "listingId"],
        message: "item listingId must match the requested listingId",
      });
    }
  });

export type CommerceMarketOwnerRootDetail = z.infer<
  typeof CommerceMarketOwnerRootDetailSchema
>;

export const CommerceMarketOwnerRootDetailResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceMarketOwnerRootDetailSchema);

export type CommerceMarketOwnerRootDetailResponse = z.infer<
  typeof CommerceMarketOwnerRootDetailResponseSchema
>;

/**
 * Protected provider picker option: an exact projection from the accepted
 * provider profile leaves only. No organization, account, credential, wallet,
 * contact or update timestamp is representable. This is not permission to
 * widen legacy provider-console reads; a future database establishes explicit
 * market read roles.
 */
export const CommerceMarketProviderOptionSchema = z.strictObject({
  providerId: CommerceProviderProfileSchema.shape.providerId,
  displayName: CommerceProviderProfileSchema.shape.displayName,
  status: CommerceProviderProfileSchema.shape.status,
});

export type CommerceMarketProviderOption = z.infer<
  typeof CommerceMarketProviderOptionSchema
>;

const ProviderOptionsLimitSchema = z.number().int().min(1).max(50);

/**
 * Rejects an object that explicitly carries a key whose value is `undefined`,
 * mirroring the accepted market/tenant patch rationale. Runs on raw input
 * before the strict object parses it so `afterProviderId: undefined` is a
 * truthfully present-but-undefined rejection rather than a silent omission.
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
        message: "Explicit undefined request fields are not allowed",
      });
    }
  }
}

function strictRequestSchema<T extends z.ZodRawShape>(shape: T) {
  return z
    .unknown()
    .superRefine(rejectExplicitUndefinedKeys)
    .pipe(z.strictObject(shape));
}

/**
 * Provider-options request. No defaults or coercions: the repository owns the
 * 25-item default cursor page size while the wire limit stays 1..50.
 */
export const CommerceMarketProviderOptionsRequestSchema = strictRequestSchema({
  organizationId: CommerceOrganizationIdSchema,
  afterProviderId: CommerceProviderIdSchema.optional(),
  limit: ProviderOptionsLimitSchema.optional(),
});

export type CommerceMarketProviderOptionsRequest = z.infer<
  typeof CommerceMarketProviderOptionsRequestSchema
>;

/** Strictly ascending and unique under the canonical id comparator. */
function isStrictlyAscending(keys: readonly string[]): boolean {
  for (let index = 1; index < keys.length; index += 1) {
    const previous = keys[index - 1];
    const current = keys[index];
    if (previous === undefined || current === undefined) return false;
    if (previous >= current) return false;
  }
  return true;
}

/**
 * Provider-options page. Items are a bounded allowlist projection sorted
 * strictly ascending and unique by canonical provider id; a null cursor is
 * valid for a final nonempty page, a non-null cursor must reference the last
 * item, and an empty page requires a null cursor.
 */
export const CommerceMarketProviderOptionsPageSchema = z
  .strictObject({
    organizationId: CommerceOrganizationIdSchema,
    items: z.array(CommerceMarketProviderOptionSchema).max(50),
    nextCursor: CommerceProviderIdSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const keys = value.items.map((item) => item.providerId);
    if (!isStrictlyAscending(keys)) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "items must be strictly ascending unique provider ids",
      });
    }
    if (keys.length === 0) {
      if (value.nextCursor !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["nextCursor"],
          message: "an empty page requires a null nextCursor",
        });
      }
      return;
    }
    if (value.nextCursor !== null && value.nextCursor !== keys[keys.length - 1]) {
      ctx.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "nextCursor must equal the last provider id or be null",
      });
    }
  });

export type CommerceMarketProviderOptionsPage = z.infer<
  typeof CommerceMarketProviderOptionsPageSchema
>;

export const CommerceMarketProviderOptionsResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceMarketProviderOptionsPageSchema);

export type CommerceMarketProviderOptionsResponse = z.infer<
  typeof CommerceMarketProviderOptionsResponseSchema
>;

/**
 * Internal safe lifecycle version-resource correlation id:
 * `canonicalListingId@version` with version >= 1. Version 1 is required so the
 * first draft can be reviewed and published; this does NOT weaken the accepted
 * `CommerceMarketVersionResourceIdSchema`, which still requires >= 2 for
 * creation. Length is capped before splitting, exactly one `@` is required, and
 * the accepted listing/version leaf parsers stay authoritative.
 */
const LIFECYCLE_RESOURCE_MAX_LENGTH = 128;

export const CommerceMarketLifecycleResourceIdSchema = z
  .string()
  .max(LIFECYCLE_RESOURCE_MAX_LENGTH, {
    message: "lifecycle resourceId must be at most 128 characters",
  })
  .superRefine((value, ctx) => {
    if (value.length > LIFECYCLE_RESOURCE_MAX_LENGTH) {
      // `.max` is non-fatal in this Zod version, so guard the split here and
      // never touch or split an unbounded raw resource string.
      return;
    }
    const parts = value.split("@");
    if (parts.length !== 2) {
      ctx.addIssue({
        code: "custom",
        message: "lifecycle resourceId must contain exactly one @",
      });
      return;
    }
    const listingId = parts[0];
    const version = parts[1];
    if (listingId === undefined || version === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "lifecycle resourceId must contain exactly one @",
      });
      return;
    }
    if (!CommerceListingIdSchema.safeParse(listingId).success) {
      ctx.addIssue({
        code: "custom",
        message: "lifecycle resourceId must start with a canonical listing id",
      });
      return;
    }
    if (!CommerceListingVersionSchema.safeParse(version).success) {
      ctx.addIssue({
        code: "custom",
        message: "lifecycle resourceId must end with a canonical version",
      });
      return;
    }
    if (BigInt(version) < 1n) {
      ctx.addIssue({
        code: "custom",
        message: "lifecycle resourceId version must be at least 1",
      });
    }
  });

export type CommerceMarketLifecycleResourceId = z.infer<
  typeof CommerceMarketLifecycleResourceIdSchema
>;

/**
 * Closed lifecycle receipt: four exact operation/resourceType/listing_version
 * branches. No raw request, endpoint, reviewer account, reason digest,
 * idempotency key or private note is representable.
 */
export const CommerceMarketLifecycleMutationReceiptSchema = z.discriminatedUnion(
  "operation",
  [
    z.strictObject({
      mutationId: CommerceTenantMutationIdSchema,
      operation: z.literal("market.listing.origin_review.record"),
      resourceType: z.literal("listing_version"),
      resourceId: CommerceMarketLifecycleResourceIdSchema,
      committedAt: IsoTimestampSchema,
    }),
    z.strictObject({
      mutationId: CommerceTenantMutationIdSchema,
      operation: z.literal("market.listing.version.publish"),
      resourceType: z.literal("listing_version"),
      resourceId: CommerceMarketLifecycleResourceIdSchema,
      committedAt: IsoTimestampSchema,
    }),
    z.strictObject({
      mutationId: CommerceTenantMutationIdSchema,
      operation: z.literal("market.listing.version.pause"),
      resourceType: z.literal("listing_version"),
      resourceId: CommerceMarketLifecycleResourceIdSchema,
      committedAt: IsoTimestampSchema,
    }),
    z.strictObject({
      mutationId: CommerceTenantMutationIdSchema,
      operation: z.literal("market.listing.version.retire"),
      resourceType: z.literal("listing_version"),
      resourceId: CommerceMarketLifecycleResourceIdSchema,
      committedAt: IsoTimestampSchema,
    }),
  ],
);

export type CommerceMarketLifecycleMutationReceipt = z.infer<
  typeof CommerceMarketLifecycleMutationReceiptSchema
>;

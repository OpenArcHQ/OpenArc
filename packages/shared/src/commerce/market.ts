import { z } from "zod";

import { IsoTimestampSchema } from "../primitives.js";
import { createCommerceSuccessEnvelopeSchema } from "./api.js";
import {
  CommerceOrganizationIdSchema,
  CommerceProviderIdSchema,
  CommerceProviderProfileSchema,
} from "./identity.js";
import {
  CommerceListingIdSchema,
  CommerceListingKindSchema,
  CommerceListingOwnerSchema,
  CommerceListingOwnerVersionSchema,
  CommerceListingPublicVersionSchema,
  CommerceListingVersionSchema,
} from "./listing.js";
import { CommerceMarketLifecycleMutationReceiptSchema } from "./market-lifecycle.js";
import { CommerceTenantMutationIdSchema } from "./tenant-writes.js";

/**
 * Frozen marketplace read/write wire contracts.
 *
 * These are strict, browser-safe Zod DTOs plus bounded ordering/binding checks.
 * They describe declared shape only: no SQL, transport, route registry,
 * authorization, publication, provider-status lookup, purchase or payment
 * execution lives here. `paymentLane` remains `unavailable`; parsing an active
 * public listing is never purchase authority. Query text is validated but not
 * transmitted or fetched by this module.
 */

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)) {
      return true;
    }
  }
  return false;
}

/**
 * Rejects an object that explicitly carries a key whose value is `undefined`.
 * Zod's optional fields would otherwise accept `undefined` and drop the key,
 * silently treating a present-but-undefined field as absent. Runs on raw input
 * before the strict object parses it, mirroring the accepted tenant patch
 * rationale.
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

/**
 * Strict read-request builder: unknown keys are rejected rather than stripped,
 * explicit `undefined` optional values are rejected, and no defaults or
 * coercions are applied. Optional keys stay omitted, never defaulted.
 */
function strictRequestSchema<T extends z.ZodRawShape>(shape: T) {
  return z
    .unknown()
    .superRefine(rejectExplicitUndefinedKeys)
    .pipe(z.strictObject(shape));
}

/**
 * Exact allowlisted listing content leaves, referenced by name from the
 * accepted owner-version schema so this module cannot drift into a second
 * source of truth. No status, review, timestamp, id, actor, key, secret or
 * arbitrary record is representable. `paymentLane` remains `unavailable`.
 */
const ownerVersionShape = CommerceListingOwnerVersionSchema.shape;

export const CommerceMarketListingContentSchema = z.strictObject({
  kind: ownerVersionShape.kind,
  title: ownerVersionShape.title,
  description: ownerVersionShape.description,
  manifest: ownerVersionShape.manifest,
  price: ownerVersionShape.price,
  evidenceContract: ownerVersionShape.evidenceContract,
  endpointContract: ownerVersionShape.endpointContract,
  termsRevision: ownerVersionShape.termsRevision,
  privacySummary: ownerVersionShape.privacySummary,
  paymentLane: ownerVersionShape.paymentLane,
  availability: ownerVersionShape.availability,
});

export type CommerceMarketListingContent = z.infer<
  typeof CommerceMarketListingContentSchema
>;

/**
 * Write bodies. Organization/listing targets are transport PATH parameters,
 * never duplicated in the body. The version create body carries no provider id
 * (the accepted listing already binds the provider). `expectedLatestVersion`
 * is the accepted canonical `1..999999999` decimal.
 */
export const CommerceMarketDraftCreateBodySchema = z.strictObject({
  mutationId: CommerceTenantMutationIdSchema,
  providerId: CommerceProviderIdSchema,
  content: CommerceMarketListingContentSchema,
});

export const CommerceMarketVersionCreateBodySchema = z.strictObject({
  mutationId: CommerceTenantMutationIdSchema,
  expectedLatestVersion: CommerceListingVersionSchema,
  content: CommerceMarketListingContentSchema,
});

export type CommerceMarketDraftCreateBody = z.infer<
  typeof CommerceMarketDraftCreateBodySchema
>;
export type CommerceMarketVersionCreateBody = z.infer<
  typeof CommerceMarketVersionCreateBodySchema
>;

/** Repository owns the default page size (25); the wire limit is 1..50. */
const MarketLimitSchema = z.number().int().min(1).max(50);

/**
 * Public catalog search text only: nonempty, trimmed, 1..80 characters, and
 * free of C0/C1 control characters. The schema validates but does not transmit
 * or fetch this value, and carries no private Vault labels or history.
 */
const MarketQuerySchema = z
  .string()
  .min(1)
  .max(80)
  .refine((value) => value === value.trim(), {
    message: "q must not have leading/trailing whitespace",
  })
  .refine((value) => !hasControlCharacter(value), {
    message: "q must not contain control characters",
  });

export const CommerceMarketOwnerListRequestSchema = strictRequestSchema({
  organizationId: CommerceOrganizationIdSchema,
  afterListingId: CommerceListingIdSchema.optional(),
  limit: MarketLimitSchema.optional(),
});

export const CommerceMarketOwnerVersionsRequestSchema = strictRequestSchema({
  organizationId: CommerceOrganizationIdSchema,
  listingId: CommerceListingIdSchema,
  afterVersion: CommerceListingVersionSchema.optional(),
  limit: MarketLimitSchema.optional(),
});

export const CommerceMarketOwnerVersionRequestSchema = strictRequestSchema({
  organizationId: CommerceOrganizationIdSchema,
  listingId: CommerceListingIdSchema,
  version: CommerceListingVersionSchema,
});

export const CommerceMarketMutationStatusRequestSchema = strictRequestSchema({
  organizationId: CommerceOrganizationIdSchema,
  mutationId: CommerceTenantMutationIdSchema,
});

export const CommerceMarketPublicListRequestSchema = strictRequestSchema({
  afterListingId: CommerceListingIdSchema.optional(),
  limit: MarketLimitSchema.optional(),
  kind: CommerceListingKindSchema.optional(),
  providerId: CommerceProviderIdSchema.optional(),
  q: MarketQuerySchema.optional(),
});

export const CommerceMarketPublicDetailRequestSchema = strictRequestSchema({
  listingId: CommerceListingIdSchema,
});

export const CommerceMarketPublicProviderRequestSchema = strictRequestSchema({
  providerId: CommerceProviderIdSchema,
});

export type CommerceMarketOwnerListRequest = z.infer<
  typeof CommerceMarketOwnerListRequestSchema
>;
export type CommerceMarketOwnerVersionsRequest = z.infer<
  typeof CommerceMarketOwnerVersionsRequestSchema
>;
export type CommerceMarketOwnerVersionRequest = z.infer<
  typeof CommerceMarketOwnerVersionRequestSchema
>;
export type CommerceMarketMutationStatusRequest = z.infer<
  typeof CommerceMarketMutationStatusRequestSchema
>;
export type CommerceMarketPublicListRequest = z.infer<
  typeof CommerceMarketPublicListRequestSchema
>;
export type CommerceMarketPublicDetailRequest = z.infer<
  typeof CommerceMarketPublicDetailRequestSchema
>;
export type CommerceMarketPublicProviderRequest = z.infer<
  typeof CommerceMarketPublicProviderRequestSchema
>;

/**
 * Current public provider profile metadata only. This is an allowlist
 * projection shape, not an immutable provider version and not a trust score;
 * a future reputation layer is separate. No organization, account, wallet,
 * key, createdAt, internal status or claimed reputation is representable. The
 * repository must project the display name from an accepted provider profile.
 */
export const CommerceMarketPublicProviderSchema = z.strictObject({
  schemaVersion: z.literal("openarc.provider-public.v1"),
  providerId: CommerceProviderIdSchema,
  displayName: CommerceProviderProfileSchema.shape.displayName,
  status: z.literal("active"),
});

export type CommerceMarketPublicProvider = z.infer<
  typeof CommerceMarketPublicProviderSchema
>;

function compareCanonicalId(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/** Accepted canonical version: `1..999999999`, no sign/leading zero/whitespace. */
const CANONICAL_VERSION_PATTERN = /^(?:[1-9][0-9]{0,8})$/;

function compareCanonicalVersion(left: string, right: string): number {
  // `superRefine` can run over raw values whose per-field string validation
  // failed non-fatally, so never feed an unvalidated string to `BigInt`. Only
  // the accepted canonical 1..999999999 decimal reaches numeric comparison;
  // malformed or oversized input is ordered lexically (and the enclosing page
  // schema still reports the malformed item), which cannot throw.
  if (
    !CANONICAL_VERSION_PATTERN.test(left) ||
    !CANONICAL_VERSION_PATTERN.test(right)
  ) {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }
  const a = BigInt(left);
  const b = BigInt(right);
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Strictly ascending and unique under the supplied comparator. */
function isStrictlyAscending(
  keys: readonly string[],
  compare: (left: string, right: string) => number,
): boolean {
  for (let index = 1; index < keys.length; index += 1) {
    const previous = keys[index - 1];
    const current = keys[index];
    if (previous === undefined || current === undefined) return false;
    if (compare(previous, current) >= 0) return false;
  }
  return true;
}

/**
 * Page cursor rule: an empty page requires a null cursor; a nonempty page may
 * always terminate with a null cursor (last page), while a non-null cursor must
 * be exactly the last item key. Cursors never point past the final item.
 */
function cursorMatchesLastItem(
  cursor: string | null,
  keys: readonly string[],
): boolean {
  if (keys.length === 0) return cursor === null;
  // A null cursor is always a valid page terminator; only a non-null cursor
  // must reference the last item key.
  if (cursor === null) return true;
  return cursor === keys[keys.length - 1];
}

/**
 * Owner root page. Items are accepted owner listing roots, sorted strictly
 * ascending and unique by canonical listing id, and every item binds to the
 * page organization id.
 */
export const CommerceMarketOwnerPageSchema = z
  .strictObject({
    organizationId: CommerceOrganizationIdSchema,
    items: z.array(CommerceListingOwnerSchema).max(50),
    nextCursor: CommerceListingIdSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const keys = value.items.map((item) => item.listingId);
    if (!isStrictlyAscending(keys, compareCanonicalId)) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "items must be strictly ascending unique listing ids",
      });
    }
    if (!cursorMatchesLastItem(value.nextCursor, keys)) {
      ctx.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "nextCursor must equal the last listing id or be null",
      });
    }
    value.items.forEach((item, index) => {
      if (item.organizationId !== value.organizationId) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "organizationId"],
          message: "item organizationId must match the page organizationId",
        });
      }
    });
  });

export type CommerceMarketOwnerPage = z.infer<
  typeof CommerceMarketOwnerPageSchema
>;

/**
 * Owner version history page. Every item binds to the page organization,
 * listing and provider ids; versions are sorted strictly ascending and unique
 * NUMERICALLY (1, 2, 10 valid; 1, 10, 2 invalid).
 */
export const CommerceMarketOwnerVersionPageSchema = z
  .strictObject({
    organizationId: CommerceOrganizationIdSchema,
    listingId: CommerceListingIdSchema,
    providerId: CommerceProviderIdSchema,
    items: z.array(CommerceListingOwnerVersionSchema).max(50),
    nextCursor: CommerceListingVersionSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const keys = value.items.map((item) => item.version);
    if (!isStrictlyAscending(keys, compareCanonicalVersion)) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "items must be strictly ascending unique versions",
      });
    }
    if (!cursorMatchesLastItem(value.nextCursor, keys)) {
      ctx.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "nextCursor must equal the last version or be null",
      });
    }
    value.items.forEach((item, index) => {
      if (item.organizationId !== value.organizationId) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "organizationId"],
          message: "item organizationId must match the page organizationId",
        });
      }
      if (item.listingId !== value.listingId) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "listingId"],
          message: "item listingId must match the page listingId",
        });
      }
      if (item.providerId !== value.providerId) {
        ctx.addIssue({
          code: "custom",
          path: ["items", index, "providerId"],
          message: "item providerId must match the page providerId",
        });
      }
    });
  });

export type CommerceMarketOwnerVersionPage = z.infer<
  typeof CommerceMarketOwnerVersionPageSchema
>;

/**
 * Owner version detail. A present item must match every requested target
 * binding (organization, listing and version); a null item is a truthful miss.
 */
export const CommerceMarketOwnerVersionDetailSchema = z
  .strictObject({
    organizationId: CommerceOrganizationIdSchema,
    listingId: CommerceListingIdSchema,
    version: CommerceListingVersionSchema,
    item: CommerceListingOwnerVersionSchema.nullable(),
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
    if (item.version !== value.version) {
      ctx.addIssue({
        code: "custom",
        path: ["item", "version"],
        message: "item version must match the requested version",
      });
    }
  });

export type CommerceMarketOwnerVersionDetail = z.infer<
  typeof CommerceMarketOwnerVersionDetailSchema
>;

/**
 * Public catalog page. Items reuse the accepted public version projection,
 * sorted strictly ascending and unique by canonical listing id. Public data
 * never carries organization ids, endpoint path, internal review, account,
 * cookies, policy, raw outputs, receipts or private notes.
 */
export const CommerceMarketPublicPageSchema = z
  .strictObject({
    items: z.array(CommerceListingPublicVersionSchema).max(50),
    nextCursor: CommerceListingIdSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const keys = value.items.map((item) => item.listingId);
    if (!isStrictlyAscending(keys, compareCanonicalId)) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "items must be strictly ascending unique listing ids",
      });
    }
    if (!cursorMatchesLastItem(value.nextCursor, keys)) {
      ctx.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "nextCursor must equal the last listing id or be null",
      });
    }
  });

export type CommerceMarketPublicPage = z.infer<
  typeof CommerceMarketPublicPageSchema
>;

export const CommerceMarketPublicDetailSchema = z
  .strictObject({
    listingId: CommerceListingIdSchema,
    item: CommerceListingPublicVersionSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.item !== null && value.item.listingId !== value.listingId) {
      ctx.addIssue({
        code: "custom",
        path: ["item", "listingId"],
        message: "item listingId must match the requested listingId",
      });
    }
  });

export type CommerceMarketPublicDetail = z.infer<
  typeof CommerceMarketPublicDetailSchema
>;

export const CommerceMarketPublicProviderDetailSchema = z
  .strictObject({
    providerId: CommerceProviderIdSchema,
    item: CommerceMarketPublicProviderSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    if (value.item !== null && value.item.providerId !== value.providerId) {
      ctx.addIssue({
        code: "custom",
        path: ["item", "providerId"],
        message: "item providerId must match the requested providerId",
      });
    }
  });

export type CommerceMarketPublicProviderDetail = z.infer<
  typeof CommerceMarketPublicProviderDetailSchema
>;

/**
 * Internal safe version-resource correlation id: `canonicalListingId@version`
 * with version >= 2 (the first version is the draft root). Length is capped
 * before splitting, exactly one `@` is required, and the accepted listing-id
 * and version parsers are authoritative. This is NEVER a public listing id.
 */
const MARKET_VERSION_RESOURCE_MAX_LENGTH = 128;

export const CommerceMarketVersionResourceIdSchema = z
  .string()
  .max(MARKET_VERSION_RESOURCE_MAX_LENGTH, {
    message: "version resourceId must be at most 128 characters",
  })
  .superRefine((value, ctx) => {
    if (value.length > MARKET_VERSION_RESOURCE_MAX_LENGTH) {
      // `.max` above is non-fatal in this Zod version, so guard the split here
      // and never touch or split an unbounded raw resource string.
      return;
    }
    const parts = value.split("@");
    if (parts.length !== 2) {
      ctx.addIssue({
        code: "custom",
        message: "version resourceId must contain exactly one @",
      });
      return;
    }
    const listingId = parts[0];
    const version = parts[1];
    if (listingId === undefined || version === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "version resourceId must contain exactly one @",
      });
      return;
    }
    if (!CommerceListingIdSchema.safeParse(listingId).success) {
      ctx.addIssue({
        code: "custom",
        message: "version resourceId must start with a canonical listing id",
      });
      return;
    }
    if (!CommerceListingVersionSchema.safeParse(version).success) {
      ctx.addIssue({
        code: "custom",
        message: "version resourceId must end with a canonical version",
      });
      return;
    }
    if (BigInt(version) < 2n) {
      ctx.addIssue({
        code: "custom",
        message: "version resourceId version must be at least 2",
      });
    }
  });

export type CommerceMarketVersionResourceId = z.infer<
  typeof CommerceMarketVersionResourceIdSchema
>;

/**
 * Safe immutable market receipt. The union is closed and discriminated by
 * operation, and each variant has an exact `operation` / `resourceType` pair.
 * No body, display name, hash, endpoint, key, actor, role, session or raw blob
 * is representable. A listing draft resourceId must equal
 * `openarc:listing:` + mutationId (deterministic draft id binding); a version
 * resourceId uses the internal version-resource correlation format.
 */
export const CommerceMarketMutationReceiptSchema = z
  .discriminatedUnion("operation", [
    z.strictObject({
      mutationId: CommerceTenantMutationIdSchema,
      operation: z.literal("market.listing.create"),
      resourceType: z.literal("listing"),
      resourceId: CommerceListingIdSchema,
      committedAt: IsoTimestampSchema,
    }),
    z.strictObject({
      mutationId: CommerceTenantMutationIdSchema,
      operation: z.literal("market.listing.version.create"),
      resourceType: z.literal("listing_version"),
      resourceId: CommerceMarketVersionResourceIdSchema,
      committedAt: IsoTimestampSchema,
    }),
    ...CommerceMarketLifecycleMutationReceiptSchema.options,
  ])
  .superRefine((receipt, ctx) => {
    if (
      receipt.operation === "market.listing.create" &&
      receipt.resourceId !== `openarc:listing:${receipt.mutationId}`
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["resourceId"],
        message:
          "listing resourceId must equal 'openarc:listing:' + mutationId",
      });
    }
  });

export type CommerceMarketMutationReceipt = z.infer<
  typeof CommerceMarketMutationReceiptSchema
>;

export const CommerceMarketMutationResultSchema = z.strictObject({
  replayed: z.boolean(),
  receipt: CommerceMarketMutationReceiptSchema,
});

export type CommerceMarketMutationResult = z.infer<
  typeof CommerceMarketMutationResultSchema
>;

/**
 * Closed status discriminated union: a committed mutation carries its safe
 * receipt; `not_found` carries no successor or pending fiction. There is no
 * `pending` or `success` state.
 */
export const CommerceMarketMutationStatusSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("committed"),
      receipt: CommerceMarketMutationReceiptSchema,
    }),
    z.strictObject({
      status: z.literal("not_found"),
    }),
  ],
);

export type CommerceMarketMutationStatus = z.infer<
  typeof CommerceMarketMutationStatusSchema
>;

/**
 * Strict v2 success envelopes over the exact DTO instances above. The factory
 * adds no envelope or error-catalog behavior; these are contracts, not
 * authentication or payment authorization.
 */
export const CommerceMarketOwnerPageResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceMarketOwnerPageSchema);
export const CommerceMarketOwnerVersionPageResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceMarketOwnerVersionPageSchema);
export const CommerceMarketOwnerVersionDetailResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceMarketOwnerVersionDetailSchema);
export const CommerceMarketPublicPageResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceMarketPublicPageSchema);
export const CommerceMarketPublicDetailResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceMarketPublicDetailSchema);
export const CommerceMarketPublicProviderDetailResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceMarketPublicProviderDetailSchema);
export const CommerceMarketMutationResultResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceMarketMutationResultSchema);
export const CommerceMarketMutationStatusResponseSchema =
  createCommerceSuccessEnvelopeSchema(CommerceMarketMutationStatusSchema);

export type CommerceMarketOwnerPageResponse = z.infer<
  typeof CommerceMarketOwnerPageResponseSchema
>;
export type CommerceMarketOwnerVersionPageResponse = z.infer<
  typeof CommerceMarketOwnerVersionPageResponseSchema
>;
export type CommerceMarketOwnerVersionDetailResponse = z.infer<
  typeof CommerceMarketOwnerVersionDetailResponseSchema
>;
export type CommerceMarketPublicPageResponse = z.infer<
  typeof CommerceMarketPublicPageResponseSchema
>;
export type CommerceMarketPublicDetailResponse = z.infer<
  typeof CommerceMarketPublicDetailResponseSchema
>;
export type CommerceMarketPublicProviderDetailResponse = z.infer<
  typeof CommerceMarketPublicProviderDetailResponseSchema
>;
export type CommerceMarketMutationResultResponse = z.infer<
  typeof CommerceMarketMutationResultResponseSchema
>;
export type CommerceMarketMutationStatusResponse = z.infer<
  typeof CommerceMarketMutationStatusResponseSchema
>;

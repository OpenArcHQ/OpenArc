import { z } from "zod";

import {
  Sha256DigestSchema,
  IsoTimestampSchema,
  compareIsoTimestamps,
} from "../primitives.js";
import {
  CommerceOrganizationIdSchema,
  CommerceProviderIdSchema,
} from "./identity.js";
import {
  CommerceUsdcAmountSchema,
  type CommerceUsdcAmount,
} from "./money.js";

/**
 * Frozen listing/version shared contracts.
 *
 * These are pure, strict Zod DTOs and one pure projection helper. They describe
 * declared shape only: no SQL, transport, authorization, provider-status lookup,
 * purchase or payment execution lives here. Public metadata is never authority.
 * `projectCommerceListingPublicVersion` performs allowlist redaction only; it is
 * not a marketplace, purchase or approval check.
 */

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

// (?![\s\S]) pins the absolute end of input so a trailing newline cannot satisfy `$`.
export const CommerceListingIdSchema = z
  .string()
  .regex(new RegExp(`^openarc:listing:${UUID_PATTERN}(?![\\s\\S])`), {
    message: "Expected a canonical openarc:listing: UUID",
  });

export type CommerceListingId = z.infer<typeof CommerceListingIdSchema>;

// Canonical decimal 1..999999999: no signs, whitespace, leading zeros,
// exponent, fractional, or semver forms.
export const CommerceListingVersionSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,8}$/u, {
    message: "Expected a canonical listing version between 1 and 999999999",
  });

export type CommerceListingVersion = z.infer<
  typeof CommerceListingVersionSchema
>;

export const CommerceListingKindSchema = z.enum([
  "api",
  "mcp_tool",
  "data",
  "model",
  "workflow",
  "agent",
]);

export type CommerceListingKind = z.infer<typeof CommerceListingKindSchema>;

export const CommerceListingStatusSchema = z.enum([
  "draft",
  "active",
  "paused",
  "retired",
]);

export type CommerceListingStatus = z.infer<
  typeof CommerceListingStatusSchema
>;

export const CommerceOriginReviewStateSchema = z.enum([
  "unreviewed",
  "approved",
  "rejected",
]);

export type CommerceOriginReviewState = z.infer<
  typeof CommerceOriginReviewStateSchema
>;

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

function trimmedText(max: number, label: string) {
  return z
    .string()
    .min(1)
    .max(max)
    .refine((value) => value === value.trim(), {
      message: `${label} must not have leading/trailing whitespace`,
    })
    .refine((value) => !hasControlCharacter(value), {
      message: `${label} must not contain control characters`,
    });
}

const TitleSchema = trimmedText(100, "title");
const DescriptionSchema = trimmedText(2000, "description");
const TermsRevisionSchema = trimmedText(128, "termsRevision");
const PrivacySummarySchema = trimmedText(1500, "privacySummary");

// Endpoint syntax only. This is NOT DNS/SSRF safety and NOT review approval;
// no parser here fetches a URL. The path remains owner-only metadata.

const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u;
const IPV4_PATTERN = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

function isLowercaseCanonicalDnsName(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (host.includes(":")) return false;
  if (IPV4_PATTERN.test(host)) return false;
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    return false;
  }
  const labels = host.split(".");
  // Reject single-label internal names and trailing-dot hosts.
  if (labels.length < 2) return false;
  for (const label of labels) {
    if (label.length === 0 || label.length > 63) return false;
    if (!DNS_LABEL_PATTERN.test(label)) return false;
  }
  return true;
}

interface ParsedHttpUrl {
  readonly protocol: string;
  readonly origin: string;
  readonly username: string;
  readonly password: string;
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
  readonly hostname: string;
}

// The shared package compiles with the ES2022 lib, which has no DOM URL type.
// Access the platform URL constructor structurally at runtime without adding a
// dependency or widening compiler configuration.
function parseHttpsUrl(value: string): ParsedHttpUrl | null {
  const Ctor = (
    globalThis as { URL?: new (input: string) => ParsedHttpUrl }
  ).URL;
  if (Ctor === undefined) return null;
  try {
    return new Ctor(value);
  } catch {
    return null;
  }
}

export const CommerceEndpointOriginSchema = z
  .string()
  .max(253, { message: "origin must be at most 253 characters" })
  .refine((value) => !hasControlCharacter(value) && !/\s/u.test(value), {
    message: "origin must not contain whitespace or control characters",
  })
  .refine((value) => {
    const url = parseHttpsUrl(value);
    if (url === null) return false;
    if (url.protocol !== "https:") return false;
    if (url.origin !== value) return false;
    if (url.username !== "" || url.password !== "") return false;
    if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
      return false;
    }
    return isLowercaseCanonicalDnsName(url.hostname);
  }, { message: "origin must be a canonical lowercase HTTPS origin" });

export type CommerceEndpointOrigin = z.infer<
  typeof CommerceEndpointOriginSchema
>;

export const CommerceEndpointPathSchema = z
  .string()
  .max(512, { message: "path must be at most 512 characters" })
  .regex(/^\/[A-Za-z0-9\-._~/]*$/u, {
    message:
      "path must start with one slash and use only ASCII unreserved characters",
  })
  .refine((value) => !value.includes("//"), {
    message: "path must not contain duplicate slashes",
  })
  .refine(
    (value) =>
      !value
        .split("/")
        .some((segment) => segment === "." || segment === ".."),
    { message: "path must not contain dot or dot-dot segments" },
  );

export type CommerceEndpointPath = z.infer<typeof CommerceEndpointPathSchema>;

export const CommerceEndpointContractSchema = z.strictObject({
  origin: CommerceEndpointOriginSchema,
  path: CommerceEndpointPathSchema,
});

export type CommerceEndpointContract = z.infer<
  typeof CommerceEndpointContractSchema
>;

const IdentifierSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/u, {
  message: "Expected a lowercase identifier",
});

export const CommerceReceiptContractSchema = z.strictObject({
  schemaVersion: z.literal("openarc.receipt-contract.v1"),
  receiptType: IdentifierSchema,
  receiptSchemaDigest: Sha256DigestSchema,
  deliveryFields: z
    .array(IdentifierSchema)
    .min(1)
    .max(32)
    .refine((fields) => new Set(fields).size === fields.length, {
      message: "deliveryFields must be unique",
    }),
});

export type CommerceReceiptContract = z.infer<
  typeof CommerceReceiptContractSchema
>;

export const CommerceListingManifestSchema = z.strictObject({
  schemaVersion: z.literal("openarc.listing-manifest.v1"),
  inputSchemaDigest: Sha256DigestSchema,
  outputSchemaDigest: Sha256DigestSchema,
});

export type CommerceListingManifest = z.infer<
  typeof CommerceListingManifestSchema
>;

const RateLimitSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,6}$/u, {
    message: "Expected a canonical decimal rate limit",
  })
  .refine(
    (value) =>
      /^[1-9][0-9]{0,6}$/u.test(value) && BigInt(value) <= 1000000n,
    { message: "rateLimitPerMinute must be at most 1000000" },
  );

export const CommerceListingAvailabilitySchema = z.strictObject({
  status: z.enum(["available", "unavailable"]),
  rateLimitPerMinute: z.union([z.null(), RateLimitSchema]),
});

export type CommerceListingAvailability = z.infer<
  typeof CommerceListingAvailabilitySchema
>;

// Positive uint256 canonical decimal: no signs, whitespace, leading zeros,
// exponent or fractional forms, and bounded to 78 digits so BigInt is only ever
// reached by already-valid canonical input.
const POSITIVE_ATOMIC_AMOUNT_PATTERN = /^[1-9][0-9]{0,77}$/u;

// A listing price amount is the erc20/decimals6 branch of the accepted USDC
// schema. This reuses the existing strict branch directly (no new money model
// and no modification to money.ts); the exported type documents that branch.
export type CommerceListingPriceAmount = Extract<
  CommerceUsdcAmount,
  { representation: "erc20"; decimals: 6 }
>;

// The accepted discriminated union's second option is its strict erc20/6
// branch. Reusing it preserves strict extra-key rejection and the canonical
// uint256 atomic amount, and keeps z.infer narrowed to erc20/6.
const CommerceUsdcAmountErc20Schema = CommerceUsdcAmountSchema.options[1];

function isSupportedPriceAmount(value: {
  representation: "erc20";
  decimals: 6;
  atomicAmount: string;
}): boolean {
  // Narrows the accepted erc20/6 branch to a positive listing price amount:
  // zero/free pricing is not supported. Overflow is already rejected upstream
  // by the canonical uint256 schema, so this only guards positivity.
  return (
    POSITIVE_ATOMIC_AMOUNT_PATTERN.test(value.atomicAmount) &&
    BigInt(value.atomicAmount) > 0n
  );
}

const CommerceListingPriceAmountSchema =
  CommerceUsdcAmountErc20Schema.refine(isSupportedPriceAmount, {
    message: "price requires a positive erc20/decimals6 USDC amount",
  });

export const CommerceListingPriceSchema = z.strictObject({
  amount: CommerceListingPriceAmountSchema,
  pricingModel: z.literal("fixed"),
});

export type CommerceListingPrice = z.infer<typeof CommerceListingPriceSchema>;

function ownerHasNonDecreasingTimestamps(value: {
  createdAt: string;
  updatedAt: string;
}): boolean {
  if (!IsoTimestampSchema.safeParse(value.createdAt).success) return true;
  if (!IsoTimestampSchema.safeParse(value.updatedAt).success) return true;
  return compareIsoTimestamps(value.updatedAt, value.createdAt) >= 0;
}

function ownerHasValidPublicationWindow(value: {
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}): boolean {
  if (value.publishedAt === null) return true;
  if (!IsoTimestampSchema.safeParse(value.createdAt).success) return true;
  if (!IsoTimestampSchema.safeParse(value.updatedAt).success) return true;
  if (!IsoTimestampSchema.safeParse(value.publishedAt).success) return true;
  return (
    compareIsoTimestamps(value.publishedAt, value.createdAt) >= 0 &&
    compareIsoTimestamps(value.publishedAt, value.updatedAt) <= 0
  );
}

function ownerIsActivePublicationEligible(value: {
  status: "draft" | "active" | "paused" | "retired";
  originReviewState: "unreviewed" | "approved" | "rejected";
  publishedAt: string | null;
}): boolean {
  if (value.status !== "active") return true;
  // Syntactically approved metadata alone never authorizes publication.
  return value.originReviewState === "approved" && value.publishedAt !== null;
}

export const CommerceListingOwnerVersionSchema = z
  .strictObject({
    schemaVersion: z.literal("openarc.listing-owner-version.v1"),
    listingId: CommerceListingIdSchema,
    organizationId: CommerceOrganizationIdSchema,
    providerId: CommerceProviderIdSchema,
    version: CommerceListingVersionSchema,
    kind: CommerceListingKindSchema,
    title: TitleSchema,
    description: DescriptionSchema,
    manifest: CommerceListingManifestSchema,
    price: CommerceListingPriceSchema,
    evidenceContract: CommerceReceiptContractSchema,
    endpointContract: CommerceEndpointContractSchema,
    originReviewState: CommerceOriginReviewStateSchema,
    termsRevision: TermsRevisionSchema,
    privacySummary: PrivacySummarySchema,
    paymentLane: z.literal("unavailable"),
    availability: CommerceListingAvailabilitySchema,
    status: CommerceListingStatusSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
    publishedAt: IsoTimestampSchema.nullable(),
  })
  .refine(ownerHasNonDecreasingTimestamps, {
    message: "updatedAt must not precede createdAt",
  })
  .refine(ownerHasValidPublicationWindow, {
    message: "publishedAt must fall between createdAt and updatedAt",
  })
  .refine(ownerIsActivePublicationEligible, {
    message: "active versions require approved origin review and publishedAt",
  });

export type CommerceListingOwnerVersion = z.infer<
  typeof CommerceListingOwnerVersionSchema
>;

export const CommerceListingPublicVersionSchema = z.strictObject({
  schemaVersion: z.literal("openarc.listing-public-version.v1"),
  listingId: CommerceListingIdSchema,
  providerId: CommerceProviderIdSchema,
  version: CommerceListingVersionSchema,
  kind: CommerceListingKindSchema,
  title: TitleSchema,
  description: DescriptionSchema,
  manifest: CommerceListingManifestSchema,
  price: CommerceListingPriceSchema,
  evidenceContract: CommerceReceiptContractSchema,
  endpointOrigin: CommerceEndpointOriginSchema,
  termsRevision: TermsRevisionSchema,
  privacySummary: PrivacySummarySchema,
  paymentLane: z.literal("unavailable"),
  availability: CommerceListingAvailabilitySchema,
  status: z.literal("active"),
  publishedAt: IsoTimestampSchema,
});

export type CommerceListingPublicVersion = z.infer<
  typeof CommerceListingPublicVersionSchema
>;

/**
 * Explicit allowlist projection from an owner version DTO to its public,
 * buyer-facing shape. Malformed owner input throws; well-formed but ineligible
 * state (not active, origin not approved, or no publishedAt) returns null.
 *
 * Future repositories MUST additionally verify current provider status and the
 * listing active-version pointer. This pure projector is not an authorization,
 * availability or purchase check.
 */
export function projectCommerceListingPublicVersion(
  input: unknown,
): CommerceListingPublicVersion | null {
  const owner = CommerceListingOwnerVersionSchema.parse(input);
  if (
    owner.status !== "active" ||
    owner.originReviewState !== "approved" ||
    owner.publishedAt === null
  ) {
    return null;
  }
  const projected = {
    schemaVersion: "openarc.listing-public-version.v1" as const,
    listingId: owner.listingId,
    providerId: owner.providerId,
    version: owner.version,
    kind: owner.kind,
    title: owner.title,
    description: owner.description,
    manifest: owner.manifest,
    price: owner.price,
    evidenceContract: owner.evidenceContract,
    endpointOrigin: owner.endpointContract.origin,
    termsRevision: owner.termsRevision,
    privacySummary: owner.privacySummary,
    paymentLane: "unavailable" as const,
    availability: owner.availability,
    status: "active" as const,
    publishedAt: owner.publishedAt,
  };
  return CommerceListingPublicVersionSchema.parse(projected);
}

export const CommerceListingOwnerSchema = z
  .strictObject({
    schemaVersion: z.literal("openarc.listing.v1"),
    listingId: CommerceListingIdSchema,
    organizationId: CommerceOrganizationIdSchema,
    providerId: CommerceProviderIdSchema,
    activeVersion: CommerceListingVersionSchema.nullable(),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .refine(ownerHasNonDecreasingTimestamps, {
    message: "updatedAt must not precede createdAt",
  });

export type CommerceListingOwner = z.infer<typeof CommerceListingOwnerSchema>;

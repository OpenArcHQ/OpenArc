import { z } from "zod";
import { compareIsoTimestamps, IsoTimestampSchema } from "../primitives.js";

const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

// (?![\s\S]) pins the absolute end of input so a trailing newline cannot satisfy `$`.
const canonicalIdSchema = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}${UUID_PATTERN}(?![\\s\\S])`));

export const CommerceOrganizationIdSchema = canonicalIdSchema("openarc:org:");
export const CommerceAccountIdSchema = canonicalIdSchema("openarc:account:");
export const CommerceAgentIdSchema = canonicalIdSchema("openarc:agent:");
export const CommerceProviderIdSchema = canonicalIdSchema("openarc:provider:");

export type CommerceOrganizationId = z.infer<typeof CommerceOrganizationIdSchema>;
export type CommerceAccountId = z.infer<typeof CommerceAccountIdSchema>;
export type CommerceAgentId = z.infer<typeof CommerceAgentIdSchema>;
export type CommerceProviderId = z.infer<typeof CommerceProviderIdSchema>;

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

const DisplayNameSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (value) => value === value.trim(),
    "displayName must not have leading/trailing whitespace",
  )
  .refine(
    (value) => !hasControlCharacter(value),
    "displayName must not contain control characters",
  );

export const CommerceHumanRoleSchema = z.enum([
  "owner",
  "operator",
  "provider_admin",
  "provider_developer",
  "viewer",
]);

export type CommerceHumanRole = z.infer<typeof CommerceHumanRoleSchema>;

function hasNonDecreasingTimestamps(value: {
  createdAt: string;
  updatedAt: string;
}): boolean {
  if (!IsoTimestampSchema.safeParse(value.createdAt).success) return true;
  if (!IsoTimestampSchema.safeParse(value.updatedAt).success) return true;
  return compareIsoTimestamps(value.updatedAt, value.createdAt) >= 0;
}

export const CommerceOrganizationSchema = z
  .strictObject({
    schemaVersion: z.literal("openarc.organization.v1"),
    organizationId: CommerceOrganizationIdSchema,
    displayName: DisplayNameSchema,
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .refine(hasNonDecreasingTimestamps, "updatedAt must not precede createdAt");

export type CommerceOrganization = z.infer<typeof CommerceOrganizationSchema>;

// Presentation-only DTO for one selected organization; never a trusted principal.
export const CommerceOrganizationAccessViewSchema = z.strictObject({
  schemaVersion: z.literal("openarc.organization-access.v1"),
  organizationId: CommerceOrganizationIdSchema,
  accountId: CommerceAccountIdSchema,
  role: CommerceHumanRoleSchema,
  membershipStatus: z.enum(["active", "suspended"]),
  sessionExpiresAt: IsoTimestampSchema,
});

export type CommerceOrganizationAccessView = z.infer<
  typeof CommerceOrganizationAccessViewSchema
>;

export const CommerceAgentProfileSchema = z
  .strictObject({
    schemaVersion: z.literal("openarc.agent-profile.v1"),
    agentId: CommerceAgentIdSchema,
    organizationId: CommerceOrganizationIdSchema,
    displayName: DisplayNameSchema,
    status: z.enum(["active", "suspended", "revoked"]),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .refine(hasNonDecreasingTimestamps, "updatedAt must not precede createdAt");

export type CommerceAgentProfile = z.infer<typeof CommerceAgentProfileSchema>;

export const CommerceProviderProfileSchema = z
  .strictObject({
    schemaVersion: z.literal("openarc.provider-profile.v1"),
    providerId: CommerceProviderIdSchema,
    organizationId: CommerceOrganizationIdSchema,
    displayName: DisplayNameSchema,
    status: z.enum(["active", "suspended", "retired"]),
    createdAt: IsoTimestampSchema,
    updatedAt: IsoTimestampSchema,
  })
  .refine(hasNonDecreasingTimestamps, "updatedAt must not precede createdAt");

export type CommerceProviderProfile = z.infer<typeof CommerceProviderProfileSchema>;

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

export const COMMERCE_IDENTITY_FIELD_CLASSES = Object.freeze({
  organization: protectedFields([
    "schemaVersion",
    "organizationId",
    "displayName",
    "createdAt",
    "updatedAt",
  ] as const),
  organizationAccessView: protectedFields([
    "schemaVersion",
    "organizationId",
    "accountId",
    "role",
    "membershipStatus",
    "sessionExpiresAt",
  ] as const),
  agentProfile: protectedFields([
    "schemaVersion",
    "agentId",
    "organizationId",
    "displayName",
    "status",
    "createdAt",
    "updatedAt",
  ] as const),
  providerProfile: protectedFields([
    "schemaVersion",
    "providerId",
    "organizationId",
    "displayName",
    "status",
    "createdAt",
    "updatedAt",
  ] as const),
});

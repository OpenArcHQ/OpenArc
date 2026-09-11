import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CommerceAccountIdSchema,
  CommerceAgentIdSchema,
  CommerceAgentProfileSchema,
  CommerceHumanRoleSchema,
  CommerceOrganizationAccessViewSchema,
  CommerceOrganizationIdSchema,
  CommerceOrganizationSchema,
  CommerceProviderIdSchema,
  CommerceProviderProfileSchema,
  COMMERCE_IDENTITY_FIELD_CLASSES,
  type CommerceAgentProfile,
  type CommerceHumanRole,
  type CommerceOrganization,
  type CommerceOrganizationAccessView,
  type CommerceProviderProfile,
} from "../src/commerce/identity.js";

const V1 = "12345678-1234-1234-8123-123456789abc";
const V4 = "12345678-1234-4234-8123-123456789abc";
const V7 = "12345678-1234-7234-8123-123456789abc";
const V8 = "12345678-1234-8234-8123-123456789abc";
const CANONICAL = [V1, V4, V7, V8];

const idCases = [
  ["organization", CommerceOrganizationIdSchema, "openarc:org:"],
  ["account", CommerceAccountIdSchema, "openarc:account:"],
  ["agent", CommerceAgentIdSchema, "openarc:agent:"],
  ["provider", CommerceProviderIdSchema, "openarc:provider:"],
] as const;

describe("commerce identity id schemas", () => {
  it("accepts canonical lowercase RFC UUIDs for versions 1, 4, 7, 8 per prefix", () => {
    for (const [, schema, prefix] of idCases) {
      for (const uuid of CANONICAL) {
        expect(schema.safeParse(`${prefix}${uuid}`).success).toBe(true);
      }
    }
  });

  it("rejects cross-prefix substitution", () => {
    for (const [, schema, prefix] of idCases) {
      for (const [, , otherPrefix] of idCases) {
        if (otherPrefix === prefix) continue;
        expect(schema.safeParse(`${otherPrefix}${V4}`).success).toBe(false);
      }
    }
  });

  it("rejects uppercase, nil, max, bad version/variant, legacy, trailing junk and newline", () => {
    const badUuids = [
      V4.toUpperCase(),
      "00000000-0000-0000-0000-000000000000",
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "12345678-1234-0234-8123-123456789abc",
      "12345678-1234-9234-8123-123456789abc",
      "12345678-1234-4234-7123-123456789abc",
      "12345678-1234-4234-c123-123456789abc",
      V4.slice(0, -1),
      `${V4}0`,
      `${V4}\n`,
      `${V4} `,
      `act_${V4}`,
      `evd_${V4}`,
    ];
    for (const [, schema, prefix] of idCases) {
      for (const bad of badUuids) {
        expect(schema.safeParse(`${prefix}${bad}`).success).toBe(false);
      }
      expect(schema.safeParse("act_").success).toBe(false);
      expect(schema.safeParse("evd_").success).toBe(false);
      expect(schema.safeParse(`${prefix.toUpperCase()}${V4}`).success).toBe(false);
    }
  });

  it("rejects empty, missing and non-string values without coercion", () => {
    for (const [, schema, prefix] of idCases) {
      expect(schema.safeParse("").success).toBe(false);
      for (const value of [42, 0, null, undefined, true, {}, [], [V4]]) {
        expect(schema.safeParse(value).success).toBe(false);
      }
      expect(schema.safeParse(prefix).success).toBe(false);
    }
  });
});

const ISO = "2024-01-01T00:00:00.000Z";
const ISO_LATER = "2024-01-01T00:00:00.001Z";
const PAST = "2000-01-01T00:00:00.000Z"; // historical fixture: structure != live auth
const ORG = `openarc:org:${V1}`;
const ACCOUNT = `openarc:account:${V4}`;
const AGENT = `openarc:agent:${V7}`;
const PROVIDER = `openarc:provider:${V8}`;

const organization = {
  schemaVersion: "openarc.organization.v1",
  organizationId: ORG,
  displayName: "Acme",
  createdAt: ISO,
  updatedAt: ISO_LATER,
} satisfies CommerceOrganization;

const accessView = {
  schemaVersion: "openarc.organization-access.v1",
  organizationId: ORG,
  accountId: ACCOUNT,
  role: "owner",
  membershipStatus: "active",
  sessionExpiresAt: PAST,
} satisfies CommerceOrganizationAccessView;

const agentProfile = {
  schemaVersion: "openarc.agent-profile.v1",
  agentId: AGENT,
  organizationId: ORG,
  displayName: "Agent",
  status: "active",
  createdAt: ISO,
  updatedAt: ISO,
} satisfies CommerceAgentProfile;

const providerProfile = {
  schemaVersion: "openarc.provider-profile.v1",
  providerId: PROVIDER,
  organizationId: ORG,
  displayName: "Provider",
  status: "active",
  createdAt: ISO,
  updatedAt: ISO,
} satisfies CommerceProviderProfile;

const dtoCases = [
  [CommerceOrganizationSchema, organization],
  [CommerceOrganizationAccessViewSchema, accessView],
  [CommerceAgentProfileSchema, agentProfile],
  [CommerceProviderProfileSchema, providerProfile],
] as const;

const timestampedCases = [
  [CommerceOrganizationSchema, organization],
  [CommerceAgentProfileSchema, agentProfile],
  [CommerceProviderProfileSchema, providerProfile],
] as const;

const displayNameCases = timestampedCases;

describe("commerce identity DTOs", () => {
  it("roundtrips all four valid DTOs without stripping fields", () => {
    for (const [schema, fixture] of dtoCases) {
      expect(schema.parse(fixture)).toEqual(fixture);
    }
  });

  it("enforces the exact role and status unions", () => {
    expect(CommerceHumanRoleSchema.options).toEqual([
      "owner",
      "operator",
      "provider_admin",
      "provider_developer",
      "viewer",
    ]);
    for (const role of CommerceHumanRoleSchema.options) {
      expect(
        CommerceOrganizationAccessViewSchema.safeParse({ ...accessView, role }).success,
      ).toBe(true);
    }
    expect(
      CommerceOrganizationAccessViewSchema.safeParse({ ...accessView, role: "admin" })
        .success,
    ).toBe(false);
    for (const membershipStatus of ["active", "suspended"]) {
      expect(
        CommerceOrganizationAccessViewSchema.safeParse({
          ...accessView,
          membershipStatus,
        }).success,
      ).toBe(true);
    }
    expect(
      CommerceOrganizationAccessViewSchema.safeParse({
        ...accessView,
        membershipStatus: "expired",
      }).success,
    ).toBe(false);
    for (const status of ["active", "suspended", "revoked"]) {
      expect(
        CommerceAgentProfileSchema.safeParse({ ...agentProfile, status }).success,
      ).toBe(true);
    }
    expect(
      CommerceAgentProfileSchema.safeParse({ ...agentProfile, status: "retired" }).success,
    ).toBe(false);
    for (const status of ["active", "suspended", "retired"]) {
      expect(
        CommerceProviderProfileSchema.safeParse({ ...providerProfile, status }).success,
      ).toBe(true);
    }
    expect(
      CommerceProviderProfileSchema.safeParse({ ...providerProfile, status: "revoked" })
        .success,
    ).toBe(false);
  });

  it("rejects unknown schema versions", () => {
    expect(
      CommerceOrganizationSchema.safeParse({
        ...organization,
        schemaVersion: "openarc.organization.v2",
      }).success,
    ).toBe(false);
    expect(
      CommerceAgentProfileSchema.safeParse({
        ...agentProfile,
        schemaVersion: "openarc.agent-profile.v0",
      }).success,
    ).toBe(false);
    expect(
      CommerceOrganizationAccessViewSchema.safeParse({
        ...accessView,
        schemaVersion: "openarc.organization-access.v2",
      }).success,
    ).toBe(false);
    expect(
      CommerceProviderProfileSchema.safeParse({
        ...providerProfile,
        schemaVersion: "openarc.provider-profile.v2",
      }).success,
    ).toBe(false);
  });

  it("rejects private, secret, provider-body, nested and data-class override fields", () => {
    const forbidden = [
      "privatePrompt",
      "rawOutput",
      "signature",
      "cookie",
      "credential",
      "privateKey",
      "dataClass",
      "audience",
      "rawBody",
      "requestBody",
      "payload",
      "maxTokens",
    ];
    for (const [schema, fixture] of dtoCases) {
      for (const key of forbidden) {
        expect(schema.safeParse({ ...fixture, [key]: "x" }).success).toBe(false);
      }
      expect(
        schema.safeParse({ ...fixture, nested: { unknown: true } }).success,
      ).toBe(false);
    }
  });

  it("rejects access-view additions such as updatedAt, canSpend and isAdmin", () => {
    expect(CommerceOrganizationAccessViewSchema.safeParse(accessView).success).toBe(true);
    for (const extra of ["updatedAt", "createdAt", "canSpend", "isAdmin"]) {
      expect(
        CommerceOrganizationAccessViewSchema.safeParse({ ...accessView, [extra]: true })
          .success,
      ).toBe(false);
    }
  });

  it("enforces updatedAt >= createdAt exactly, including sub-ms fractions", () => {
    for (const [schema, fixture] of timestampedCases) {
      expect(schema.safeParse({ ...fixture, updatedAt: fixture.createdAt }).success).toBe(
        true,
      );
    }
    const created = "2024-01-01T00:00:00.000000001Z";
    const later = "2024-01-01T00:00:00.000000002Z";
    for (const [schema, fixture] of timestampedCases) {
      expect(
        schema.safeParse({ ...fixture, createdAt: created, updatedAt: later }).success,
      ).toBe(true);
      expect(
        schema.safeParse({ ...fixture, createdAt: later, updatedAt: created }).success,
      ).toBe(false);
    }
    expect(
      CommerceOrganizationSchema.safeParse({
        ...organization,
        createdAt: ISO_LATER,
        updatedAt: ISO,
      }).success,
    ).toBe(false);
  });

  it("rejects invalid timestamps on every field without throwing", () => {
    const badValues = [
      "2024-13-01T00:00:00.000Z",
      "2024-02-30T00:00:00.000Z",
      "2024-01-01T00:00:00+01:00",
      "2024-01-01T00:00:00",
      "not-a-date",
    ];
    for (const bad of badValues) {
      expect(
        CommerceOrganizationSchema.safeParse({ ...organization, createdAt: bad }).success,
      ).toBe(false);
      expect(
        CommerceOrganizationSchema.safeParse({ ...organization, updatedAt: bad }).success,
      ).toBe(false);
      expect(
        CommerceAgentProfileSchema.safeParse({ ...agentProfile, createdAt: bad }).success,
      ).toBe(false);
      expect(
        CommerceAgentProfileSchema.safeParse({ ...agentProfile, updatedAt: bad }).success,
      ).toBe(false);
      expect(
        CommerceProviderProfileSchema.safeParse({ ...providerProfile, createdAt: bad })
          .success,
      ).toBe(false);
      expect(
        CommerceProviderProfileSchema.safeParse({ ...providerProfile, updatedAt: bad })
          .success,
      ).toBe(false);
      expect(
        CommerceOrganizationAccessViewSchema.safeParse({
          ...accessView,
          sessionExpiresAt: bad,
        }).success,
      ).toBe(false);
    }
  });

  it("structurally allows past access-view expiry while remaining non-authenticating", () => {
    expect(PAST < ISO).toBe(true);
    expect(
      CommerceOrganizationAccessViewSchema.safeParse({
        ...accessView,
        sessionExpiresAt: PAST,
      }).success,
    ).toBe(true);
  });

  it("validates displayName Unicode, length, whitespace and control chars", () => {
    const unicode100 = "é".repeat(100);
    for (const [schema, fixture] of displayNameCases) {
      expect(schema.safeParse(fixture).success).toBe(true);
      expect(schema.safeParse({ ...fixture, displayName: unicode100 }).success).toBe(true);
      expect(
        schema.safeParse({ ...fixture, displayName: "é".repeat(101) }).success,
      ).toBe(false);
      for (const bad of ["", "   ", " a", "a ", "a\nb", "a\tb", "a\u0000b", "a\u009fb"]) {
        expect(schema.safeParse({ ...fixture, displayName: bad }).success).toBe(false);
      }
    }
  });
});

describe("commerce identity field-class registry", () => {
  const expected = {
    organization: [
      "schemaVersion",
      "organizationId",
      "displayName",
      "createdAt",
      "updatedAt",
    ],
    organizationAccessView: [
      "schemaVersion",
      "organizationId",
      "accountId",
      "role",
      "membershipStatus",
      "sessionExpiresAt",
    ],
    agentProfile: [
      "schemaVersion",
      "agentId",
      "organizationId",
      "displayName",
      "status",
      "createdAt",
      "updatedAt",
    ],
    providerProfile: [
      "schemaVersion",
      "providerId",
      "organizationId",
      "displayName",
      "status",
      "createdAt",
      "updatedAt",
    ],
  } as const;

  it("has exact frozen leaf paths all classified organization_protected", () => {
    expect(Object.isFrozen(COMMERCE_IDENTITY_FIELD_CLASSES)).toBe(true);
    expect(Object.keys(COMMERCE_IDENTITY_FIELD_CLASSES).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    for (const [name, keys] of Object.entries(expected)) {
      const map =
        COMMERCE_IDENTITY_FIELD_CLASSES[name as keyof typeof expected];
      expect(Object.isFrozen(map)).toBe(true);
      expect(Object.keys(map).sort()).toEqual([...keys].sort());
      for (const value of Object.values(map)) {
        expect(value).toBe("organization_protected");
      }
    }
  });

  it("infers the frozen DTO literal contracts", () => {
    expectTypeOf<CommerceOrganization["schemaVersion"]>().toEqualTypeOf<"openarc.organization.v1">();
    expectTypeOf<CommerceHumanRole>().toEqualTypeOf<
      "owner" | "operator" | "provider_admin" | "provider_developer" | "viewer"
    >();
  });
});
